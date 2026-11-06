import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { WorkbenchActor } from '../contracts/workbench.ts';
import {
  reviewConfigurationSchema,
  completionSchema,
  reviewSchema,
  reviewRetrySchema,
} from '../contracts/completion.ts';
import type { CompletionRecord, ReviewRecord } from '../contracts/completion.ts';
import type { ActionProgress } from '../contracts/completion.ts';
import type { NativeGoalView } from '../contracts/execution.ts';
import { nativeGoalSchema } from '../contracts/execution.ts';
import type { StoppedObservation, OwnedJob } from '../contracts/controls.ts';
import {
  ownedJobSchema,
  stoppedObservationSchema,
  nativeTerminalJobStatuses,
} from '../contracts/controls.ts';
import type { NativeEvent } from '../host/native.ts';
import type { TicketExecutionScope } from './workbench-catalog.ts';
import { deliveryVersionInputSchema } from '../contracts/versions.ts';
import type { ExecutionCatalog } from './execution-catalog.ts';
import type { WorkbenchCatalog } from './workbench-catalog.ts';
import type { SessionCatalog } from './session-catalog.ts';
import type { RoleCatalog } from './role-catalog.ts';
import type { VersionCatalog } from './version-catalog.ts';
import type { ControlCatalog } from './control-catalog.ts';
import { transaction } from './transaction.ts';
import { ProjectError } from '../services/errors.ts';
const now = () => new Date().toISOString(),
  hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pending = () => ({
  state: 'pending' as const,
  note: '尚未执行，不以保存记录冒充接纳',
  at: now(),
});
export function migrateCompletions(db: DatabaseSync) {
  db.exec(`CREATE TABLE completion(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,execution_id TEXT NOT NULL REFERENCES execution(id),version_id TEXT NOT NULL UNIQUE REFERENCES execution_version(id),review_id TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
CREATE TABLE review(id TEXT PRIMARY KEY,completion_id TEXT NOT NULL UNIQUE REFERENCES completion(id),execution_id TEXT NOT NULL REFERENCES execution(id),version_id TEXT NOT NULL UNIQUE REFERENCES execution_version(id),data TEXT NOT NULL);
CREATE TABLE review_setting(scope TEXT PRIMARY KEY,data TEXT NOT NULL);
CREATE TABLE review_command(operation_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,data TEXT NOT NULL);
PRAGMA user_version=9;`);
}
/** Formal completion owns the only transition into a version-bound review and durable wait. */
export class ReviewCatalog {
  private readonly db: DatabaseSync;
  private readonly executions: ExecutionCatalog;
  private readonly wb: WorkbenchCatalog;
  private readonly sessions: SessionCatalog;
  private readonly roles: RoleCatalog;
  private readonly versions: VersionCatalog;
  private readonly controls: ControlCatalog;
  constructor(
    db: DatabaseSync,
    executions: ExecutionCatalog,
    wb: WorkbenchCatalog,
    sessions: SessionCatalog,
    roles: RoleCatalog,
    versions: VersionCatalog,
    controls: ControlCatalog,
  ) {
    this.db = db;
    this.executions = executions;
    this.wb = wb;
    this.sessions = sessions;
    this.roles = roles;
    this.versions = versions;
    this.controls = controls;
  }
  configuration(ticketId?: string): {
    scope: string;
    reviewerRoleId: string | null;
    inherit: boolean;
  } {
    const ticket = ticketId ? this.wb.getTicket(ticketId) : null,
      key = ticket ? 'ticket:' + ticket.id : 'project',
      row = this.db.prepare('SELECT data FROM review_setting WHERE scope=?').get(key);
    if (row)
      return JSON.parse(String(row.data)) as {
        scope: string;
        reviewerRoleId: string | null;
        inherit: boolean;
      };
    if (ticket) return { ...this.configuration(), scope: key, inherit: true };
    return { scope: key, reviewerRoleId: null, inherit: false };
  }
  configure(actor: WorkbenchActor, raw: unknown) {
    const input = reviewConfigurationSchema.parse(raw),
      author = this.wb.author(actor),
      requestHash = hash({ input, author });
    if (
      author.kind !== 'user' &&
      (author.roleType !== 'supervisor' ||
        this.sessions.get(actor.kind === 'session' ? actor.sessionId : '').communicationState !==
          'active')
    )
      throw new ProjectError('REVIEW_MANAGER_REQUIRED', '默认和逐票审阅安排仅用户或实际主管可维护');
    return transaction(this.db, () => {
      const previous = this.db
        .prepare('SELECT request_hash,data FROM review_command WHERE operation_id=?')
        .get(input.operationId);
      if (previous) {
        if (previous.request_hash !== requestHash)
          throw new ProjectError(
            'REVIEW_CONFIGURATION_CONFLICT',
            '操作身份已存在，审阅配置正文或来源不同',
          );
        return JSON.parse(String(previous.data));
      }
      if (input.inherit && !input.ticketId)
        throw new ProjectError('REVIEW_CONFIGURATION_INVALID', '项目默认配置没有上级可继承');
      const role = input.reviewerRoleId
        ? this.roles.list().find((role) => role.id === input.reviewerRoleId)
        : null;
      if (input.reviewerRoleId && role?.type !== 'reviewer')
        throw new ProjectError('REVIEW_ROLE_REQUIRED', '请选择已登记的审阅类型角色，作者不能自审');
      const ticket = input.ticketId ? this.wb.getTicket(input.ticketId) : null,
        scope = ticket ? 'ticket:' + ticket.id : 'project';
      if (input.inherit) this.db.prepare('DELETE FROM review_setting WHERE scope=?').run(scope);
      else
        this.db
          .prepare(
            'INSERT INTO review_setting(scope,data) VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET data=excluded.data',
          )
          .run(
            scope,
            JSON.stringify({
              scope,
              reviewerRoleId: input.reviewerRoleId,
              inherit: false,
              author,
              at: now(),
            }),
          );
      const result = this.configuration(ticket?.id);
      this.db
        .prepare('INSERT INTO review_command(operation_id,request_hash,data) VALUES(?,?,?)')
        .run(input.operationId, requestHash, JSON.stringify(result));
      return result;
    });
  }
  get(id: string): ReviewRecord {
    const row = this.db.prepare('SELECT data FROM review WHERE id=?').get(id);
    if (!row) throw new ProjectError('REVIEW_NOT_FOUND', '正式审核记录不存在');
    return reviewSchema.parse(JSON.parse(String(row.data)));
  }
  completion(id: string): CompletionRecord {
    const row = this.db.prepare('SELECT data FROM completion WHERE id=?').get(id);
    if (!row) throw new ProjectError('COMPLETION_NOT_FOUND', '正式交回不存在');
    return completionSchema.parse(JSON.parse(String(row.data)));
  }
  byOperation(operationId: string): CompletionRecord | undefined {
    const row = this.db.prepare('SELECT id FROM completion WHERE operation_id=?').get(operationId);
    return row ? this.completion(String(row.id)) : undefined;
  }
  list(executionId?: string): ReviewRecord[] {
    if (executionId) this.executions.get(executionId);
    const rows = executionId
      ? this.db
          .prepare('SELECT id FROM review WHERE execution_id=? ORDER BY rowid')
          .all(executionId)
      : this.db.prepare('SELECT id FROM review ORDER BY rowid').all();
    return rows.map((row) => this.get(String(row.id)));
  }
  complete(sessionId: string, raw: unknown): CompletionRecord {
    const input = deliveryVersionInputSchema.parse(raw),
      actor = { kind: 'session' as const, sessionId },
      author = this.wb.author(actor),
      requestHash = hash({ sessionId, input });
    return transaction(this.db, () => {
      const prior = this.db
        .prepare('SELECT id,request_hash FROM completion WHERE operation_id=?')
        .get(input.operationId);
      if (prior) {
        if (prior.request_hash !== requestHash)
          throw new ProjectError(
            'COMPLETION_CONFLICT',
            '操作身份已存在，但完成交回正文或实际来源不同',
          );
        return this.completion(String(prior.id));
      }
      const execution = this.executions.currentForSession(sessionId);
      if (!execution)
        throw new ProjectError('COMPLETION_EXECUTION_REQUIRED', '当前会话没有原正式主执行');
      if (execution.lifecycleState === 'waiting')
        throw new ProjectError(
          'COMPLETION_WAITING',
          '原执行正在等待独审，不能重复形成新的有效交付',
        );
      if (
        !['developer', 'investigator'].includes(author.roleType ?? '') ||
        execution.sessionId !== sessionId ||
        execution.nativeSessionId !== this.sessions.get(sessionId).nativeSessionId ||
        execution.lifecycleState !== 'active' ||
        execution.failure ||
        !execution.goalId ||
        !execution.goalDurableAt ||
        !execution.firstRequestId
      )
        throw new ProjectError('COMPLETION_NOT_READY', '只有有效原主执行在实际开始后才能完成交回');
      const control = this.controls.activeControl(execution.id);
      if (control && !(control.action === 'resume' && control.status === 'resumed'))
        throw new ProjectError('COMPLETION_CONTROLLED', '已有控制优先，完成Chat不能解除暂停或终止');
      const ticket = this.wb.getTicket(execution.ticketId);
      if (ticket.state !== 'in-progress' || ticket.currentExecution !== execution.id)
        throw new ProjectError(
          'COMPLETION_TICKET_MISMATCH',
          '原票状态或当前执行不对应，未固定其他工作',
        );
      const version = this.versions.delivery(actor, execution.id, input),
        setting = this.configuration(ticket.id),
        selected = setting.reviewerRoleId
          ? this.roles.list().find((role) => role.id === setting.reviewerRoleId)
          : null,
        reviewerRole =
          selected?.type === 'reviewer' && selected.id !== execution.roleId ? selected : null;
      const value: CompletionRecord = {
        id: randomUUID(),
        operationId: input.operationId,
        executionId: execution.id,
        ticketId: ticket.id,
        sourceSessionId: sessionId,
        goalId: execution.goalId,
        versionId: version.id,
        reviewId: randomUUID(),
        taskId: randomUUID(),
        input,
        createdAt: now(),
      };
      const review: ReviewRecord = {
        id: value.reviewId,
        completionId: value.id,
        executionId: execution.id,
        ticketId: ticket.id,
        versionId: version.id,
        reviewerRole,
        status: reviewerRole ? 'pending' : 'missing-reviewer',
        sessionId: null,
        nativeSessionId: null,
        goalId: null,
        goalSnapshot: null,
        startBoundarySeq: null,
        quiet: null,
        jobs: [],
        control: null,
        stopObservation: null,
        closure: null,
        wait: { state: 'registered', resultId: null, at: now() },
        materialPath: null,
        workspaceCheck: null,
        authorPause: pending(),
        create: pending(),
        start: pending(),
        notifications: execution.managerSessionIds.map((targetSessionId) => ({
          targetSessionId,
          messageId: randomUUID(),
          content: `MAT完成交回已保存。票据 ${ticket.code}；执行 ${execution.id}；固定版本 ${version.id}；审核 ${value.reviewId}；主管待处理 ${value.taskId}。原执行等待独审，不接下一票。此为平台通知，不代表通过、结票、恢复或新派工；简报、证据与审核进展从正式记录按需读取。`,
          progress: pending(),
        })),
        reason: reviewerRole
          ? '等待原执行挂起和独立审核启动'
          : '没有合格非作者审阅人，交主管安排；不自审兜底',
        createdAt: now(),
        updatedAt: now(),
      };
      this.db
        .prepare(
          'INSERT INTO completion(id,operation_id,request_hash,execution_id,version_id,review_id,data) VALUES(?,?,?,?,?,?,?)',
        )
        .run(
          value.id,
          value.operationId,
          requestHash,
          value.executionId,
          value.versionId,
          value.reviewId,
          JSON.stringify(completionSchema.parse(value)),
        );
      this.db
        .prepare(
          'INSERT INTO review(id,completion_id,execution_id,version_id,data) VALUES(?,?,?,?,?)',
        )
        .run(
          review.id,
          value.id,
          execution.id,
          version.id,
          JSON.stringify(reviewSchema.parse(review)),
        );
      this.wb.reviewSubmitted(actor, ticket.id, execution.id, review.id, version.id, value.taskId);
      this.executions.waitForReview(execution.id, review.id);
      return value;
    });
  }
  private save(value: ReviewRecord): ReviewRecord {
    value.updatedAt = now();
    const valid = reviewSchema.parse(value);
    this.db.prepare('UPDATE review SET data=? WHERE id=?').run(JSON.stringify(valid), valid.id);
    this.db
      .prepare('INSERT INTO ui_event(kind,object_id) VALUES(?,?)')
      .run('review-changed', valid.id);
    return valid;
  }
  current(id: string, requireRunning = true): ReviewRecord {
    const value = this.get(id),
      execution = this.executions.get(value.executionId),
      ticket = this.wb.getTicket(value.ticketId);
    if (
      ['decided', 'cancelled'].includes(value.status) ||
      execution.waitingReviewId !== id ||
      execution.lifecycleState !== 'waiting' ||
      ticket.currentExecution !== execution.id ||
      ticket.state !== 'awaiting-review'
    )
      throw new ProjectError('REVIEW_NOT_CURRENT', '原审核已不处于当前等待，不复活旧结果');
    const control = this.controls.activeControl(execution.id);
    if (control && !(control.action === 'resume' && control.status === 'resumed'))
      throw new ProjectError('REVIEW_CONTROLLED', '原执行已有有权控制，不继续自动派审');
    if (requireRunning) this.controls.requireDispatch();
    return value;
  }
  forSession(sessionId: string): ReviewRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT id FROM review WHERE json_extract(data,'$.sessionId')=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(sessionId);
    return row ? this.get(String(row.id)) : undefined;
  }
  retry(actor: WorkbenchActor, id: string, raw: unknown) {
    const input = reviewRetrySchema.parse(raw),
      author = this.wb.author(actor),
      requestHash = hash({ action: 'retry', id, input, author });
    if (
      author.kind !== 'user' &&
      (author.roleType !== 'supervisor' ||
        this.sessions.get(actor.kind === 'session' ? actor.sessionId : '').communicationState !==
          'active')
    )
      throw new ProjectError('REVIEW_MANAGER_REQUIRED', '仅用户或实际主管可显式接续审核');
    return transaction(this.db, () => {
      const prior = this.db
        .prepare('SELECT request_hash FROM review_command WHERE operation_id=?')
        .get(input.operationId);
      if (prior) {
        if (prior.request_hash !== requestHash)
          throw new ProjectError('REVIEW_RETRY_CONFLICT', '重试操作来源或正文不同');
        return { review: this.get(id), enqueue: false };
      }
      const value = this.current(id);
      if (!['missing-reviewer', 'unknown', 'failed', 'pending'].includes(value.status))
        throw new ProjectError('REVIEW_RETRY_NOT_NEEDED', '审核已启动，不重复创建或追加目标');
      if (value.sessionId && !value.nativeSessionId)
        throw new ProjectError(
          'REVIEW_NATIVE_BINDING_UNKNOWN',
          '原审核已有预留，原生接纳未知，先核对原会话，不换身份',
        );
      if (!value.sessionId) {
        const roleId = this.configuration(value.ticketId).reviewerRoleId;
        value.reviewerRole =
          this.roles.list().find((role) => role.id === roleId && role.type === 'reviewer') ?? null;
      }
      value.status = value.reviewerRole
        ? value.sessionId
          ? 'starting'
          : 'pending'
        : 'missing-reviewer';
      value.control = null;
      value.stopObservation = null;
      value.reason = input.reason;
      this.save(value);
      this.db
        .prepare('INSERT INTO review_command(operation_id,request_hash,data) VALUES(?,?,?)')
        .run(input.operationId, requestHash, JSON.stringify({ reviewId: id }));
      return { review: value, enqueue: true };
    });
  }
  scopeForSession(sessionId: string): TicketExecutionScope | undefined {
    const value = this.forSession(sessionId);
    if (!value) return undefined;
    try {
      this.current(value.id, false);
    } catch {
      return undefined;
    }
    return {
      ticketId: value.ticketId,
      executionId: value.executionId,
      kind: 'review',
      reviewId: value.id,
      checklistIds: [],
      allowWrite: false,
      ...(value.materialPath ? { cwd: value.materialPath } : {}),
    };
  }
  recordJob(sessionId: string, event: NativeEvent): void {
    if (!['job/registered', 'job/settled'].includes(event.type)) return;
    transaction(this.db, () => {
      const value = this.forSession(sessionId);
      if (!value || value.startBoundarySeq === null || event.seq <= value.startBoundarySeq) return;
      if (
        event.data.owner !== value.nativeSessionId ||
        this.sessions.get(sessionId).nativeSessionId !== value.nativeSessionId
      )
        throw new ProjectError('REVIEW_JOB_OWNER', '审阅作业owner不属于实际审阅会话');
      const id = String(event.data.jobId),
        previous = value.jobs.find((job) => job.id === id);
      if (!id || id === 'undefined')
        throw new ProjectError('REVIEW_JOB_ID', '审阅作业没有稳定身份');
      if (event.type === 'job/settled' && !previous)
        throw new ProjectError('REVIEW_JOB_SOURCE', '审阅结束作业缺登记来源');
      const job: OwnedJob = previous ?? {
        id,
        executionId: value.executionId,
        sessionId,
        nativeOwner: value.nativeSessionId!,
        kind: String(event.data.kind),
        label: String(event.data.label),
        startedAt: Number(event.data.startedAt),
        registeredSeq: event.seq,
        settledSeq: null,
        status: 'running',
        producerReported: null,
        settlement: null,
        processWitness: null,
        toolCallId:
          typeof (event.data.toolCall as { callId?: unknown } | undefined)?.callId === 'string'
            ? (event.data.toolCall as { callId: string }).callId
            : null,
        managedRanges: [],
        epoch: this.executions.get(value.executionId).hostEpoch,
        updatedAt: now(),
      };
      if (job.nativeOwner !== event.data.owner || job.startedAt !== Number(event.data.startedAt))
        throw new ProjectError('REVIEW_JOB_CONFLICT', '审阅作业来源变化');
      if (event.type === 'job/registered' && previous && previous.registeredSeq !== event.seq)
        throw new ProjectError('REVIEW_JOB_CONFLICT', '审阅作业登记身份冲突');
      if (event.type === 'job/settled') {
        if (job.settledSeq !== null && job.settledSeq !== event.seq)
          throw new ProjectError('REVIEW_JOB_CONFLICT', '审阅作业结束身份冲突');
        job.settledSeq = event.seq;
        job.status = String(event.data.status);
        job.producerReported =
          typeof event.data.producerReported === 'boolean' ? event.data.producerReported : null;
        job.settlement = event.data;
      }
      job.updatedAt = now();
      if (!previous) value.jobs.push(ownedJobSchema.parse(job));
      if (value.closure)
        value.closure = {
          state: 'unknown',
          note: '收尾后收到真实作业事实，重新核对，不复用旧停稳',
          at: now(),
        };
      if (value.control?.state === 'confirmed')
        value.control = {
          state: 'unknown',
          note: '收到后续真实作业事实，原停稳回执重新核对',
          at: now(),
        };
      this.save(value);
    });
  }
  saveWitness(id: string, jobId: string, witness: unknown): void {
    transaction(this.db, () => {
      const value = this.get(id),
        job = value.jobs.find((job) => job.id === jobId);
      if (!job) throw new ProjectError('REVIEW_JOB_NOT_FOUND', '审核作业不存在');
      job.processWitness = witness;
      this.save(value);
    });
  }
  saveManagedRange(
    sessionId: string,
    callId: string,
    fact: OwnedJob['managedRanges'][number],
  ): void {
    transaction(this.db, () => {
      const value = this.forSession(sessionId);
      if (!value) return;
      let changed = false;
      for (const job of value.jobs)
        if (job.toolCallId === callId) {
          const index = job.managedRanges.findIndex((range) => range.id === fact.id);
          if (index < 0) job.managedRanges.push(fact);
          else job.managedRanges[index] = fact;
          changed = true;
        }
      if (changed) {
        if (value.closure)
          value.closure = { state: 'unknown', note: '收尾后受管范围变化，重新核对', at: now() };
        if (value.control?.state === 'confirmed')
          value.control = {
            state: 'unknown',
            note: '受管范围事实变化，重新核对审核停稳',
            at: now(),
          };
        this.save(value);
      }
    });
  }
  controlled(id: string, note: string, observation?: StoppedObservation): ReviewRecord {
    return transaction(this.db, () => {
      const value = this.get(id);
      value.stopObservation = observation ? stoppedObservationSchema.parse(observation) : null;
      const jobs = value.jobs,
        proof = value.stopObservation;
      const quiet =
        !!proof &&
        proof.agentIdle &&
        !proof.inFlightTools &&
        proof.filesStable === true &&
        proof.processesComplete &&
        proof.jobObservations.length === jobs.length &&
        jobs.every((job) =>
          proof.jobObservations.some(
            (seen) =>
              seen.jobId === job.id &&
              seen.externalStatus === 'gone' &&
              nativeTerminalJobStatuses.includes(seen.nativeStatus),
          ),
        );
      value.control = { state: quiet ? 'confirmed' : 'unknown', note, at: now() };
      if (!['decided', 'cancelled'].includes(value.status)) value.status = 'unknown';
      value.reason = note;
      return this.save(value);
    });
  }
  closeAfterResult(id: string, goalId: string, nativeSessionId: string): ReviewRecord {
    return transaction(this.db, () => {
      const value = this.get(id);
      if (
        value.status !== 'decided' ||
        !value.wait.resultId ||
        value.goalId !== goalId ||
        value.nativeSessionId !== nativeSessionId ||
        value.control?.state !== 'confirmed' ||
        !value.stopObservation?.processesComplete
      )
        throw new ProjectError(
          'REVIEW_CLOSURE_UNCONFIRMED',
          '指定审核原Goal及自身范围尚未核清，不收尾',
        );
      value.closure = {
        state: 'confirmed',
        note: '本次独审已收尾，原Goal暂停并撤销续轮供历史回查；不伪造原生Goal完成',
        at: now(),
      };
      if (value.sessionId) this.sessions.communicationState(value.sessionId, 'paused');
      return this.save(value);
    });
  }
  authorPaused(
    id: string,
    goalId: string,
    nativeSessionId: string,
    durable: boolean,
    observation: StoppedObservation,
  ): ReviewRecord {
    return transaction(this.db, () => {
      const value = this.current(id, false),
        execution = this.executions.get(value.executionId),
        completion = this.completion(value.completionId);
      if (goalId !== completion.goalId || nativeSessionId !== execution.nativeSessionId)
        throw new ProjectError(
          'REVIEW_AUTHOR_BINDING_MISMATCH',
          '挂起证明不是原执行的原Goal和原生会话',
        );
      const quiet =
        durable &&
        observation.agentIdle &&
        !observation.inFlightTools &&
        observation.filesStable === true &&
        observation.processesComplete &&
        observation.jobObservations.length === this.controls.jobs(execution.id).length &&
        new Set(observation.jobObservations.map((job) => job.jobId)).size ===
          observation.jobObservations.length &&
        this.controls
          .jobs(execution.id)
          .every(
            (job) =>
              job.sessionId === completion.sourceSessionId &&
              job.nativeOwner === nativeSessionId &&
              observation.jobObservations.some(
                (seen) =>
                  seen.jobId === job.id &&
                  seen.externalStatus === 'gone' &&
                  nativeTerminalJobStatuses.includes(seen.nativeStatus),
              ),
          );
      value.quiet = observation;
      value.authorPause = {
        state: quiet ? 'confirmed' : 'unknown',
        note: quiet
          ? '原Goal已挂起并持久化，原执行与后台及声明范围均核对'
          : '原执行挂起、持久化或独立停稳尚未核实，未启动审核',
        at: now(),
      };
      if (!quiet) {
        value.status = 'unknown';
        value.reason = value.authorPause.note;
      } else if (value.status === 'unknown' && !value.sessionId)
        value.status = value.reviewerRole ? 'pending' : 'missing-reviewer';
      return this.save(value);
    });
  }
  sessionReserved(id: string, sessionId: string): ReviewRecord {
    return transaction(this.db, () => {
      const value = this.current(id),
        session = this.sessions.get(sessionId),
        completion = this.completion(value.completionId);
      if (value.authorPause.state !== 'confirmed')
        throw new ProjectError('REVIEW_AUTHOR_NOT_QUIET', '原执行尚未核实挂起，不创建独审');
      if (
        !value.reviewerRole ||
        session.roleId !== value.reviewerRole.id ||
        session.roleType !== 'reviewer' ||
        sessionId === completion.sourceSessionId
      )
        throw new ProjectError(
          'REVIEW_INDEPENDENCE_REQUIRED',
          '审核只能绑定已指定的非作者审阅会话',
        );
      if (value.sessionId && value.sessionId !== sessionId)
        throw new ProjectError('REVIEW_SESSION_EXISTS', '已经预留原审核会话，未知结果不换会话');
      if (value.sessionId === sessionId) return value;
      if (
        session.status !== 'creating' ||
        session.nativeSessionId !== null ||
        this.forSession(sessionId)
      )
        throw new ProjectError(
          'REVIEW_FRESH_SESSION_REQUIRED',
          '独审必须预留新的空上下文会话，不能绑定旧会话',
        );
      value.sessionId = sessionId;
      value.status = 'creating';
      value.create = { state: 'reserved', note: '逻辑会话先保存，尚未冒充原生接纳', at: now() };
      return this.save(value);
    });
  }
  sessionPrepared(id: string, sessionId: string, nativeSessionId: string): ReviewRecord {
    return transaction(this.db, () => {
      const value = this.current(id),
        session = this.sessions.get(sessionId);
      if (
        value.sessionId !== sessionId ||
        session.status !== 'bound' ||
        session.nativeSessionId !== nativeSessionId
      )
        throw new ProjectError('REVIEW_SESSION_MISMATCH', '原生审核会话未与预留逻辑会话实际绑定');
      if (value.nativeSessionId && value.nativeSessionId !== nativeSessionId)
        throw new ProjectError('REVIEW_SESSION_MISMATCH', '不能替换既有原生审核会话');
      value.nativeSessionId = nativeSessionId;
      value.status = 'starting';
      value.create = {
        state: 'confirmed',
        note: '实际原生审核会话已绑定；尚未创建审核Goal',
        at: now(),
      };
      return this.save(value);
    });
  }
  materialPrepared(id: string): ReviewRecord {
    return transaction(this.db, () => {
      const value = this.current(id),
        domain = this.wb
          .materialDomains(value.ticketId)
          .find(
            (domain) =>
              domain.kind === 'review' &&
              domain.referenceId === id &&
              domain.sessionId === value.sessionId,
          );
      if (!domain?.available)
        throw new ProjectError('REVIEW_MATERIAL_MISSING', '没有实际审核会话自己的材料子域');
      value.materialPath = domain.path;
      return this.save(value);
    });
  }
  goalLinked(id: string, raw: NativeGoalView, boundary: number): ReviewRecord {
    return transaction(this.db, () => {
      const value = this.current(id),
        goal = nativeGoalSchema.parse(raw);
      if (!value.nativeSessionId || !value.materialPath)
        throw new ProjectError('REVIEW_GOAL_UNPREPARED', '审核会话及自身材料尚未准备');
      if (value.goalId && value.goalId !== goal.id)
        throw new ProjectError('REVIEW_GOAL_EXISTS', '审核Goal身份不替换');
      value.goalId = goal.id;
      value.goalSnapshot = goal;
      value.startBoundarySeq = boundary;
      value.start = {
        state: 'prepared',
        note: '已取得原生Goal身份，持久化及实际请求另验',
        at: now(),
      };
      return this.save(value);
    });
  }
  startDurable(
    id: string,
    durable: boolean,
    check: { matches: boolean | null; error: string | null },
  ): ReviewRecord {
    return transaction(this.db, () => {
      const value = this.current(id);
      if (!value.goalId) throw new ProjectError('REVIEW_GOAL_MISSING', '没有实际审核Goal身份');
      value.workspaceCheck = check;
      value.start = {
        state: durable ? 'confirmed' : 'unknown',
        note: durable
          ? '审核Goal持久接纳；当前匹配状态随固定版本明确提供'
          : '审核Goal持久化未知，不另开替代',
        at: now(),
      };
      value.status = durable ? 'active' : 'unknown';
      return this.save(value);
    });
  }
  problem(id: string, note: string, unknown = true): ReviewRecord {
    return transaction(this.db, () => {
      const value = this.get(id);
      if (['decided', 'cancelled'].includes(value.status)) return value;
      value.status = unknown ? 'unknown' : 'failed';
      value.reason = note;
      if (value.authorPause.state === 'pending')
        value.authorPause = { state: 'unknown', note, at: now() };
      return this.save(value);
    });
  }
  notified(id: string, targetSessionId: string, progress: ActionProgress): ReviewRecord {
    return transaction(this.db, () => {
      const value = this.get(id),
        notice = value.notifications.find((notice) => notice.targetSessionId === targetSessionId);
      if (!notice)
        throw new ProjectError('REVIEW_NOTIFICATION_TARGET', '不是本次保存的主管通知对象');
      notice.progress = progress;
      return this.save(value);
    });
  }
  armWait(id: string): ReviewRecord {
    return transaction(this.db, () => {
      const saved = this.get(id);
      if (saved.wait.state === 'signalled') return saved;
      const value = this.current(id, false);
      if (value.authorPause.state !== 'confirmed')
        throw new ProjectError('REVIEW_AUTHOR_NOT_QUIET', '原执行尚未挂起，不办理等待接纳');
      value.wait = { state: 'armed', resultId: null, at: now() };
      return this.save(value);
    });
  }
  /** Internal bridge for a formally stored review result; not a model approval or resume tool. */
  decided(id: string, resultId: string): ReviewRecord {
    return transaction(this.db, () => {
      const value = this.get(id),
        result = this.db.prepare('SELECT data FROM review_result WHERE id=?').get(resultId);
      if (!result || value.wait.resultId !== resultId)
        throw new ProjectError('REVIEW_RESULT_UNCONFIRMED', '没有同次保存并触达等待的正式意见');
      const stored = JSON.parse(String(result.data)) as {
        reviewId: string;
        versionId: string;
        author: { sessionId: string };
      };
      if (
        stored.reviewId !== value.id ||
        stored.versionId !== value.versionId ||
        stored.author.sessionId !== value.sessionId
      )
        throw new ProjectError('REVIEW_RESULT_SOURCE', '正式意见未关联本次独审及版本');
      value.status = 'decided';
      return this.save(value);
    });
  }
  signalWait(
    id: string,
    reviewerSessionId: string,
    versionId: string,
    resultId: string,
  ): ReviewRecord {
    return transaction(this.db, () => {
      const value = this.get(id);
      if (
        value.sessionId !== reviewerSessionId ||
        !value.nativeSessionId ||
        value.versionId !== versionId ||
        this.sessions.get(reviewerSessionId).nativeSessionId !== value.nativeSessionId
      )
        throw new ProjectError(
          'REVIEW_RESULT_SOURCE',
          '只有指定实际审阅会话的对应版本结果可触达等待',
        );
      if (!resultId.trim())
        throw new ProjectError('REVIEW_RESULT_REQUIRED', '等待必须关联已保存的正式结果ID');
      if (value.wait.resultId) {
        if (value.wait.resultId !== resultId)
          throw new ProjectError('REVIEW_RESULT_CONFLICT', '旧等待结果不能被另一个结果覆盖');
        return value;
      }
      this.current(id, false);
      value.wait = { state: 'signalled', resultId, at: now() };
      return this.save(value);
    });
  }
}
