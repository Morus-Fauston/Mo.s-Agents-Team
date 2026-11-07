import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  assistantControlInputSchema,
  assistantControlSchema,
} from '../contracts/assistant-controls.ts';
import type { AssistantControlRecord } from '../contracts/assistant-controls.ts';
import type { ControlRecord, ControlReceipt, StoppedObservation } from '../contracts/controls.ts';
import {
  controlSchema,
  receiptSchema,
  stoppedObservationSchema,
  nativeTerminalJobStatuses,
} from '../contracts/controls.ts';
import type { WorkbenchActor } from '../contracts/workbench.ts';
import type { CollaborationCatalog } from './collaboration-catalog.ts';
import type { ExecutionCatalog } from './execution-catalog.ts';
import type { SessionCatalog } from './session-catalog.ts';
import type { WorkbenchCatalog } from './workbench-catalog.ts';
import { transaction } from './transaction.ts';
import { ProjectError } from '../services/errors.ts';
import { messageIdentity } from '../services/message-presentation.ts';
const now = () => new Date().toISOString();
export function migrateAssistantControls(db: DatabaseSync): void {
  db.exec(`CREATE TABLE assistant_control(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,collaboration_id TEXT NOT NULL REFERENCES collaboration(id),parent_control_id TEXT REFERENCES execution_control(id),revision INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(collaboration_id,revision));
 DROP INDEX collaboration_current_session;
 CREATE UNIQUE INDEX collaboration_current_session ON collaboration(session_id) WHERE session_id IS NOT NULL AND state NOT IN('completed','terminated');
 PRAGMA user_version=13;`);
}
export class AssistantControlCatalog {
  private readonly db: DatabaseSync;
  private readonly collaborations: CollaborationCatalog;
  private readonly executions: ExecutionCatalog;
  private readonly sessions: SessionCatalog;
  private readonly wb: WorkbenchCatalog;
  private changed: (executionId: string) => void = () => {};
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
  bindChange(handler: (executionId: string) => void): void {
    this.changed = handler;
  }
  get(id: string): AssistantControlRecord {
    const row = this.db.prepare('SELECT data FROM assistant_control WHERE id=?').get(id);
    if (!row) throw new ProjectError('ASSISTANT_CONTROL_NOT_FOUND', '辅助控制请求不存在');
    return assistantControlSchema.parse(JSON.parse(String(row.data)));
  }
  list(collaborationId?: string): AssistantControlRecord[] {
    return this.db
      .prepare('SELECT id FROM assistant_control ORDER BY rowid')
      .all()
      .map((r) => this.get(String(r.id)))
      .filter((v) => !collaborationId || v.collaborationId === collaborationId);
  }
  current(id: string): AssistantControlRecord | undefined {
    return this.list(id).at(-1);
  }
  revision(id: string): number {
    return this.current(id)?.revision ?? 0;
  }
  forExecution(id: string): AssistantControlRecord[] {
    return this.list().filter((v) => v.executionId === id);
  }
  inventory(id: string) {
    return this.collaborations.list(id).map((a) => {
      const s = a.sessionId ? this.sessions.get(a.sessionId) : null;
      return {
        collaborationId: a.id,
        name: a.name,
        sessionId: a.sessionId,
        address: s?.addresses.readable ?? null,
        state: a.state,
        communicationState: s?.communicationState ?? null,
        revision: this.revision(a.id),
        current: this.current(a.id) ?? null,
      };
    });
  }
  private save(v: AssistantControlRecord): AssistantControlRecord {
    v.updatedAt = now();
    assistantControlSchema.parse(v);
    this.db.prepare('UPDATE assistant_control SET data=? WHERE id=?').run(JSON.stringify(v), v.id);
    this.db
      .prepare('INSERT INTO ui_event(kind,object_id) VALUES(?,?)')
      .run('assistant-control-changed', v.executionId);
    this.changed(v.executionId);
    return v;
  }
  private latest(v: AssistantControlRecord): boolean {
    return this.current(v.collaborationId)?.id === v.id;
  }
  request(
    actor: WorkbenchActor,
    raw: unknown,
    epoch: string,
    parentControlId: string | null = null,
  ): AssistantControlRecord {
    const input = assistantControlInputSchema.parse(raw),
      author = this.wb.author(actor),
      hash = createHash('sha256')
        .update(JSON.stringify({ actor, input, parentControlId }))
        .digest('hex');
    return transaction(this.db, () => {
      const prior = this.db
        .prepare('SELECT id,request_hash FROM assistant_control WHERE operation_id=?')
        .get(input.operationId);
      if (prior) {
        if (prior.request_hash !== hash)
          throw new ProjectError('ASSISTANT_CONTROL_CONFLICT', '辅助控制操作来源或内容冲突');
        return this.get(String(prior.id));
      }
      const a = this.collaborations.get(input.collaborationId),
        e = this.executions.get(a.executionId),
        previous = this.current(a.id);
      if (parentControlId) {
        const row = this.db
          .prepare('SELECT data FROM execution_control WHERE id=?')
          .get(parentControlId);
        const source = row ? controlSchema.parse(JSON.parse(String(row.data))) : null;
        if (
          !source ||
          source.executionId !== e.id ||
          source.epoch !== epoch ||
          source.action !== input.action ||
          JSON.stringify(source.actor) !== JSON.stringify(author)
        )
          throw new ProjectError('ASSISTANT_CONTROL_SOURCE', '缺少同事务保存的实际主控制来源');
      }
      const manager = actor.kind === 'user' || author.roleType === 'supervisor';
      if (!manager && !parentControlId) {
        if (input.action !== 'resume' || actor.sessionId !== a.parentSessionId)
          throw new ProjectError('ASSISTANT_CONTROL_FORBIDDEN', '普通会话不能控制其他入口');
        this.collaborations.requireMain(actor.sessionId);
        if (!previous?.parentControlId || previous.blockedBy.length)
          throw new ProjectError(
            'ASSISTANT_INDEPENDENT_PAUSE',
            '辅助另受独立暂停，原主负责人不能借父恢复解除',
          );
      }
      if (!a.sessionId || ['completed', 'terminated'].includes(a.state))
        throw new ProjectError('ASSISTANT_CONTROL_ENDED', '辅助已结束或尚无明确会话，不复活历史');
      if (this.revision(a.id) !== input.expectedRevision)
        throw new ProjectError('STALE_ASSISTANT_CONTROL', '辅助控制修订已变化');
      const s = this.sessions.get(a.sessionId);
      if (input.action === 'resume') {
        if (
          parentControlId ||
          e.lifecycleState !== 'active' ||
          e.writeOccupancy !== 'held' ||
          e.failure ||
          e.hostEpoch !== epoch ||
          this.sessions.get(a.parentSessionId).communicationState !== 'active'
        )
          throw new ProjectError('ASSISTANT_PARENT_NOT_READY', '先明确恢复原主负责人并核清现场');
        if (
          !previous ||
          previous.status !== 'stopped' ||
          s.communicationState !== 'paused' ||
          s.status !== 'bound' ||
          !['active', 'waiting'].includes(a.state)
        )
          throw new ProjectError('ASSISTANT_RESUME_NOT_QUIET', '原辅助尚未核清或不可恢复');
      }
      const inheritedBlock = previous
        ? previous.action === 'resume' && previous.status === 'resumed'
          ? []
          : previous.parentControlId
            ? previous.blockedBy
            : [previous.id]
        : s.communicationState === 'paused'
          ? ['session:' + s.id]
          : [];
      const v: AssistantControlRecord = {
        id: randomUUID(),
        operationId: input.operationId,
        collaborationId: a.id,
        executionId: e.id,
        parentSessionId: a.parentSessionId,
        sessionId: s.id,
        nativeSessionId: s.nativeSessionId,
        parentControlId,
        blockedBy: parentControlId ? inheritedBlock : [],
        revision: input.expectedRevision + 1,
        actor: author,
        action: input.action,
        reason: input.reason,
        content: input.content,
        stopMode: input.action === 'soft-stop' ? 'soft' : input.stopMode,
        status: 'requested',
        handoffRequired: s.communicationState === 'active' && a.state === 'active',
        error: null,
        goal: null,
        cancel: null,
        jobKills: [],
        observation: null,
        observations: [],
        report: null,
        messageId: randomUUID(),
        resumeMessageId: randomUUID(),
        resumeSnapshot: null,
        writeScopes: [...a.writeScopes],
        materialPaths: this.wb
          .materialDomains(a.ticketId)
          .filter((d) => d.referenceId === a.id)
          .map((d) => d.path),
        epoch,
        createdAt: now(),
        updatedAt: now(),
      };
      this.db
        .prepare(
          'INSERT INTO assistant_control(id,operation_id,request_hash,collaboration_id,parent_control_id,revision,data) VALUES(?,?,?,?,?,?,?)',
        )
        .run(v.id, v.operationId, hash, a.id, parentControlId, v.revision, JSON.stringify(v));
      if (
        input.action === 'hard-stop' ||
        (input.action === 'terminate' && input.stopMode === 'hard')
      )
        this.sessions.communicationState(s.id, 'paused');
      this.db
        .prepare('INSERT INTO ui_event(kind,object_id) VALUES(?,?)')
        .run('assistant-control-changed', e.id);
      return v;
    });
  }
  capture(value: ControlRecord): string[] {
    if (!['soft-stop', 'hard-stop', 'terminate'].includes(value.action)) return [];
    return this.collaborations
      .list(value.executionId)
      .filter((a) => a.sessionId && !['completed', 'terminated'].includes(a.state))
      .map(
        (a) =>
          this.request(
            value.actor.kind === 'user'
              ? { kind: 'user' }
              : { kind: 'session', sessionId: value.actor.sessionId! },
            {
              operationId: messageIdentity('assistant-control:' + value.id + ':' + a.id),
              collaborationId: a.id,
              action: value.action,
              reason: value.reason,
              content: value.content,
              stopMode: value.stopMode,
              expectedRevision: this.revision(a.id),
            },
            value.epoch,
            value.id,
          ).id,
      );
  }
  quiet(ids: string[]): boolean {
    return ids.every((id) => {
      const v = this.get(id),
        latest = this.current(v.collaborationId);
      return !!latest && ['stopped', 'terminated'].includes(latest.status);
    });
  }
  receipt(id: string, kind: 'goal' | 'cancel', raw: ControlReceipt): void {
    const receipt = receiptSchema.parse(raw),
      v = this.get(id);
    v[kind] = receipt;
    this.save(v);
  }
  observe(id: string, raw: StoppedObservation): AssistantControlRecord {
    const o = stoppedObservationSchema.parse(raw);
    return transaction(this.db, () => {
      const v = this.get(id);
      v.observations.push(o);
      v.observation = o;
      if (!this.latest(v)) return this.save(v);
      const stopped =
        (v.stopMode === 'hard' || v.report !== null || !v.handoffRequired) &&
        ['confirmed', 'unnecessary'].includes(v.goal?.state ?? '') &&
        (v.stopMode === 'soft' || ['confirmed', 'unnecessary'].includes(v.cancel?.state ?? '')) &&
        o.agentIdle === true &&
        o.inFlightTools === false &&
        o.filesStable === true &&
        o.processesComplete &&
        o.jobObservations.every(
          (j) => j.externalStatus === 'gone' && nativeTerminalJobStatuses.includes(j.nativeStatus),
        );
      v.status = stopped
        ? 'stopped'
        : o.agentIdle === false ||
            o.filesStable === false ||
            o.jobObservations.some((j) => j.externalStatus === 'running')
          ? 'checking'
          : 'unknown';
      if (stopped) {
        const s = this.sessions.get(v.sessionId);
        if (s.communicationState === 'active') this.sessions.communicationState(s.id, 'paused');
      }
      return this.save(v);
    });
  }
  resumed(id: string, snapshot: unknown): AssistantControlRecord {
    return transaction(this.db, () => {
      const v = this.get(id),
        a = this.collaborations.get(v.collaborationId),
        e = this.executions.get(v.executionId);
      if (
        !this.latest(v) ||
        v.action !== 'resume' ||
        v.status !== 'requested' ||
        ['completed', 'terminated'].includes(a.state) ||
        e.lifecycleState !== 'active' ||
        e.writeOccupancy !== 'held' ||
        e.hostEpoch !== v.epoch ||
        e.failure ||
        this.sessions.get(v.parentSessionId).communicationState !== 'active'
      )
        throw new ProjectError('ASSISTANT_RESUME_CHANGED', '原主辅现场或最新控制变化，不恢复');
      v.resumeSnapshot = snapshot;
      v.status = 'resumed';
      this.collaborations.activateAfterControl(v.collaborationId);
      this.sessions.communicationState(v.sessionId, 'active');
      return this.save(v);
    });
  }
  beginResume(id: string, snapshot: unknown): AssistantControlRecord {
    const v = this.get(id),
      e = this.executions.get(v.executionId);
    if (
      !this.latest(v) ||
      v.action !== 'resume' ||
      e.lifecycleState !== 'active' ||
      e.writeOccupancy !== 'held' ||
      this.sessions.get(v.parentSessionId).communicationState !== 'active'
    )
      throw new ProjectError('ASSISTANT_RESUME_CHANGED', '原主辅控制已变化');
    v.resumeSnapshot ??= snapshot;
    v.status = 'requested';
    v.error = null;
    this.sessions.communicationState(v.sessionId, 'active');
    return this.save(v);
  }
  access(collaborationId: string) {
    const v = this.current(collaborationId);
    if (!v || (v.action === 'resume' && v.status === 'resumed'))
      return { blocked: false, shutdownOnly: false, controlId: null };
    const shutdownOnly =
      v.action !== 'resume' && v.stopMode === 'soft' && ['delivered', 'handoff'].includes(v.status);
    return { blocked: !shutdownOnly, shutdownOnly, controlId: v.id };
  }
  checking(id: string): void {
    const v = this.get(id);
    if (!this.latest(v)) throw new ProjectError('ASSISTANT_CONTROL_SUPERSEDED', '辅助控制已被取代');
    v.status = 'checking';
    this.save(v);
  }
  delivered(id: string): AssistantControlRecord {
    const v = this.get(id);
    if (!this.latest(v) || v.stopMode !== 'soft' || v.action === 'resume')
      throw new ProjectError('ASSISTANT_CONTROL_CHANGED', '原软停止已被更新控制取代');
    if (v.status !== 'stopped' && v.status !== 'terminated') {
      v.status = 'delivered';
      v.error = null;
      this.save(v);
    }
    return v;
  }
  handoff(id: string, sessionId: string, content: string): AssistantControlRecord {
    return transaction(this.db, () => {
      const v = this.get(id);
      if (
        !this.latest(v) ||
        v.sessionId !== sessionId ||
        v.stopMode !== 'soft' ||
        v.action === 'resume' ||
        !['delivered', 'handoff'].includes(v.status)
      )
        throw new ProjectError('ASSISTANT_HANDOFF_SOURCE', '回报不属于当前实际辅助的软停止要求');
      if (v.report) {
        if (v.report.content !== content)
          throw new ProjectError('ASSISTANT_HANDOFF_CONFLICT', '同一软停止回报不能替换正文');
        return v;
      }
      v.report = { sessionId, content, at: now() };
      v.status = 'handoff';
      this.sessions.communicationState(sessionId, 'paused');
      return this.save(v);
    });
  }
  problem(id: string, note: string): AssistantControlRecord {
    const v = this.get(id);
    v.error = note;
    if (this.latest(v)) {
      v.status = 'unknown';
      if (v.action === 'resume') this.sessions.communicationState(v.sessionId, 'paused');
    }
    return this.save(v);
  }
  jobKill(id: string, jobId: string, raw: ControlReceipt): void {
    const v = this.get(id),
      receipt = receiptSchema.parse(raw),
      old = v.jobKills.find((j) => j.jobId === jobId);
    if (old) old.receipt = receipt;
    else v.jobKills.push({ jobId, receipt });
    this.save(v);
  }
  retry(
    actor: WorkbenchActor,
    id: string,
    expectedRevision: number,
    operationId: string,
    reason: string,
  ): AssistantControlRecord {
    return transaction(this.db, () => {
      const v = this.get(id),
        author = this.wb.author(actor);
      if (!this.latest(v) || v.revision !== expectedRevision)
        throw new ProjectError('STALE_ASSISTANT_CONTROL', '辅助控制修订已变化');
      if (actor.kind !== 'user' && author.roleType !== 'supervisor') {
        if (actor.sessionId !== v.parentSessionId || !v.parentControlId || v.blockedBy.length)
          throw new ProjectError('ASSISTANT_CONTROL_FORBIDDEN', '仅有权入口可补核当前辅助控制');
        this.collaborations.requireMain(actor.sessionId);
      }
      if (['resumed', 'terminated'].includes(v.status)) return v;
      const value = { id, operationId, expectedRevision, reason, author },
        key = 'assistant-control-retry:' + operationId;
      const prior = this.db
        .prepare(
          "SELECT data FROM workbench_revision WHERE kind='assistant-control-retry' AND object_id=?",
        )
        .get(key);
      if (prior) {
        if (JSON.parse(String(prior.data)).request !== JSON.stringify(value))
          throw new ProjectError('ASSISTANT_CONTROL_CONFLICT', '补核操作来源或内容冲突');
      } else
        this.db
          .prepare('INSERT INTO workbench_revision(kind,object_id,data) VALUES(?,?,?)')
          .run(
            'assistant-control-retry',
            key,
            JSON.stringify({ request: JSON.stringify(value), value, at: now() }),
          );
      return v;
    });
  }
  terminateConfirmed(id: string): AssistantControlRecord {
    return transaction(this.db, () => {
      const v = this.get(id);
      if (!this.latest(v) || v.action !== 'terminate' || v.status !== 'stopped')
        throw new ProjectError('ASSISTANT_TERMINATE_NOT_QUIET', '辅助终止尚未核清，保留未知');
      if (this.collaborations.get(v.collaborationId).state === 'completed') return v;
      v.status = 'terminated';
      this.sessions.communicationState(v.sessionId, 'terminated');
      this.save(v);
      this.collaborations.controlOutcome(v.collaborationId, v.id, 'terminated');
      return v;
    });
  }
}
