import { join, relative } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  dispatchInputSchema,
  executionSchema,
  executionStepSchema,
  nativeGoalSchema,
} from '../contracts/execution.ts';
import type {
  ExecutionRecord,
  ExecutionStep,
  NativeGoalView,
  DependencyEvidence,
} from '../contracts/execution.ts';
import type { WorkbenchActor, RecordAuthor } from '../contracts/workbench.ts';
import type { ExecutionConfiguration } from '../contracts/project.ts';
import type { RequestRecord } from '../contracts/session-runtime.ts';
import type { NativeEvent } from '../host/native.ts';
import { ProjectError } from '../services/errors.ts';
import {
  canonicalDirectory,
  canonicalWriteScope,
  withinPath,
  scopesOverlap,
} from '../services/write-scopes.ts';
import { transaction } from './transaction.ts';
import type { WorkbenchCatalog, TicketExecutionScope } from './workbench-catalog.ts';
import type { SessionCatalog } from './session-catalog.ts';
import type { RoleCatalog } from './role-catalog.ts';
import type { SessionRecord } from '../contracts/sessions.ts';
type ReuseObservation = NonNullable<ExecutionRecord['sessionReuse']>['observation'];
export function migrateExecutions(db: DatabaseSync): void {
  db.exec(`CREATE TABLE execution(id TEXT PRIMARY KEY,dispatch_id TEXT NOT NULL UNIQUE,operation_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,ticket_id TEXT NOT NULL REFERENCES ticket(id),role_id TEXT NOT NULL REFERENCES role(id),session_id TEXT REFERENCES session(id),current INTEGER NOT NULL DEFAULT 1 CHECK(current IN(0,1)),data TEXT NOT NULL);
 CREATE UNIQUE INDEX execution_current_ticket ON execution(ticket_id) WHERE current=1;
 CREATE UNIQUE INDEX execution_current_session ON execution(session_id) WHERE current=1 AND session_id IS NOT NULL;
 CREATE TABLE execution_step(execution_id TEXT NOT NULL REFERENCES execution(id),turn INTEGER NOT NULL,step INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(execution_id,turn,step));
 CREATE TABLE execution_event(seq INTEGER PRIMARY KEY AUTOINCREMENT,execution_id TEXT NOT NULL REFERENCES execution(id),event_key TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(execution_id,event_key));
 PRAGMA user_version=6;`);
}
const now = () => new Date().toISOString();
export class ExecutionCatalog {
  private readonly db: DatabaseSync;
  private readonly sessions: SessionCatalog;
  private readonly roles: RoleCatalog;
  private readonly wb: WorkbenchCatalog;
  private dependencyResolver: ((ticketId: string) => DependencyEvidence | undefined) | undefined;
  private ownerEpoch: string | undefined;
  private localCommitGuard: ((scopes: string[], mergeId?: string) => void) | undefined;
  private mergeGuard:
    | ((
        actor: WorkbenchActor,
        input: {
          mergeId?: string | undefined;
          ticket: string;
          roleType: ExecutionRecord['roleType'];
          cwd: string;
          writeScopes: string[];
          additionalRepositories: string[];
          worktreeId?: string | undefined;
        },
      ) => void)
    | undefined;
  private mergeLink: ((execution: ExecutionRecord) => void) | undefined;
  bindMergeContext(
    guard: NonNullable<ExecutionCatalog['mergeGuard']>,
    link: NonNullable<ExecutionCatalog['mergeLink']>,
  ) {
    this.mergeGuard = guard;
    this.mergeLink = link;
  }
  constructor(
    db: DatabaseSync,
    sessions: SessionCatalog,
    roles: RoleCatalog,
    wb: WorkbenchCatalog,
  ) {
    this.db = db;
    this.sessions = sessions;
    this.roles = roles;
    this.wb = wb;
  }
  bindDependencyEvidence(resolve: (id: string) => DependencyEvidence | undefined): void {
    this.dependencyResolver = resolve;
  }
  resolveDependencies(ids: string[]): DependencyEvidence[] {
    return ids.map((id) => {
      const evidence = this.dependencyResolver?.(id);
      if (
        !evidence ||
        evidence.ticketId !== id ||
        !evidence.deliveryId ||
        !evidence.reviewId ||
        !evidence.scope
      )
        throw new ProjectError(
          'DEPENDENCY_NOT_READY',
          '直接依赖尚无对应已审版本依据，不接受正文自报完成',
        );
      return evidence;
    });
  }
  private manager(actor: WorkbenchActor): RecordAuthor {
    if (actor.kind !== 'session')
      throw new ProjectError('SUPERVISOR_REQUIRED', '正式派工由实际主管会话调用');
    const author = this.wb.author(actor),
      session = this.sessions.get(actor.sessionId);
    if (author.roleType !== 'supervisor' || session.communicationState !== 'active')
      throw new ProjectError('SUPERVISOR_REQUIRED', '来源不是可派工的实际主管入口');
    return author;
  }
  get(id: string): ExecutionRecord {
    const row = this.db
      .prepare('SELECT data FROM execution WHERE id=? OR dispatch_id=?')
      .get(id, id);
    if (!row) throw new ProjectError('EXECUTION_NOT_FOUND', '派工或执行不存在');
    return executionSchema.parse(JSON.parse(String(row.data)));
  }
  list(): ExecutionRecord[] {
    return this.db
      .prepare('SELECT id FROM execution ORDER BY rowid')
      .all()
      .map((row) => this.get(String(row.id)));
  }
  bindLocalCommitGuard(guard: (scopes: string[], mergeId?: string) => void): void {
    this.localCommitGuard = guard;
  }
  currentForSession(sessionId: string): ExecutionRecord | undefined {
    const row = this.db
      .prepare('SELECT id FROM execution WHERE session_id=? AND current=1')
      .get(sessionId);
    return row ? this.get(String(row.id)) : undefined;
  }
  scopeForSession(sessionId: string): TicketExecutionScope | undefined {
    const value = this.currentForSession(sessionId);
    if (!value || ['terminated', 'closed'].includes(value.lifecycleState)) return undefined;
    return {
      ticketId: value.ticketId,
      executionId: value.id,
      kind: 'main',
      checklistIds: [],
      allowAssist:
        value.writeOccupancy === 'held' &&
        value.goalId !== null &&
        (value.lifecycleState === 'active' ||
          (value.lifecycleState === 'waiting' && value.waitingReviewId === null)) &&
        value.failure === null &&
        value.hostEpoch === this.ownerEpoch,
      allowWrite:
        value.goalId !== null &&
        value.lifecycleState === 'active' &&
        value.failure === null &&
        value.hostEpoch === this.ownerEpoch,
      cwd: value.cwd,
    };
  }
  private save(value: ExecutionRecord): void {
    value.updatedAt = now();
    this.db
      .prepare('UPDATE execution SET session_id=?,data=? WHERE id=?')
      .run(value.sessionId, JSON.stringify(value), value.id);
  }
  private event(value: ExecutionRecord, key: string, kind: string, data: unknown): void {
    this.db
      .prepare('INSERT OR IGNORE INTO execution_event(execution_id,event_key,data) VALUES(?,?,?)')
      .run(value.id, key, JSON.stringify({ kind, at: now(), data }));
    this.db
      .prepare('INSERT INTO ui_event(kind,object_id) VALUES(?,?)')
      .run('execution-changed', value.id);
  }
  private history(value: ExecutionRecord, kind: string, reason: string): void {
    const author: RecordAuthor = {
      kind: 'system',
      sessionId: null,
      roleId: null,
      roleCode: 'MAT',
      roleType: null,
      address: null,
    };
    this.db.prepare('INSERT INTO project_history(data) VALUES(?)').run(
      JSON.stringify({
        id: randomUUID(),
        kind,
        objectId: value.ticketId,
        actor: author,
        at: now(),
        reason,
        references: ['execution:' + value.id],
        corrects: null,
      }),
    );
  }
  private conflicts(scopes: string[], exclude?: string, mergeId?: string): void {
    this.localCommitGuard?.(scopes, mergeId);
    for (const value of this.list())
      if (
        value.id !== exclude &&
        value.writeOccupancy !== 'released' &&
        value.writeScopes.some((old) => scopes.some((scope) => scopesOverlap(old, scope)))
      )
        throw new ProjectError(
          'WRITE_SCOPE_BUSY',
          '写入范围与已有执行或未知占用冲突，请核对原执行，不盲目另开',
        );
  }
  register(
    actor: WorkbenchActor,
    raw: unknown,
    hostEpoch: string,
    externalGuard?: (scopes: string[]) => void,
    observeReuse?: (
      session: SessionRecord,
      previous: ExecutionRecord,
    ) => ReuseObservation | undefined,
  ): { record: ExecutionRecord; isNew: boolean } {
    this.ownerEpoch ??= hostEpoch;
    const input = dispatchInputSchema.parse(raw),
      author = this.manager(actor),
      hash = createHash('sha256').update(JSON.stringify({ actor, input })).digest('hex');
    return transaction(this.db, () => {
      const prior = this.db
        .prepare('SELECT id,request_hash FROM execution WHERE operation_id=?')
        .get(input.operationId);
      if (prior) {
        if (prior.request_hash !== hash)
          throw new ProjectError('DISPATCH_CONFLICT', '操作身份已存在但派工正文或来源不同');
        return { record: this.get(String(prior.id)), isNew: false };
      }
      const ticket = this.wb.getTicket(input.ticket),
        phase = this.wb.getPhase(ticket.phaseId);
      if (
        this.list().some(
          (value) =>
            value.ticketId === ticket.id &&
            ['terminated', 'closed'].includes(value.lifecycleState) &&
            value.writeOccupancy !== 'released',
        )
      )
        throw new ProjectError(
          'OLD_EXECUTION_NOT_QUIESCENT',
          '原尝试尚未停稳，不能对同票盲目另开替代执行',
        );
      if (phase.state !== 'opened')
        throw new ProjectError('PHASE_NOT_OPENED', '所属期次未开放，不能因聊天或计划开工');
      if (
        this.db.prepare('SELECT id FROM execution WHERE ticket_id=? AND current=1').get(ticket.id)
      )
        throw new ProjectError('PRIMARY_EXECUTION_EXISTS', '本票已有活跃主执行，不能重复安排');
      if (ticket.state !== 'todo')
        throw new ProjectError('TICKET_NOT_TODO', '当前票据状态不能新派工，请沿实际办理处理');
      const dependencyEvidence = this.resolveDependencies(ticket.dependencies);
      const session = input.sessionId ? this.sessions.get(input.sessionId) : undefined;
      const role = session
        ? this.roles.list().find((role) => role.id === session.roleId)
        : this.roles
            .list()
            .find((role) => role.id === input.roleId || role.aliases.includes(input.roleId!));
      if (!role) throw new ProjectError('ROLE_NOT_FOUND', '目标角色未在项目登记');
      if (ticket.kind === 'research' && role.type !== 'investigator')
        throw new ProjectError(
          'RESEARCH_INVESTIGATOR_REQUIRED',
          '研究票的正式主执行必须是调查角色',
        );
      if (role.type === 'supervisor')
        throw new ProjectError(
          'INVALID_EXECUTOR_TYPE',
          '正式主执行引用开发、调查、审阅或提交角色，不复用主管管理入口',
        );
      if (
        session &&
        (session.status !== 'bound' ||
          (!input.reuseClosedExecutionId && session.communicationState !== 'active') ||
          session.error !== null)
      )
        throw new ProjectError(
          'SESSION_UNAVAILABLE',
          '目标会话未准备、受控制或异常，不能因派工复活',
        );
      if (
        session &&
        (this.currentForSession(session.id) ||
          this.db
            .prepare("SELECT id FROM collaboration WHERE session_id=? AND state!='completed'")
            .get(session.id) ||
          this.db
            .prepare(
              "SELECT id FROM local_commit_arrangement WHERE session_id=? AND json_extract(data,'$.status') NOT IN('completed','cancelled')",
            )
            .get(session.id) ||
          this.db
            .prepare(
              "SELECT id FROM worktree_merge WHERE session_id=? AND json_extract(data,'$.status') NOT IN('completed','cancelled')",
            )
            .get(session.id) ||
          this.db
            .prepare(
              "SELECT id FROM review WHERE json_extract(data,'$.sessionId')=? AND (json_extract(data,'$.status') NOT IN('decided','cancelled') OR COALESCE(json_extract(data,'$.closure.state'),'')!='confirmed')",
            )
            .get(session.id))
      )
        throw new ProjectError(
          'SESSION_EXECUTION_BUSY',
          '同一会话已有本票或另一票责任，不能并行承接',
        );
      const targets = [author.sessionId!];
      if (input.notifySessionId) {
        const notify = this.sessions.get(input.notifySessionId);
        if (
          notify.status !== 'bound' ||
          notify.roleType !== 'supervisor' ||
          ['terminated', 'archived'].includes(notify.communicationState)
        )
          throw new ProjectError(
            'INVALID_MANAGER_TARGET',
            '指定管理入口必须是本项目可联系的主管会话',
          );
        targets.push(notify.id);
      }
      const cwd = canonicalDirectory(input.cwd ?? session!.cwd),
        scopes = (input.writeScopes ?? [cwd]).map(canonicalWriteScope);
      if (input.cwd || !session)
        for (const scope of scopes)
          if (!withinPath(cwd, scope))
            throw new ProjectError('WRITE_SCOPE_OUTSIDE_CWD', '协调写入范围超出本次源码工作目录');
      if (input.mergeId && !this.mergeGuard)
        throw new ProjectError(
          'MERGE_DISPATCH_UNAVAILABLE',
          '原合入交接核对缺件，不以正文id授范围例外',
        );
      this.mergeGuard?.(actor, {
        mergeId: input.mergeId,
        ticket: ticket.id,
        roleType: role.type,
        cwd,
        writeScopes: scopes,
        additionalRepositories: input.additionalRepositories,
        worktreeId: input.worktreeId,
      });
      this.conflicts(scopes, undefined, input.mergeId);
      externalGuard?.(scopes);
      let sessionReuse: ExecutionRecord['sessionReuse'] = null;
      if (input.reuseClosedExecutionId && session) {
        const origin = session.communicationOrigin;
        if (
          session.communicationState !== 'paused' ||
          origin?.executionId !== input.reuseClosedExecutionId
        )
          throw new ProjectError(
            'SESSION_REUSE_ORIGIN_MISMATCH',
            '原会话暂停来源不是指定的审阅收尾，不能解除',
          );
        const previous = this.get(origin.executionId);
        if (
          previous.sessionId !== session.id ||
          previous.nativeSessionId !== session.nativeSessionId ||
          previous.ticketId === ticket.id ||
          previous.lifecycleState !== 'closed' ||
          previous.writeOccupancy !== 'released' ||
          previous.reviewResultId !== origin.resultId ||
          !previous.goalId
        )
          throw new ProjectError(
            'SESSION_REUSE_ORIGIN_MISMATCH',
            '原收尾身份或释放依据不匹配，不能接下一票',
          );
        if (!input.writeScopes)
          throw new ProjectError(
            'SESSION_REUSE_SCOPE_REQUIRED',
            '顺序承票须明确声明下一票写入范围；只读填空数组',
          );
        const observation = observeReuse?.(session, previous);
        if (
          !observation ||
          !session.nativeSessionId ||
          observation.state !== 'confirmed' ||
          observation.nativeSessionId !== session.nativeSessionId ||
          observation.epoch !== hostEpoch ||
          observation.ranges.some(
            (range) => range.state !== 'gone' || range.nativeOwner !== session.nativeSessionId,
          )
        )
          throw new ProjectError(
            'SESSION_REUSE_NOT_QUIET',
            '原生会话未确认停稳，不能接下一票。' + (observation?.note ?? ''),
          );
        sessionReuse = {
          previousExecutionId: previous.id,
          previousResultId: origin.resultId,
          observation,
        };
      }
      const value: ExecutionRecord = {
        id: randomUUID(),
        dispatchId: randomUUID(),
        operationId: input.operationId,
        actor: author,
        managerSessionIds: [...new Set(targets)],
        ticketId: ticket.id,
        ticketCode: ticket.code,
        ticketRevision: ticket.revision,
        dependencyEvidence,
        roleId: role.id,
        roleType: role.type,
        name: input.name,
        requirements: input.requirements,
        cwd,
        worktreeId: input.worktreeId ?? null,
        mergeId: input.mergeId ?? null,
        cwdMode: input.cwd ? 'explicit' : 'preserve-current',
        writeScopes: scopes,
        scopeAdjustments: [],
        additionalRepositories: input.additionalRepositories,
        writeScopesDefaulted: input.writeScopes === undefined,
        requestedConfiguration: input.configuration ?? (session ? null : role.configuration),
        resolvedConfiguration: null,
        configurationBasis: input.configuration
          ? 'dispatch-override'
          : session
            ? 'preserve-native'
            : 'role-default',
        maxGoalRounds: input.maxGoalRounds ?? null,
        sessionId: session?.id ?? null,
        nativeSessionId: session?.nativeSessionId ?? null,
        startupState: 'registered',
        lifecycleState: 'active',
        waitingReviewId: null,
        reviewResultId: null,
        sessionReuse,
        writeOccupancy: 'held',
        goalId: null,
        goalObjective: null,
        goalSnapshot: null,
        goalDurableAt: null,
        startBoundarySeq: null,
        firstRequestId: null,
        firstStartedAt: null,
        confirmedAt: null,
        completedSteps: 0,
        failure: null,
        notifications: [],
        hostEpoch,
        detachedAt: null,
        createdAt: now(),
        updatedAt: now(),
      };
      this.db
        .prepare(
          'INSERT INTO execution(id,dispatch_id,operation_id,request_hash,ticket_id,role_id,session_id,data) VALUES(?,?,?,?,?,?,?,?)',
        )
        .run(
          value.id,
          value.dispatchId,
          value.operationId,
          hash,
          ticket.id,
          role.id,
          value.sessionId,
          JSON.stringify(value),
        );
      this.db
        .prepare('UPDATE ticket SET data=? WHERE id=?')
        .run(JSON.stringify({ ...ticket, currentExecution: value.id }), ticket.id);
      this.mergeLink?.(value);
      if (sessionReuse && session) this.sessions.communicationState(session.id, 'active');
      this.event(value, 'registered', 'registered', {
        actor: author,
        ticketRevision: ticket.revision,
        dependencyEvidence,
        ...(sessionReuse ? { sessionReuse } : {}),
      });
      this.history(value, 'dispatch-registered', '主管登记单票派工；尚未确认启动');
      return { record: value, isNew: true };
    });
  }
  private change(id: string, action: (value: ExecutionRecord) => void): ExecutionRecord {
    return transaction(this.db, () => {
      const value = this.get(id);
      action(value);
      this.save(value);
      return value;
    });
  }
  sessionReserved(id: string, sessionId: string): ExecutionRecord {
    return this.change(id, (value) => {
      const session = this.sessions.get(sessionId);
      if (session.roleId !== value.roleId)
        throw new ProjectError('EXECUTION_ROLE_MISMATCH', '会话角色与派工不一致');
      const other = this.currentForSession(sessionId);
      if (other && other.id !== id)
        throw new ProjectError('SESSION_EXECUTION_BUSY', '同一会话不能并行承接两票');
      if (value.sessionId && value.sessionId !== sessionId)
        throw new ProjectError('SESSION_REBIND_FORBIDDEN', '本次执行不能改绑另一个会话');
      value.sessionId = sessionId;
      value.startupState = 'creating-session';
      this.event(value, 'session-reserved', 'session-reserved', { sessionId });
    });
  }
  sessionPrepared(id: string, sessionId: string): ExecutionRecord {
    return this.change(id, (value) => {
      const session = this.sessions.get(sessionId);
      if (
        value.sessionId !== sessionId ||
        session.status !== 'bound' ||
        session.roleId !== value.roleId ||
        !session.nativeSessionId
      )
        throw new ProjectError('SESSION_BINDING_REQUIRED', '缺少本次真实会话绑定');
      value.nativeSessionId = session.nativeSessionId;
      value.startupState = 'session-prepared';
      this.event(value, 'session-prepared', 'session-prepared', {
        sessionId,
        nativeSessionId: session.nativeSessionId,
      });
    });
  }
  resolveWorkingDirectory(
    id: string,
    cwd: string,
    externalGuard?: (scopes: string[]) => void,
  ): ExecutionRecord {
    return this.change(id, (value) => {
      const canonical = canonicalDirectory(cwd),
        scopes = value.writeScopesDefaulted ? [canonical] : value.writeScopes;
      for (const scope of scopes)
        if (!withinPath(canonical, scope))
          throw new ProjectError('WRITE_SCOPE_OUTSIDE_CWD', '实际目录与声明写域不一致');
      this.conflicts(scopes, id, value.mergeId ?? undefined);
      externalGuard?.(scopes);
      value.cwd = canonical;
      value.writeScopes = scopes;
    });
  }
  guardExistingScope(id: string, scopes: string[], linkedMergeId?: string): void {
    this.conflicts(scopes, id, linkedMergeId);
  }
  linkStartupWorktree(id: string, worktreeId: string) {
    return this.change(id, (value) => {
      if (value.worktreeId === worktreeId) return;
      if (
        value.worktreeId ||
        value.goalId ||
        value.firstRequestId ||
        !['registered', 'creating-session', 'session-prepared'].includes(value.startupState)
      )
        throw new ProjectError('WORKTREE_BINDING_CHANGED', '仅在本次启动基线前关联实际已有工作树');
      value.worktreeId = worktreeId;
      this.event(value, 'worktree-link:' + worktreeId, 'worktree-linked', {
        worktreeId,
        cwd: value.cwd,
      });
    });
  }
  worktreeEntered(
    id: string,
    worktreeId: string,
    sourceRepository: string,
    path: string,
    originalCwd: string,
    cwd: string,
  ): ExecutionRecord {
    return this.change(id, (value) => {
      const desired = canonicalDirectory(cwd);
      if (value.worktreeId === worktreeId && value.cwd === desired) return;
      if (
        value.cwd !== canonicalDirectory(originalCwd) ||
        value.mergeId ||
        value.worktreeId ||
        !['active', 'paused'].includes(value.lifecycleState) ||
        value.waitingReviewId
      )
        throw new ProjectError(
          'WORKTREE_EXECUTION_CHANGED',
          '原执行目录或责任已变化，不覆盖新状态',
        );
      if (!withinPath(path, desired) || !withinPath(sourceRepository, value.cwd))
        throw new ProjectError('WORKTREE_CWD_SCOPE', '新目录不对应原源码空间');
      const scopes = value.writeScopesDefaulted
        ? [desired]
        : value.writeScopes.map((scope) => {
            if (!withinPath(sourceRepository, scope))
              throw new ProjectError('WORKTREE_WRITE_SCOPE', '原写域不在原源码仓库，不自动扩围');
            return canonicalWriteScope(join(path, relative(sourceRepository, scope)));
          });
      this.conflicts(scopes, id);
      value.cwd = desired;
      value.cwdMode = 'explicit';
      value.writeScopes = scopes;
      value.worktreeId = worktreeId;
      this.event(value, 'worktree:' + worktreeId, 'worktree-entered', {
        worktreeId,
        originalCwd,
        cwd: desired,
        writeScopes: scopes,
      });
    });
  }
  starting(
    id: string,
    boundarySeq: number,
    configuration: ExecutionConfiguration,
    objective: string,
  ): ExecutionRecord {
    return this.change(id, (value) => {
      if (!value.sessionId || !value.nativeSessionId)
        throw new ProjectError('SESSION_BINDING_REQUIRED', '尚未取得实际会话');
      if (this.wb.getTicket(value.ticketId).revision !== value.ticketRevision)
        throw new ProjectError(
          'REQUIREMENTS_CHANGED',
          '会话准备期间票据要求已变化，先核对原安排，不悄悄替换授权',
        );
      value.startBoundarySeq = boundarySeq;
      value.resolvedConfiguration = configuration;
      value.goalObjective = objective;
      value.startupState = 'starting';
      this.event(value, 'starting', 'starting', { boundarySeq, configuration });
    });
  }
  goalLinked(id: string, raw: NativeGoalView): ExecutionRecord {
    const goal = nativeGoalSchema.parse(raw);
    return this.change(id, (value) => {
      if (goal.objective !== value.goalObjective || !value.nativeSessionId)
        throw new ProjectError('GOAL_BINDING_MISMATCH', 'Goal与派工本次目标或会话不一致');
      if (value.goalId && value.goalId !== goal.id)
        throw new ProjectError('GOAL_REBIND_FORBIDDEN', '原Goal不可换成替代Goal');
      value.goalId = goal.id;
      value.goalSnapshot = goal;
      this.event(value, 'goal:' + goal.id + ':' + goal.revision, 'goal-linked', goal);
    });
  }
  goalObserved(sessionId: string, raw: NativeGoalView): void {
    const current = this.currentForSession(sessionId);
    if (!current || current.goalId !== raw.id) return;
    this.change(current.id, (value) => {
      value.goalSnapshot = nativeGoalSchema.parse(raw);
      this.event(
        value,
        'goal-view:' + raw.id + ':' + raw.revision + ':' + raw.activation,
        'goal-observed',
        raw,
      );
    });
  }
  goalDurable(id: string): ExecutionRecord {
    return this.change(id, (value) => {
      value.goalDurableAt ??= now();
      this.confirm(value);
    });
  }
  waitForReview(id: string, reviewId: string): ExecutionRecord {
    return this.change(id, (value) => {
      if (value.lifecycleState !== 'active' || value.failure)
        throw new ProjectError('EXECUTION_CANNOT_WAIT', '原执行已受控或失败，不能改成等待');
      value.lifecycleState = 'waiting';
      value.waitingReviewId = reviewId;
      value.reviewResultId = null;
      this.event(value, 'review-wait:' + reviewId, 'review-wait', { reviewId });
    });
  }
  waitForCollaborations(id: string): ExecutionRecord {
    return this.change(id, (v) => {
      if (v.lifecycleState !== 'active' || v.failure)
        throw new ProjectError('EXECUTION_CANNOT_WAIT', '当前执行不能进入协作等待');
      v.lifecycleState = 'waiting';
      v.waitingReviewId = null;
      this.event(v, 'collaboration-wait:' + randomUUID(), 'collaboration-wait', {});
    });
  }
  returnFromCollaborationWait(id: string): ExecutionRecord {
    return this.change(id, (v) => {
      if (v.lifecycleState !== 'waiting' || v.waitingReviewId !== null || v.failure)
        throw new ProjectError('COLLABORATION_WAIT_CHANGED', '原执行已不在普通协作等待');
      v.lifecycleState = 'active';
      this.event(v, 'collaboration-resume:' + randomUUID(), 'collaboration-resume', {});
    });
  }
  returnFromReview(id: string, reviewId: string, resultId: string, epoch: string): ExecutionRecord {
    return transaction(this.db, () =>
      this.change(id, (value) => {
        if (
          value.waitingReviewId === null &&
          value.reviewResultId === resultId &&
          value.lifecycleState === 'active'
        )
          return;
        if (
          value.waitingReviewId !== reviewId ||
          value.lifecycleState !== 'waiting' ||
          value.failure
        )
          throw new ProjectError('REVIEW_RETURN_CHANGED', '原执行已不在本次审阅等待');
        value.waitingReviewId = null;
        value.reviewResultId = resultId;
        value.lifecycleState = 'active';
        value.hostEpoch = epoch;
        value.detachedAt = null;
        value.writeOccupancy = 'held';
        if (value.sessionId) this.sessions.communicationState(value.sessionId, 'active');
        this.event(value, 'review-return:' + resultId, 'review-return', { reviewId, resultId });
      }),
    );
  }
  closeFromReview(id: string, reviewId: string, resultId: string): ExecutionRecord {
    return transaction(this.db, () => {
      const result = this.change(id, (value) => {
        if (value.waitingReviewId !== reviewId || value.lifecycleState !== 'waiting')
          throw new ProjectError('REVIEW_CLOSE_CHANGED', '原执行已不在本次通过等待');
        value.waitingReviewId = null;
        value.reviewResultId = resultId;
        value.lifecycleState = 'closed';
        value.writeOccupancy = 'released';
        if (value.sessionId)
          this.sessions.communicationState(value.sessionId, 'paused', {
            kind: 'execution-closed',
            executionId: value.id,
            resultId,
            at: now(),
          });
        this.event(value, 'review-close:' + resultId, 'review-close', { reviewId, resultId });
      });
      this.db.prepare('UPDATE execution SET current=0 WHERE id=?').run(id);
      return result;
    });
  }
  private confirm(value: ExecutionRecord): void {
    value.completedSteps = this.steps(value.id).filter(
      (step) => step.settled && !step.failed && step.lastRequestStatus === 'completed',
    ).length;
    if (
      value.completedSteps >= 3 &&
      value.goalDurableAt &&
      value.lifecycleState === 'active' &&
      value.failure === null &&
      !value.failure
    ) {
      value.startupState = 'confirmed';
      if (value.confirmedAt === null) {
        value.confirmedAt = now();
        this.history(
          value,
          'execution-start-confirmed',
          '平台按三个实际Agent步骤确认持续启动；不代表票据完成',
        );
      }
    }
  }
  requestObserved(sessionId: string, requestId: string): void {
    const current = this.currentForSession(sessionId);
    if (!current || !current.goalId || current.startBoundarySeq === null) return;
    const row = this.db
      .prepare('SELECT data FROM model_request WHERE id=? AND session_id=?')
      .get(requestId, sessionId);
    if (!row) throw new ProjectError('REQUEST_EVIDENCE_REQUIRED', '实际请求记录不存在');
    const request = JSON.parse(String(row.data)) as RequestRecord;
    this.change(current.id, (value) => {
      value.firstRequestId ??= requestId;
      value.firstStartedAt ??= request.startedAt;
      const ticket = this.wb.getTicket(value.ticketId);
      if (ticket.state === 'todo') {
        this.db
          .prepare('UPDATE ticket SET data=? WHERE id=?')
          .run(
            JSON.stringify({ ...ticket, state: 'in-progress', currentExecution: value.id }),
            ticket.id,
          );
        this.history(value, 'execution-started', '平台依据关联原生请求确认已开始，不将登记当启动');
      }
      const step = this.step(value.id, request.turn, request.step);
      if (step) {
        if (!step.requestIds.includes(requestId)) step.requestIds.push(requestId);
        step.lastRequestStatus = request.status;
        this.saveStep(value.id, step);
      }
      this.event(value, 'request:' + requestId + ':' + request.status, 'request-observed', {
        requestId,
        turn: request.turn,
        step: request.step,
        status: request.status,
      });
    });
  }
  private step(id: string, turn: number, step: number): ExecutionStep | undefined {
    const row = this.db
      .prepare('SELECT data FROM execution_step WHERE execution_id=? AND turn=? AND step=?')
      .get(id, turn, step);
    return row ? executionStepSchema.parse(JSON.parse(String(row.data))) : undefined;
  }
  private saveStep(id: string, value: ExecutionStep): void {
    this.db
      .prepare(
        'INSERT INTO execution_step(execution_id,turn,step,data) VALUES(?,?,?,?) ON CONFLICT(execution_id,turn,step) DO UPDATE SET data=excluded.data',
      )
      .run(id, value.turn, value.step, JSON.stringify(value));
  }
  steps(id: string): ExecutionStep[] {
    this.get(id);
    return this.db
      .prepare('SELECT data FROM execution_step WHERE execution_id=? ORDER BY rowid')
      .all(id)
      .map((row) => executionStepSchema.parse(JSON.parse(String(row.data))));
  }
  stepStarted(sessionId: string, event: NativeEvent): void {
    const current = this.currentForSession(sessionId);
    if (
      !current ||
      event.type !== 'step/start' ||
      current.startBoundarySeq === null ||
      event.seq <= current.startBoundarySeq
    )
      return;
    const turn = Number(event.data.turn),
      step = Number(event.data.step);
    if (!Number.isSafeInteger(turn) || !Number.isSafeInteger(step))
      throw new ProjectError('STEP_EVIDENCE_INVALID', '原生步骤缺少准确编号');
    this.change(current.id, (value) => {
      const previous = this.step(value.id, turn, step);
      if (previous) {
        if (previous.startSeq !== event.seq)
          throw new ProjectError(
            'STEP_IDENTITY_CONFLICT',
            '同一步骤出现不同原生来源，保留未知核对',
          );
        return;
      }
      this.saveStep(value.id, {
        turn,
        step,
        startSeq: event.seq,
        endSeq: null,
        requestIds: [],
        lastRequestStatus: null,
        settled: false,
        failed: false,
      });
      this.event(value, 'native:' + event.seq, 'step-started', {
        turn,
        step,
        sourceSeq: event.seq,
      });
    });
  }
  stepEnded(sessionId: string, event: NativeEvent): void {
    const current = this.currentForSession(sessionId);
    if (!current || event.type !== 'step/end') return;
    const step = this.step(current.id, Number(event.data.turn), Number(event.data.step));
    if (!step) return;
    this.change(current.id, (value) => {
      step.endSeq ??= event.seq;
      this.saveStep(value.id, step);
      this.event(value, 'native:' + event.seq, 'step-ended', {
        turn: step.turn,
        step: step.step,
        sourceSeq: event.seq,
      });
    });
  }
  settleStep(id: string, turn: number, number: number): void {
    this.change(id, (value) => {
      const step = this.step(id, turn, number);
      if (!step || step.endSeq === null) return;
      step.settled = true;
      this.saveStep(id, step);
      this.confirm(value);
    });
  }
  settleEndedSteps(id: string, turn: number, beforeStep?: number): void {
    for (const step of this.steps(id))
      if (
        step.turn === turn &&
        step.endSeq !== null &&
        !step.settled &&
        (beforeStep === undefined || step.step < beforeStep)
      )
        this.settleStep(id, turn, step.step);
  }
  nativeError(sessionId: string, input: { code: string; turn?: number; step?: number }): void {
    const current = this.currentForSession(sessionId);
    if (!current) return;
    const step =
      input.turn !== undefined && input.step !== undefined
        ? this.step(current.id, input.turn, input.step)
        : undefined;
    if (step && !step.settled)
      transaction(this.db, () => {
        step.failed = true;
        this.saveStep(current.id, step);
      });
    this.fail(current.id, {
      code: input.code,
      message:
        '执行宿主报告独立异常，原始错误见关联DSH会话；模型选择和实际请求另查配置记录，未盲目重派',
      unknown: false,
    });
  }
  turnEnded(sessionId: string, event: NativeEvent, modelChangeId?: string): void {
    const current = this.currentForSession(sessionId);
    if (!current || event.type !== 'turn/end') return;
    const reason = event.data.reason as { kind?: string; error?: { code?: string } } | undefined;
    if (reason?.kind !== 'error') return;
    const turn = Number(event.data.turn),
      last = this.steps(current.id)
        .filter((step) => step.turn === turn)
        .at(-1);
    if (last && !last.settled)
      transaction(this.db, () => {
        last.failed = true;
        this.saveStep(current.id, last);
      });
    if (modelChangeId) {
      const row = this.db
        .prepare('SELECT data FROM model_change WHERE id=? AND session_id=?')
        .get(modelChangeId, sessionId);
      const change = row ? JSON.parse(String(row.data)) : null;
      if (
        change?.source === 'fallback' &&
        change.failureId === String(turn) + ':' + String(last?.step ?? 0) &&
        change.failureCode === reason.error?.code &&
        ['reserved', 'confirmed', 'unknown'].includes(change.status)
      ) {
        this.change(current.id, (value) => {
          this.event(value, 'model-recovery:' + modelChangeId + ':' + event.seq, 'model-recovery', {
            modelChangeId,
            turn,
            code: reason.error?.code,
            note: '原模型失败步骤仍保留；仅此原错误正在按已捕获单一备用策略接续，不将整次执行提前标为终止故障',
          });
        });
        return;
      }
    }
    this.fail(current.id, {
      code: reason.error?.code ?? 'NATIVE_TURN_ERROR',
      message:
        '执行宿主异常结束，原始错误见关联DSH会话；模型选择和实际请求另查配置记录，未盲目重派',
      unknown: false,
    });
  }
  fail(id: string, failure: { code: string; message: string; unknown: boolean }): ExecutionRecord {
    return this.change(id, (value) => {
      if (!value.failure)
        value.failure = {
          id: randomUUID(),
          ...failure,
          phase: value.startupState === 'confirmed' ? 'runtime' : 'startup',
          at: now(),
        };
      const unknown = failure.unknown || value.failure.unknown;
      value.failure.unknown = unknown;
      value.startupState = unknown ? 'unknown' : 'error';
      if (!unknown) value.lifecycleState = 'error';
      value.writeOccupancy = unknown ? 'unknown' : value.writeOccupancy;
      this.event(value, 'failure:' + value.failure.id, 'execution-problem', value.failure);
    });
  }
  prepareNotifications(
    id: string,
    build: (value: ExecutionRecord, target: string) => { messageId: string; content: string },
  ): ExecutionRecord {
    return this.change(id, (value) => {
      if (!value.failure || value.notifications.length) return;
      value.notifications = value.managerSessionIds.map((target) => ({
        ...build(value, target),
        targetSessionId: target,
        state: 'pending',
        error: null,
      }));
    });
  }
  notificationResult(
    id: string,
    target: string,
    state: 'saved' | 'unavailable',
    error: string | null,
  ): void {
    this.change(id, (value) => {
      const notice = value.notifications.find((item) => item.targetSessionId === target);
      if (notice) {
        notice.state = state;
        notice.error = error;
        this.event(value, 'notice:' + notice.messageId + ':' + state, 'notification-result', {
          target,
          state,
          error,
        });
      }
    });
  }
  toolObserved(sessionId: string, event: NativeEvent): void {
    const current = this.currentForSession(sessionId);
    if (
      !current ||
      current.startBoundarySeq === null ||
      event.seq <= current.startBoundarySeq ||
      !['tool/call', 'tool/result'].includes(event.type)
    )
      return;
    this.change(current.id, (value) =>
      this.event(value, 'native:' + event.seq, event.type, {
        name: event.data.name ?? null,
        callId: event.data.callId ?? null,
        sourceSeq: event.seq,
        note: '原生公开工具事件；结果详情按原会话核对',
      }),
    );
  }
  events(id: string): { kind: string; at: string; data: unknown }[] {
    this.get(id);
    return this.db
      .prepare('SELECT data FROM execution_event WHERE execution_id=? ORDER BY seq')
      .all(id)
      .map((row) => JSON.parse(String(row.data)));
  }
  hostAttached(epoch: string): void {
    this.ownerEpoch = epoch;
    for (const value of this.list())
      if (
        value.hostEpoch !== epoch &&
        this.db.prepare('SELECT current FROM execution WHERE id=?').get(value.id)?.current === 1
      )
        this.change(value.id, (record) => {
          record.detachedAt ??= now();
          if (!['confirmed', 'error'].includes(record.startupState))
            record.startupState = 'unknown';
          record.writeOccupancy = 'unknown';
          this.event(record, 'host-detached:' + record.hostEpoch, 'host-detached', {
            previousOwner: record.hostEpoch,
            newOwner: epoch,
          });
        });
  }
  detached(epoch: string): void {
    for (const value of this.list())
      if (value.hostEpoch === epoch && value.writeOccupancy !== 'released')
        this.change(value.id, (record) => {
          record.detachedAt = now();
          record.writeOccupancy = 'unknown';
          this.event(record, 'host-closing:' + epoch, 'host-closing', {
            note: '宿主关闭不证明外部作业停稳，未释放写域',
          });
        });
  }
}
