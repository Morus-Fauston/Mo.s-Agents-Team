import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  controlInputSchema,
  controlSchema,
  ownedJobSchema,
  projectRuntimeSchema,
  stoppedObservationSchema,
  receiptSchema,
  nativeTerminalJobStatuses,
} from '../contracts/controls.ts';
import type {
  ControlRecord,
  ControlReceipt,
  OwnedJob,
  StoppedObservation,
  ProjectRuntime,
} from '../contracts/controls.ts';
import type { WorkbenchActor } from '../contracts/workbench.ts';
import { executionSchema } from '../contracts/execution.ts';
import type { ExecutionRecord } from '../contracts/execution.ts';
import type { WorkbenchCatalog } from './workbench-catalog.ts';
import type { ExecutionCatalog } from './execution-catalog.ts';
import type { SessionCatalog } from './session-catalog.ts';
import type { NativeEvent } from '../host/native.ts';
import { transaction } from './transaction.ts';
import { ProjectError } from '../services/errors.ts';
const now = () => new Date().toISOString();
export function migrateControls(db: DatabaseSync): void {
  db.exec(`CREATE TABLE execution_control(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,execution_id TEXT NOT NULL REFERENCES execution(id),revision INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(execution_id,revision));
 CREATE TABLE execution_job(execution_id TEXT NOT NULL REFERENCES execution(id),job_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(execution_id,job_id));
 CREATE TABLE project_runtime(singleton INTEGER PRIMARY KEY CHECK(singleton=1),data TEXT NOT NULL);
 CREATE TABLE project_command(operation_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,data TEXT NOT NULL);
 PRAGMA user_version=7;`);
}
export class ControlCatalog {
  private readonly db: DatabaseSync;
  private readonly wb: WorkbenchCatalog;
  private readonly executions: ExecutionCatalog;
  private readonly sessions: SessionCatalog;
  constructor(
    db: DatabaseSync,
    wb: WorkbenchCatalog,
    executions: ExecutionCatalog,
    sessions: SessionCatalog,
  ) {
    this.db = db;
    this.wb = wb;
    this.executions = executions;
    this.sessions = sessions;
  }
  private emit(kind: string, id: string): void {
    this.db.prepare('INSERT INTO ui_event(kind,object_id) VALUES(?,?)').run(kind, id);
  }
  private saveExecution(value: ExecutionRecord): void {
    value.updatedAt = now();
    executionSchema.parse(value);
    this.db.prepare('UPDATE execution SET data=? WHERE id=?').run(JSON.stringify(value), value.id);
    this.emit('execution-changed', value.id);
  }
  private saveControl(value: ControlRecord): void {
    value.updatedAt = now();
    this.db
      .prepare('UPDATE execution_control SET data=? WHERE id=?')
      .run(JSON.stringify(value), value.id);
    this.emit('control-changed', value.executionId);
  }
  get(id: string): ControlRecord {
    const row = this.db.prepare('SELECT data FROM execution_control WHERE id=?').get(id);
    if (!row) throw new ProjectError('CONTROL_NOT_FOUND', '控制请求不存在');
    return controlSchema.parse(JSON.parse(String(row.data)));
  }
  list(executionId: string): ControlRecord[] {
    this.executions.get(executionId);
    return this.db
      .prepare('SELECT data FROM execution_control WHERE execution_id=? ORDER BY revision')
      .all(executionId)
      .map((row) => controlSchema.parse(JSON.parse(String(row.data))));
  }
  revision(executionId: string): number {
    return Number(
      this.db
        .prepare(
          'SELECT COALESCE(MAX(revision),0) AS revision FROM execution_control WHERE execution_id=?',
        )
        .get(executionId)?.revision,
    );
  }
  activeControl(executionId: string): ControlRecord | undefined {
    return this.list(executionId).findLast((value) => value.action !== 'reconcile');
  }
  handoff(sessionId: string, id: string, content: string, messageIds: string[]): ControlRecord {
    return transaction(this.db, () => {
      const value = this.get(id),
        execution = this.executions.get(value.executionId);
      if (execution.sessionId !== sessionId)
        throw new ProjectError('HANDOFF_CALLER_MISMATCH', '挂起回报不属于本次真实执行会话');
      if (
        this.activeControl(execution.id)?.id !== id ||
        value.stopMode !== 'soft' ||
        !['soft-stop', 'terminate'].includes(value.action)
      )
        throw new ProjectError(
          'SOFT_STOP_REQUIRED',
          '没有本次尚有效的软停止要求，不能以普通回复代办',
        );
      if (!content.trim())
        throw new ProjectError('HANDOFF_REQUIRED', '挂起回报须说明已保存内容、后台状态和恢复位置');
      if (value.report) {
        if (value.report.content !== content)
          throw new ProjectError('HANDOFF_CONFLICT', '本次挂起回报已经保存，正文变化须另作说明');
        return value;
      }
      value.report = { sessionId, content, messageIds, at: now() };
      value.status = 'handoff';
      this.saveControl(value);
      return value;
    });
  }
  handoffPaused(id: string): void {
    transaction(this.db, () => {
      const value = this.get(id),
        execution = this.executions.get(value.executionId);
      if (!value.report || this.activeControl(execution.id)?.id !== id)
        throw new ProjectError('HANDOFF_CHANGED', '挂起要求已变化，不能覆盖更晚控制');
      if (!['terminated', 'closed'].includes(execution.lifecycleState)) {
        execution.lifecycleState = 'paused';
        if (execution.sessionId) this.sessions.communicationState(execution.sessionId, 'paused');
        this.saveExecution(execution);
      }
    });
  }
  isResultMessage(messageId: string, sessionId: string): boolean {
    const records = this.db
      .prepare("SELECT data FROM execution_control WHERE json_extract(data,'$.report.sessionId')=?")
      .all(sessionId);
    return records.some((row) =>
      controlSchema.parse(JSON.parse(String(row.data))).report?.messageIds.includes(messageId),
    );
  }
  resultMessage(
    messageId: string,
    sessionId: string,
  ): { id: string; target: string; content: string } | undefined {
    const rows = this.db
      .prepare("SELECT data FROM execution_control WHERE json_extract(data,'$.report.sessionId')=?")
      .all(sessionId);
    for (const row of rows) {
      const value = controlSchema.parse(JSON.parse(String(row.data))),
        index = value.report?.messageIds.indexOf(messageId) ?? -1;
      if (index < 0) continue;
      const execution = this.executions.get(value.executionId),
        target = execution.managerSessionIds[index];
      if (execution.sessionId === sessionId && target && value.report)
        return { id: messageId, target, content: value.report.content };
    }
    return undefined;
  }
  controlMessage(
    id: string,
    kind: 'request' | 'resume',
  ): { id: string; target: string; content: string } {
    const value = this.get(id),
      execution = this.executions.get(value.executionId);
    if (!execution.sessionId)
      throw new ProjectError('CONTROL_SESSION_UNPREPARED', '尚未取得控制目标会话');
    if (
      (kind === 'resume' && value.action !== 'resume') ||
      (kind === 'request' && value.stopMode !== 'soft')
    )
      throw new ProjectError('CONTROL_MESSAGE_MISMATCH', '此请求没有对应控制消息');
    return {
      id: kind === 'resume' ? value.resumeMessageId : value.messageId,
      target: execution.sessionId,
      content:
        kind === 'resume'
          ? `MAT恢复说明。控制 ${value.id}，执行 ${execution.id}。\n仅沿本次授权恢复原尝试，核对最新现场与未办输入，不重复已办或结果未知的副作用。\n${value.reason}\n${JSON.stringify(value.resumeSnapshot)}`
          : `MAT软停止要求。控制 ${value.id}，执行 ${execution.id}。\n停止展开新工作，完成手上小块，结束自己启动的后台作业，保存必要文件与恢复位置。不要为收尾自动提交或推送。随后用mat_chat action=hangup、controlId=${value.id}回报；平台另行核对停稳。\n原因：${value.reason}\n收尾正文：${value.content}`,
    };
  }
  private manager(actor: WorkbenchActor): void {
    const author = this.wb.author(actor);
    if (actor.kind !== 'user' && author.roleType !== 'supervisor')
      throw new ProjectError('CONTROL_FORBIDDEN', '无权控制本项目');
  }
  request(actor: WorkbenchActor, raw: unknown, epoch: string): ControlRecord {
    const input = controlInputSchema.parse(raw),
      author = this.wb.author(actor),
      hash = createHash('sha256').update(JSON.stringify({ actor, input })).digest('hex');
    return transaction(this.db, () => {
      const previous = this.db
        .prepare('SELECT id,request_hash FROM execution_control WHERE operation_id=?')
        .get(input.operationId);
      if (previous) {
        if (previous.request_hash !== hash)
          throw new ProjectError('CONTROL_CONFLICT', '控制操作身份已经存在，正文或来源不同');
        return this.get(String(previous.id));
      }
      const execution = this.executions.get(input.executionId);
      if (actor.kind !== 'user' && author.roleType !== 'supervisor') {
        if (input.action === 'resume')
          throw new ProjectError('CONTROL_RESUME_FORBIDDEN', '普通会话不能恢复上级暂停');
        if (execution.sessionId !== actor.sessionId)
          throw new ProjectError('CONTROL_FORBIDDEN', '无权控制其他会话的执行');
      }
      if (
        input.action !== 'reconcile' &&
        ['terminated', 'closed'].includes(execution.lifecycleState)
      )
        throw new ProjectError('EXECUTION_TERMINATED', '已经终止或收尾的原执行不能恢复');
      if (this.revision(execution.id) !== input.expectedRevision)
        throw new ProjectError('STALE_CONTROL', '控制修订已变化，请读取最新现场');
      if (input.action === 'resume') this.requireDispatch();
      if (input.action === 'resume' && execution.waitingReviewId)
        throw new ProjectError(
          'EXECUTION_REVIEW_WAITING',
          '原执行正在等待正式独审，先办理原等待结果，不能普通恢复修改送审成果',
        );
      if (input.action === 'resume' && execution.reviewResultId) {
        const result = this.db
          .prepare('SELECT data FROM review_result WHERE id=?')
          .get(execution.reviewResultId);
        if (!result || JSON.parse(String(result.data)).authorAction?.state !== 'confirmed')
          throw new ProjectError(
            'REVIEW_RESULT_PENDING',
            '原正式结果的实际接续未核清，须接续原结果，不能普通恢复越过未知',
          );
      }
      const value: ControlRecord = {
        id: randomUUID(),
        operationId: input.operationId,
        executionId: execution.id,
        actor: author,
        action: input.action,
        reason: input.reason,
        content: input.content,
        stopMode: input.action === 'soft-stop' ? 'soft' : input.stopMode,
        revision: input.expectedRevision + 1,
        status: 'requested',
        goal: null,
        cancel: null,
        jobKills: [],
        observation: null,
        report: null,
        messageId: randomUUID(),
        resumeMessageId: randomUUID(),
        resumeSnapshot: null,
        epoch,
        createdAt: now(),
        updatedAt: now(),
      };
      this.db
        .prepare(
          'INSERT INTO execution_control(id,operation_id,request_hash,execution_id,revision,data) VALUES(?,?,?,?,?,?)',
        )
        .run(
          value.id,
          value.operationId,
          hash,
          execution.id,
          value.revision,
          JSON.stringify(value),
        );
      if (['soft-stop', 'hard-stop', 'terminate'].includes(input.action)) {
        execution.writeOccupancy = 'pending-release';
        if (
          input.action === 'hard-stop' ||
          (input.action === 'terminate' && input.stopMode === 'hard')
        ) {
          execution.lifecycleState = 'paused';
          if (execution.sessionId) this.sessions.communicationState(execution.sessionId, 'paused');
        }
        this.saveExecution(execution);
      }
      this.emit('control-changed', execution.id);
      return value;
    });
  }
  resumeReviewResultOnly(
    actor: WorkbenchActor,
    executionId: string,
    resultId: string,
    expectedRevision: number,
    operationId: string,
    reason: string,
  ): void {
    this.manager(actor);
    this.requireDispatch();
    const previous = this.activeControl(executionId),
      execution = this.executions.get(executionId);
    if (this.revision(executionId) !== expectedRevision)
      throw new ProjectError('STALE_CONTROL', '控制修订已变化，请重新核对原结果及控制');
    if (!previous) return;
    if (previous.action === 'resume' && previous.status === 'resumed') return;
    if (
      !['soft-stop', 'hard-stop'].includes(previous.action) ||
      previous.status !== 'stopped' ||
      execution.lifecycleState !== 'paused' ||
      execution.writeOccupancy !== 'released' ||
      execution.failure
    )
      throw new ProjectError(
        'RESULT_RESUME_QUIESCENCE_REQUIRED',
        '只可明确解除已核实停止的原结果限制，终止、未知或在途控制不能绕过',
      );
    const row = this.db.prepare('SELECT data FROM review_result WHERE id=?').get(resultId),
      result = row
        ? (JSON.parse(String(row.data)) as {
            executionId: string;
            reviewId: string;
            progress: { state: string };
          })
        : undefined;
    if (
      !result ||
      result.executionId !== execution.id ||
      result.progress.state === 'confirmed' ||
      !(execution.waitingReviewId === result.reviewId || execution.reviewResultId === resultId)
    )
      throw new ProjectError('RESULT_RESUME_SOURCE', '原结果或当前执行关联不符');
    const value = controlSchema.parse({
      ...previous,
      id: randomUUID(),
      operationId,
      actor: this.wb.author(actor),
      action: 'resume',
      reason,
      content: '仅接续原正式结果，不宣称原生Goal已恢复',
      revision: expectedRevision + 1,
      status: 'resumed',
      goal: {
        state: 'unnecessary',
        note: '原Goal控制留给原结果协调；此记录只明确解除已停稳的上级限制',
      },
      cancel: null,
      jobKills: [],
      observation: previous.observation,
      report: null,
      messageId: randomUUID(),
      resumeMessageId: randomUUID(),
      resumeSnapshot: { mode: 'review-result-only', resultId, previousControlId: previous.id },
      createdAt: now(),
      updatedAt: now(),
    });
    this.db
      .prepare(
        'INSERT INTO execution_control(id,operation_id,request_hash,execution_id,revision,data) VALUES(?,?,?,?,?,?)',
      )
      .run(
        value.id,
        operationId,
        createHash('sha256').update(JSON.stringify(value)).digest('hex'),
        execution.id,
        value.revision,
        JSON.stringify(value),
      );
    execution.lifecycleState = 'waiting';
    execution.waitingReviewId = result.reviewId;
    execution.reviewResultId = null;
    this.saveExecution(execution);
    this.emit('control-changed', execution.id);
  }
  receipt(id: string, kind: 'goal' | 'cancel', raw: ControlReceipt): void {
    const receipt = receiptSchema.parse(raw);
    transaction(this.db, () => {
      const value = this.get(id);
      value[kind] = receipt;
      this.saveControl(value);
    });
  }
  jobKill(id: string, jobId: string, raw: ControlReceipt): void {
    const receipt = receiptSchema.parse(raw);
    transaction(this.db, () => {
      const value = this.get(id);
      if (!this.jobs(value.executionId).some((job) => job.id === jobId))
        throw new ProjectError('JOB_NOT_OWNED', '作业未关联本次执行，不能记录控制');
      const prior = value.jobKills.find((item) => item.jobId === jobId);
      if (prior) prior.receipt = receipt;
      else value.jobKills.push({ jobId, receipt });
      this.saveControl(value);
    });
  }
  setStatus(id: string, status: ControlRecord['status']): void {
    transaction(this.db, () => {
      const value = this.get(id);
      value.status = status;
      this.saveControl(value);
    });
  }
  unconfirmed(id: string, note: string): void {
    transaction(this.db, () => {
      const value = this.get(id),
        execution = this.executions.get(value.executionId);
      value.status = 'unknown';
      value.goal = { state: 'unknown', note };
      const latest = this.activeControl(execution.id);
      if (!latest || latest.revision <= value.revision) {
        execution.writeOccupancy = 'unknown';
        this.saveExecution(execution);
      }
      this.saveControl(value);
    });
  }
  jobs(executionId: string): OwnedJob[] {
    this.executions.get(executionId);
    return this.db
      .prepare('SELECT data FROM execution_job WHERE execution_id=? ORDER BY rowid')
      .all(executionId)
      .map((row) => ownedJobSchema.parse(JSON.parse(String(row.data))));
  }
  recordJob(sessionId: string, event: NativeEvent): void {
    if (!['job/registered', 'job/settled'].includes(event.type)) return;
    const known = this.db
      .prepare('SELECT data FROM execution_job WHERE job_id=?')
      .all(String(event.data.jobId))
      .map((row) => ownedJobSchema.parse(JSON.parse(String(row.data))))
      .filter(
        (job) =>
          job.sessionId === sessionId &&
          job.nativeOwner === event.data.owner &&
          job.startedAt === Number(event.data.startedAt),
      );
    if (known.length > 1)
      throw new ProjectError('JOB_ASSOCIATION_AMBIGUOUS', '原作业关联有歧义，保持未知');
    const execution = known[0]
      ? this.executions.get(known[0].executionId)
      : this.executions.currentForSession(sessionId);
    if (
      !execution ||
      execution.startBoundarySeq === null ||
      event.seq <= execution.startBoundarySeq
    )
      return;
    const session = this.sessions.get(sessionId);
    if (
      event.data.owner !== session.nativeSessionId ||
      session.nativeSessionId !== execution.nativeSessionId
    )
      throw new ProjectError('JOB_OWNER_MISMATCH', '原生作业owner与本次真实会话不一致');
    const id = String(event.data.jobId);
    if (!id || id === 'undefined')
      throw new ProjectError('JOB_ID_REQUIRED', '原生作业没有稳定身份');
    transaction(this.db, () => {
      const previous = this.jobs(execution.id).find((job) => job.id === id);
      if (event.type === 'job/settled' && !previous)
        throw new ProjectError(
          'JOB_REGISTRATION_MISSING',
          '作业结束没有本次登记来源，保持未知核对',
        );
      const job: OwnedJob = previous ?? {
        id,
        executionId: execution.id,
        sessionId,
        nativeOwner: session.nativeSessionId!,
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
        epoch: execution.hostEpoch,
        updatedAt: now(),
      };
      if (event.type === 'job/registered' && previous && previous.registeredSeq !== event.seq)
        throw new ProjectError('JOB_IDENTITY_CONFLICT', '作业身份有不同登记来源');
      if (event.type === 'job/settled') {
        if (job.settledSeq !== null && job.settledSeq !== event.seq)
          throw new ProjectError('JOB_SETTLEMENT_CONFLICT', '作业出现不同结束来源');
        job.settledSeq = event.seq;
        job.status = String(event.data.status);
        job.producerReported =
          typeof event.data.producerReported === 'boolean' ? event.data.producerReported : null;
        job.settlement = event.data;
      }
      job.updatedAt = now();
      this.db
        .prepare(
          'INSERT INTO execution_job(execution_id,job_id,data) VALUES(?,?,?) ON CONFLICT(execution_id,job_id) DO UPDATE SET data=excluded.data',
        )
        .run(execution.id, id, JSON.stringify(ownedJobSchema.parse(job)));
      this.emit('job-changed', execution.id);
    });
  }
  saveWitness(executionId: string, jobId: string, witness: unknown): void {
    transaction(this.db, () => {
      const job = this.jobs(executionId).find((item) => item.id === jobId);
      if (!job) throw new ProjectError('JOB_NOT_FOUND', '本次作业不存在');
      job.processWitness = witness;
      job.updatedAt = now();
      this.db
        .prepare('UPDATE execution_job SET data=? WHERE execution_id=? AND job_id=?')
        .run(JSON.stringify(job), executionId, jobId);
    });
  }
  saveManagedRange(
    sessionId: string,
    callId: string,
    fact: { id: string; state: 'pending' | 'gone' | 'unknown'; at: string; note: string },
  ): void {
    transaction(this.db, () => {
      for (const row of this.db
        .prepare('SELECT execution_id,job_id,data FROM execution_job')
        .all()) {
        const job = ownedJobSchema.parse(JSON.parse(String(row.data)));
        if (job.sessionId !== sessionId || job.toolCallId !== callId) continue;
        const index = job.managedRanges.findIndex((range) => range.id === fact.id);
        if (index < 0) job.managedRanges.push(fact);
        else job.managedRanges[index] = fact;
        job.updatedAt = now();
        this.db
          .prepare('UPDATE execution_job SET data=? WHERE execution_id=? AND job_id=?')
          .run(JSON.stringify(job), job.executionId, job.id);
        this.emit('job-changed', job.executionId);
      }
    });
  }
  observeStopped(id: string, raw: StoppedObservation): void {
    const observation = stoppedObservationSchema.parse(raw);
    transaction(this.db, () => {
      const value = this.get(id),
        execution = this.executions.get(value.executionId),
        jobs = this.jobs(execution.id),
        ids = observation.jobObservations.map((item) => item.jobId);
      const allJobs =
        ids.length === new Set(ids).size &&
        ids.length === jobs.length &&
        jobs.every((job) =>
          observation.jobObservations.some(
            (item) =>
              item.jobId === job.id &&
              item.externalStatus === 'gone' &&
              nativeTerminalJobStatuses.includes(item.nativeStatus),
          ),
        );
      const handoffReady = value.stopMode === 'hard' || value.report !== null;
      const goalReady = value.goal?.state === 'confirmed' || value.goal?.state === 'unnecessary';
      const cancelReady =
        value.stopMode === 'soft' ||
        value.cancel?.state === 'confirmed' ||
        value.cancel?.state === 'unnecessary';
      const stopped =
        handoffReady &&
        goalReady &&
        cancelReady &&
        observation.agentIdle === true &&
        observation.inFlightTools === false &&
        observation.filesStable === true &&
        observation.processesComplete &&
        allJobs;
      value.observation = observation;
      value.status = stopped
        ? 'stopped'
        : observation.agentIdle === false ||
            observation.filesStable === false ||
            observation.jobObservations.some((item) => item.externalStatus === 'running')
          ? 'checking'
          : 'unknown';
      const latest = this.activeControl(execution.id);
      const waitingResume =
        latest?.action === 'resume' &&
        latest.status === 'requested' &&
        latest.resumeSnapshot === null &&
        execution.lifecycleState !== 'active';
      if (latest && latest.revision > value.revision && !waitingResume) {
        value.observation = {
          ...observation,
          note: observation.note + '；此回执属于旧控制，仅补历史，不改变较新的执行状态或占用',
        };
        this.saveControl(value);
        return;
      }
      if (stopped) {
        const ended = ['terminated', 'closed'].includes(execution.lifecycleState);
        if (!ended) execution.lifecycleState = 'paused';
        execution.writeOccupancy = 'released';
        if (!ended && execution.sessionId)
          this.sessions.communicationState(execution.sessionId, 'paused');
      } else execution.writeOccupancy = value.status === 'unknown' ? 'unknown' : 'pending-release';
      this.saveExecution(execution);
      this.saveControl(value);
    });
  }
  terminateRecorded(id: string, raw: ControlReceipt): void {
    const receipt = receiptSchema.parse(raw);
    transaction(this.db, () => {
      const value = this.get(id);
      if (value.action !== 'terminate')
        throw new ProjectError('TERMINATE_REQUIRED', '不是终止请求');
      const execution = this.executions.get(value.executionId);
      if (execution.lifecycleState === 'terminated') return;
      if (this.activeControl(execution.id)?.id !== id)
        throw new ProjectError('CONTROL_CHANGED', '终止请求已被更晚控制取代，不能清理新现场');
      value.goal = receipt;
      value.status = 'terminated';
      execution.lifecycleState = 'terminated';
      if (execution.writeOccupancy !== 'released') execution.writeOccupancy = 'unknown';
      if (execution.sessionId) this.sessions.communicationState(execution.sessionId, 'terminated');
      this.saveExecution(execution);
      this.db.prepare('UPDATE execution SET current=0 WHERE id=?').run(execution.id);
      const ticket = this.wb.getTicket(execution.ticketId);
      this.db.prepare('UPDATE ticket SET data=? WHERE id=?').run(
        JSON.stringify({
          ...ticket,
          state: 'todo',
          currentExecution:
            ticket.currentExecution === execution.id ? null : ticket.currentExecution,
        }),
        ticket.id,
      );
      this.saveControl(value);
    });
  }
  resumeAdmitted(
    id: string,
    snapshot: unknown,
    epoch: string,
    guard: (execution: ExecutionRecord) => void,
  ): ExecutionRecord {
    return transaction(this.db, () => {
      const value = this.get(id),
        execution = this.executions.get(value.executionId);
      this.requireDispatch();
      if (value.action !== 'resume' || this.activeControl(execution.id)?.id !== id)
        throw new ProjectError('RESUME_CHANGED', '恢复请求已被更晚控制取代');
      if (['terminated', 'closed'].includes(execution.lifecycleState))
        throw new ProjectError('EXECUTION_TERMINATED', '已终止的原尝试不能恢复');
      if (execution.writeOccupancy !== 'released')
        throw new ProjectError(
          'QUIESCENCE_REQUIRED',
          '原范围尚未停稳，先核对未知副作用，不能直接恢复',
        );
      guard(execution);
      value.resumeSnapshot = snapshot;
      value.status = 'checking';
      execution.hostEpoch = epoch;
      execution.detachedAt = null;
      execution.lifecycleState = 'active';
      execution.writeOccupancy = 'held';
      execution.failure = null;
      execution.startupState = execution.confirmedAt ? 'confirmed' : 'starting';
      if (execution.sessionId) {
        this.sessions.communicationState(execution.sessionId, 'active');
        this.db.prepare('UPDATE session SET error=NULL WHERE id=?').run(execution.sessionId);
      }
      this.saveExecution(execution);
      this.saveControl(value);
      return execution;
    });
  }
  resumeFailed(id: string, note: string): void {
    transaction(this.db, () => {
      const value = this.get(id),
        execution = this.executions.get(value.executionId);
      value.status = 'unknown';
      value.goal = { state: 'unknown', note };
      if (
        this.activeControl(execution.id)?.id === id &&
        !['terminated', 'closed'].includes(execution.lifecycleState)
      ) {
        execution.lifecycleState = 'paused';
        execution.writeOccupancy = 'unknown';
        if (execution.sessionId) this.sessions.communicationState(execution.sessionId, 'paused');
        this.saveExecution(execution);
      }
      this.saveControl(value);
    });
  }
  project(): ProjectRuntime {
    const row = this.db.prepare('SELECT data FROM project_runtime WHERE singleton=1').get();
    return row
      ? projectRuntimeSchema.parse(JSON.parse(String(row.data)))
      : {
          state: 'stopped',
          managerSessionId: null,
          epoch: null,
          reason: '项目尚未明确启动',
          updatedAt: now(),
        };
  }
  private saveProject(value: ProjectRuntime): void {
    value.updatedAt = now();
    this.db
      .prepare(
        'INSERT INTO project_runtime(singleton,data) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET data=excluded.data',
      )
      .run(JSON.stringify(value));
    this.emit('project-control', 'project');
  }
  projectOutcome(state: ProjectRuntime['state'], reason: string, epoch: string): void {
    transaction(this.db, () => {
      const value = this.project();
      value.state = state;
      value.reason = reason;
      value.epoch = epoch;
      this.saveProject(value);
    });
  }
  projectDetached(epoch: string): void {
    transaction(this.db, () => {
      const value = this.project();
      if (
        value.epoch === epoch &&
        this.db.prepare('SELECT started FROM project WHERE singleton=1').get()?.started === 1
      ) {
        value.state = 'starting';
        value.reason = '插件重新接入，先核对原现场；不重放副作用';
        this.saveProject(value);
      }
    });
  }
  private projectCommand(
    actor: WorkbenchActor,
    input: { operationId: string; reason: string },
    action: string,
    run: () => unknown,
  ): unknown {
    this.manager(actor);
    if (!input.reason.trim())
      throw new ProjectError('CONTROL_REASON_REQUIRED', '请说明项目控制原因');
    const hash = createHash('sha256')
      .update(JSON.stringify({ actor, input, action }))
      .digest('hex');
    return transaction(this.db, () => {
      const previous = this.db
        .prepare('SELECT request_hash,data FROM project_command WHERE operation_id=?')
        .get(input.operationId);
      if (previous) {
        if (previous.request_hash !== hash)
          throw new ProjectError('CONTROL_CONFLICT', '项目控制操作身份不同');
        return JSON.parse(String(previous.data));
      }
      const result = run();
      this.db
        .prepare('INSERT INTO project_command(operation_id,request_hash,data) VALUES(?,?,?)')
        .run(input.operationId, hash, JSON.stringify(result));
      return result;
    });
  }
  startProject(
    actor: WorkbenchActor,
    input: { operationId: string; reason: string },
    epoch: string,
  ): ProjectRuntime {
    return this.projectCommand(actor, input, 'start', () => {
      const value = this.project();
      if (value.state === 'running' && value.epoch === epoch) return value;
      value.state = 'starting';
      value.epoch = epoch;
      value.reason = input.reason;
      this.db.prepare('UPDATE project SET started=1 WHERE singleton=1').run();
      this.saveProject(value);
      return value;
    }) as ProjectRuntime;
  }
  projectReady(epoch: string, managerSessionId: string): void {
    transaction(this.db, () => {
      const manager = this.sessions.get(managerSessionId);
      if (manager.roleType !== 'supervisor' || manager.status !== 'bound')
        throw new ProjectError('MANAGER_BINDING_REQUIRED', '项目管理入口尚未真实绑定');
      const value = this.project();
      if (
        value.epoch !== epoch ||
        this.db.prepare('SELECT started FROM project WHERE singleton=1').get()?.started !== 1
      )
        throw new ProjectError('PROJECT_START_CHANGED', '项目启动意图已变化');
      value.state = 'running';
      value.managerSessionId = manager.id;
      this.saveProject(value);
    });
  }
  reserveManager(epoch: string, sessionId: string): void {
    transaction(this.db, () => {
      const value = this.project(),
        session = this.sessions.get(sessionId);
      if (
        value.epoch !== epoch ||
        session.roleType !== 'supervisor' ||
        (value.managerSessionId && value.managerSessionId !== sessionId)
      )
        throw new ProjectError('MANAGER_CHANGED', '管理入口预留与当前启动不一致');
      value.managerSessionId = sessionId;
      this.saveProject(value);
    });
  }
  stopProject(
    actor: WorkbenchActor,
    input: { operationId: string; reason: string },
    epoch: string,
  ): { executionIds: string[] } {
    return this.projectCommand(actor, input, 'stop', () => {
      const value = this.project();
      value.state = 'stopping';
      value.epoch = epoch;
      value.reason = input.reason;
      this.db.prepare('UPDATE project SET started=0 WHERE singleton=1').run();
      this.saveProject(value);
      return {
        executionIds: this.executions
          .list()
          .filter((item) => !['terminated', 'closed'].includes(item.lifecycleState))
          .map((item) => item.id),
      };
    }) as { executionIds: string[] };
  }
  requireDispatch(): void {
    if (
      this.db.prepare('SELECT started FROM project WHERE singleton=1').get()?.started !== 1 ||
      this.project().state !== 'running'
    )
      throw new ProjectError('PROJECT_NOT_STARTED', '项目尚未启动或已停止接收新派工');
  }
}
