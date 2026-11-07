import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  collaborationReportSchema,
  collaborationResultSchema,
  collaborationWaitInputSchema,
  collaborationWaitSchema,
} from '../contracts/collaboration-results.ts';
import type { CollaborationResult, CollaborationWait } from '../contracts/collaboration-results.ts';
import { stoppedObservationSchema, nativeTerminalJobStatuses } from '../contracts/controls.ts';
import type { CollaborationCatalog } from './collaboration-catalog.ts';
import type { ExecutionCatalog } from './execution-catalog.ts';
import type { SessionCatalog } from './session-catalog.ts';
import type { WorkbenchCatalog } from './workbench-catalog.ts';
import { transaction } from './transaction.ts';
import { ProjectError } from '../services/errors.ts';
import { messageIdentity } from '../services/message-presentation.ts';
import { deliverySchema } from '../contracts/chat.ts';
import { collaborationFaultSchema } from '../contracts/collaboration.ts';
import { decisionRequestSchema, decisionNoticeSchema } from '../contracts/decision-requests.ts';
const now = () => new Date().toISOString();
export function migrateCollaborationResults(db: DatabaseSync): void {
  db.exec(`CREATE TABLE collaboration_result(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,collaboration_id TEXT NOT NULL REFERENCES collaboration(id),data TEXT NOT NULL);
 CREATE TABLE collaboration_wait(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES session(id),execution_id TEXT NOT NULL REFERENCES execution(id),state TEXT NOT NULL,data TEXT NOT NULL);
 CREATE UNIQUE INDEX collaboration_wait_current ON collaboration_wait(session_id) WHERE state IN('waiting','unknown'); PRAGMA user_version=12;`);
}
export class CollaborationResultsCatalog {
  private readonly db: DatabaseSync;
  private readonly collaborations: CollaborationCatalog;
  private readonly executions: ExecutionCatalog;
  private readonly sessions: SessionCatalog;
  private readonly wb: WorkbenchCatalog;
  constructor(
    db: DatabaseSync,
    collaborations: CollaborationCatalog,
    executions: ExecutionCatalog,
    sessions: SessionCatalog,
    wb: WorkbenchCatalog,
  ) {
    this.db = db;
    this.collaborations = collaborations;
    this.executions = executions;
    this.sessions = sessions;
    this.wb = wb;
  }
  get(id: string): CollaborationResult {
    const row = this.db.prepare('SELECT data FROM collaboration_result WHERE id=?').get(id);
    if (!row) throw new ProjectError('COLLABORATION_RESULT_NOT_FOUND', '正式协作结果不存在');
    return collaborationResultSchema.parse(JSON.parse(String(row.data)));
  }
  results(id?: string): CollaborationResult[] {
    return this.db
      .prepare('SELECT id FROM collaboration_result ORDER BY rowid')
      .all()
      .map((r) => this.get(String(r.id)))
      .filter((r) => !id || r.collaborationId === id);
  }
  report(sessionId: string, raw: unknown): CollaborationResult {
    const input = collaborationReportSchema.parse(raw),
      hash = createHash('sha256').update(JSON.stringify({ sessionId, input })).digest('hex');
    return transaction(this.db, () => {
      const old = this.db
        .prepare('SELECT id,request_hash FROM collaboration_result WHERE operation_id=?')
        .get(input.operationId);
      if (old) {
        if (old.request_hash !== hash)
          throw new ProjectError('COLLABORATION_RESULT_CONFLICT', '正式协作结果操作来源或内容冲突');
        return this.get(String(old.id));
      }
      const a = this.collaborations.currentForSession(sessionId),
        scope = this.collaborations.scopeForSession(sessionId);
      if (!a || a.state !== 'active' || !scope?.allowWrite || scope.shutdownOnly)
        throw new ProjectError(
          'CURRENT_ASSISTANT_REQUIRED',
          '正式协作交回必须来自当前允许执行的实际辅助',
        );
      for (const id of input.dependencies)
        if (this.collaborations.get(id).executionId !== a.executionId || id === a.id)
          throw new ProjectError('WAIT_DEPENDENCY_SCOPE', '等待对象不属于本票或形成自等');
      const v: CollaborationResult = {
        id: randomUUID(),
        operationId: input.operationId,
        collaborationId: a.id,
        executionId: a.executionId,
        ticketId: a.ticketId,
        sessionId,
        parentSessionId: a.parentSessionId,
        author: this.wb.author({ kind: 'session', sessionId }),
        action: input.action,
        content: input.content,
        evidencePaths: input.evidencePaths,
        dependencies: input.dependencies,
        resumeCondition: input.resumeCondition ?? null,
        previousResultId: a.lastResultId,
        progress: 'saved',
        observation: null,
        observations: [],
        error: null,
        deliveryError: null,
        notices: [],
        createdAt: now(),
        updatedAt: now(),
      };
      this.db
        .prepare(
          'INSERT INTO collaboration_result(id,operation_id,request_hash,collaboration_id,data) VALUES(?,?,?,?,?)',
        )
        .run(v.id, input.operationId, hash, a.id, JSON.stringify(v));
      this.collaborations.reportStarted(a.id, v.id);
      return v;
    });
  }
  observe(id: string, raw: unknown): CollaborationResult {
    const observation = stoppedObservationSchema.parse(raw);
    return transaction(this.db, () => {
      const v = this.get(id),
        a = this.collaborations.get(v.collaborationId);
      if (a.lastResultId !== id)
        throw new ProjectError('STALE_COLLABORATION_RESULT', '旧结果不能改变新的协作');
      if (a.state === 'terminated')
        throw new ProjectError('STALE_COLLABORATION_RESULT', '已终止协作不能被旧结果恢复');
      if (v.progress === 'confirmed') return v;
      const quiet =
        observation.agentIdle === true &&
        observation.inFlightTools === false &&
        observation.filesStable === true &&
        observation.processesComplete &&
        observation.jobObservations.every(
          (j) => j.externalStatus === 'gone' && nativeTerminalJobStatuses.includes(j.nativeStatus),
        );
      v.progress = quiet ? 'confirmed' : 'unknown';
      v.observation = observation;
      v.observations.push(observation);
      v.error = quiet ? null : '协作会话、工具、作业或写入尚未核停稳，未释放责任';
      v.updatedAt = now();
      this.db
        .prepare('UPDATE collaboration_result SET data=? WHERE id=?')
        .run(JSON.stringify(v), id);
      this.collaborations.reportObserved(
        v.collaborationId,
        v.id,
        quiet ? (v.action === 'complete' ? 'completed' : 'waiting') : 'unknown',
      );
      if (
        quiet &&
        v.action === 'complete' &&
        this.sessions.get(v.sessionId).communicationState === 'active'
      )
        this.sessions.communicationState(v.sessionId, 'archived');
      return v;
    });
  }
  resultProblem(id: string, error: string): CollaborationResult {
    return transaction(this.db, () => {
      const v = this.get(id);
      if (v.progress === 'confirmed') return v;
      v.progress = 'unknown';
      v.error = error;
      v.updatedAt = now();
      this.db
        .prepare('UPDATE collaboration_result SET data=? WHERE id=?')
        .run(JSON.stringify(v), id);
      this.collaborations.reportObserved(v.collaborationId, v.id, 'unknown');
      return v;
    });
  }
  deliveryProblem(id: string, error: string | null): void {
    const v = this.get(id);
    v.deliveryError = error;
    v.updatedAt = now();
    this.db.prepare('UPDATE collaboration_result SET data=? WHERE id=?').run(JSON.stringify(v), id);
  }
  prepareNotice(id: string) {
    return transaction(this.db, () => {
      const v = this.get(id);
      if (v.progress === 'saved') throw new ProjectError('RESULT_NOT_OBSERVED', '停稳进展尚未记录');
      const progress = v.progress;
      let notice = v.notices.find((n) => n.progress === progress);
      if (!notice) {
        notice = {
          id: messageIdentity('collaboration-result:' + id + ':' + progress),
          progress,
          targetSessionId: v.parentSessionId,
          content: JSON.stringify({
            resultId: id,
            collaborationId: v.collaborationId,
            action: v.action,
            progress,
            content: v.content,
            evidencePaths: v.evidencePaths,
            error: v.error,
            note: '这是正式协作交回及停稳进展，不代表结果合格或整票完成；详情及历史按resultId查询。',
          }),
        };
        v.notices.push(notice);
        this.db
          .prepare('UPDATE collaboration_result SET data=? WHERE id=?')
          .run(JSON.stringify(v), id);
      }
      return notice;
    });
  }
  getWait(id: string): CollaborationWait {
    const r = this.db.prepare('SELECT data FROM collaboration_wait WHERE id=?').get(id);
    if (!r) throw new ProjectError('COLLABORATION_WAIT_NOT_FOUND', '等待记录不存在');
    return collaborationWaitSchema.parse(JSON.parse(String(r.data)));
  }
  waits(executionId?: string): CollaborationWait[] {
    return this.db
      .prepare('SELECT id FROM collaboration_wait ORDER BY rowid')
      .all()
      .map((r) => this.getWait(String(r.id)))
      .filter((w) => !executionId || w.executionId === executionId);
  }
  readiness(id: string) {
    const w = this.getWait(id);
    const facts = w.dependencies.map((id) => {
      const a = this.collaborations.get(id);
      return {
        id,
        state: a.state,
        delivered: this.deliveryReady(a.id),
        controlled: !!a.faultId && this.fault(a.faultId).kind === 'control',
      };
    });
    const outstanding = facts
      .filter((f) => f.state !== 'completed' || !f.delivered)
      .map((f) => f.id);
    const exceptions = facts
      .filter(
        (f) =>
          (['error', 'unknown', 'waiting', 'terminated'].includes(f.state) || f.controlled) &&
          f.delivered,
      )
      .map((f) => f.id);
    const requests = this.db
      .prepare('SELECT data FROM decision_request WHERE execution_id=?')
      .all(w.executionId)
      .map((row) => decisionRequestSchema.parse(JSON.parse(String(row.data))));
    const noticeReady = (requestId: string, revision: number) =>
      this.db
        .prepare('SELECT data FROM decision_request_notice WHERE request_id=?')
        .all(requestId)
        .some((row) => {
          const n = decisionNoticeSchema.parse(JSON.parse(String(row.data)));
          return (
            n.revision === revision &&
            n.target.sessionId === w.sessionId &&
            this.receiptReady(n.id, w.sessionId)
          );
        });
    const requestOutstanding = w.requestIds.filter((id) => {
      const r = requests.find((r) => r.id === id);
      return (
        !r ||
        !['answered', 'rejected', 'withdrawn'].includes(r.state) ||
        !noticeReady(id, r.revision)
      );
    });
    const requestExceptions = requests
      .filter(
        (r) =>
          noticeReady(r.id, r.revision) &&
          ((r.state === 'pending' &&
            r.assignee.sessionId === w.sessionId &&
            r.collaborationId !== null &&
            w.dependencies.includes(r.collaborationId)) ||
            (r.state === 'needs-info' &&
              r.requester.sessionId === w.sessionId &&
              w.requestIds.includes(r.id))),
      )
      .map((r) => r.id);
    return {
      ready:
        (w.dependencies.length + w.requestIds.length > 0 &&
          outstanding.length === 0 &&
          requestOutstanding.length === 0) ||
        exceptions.length > 0 ||
        requestExceptions.length > 0,
      outstanding,
      exceptions,
      dependencies: w.dependencies,
      requestOutstanding,
      requestExceptions,
    };
  }
  deliveryReady(id: string): boolean {
    const a = this.collaborations.get(id);
    if (
      a.faultId &&
      (['unknown', 'error', 'terminated'].includes(a.state) ||
        this.fault(a.faultId).kind === 'control')
    ) {
      const n = this.fault(a.faultId);
      return this.receiptReady(n.id, n.parentSessionId);
    }
    if (!a.lastResultId) return false;
    const v = this.get(a.lastResultId);
    if (v.progress === 'saved') return false;
    const notice = v.notices.find((n) => n.progress === v.progress);
    if (!notice) return false;
    return this.receiptReady(notice.id, v.parentSessionId);
  }
  private receiptReady(id: string, parentSessionId: string): boolean {
    const row = this.db.prepare('SELECT data FROM message_delivery WHERE message_id=?').get(id);
    if (!row) return false;
    const receipt = deliverySchema.parse(JSON.parse(String(row.data)));
    return (
      receipt.targetSessionId === parentSessionId &&
      receipt.nativeMessageId === id &&
      receipt.memoryAcceptedAt !== null &&
      receipt.durableAcceptedAt !== null
    );
  }
  fault(id: string) {
    const row = this.db
      .prepare(
        "SELECT data FROM workbench_revision WHERE kind='collaboration-fault' AND object_id=? ORDER BY seq LIMIT 1",
      )
      .get(id);
    if (!row) throw new ProjectError('COLLABORATION_FAULT_NOT_FOUND', '没有已保存的实际协作故障');
    return collaborationFaultSchema.parse(JSON.parse(String(row.data)).value);
  }
  unsettled(executionId: string) {
    return this.collaborations
      .list(executionId)
      .filter(
        (a) =>
          !(a.state === 'error' && a.sessionId === null) &&
          (!['completed', 'terminated'].includes(a.state) ||
            !this.deliveryReady(a.id) ||
            (a.state === 'terminated' &&
              this.db
                .prepare(
                  "SELECT json_extract(data,'$.status') AS status FROM assistant_control WHERE collaboration_id=? ORDER BY revision DESC LIMIT 1",
                )
                .get(a.id)?.status !== 'terminated')),
      );
  }
  wait(sessionId: string, raw: unknown): CollaborationWait {
    const input = collaborationWaitInputSchema.parse(raw),
      hash = createHash('sha256').update(JSON.stringify({ sessionId, input })).digest('hex');
    return transaction(this.db, () => {
      const old = this.db
        .prepare('SELECT id,request_hash FROM collaboration_wait WHERE operation_id=?')
        .get(input.operationId);
      if (old) {
        if (old.request_hash !== hash)
          throw new ProjectError('COLLABORATION_WAIT_CONFLICT', '等待操作来源或内容冲突');
        return this.getWait(String(old.id));
      }
      const e = this.collaborations.requireMain(sessionId);
      if (!input.dependencies.length && !input.requestIds.length && !input.resumeCondition)
        throw new ProjectError(
          'WAIT_CONDITION_REQUIRED',
          '无已有对象时须说明恢复条件，系统不猜测文字满足',
        );
      const dependencies = [...new Set(input.dependencies)];
      for (const id of dependencies)
        if (this.collaborations.get(id).executionId !== e.id)
          throw new ProjectError('WAIT_DEPENDENCY_SCOPE', '只能等待本次主执行的协作');
      const requestIds = [...new Set(input.requestIds)];
      for (const id of requestIds) {
        const row = this.db.prepare('SELECT data FROM decision_request WHERE id=?').get(id);
        const r = row ? decisionRequestSchema.parse(JSON.parse(String(row.data))) : null;
        if (!r || r.executionId !== e.id || r.requester.sessionId !== sessionId)
          throw new ProjectError('WAIT_REQUEST_SCOPE', '只能等待本次自己提出的准确请求');
      }
      if (this.waits(e.id).some((w) => ['waiting', 'unknown'].includes(w.state)))
        throw new ProjectError('COLLABORATION_WAIT_EXISTS', '已有当前等待，先核对原对象');
      const revision = Number(
        this.db
          .prepare(
            'SELECT COALESCE(MAX(revision),0) AS n FROM execution_control WHERE execution_id=?',
          )
          .get(e.id)!.n,
      );
      const w: CollaborationWait = {
        id: randomUUID(),
        operationId: input.operationId,
        executionId: e.id,
        sessionId,
        dependencies,
        requestIds,
        reason: input.reason,
        resumeCondition: input.resumeCondition ?? null,
        state: 'waiting',
        supersededByControlId: null,
        goalId: e.goalId,
        controlRevision: revision,
        error: null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.db
        .prepare(
          'INSERT INTO collaboration_wait(id,operation_id,request_hash,session_id,execution_id,state,data) VALUES(?,?,?,?,?,?,?)',
        )
        .run(w.id, input.operationId, hash, sessionId, e.id, w.state, JSON.stringify(w));
      if (this.readiness(w.id).ready) {
        w.state = 'ready';
        this.saveWait(w);
      } else this.executions.waitForCollaborations(e.id);
      return w;
    });
  }
  private saveWait(w: CollaborationWait): void {
    w.updatedAt = now();
    this.db
      .prepare('UPDATE collaboration_wait SET state=?,data=? WHERE id=?')
      .run(w.state, JSON.stringify(w), w.id);
  }
  problem(id: string, error: string): CollaborationWait {
    const w = this.getWait(id);
    if (w.state === 'signalled' || w.state === 'ready' || w.state === 'controlled') return w;
    w.state = 'unknown';
    w.error = error;
    this.saveWait(w);
    return w;
  }
  canWake(id: string): boolean {
    const w = this.getWait(id);
    return w.state === 'waiting' && this.readiness(id).ready && this.currentWait(w);
  }
  retryWait(id: string): CollaborationWait {
    return transaction(this.db, () => {
      const w = this.getWait(id);
      if (!['waiting', 'unknown'].includes(w.state) || !this.currentWait(w))
        throw new ProjectError('WAIT_CONTROL_CHANGED', '原等待已结束或控制变化，不能接续');
      w.state = 'waiting';
      w.error = null;
      this.saveWait(w);
      return w;
    });
  }
  private currentWait(w: CollaborationWait): boolean {
    const e = this.executions.get(w.executionId),
      s = this.sessions.get(w.sessionId);
    const revision = Number(
      this.db
        .prepare(
          'SELECT COALESCE(MAX(revision),0) AS n FROM execution_control WHERE execution_id=?',
        )
        .get(e.id)!.n,
    );
    return (
      e.lifecycleState === 'waiting' &&
      this.executions.scopeForSession(w.sessionId)?.allowAssist === true &&
      e.waitingReviewId === null &&
      e.failure === null &&
      s.status === 'bound' &&
      s.communicationState === 'active' &&
      revision === w.controlRevision
    );
  }
  signalled(id: string): CollaborationWait {
    return transaction(this.db, () => {
      const w = this.getWait(id);
      if (!this.canWake(id))
        throw new ProjectError('WAIT_NOT_READY', '等待未满足或已有更新控制，不解除暂停');
      this.executions.returnFromCollaborationWait(w.executionId);
      w.state = 'signalled';
      this.saveWait(w);
      return w;
    });
  }
}
