import type { ControlCatalog } from './control-catalog.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  worktreeCreateSchema,
  worktreeRecordSchema,
  worktreeSourceSchema,
  worktreeCleanupInputSchema,
} from '../contracts/worktrees.ts';
import type { WorktreeRecord, WorktreeSource } from '../contracts/worktrees.ts';
import type { WorkbenchActor, RecordAuthor } from '../contracts/workbench.ts';
import type { SessionCatalog } from './session-catalog.ts';
import type { WorkbenchCatalog } from './workbench-catalog.ts';
import type { ExecutionCatalog } from './execution-catalog.ts';
import { ProjectError } from '../services/errors.ts';
import { transaction } from './transaction.ts';
import { withinPath } from '../services/write-scopes.ts';
const stamp = () => new Date().toISOString(),
  hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function migrateWorktrees(db: DatabaseSync) {
  db.exec(
    `CREATE TABLE worktree_record(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,data TEXT NOT NULL);CREATE TABLE worktree_event(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,worktree_id TEXT NOT NULL REFERENCES worktree_record(id),data TEXT NOT NULL);PRAGMA user_version=17;`,
  );
}
export class WorktreeCatalog {
  private readonly db: DatabaseSync;
  private readonly sessions: SessionCatalog;
  private readonly wb: WorkbenchCatalog;
  private readonly executions: ExecutionCatalog;
  private readonly root: string;
  private readonly controls: ControlCatalog;
  private gitGuard: ((commonDir: string) => void) | undefined;
  constructor(
    db: DatabaseSync,
    sessions: SessionCatalog,
    wb: WorkbenchCatalog,
    executions: ExecutionCatalog,
    root: string,
    controls: ControlCatalog,
  ) {
    this.db = db;
    this.sessions = sessions;
    this.wb = wb;
    this.executions = executions;
    this.root = root;
    this.controls = controls;
  }
  private raw(id: string): WorktreeRecord {
    const row = this.db.prepare('SELECT data FROM worktree_record WHERE id=?').get(id);
    if (!row) throw new ProjectError('WORKTREE_NOT_FOUND', '原工作树记录不存在');
    return worktreeRecordSchema.parse(JSON.parse(String(row.data)));
  }
  private save(v: WorktreeRecord) {
    v.updatedAt = stamp();
    this.db.prepare('UPDATE worktree_record SET data=? WHERE id=?').run(JSON.stringify(v), v.id);
  }
  private event(v: WorktreeRecord, kind: string, actor: RecordAuthor, data: unknown) {
    const e = { id: randomUUID(), kind, actor, data, at: stamp() };
    this.db
      .prepare('INSERT INTO worktree_event(id,worktree_id,data) VALUES(?,?,?)')
      .run(e.id, v.id, JSON.stringify(e));
  }
  get(actor: WorkbenchActor, id: string) {
    const v = this.raw(id),
      a = this.wb.author(actor);
    const relatedTickets = [v.ticketId, ...v.associations.map((a) => a.ticketId)];
    const helper =
      actor.kind === 'session' &&
      relatedTickets.some(
        (ticket) =>
          !!this.db
            .prepare(
              'SELECT c.id FROM collaboration c JOIN execution e ON e.id=c.execution_id WHERE c.session_id=? AND e.ticket_id=?',
            )
            .get(actor.sessionId, ticket),
      );
    const reviewer =
      actor.kind === 'session' &&
      relatedTickets.some(
        (ticket) =>
          !!this.db
            .prepare(
              "SELECT id FROM review WHERE json_extract(data,'$.sessionId')=? AND json_extract(data,'$.ticketId')=?",
            )
            .get(actor.sessionId, ticket),
      );
    if (
      !helper &&
      !reviewer &&
      actor.kind !== 'user' &&
      a.roleType !== 'supervisor' &&
      actor.sessionId !== v.creatorSessionId &&
      !this.executions
        .list()
        .some(
          (e) =>
            e.sessionId === actor.sessionId &&
            (e.ticketId === v.ticketId || v.associations.some((a) => a.executionId === e.id)),
        )
    )
      throw new ProjectError('WORKTREE_READ_SCOPE', '不是原票或关联执行的工作树');
    return v;
  }
  list(actor: WorkbenchActor) {
    return this.db
      .prepare('SELECT id FROM worktree_record ORDER BY rowid')
      .all()
      .map((r) => this.raw(String(r.id)))
      .filter((v) => {
        try {
          this.get(actor, v.id);
          return true;
        } catch (e) {
          if (e instanceof ProjectError && e.code === 'WORKTREE_READ_SCOPE') return false;
          throw e;
        }
      });
  }
  history(actor: WorkbenchActor, id: string) {
    this.get(actor, id);
    return this.db
      .prepare('SELECT data FROM worktree_event WHERE worktree_id=? ORDER BY seq')
      .all(id)
      .map((r) => JSON.parse(String(r.data)) as unknown);
  }
  source(actor: WorkbenchActor, ticketId?: string) {
    const a = this.wb.author(actor);
    if (actor.kind !== 'session')
      throw new ProjectError('WORKTREE_ACTOR', '创建须来自主管或本次开发/调查主执行');
    const s = this.sessions.get(actor.sessionId);
    if (s.status !== 'bound' || s.communicationState !== 'active' || s.error)
      throw new ProjectError('WORKTREE_CONTROLLED', '原会话未绑定、受控或异常');
    if (a.roleType === 'supervisor') {
      if (!ticketId) throw new ProjectError('WORKTREE_TICKET', '主管准备须明确本票');
      const ticket = this.wb.getTicket(ticketId);
      return { author: a, session: s, ticket, execution: null };
    }
    const e = this.executions.currentForSession(s.id);
    if (
      !e ||
      !['developer', 'investigator'].includes(s.roleType) ||
      e.lifecycleState !== 'active' ||
      e.waitingReviewId ||
      e.failure ||
      (ticketId && ticketId !== e.ticketId)
    )
      throw new ProjectError(
        'WORKTREE_MAIN_REQUIRED',
        '只有本次开发/调查主执行创建；辅助、审阅和提交不从类型名推定权限',
      );
    return { author: a, session: s, ticket: this.wb.getTicket(e.ticketId), execution: e };
  }
  existing(actor: WorkbenchActor, raw: unknown) {
    const input = worktreeCreateSchema.parse(raw);
    this.source(actor, input.ticketId);
    const row = this.db
      .prepare('SELECT id,request_hash FROM worktree_record WHERE operation_id=?')
      .get(input.operationId);
    if (!row) return undefined;
    if (row.request_hash !== hash({ actor, input }))
      throw new ProjectError('WORKTREE_OPERATION', '原创建身份已使用但输入或来源不同');
    return this.get(actor, String(row.id));
  }
  reserve(
    actor: WorkbenchActor,
    raw: unknown,
    rawSource: WorktreeSource,
    nativeSessionId: string,
    originalCwd: string,
    expectedPath?: string,
    nativeCallId?: string,
  ) {
    const input = worktreeCreateSchema.parse(raw),
      s = this.source(actor, input.ticketId),
      source = worktreeSourceSchema.parse(rawSource),
      old = this.existing(actor, input);
    if (old) return old;
    const known = [this.root, ...this.executions.list().flatMap((e) => e.additionalRepositories)];
    if (!known.some((root) => withinPath(root, source.repository)))
      throw new ProjectError('WORKTREE_REPOSITORY', '来源不属于固定项目或明确其他仓库');
    if (s.session.nativeSessionId !== nativeSessionId)
      throw new ProjectError('WORKTREE_NATIVE_SOURCE', '不是实际绑定原生会话');
    return transaction(this.db, () => {
      const old = this.existing(actor, input);
      if (old) return old;
      if (
        this.list({ kind: 'user' }).some(
          (v) =>
            v.source.commonDir === source.commonDir &&
            ['reserved', 'creating', 'unknown', 'removing'].includes(v.status),
        )
      )
        throw new ProjectError(
          'WORKTREE_PENDING',
          '原共同仓库有创建或未知结果，先沿原记录核对，不重建',
        );
      this.gitGuard?.(source.commonDir);
      const name = input.name ?? 'mat-' + input.operationId.slice(0, 8);
      if (
        !/^[a-z0-9][a-z0-9/-]*$/.test(name) ||
        name.includes('..') ||
        name.split('/').some((p) => !p)
      )
        throw new ProjectError('WORKTREE_NAME', '名称须为清楚英文/数字及连字符，不使用路径越界');
      const v: WorktreeRecord = {
        id: randomUUID(),
        operationId: input.operationId,
        actor: s.author,
        ticketId: s.ticket.id,
        executionId: s.execution?.id ?? null,
        controlRevision: s.execution ? this.controls.revision(s.execution.id) : null,
        nativeCallId: nativeCallId ?? null,
        ranges: [],
        creatorSessionId: s.session.id,
        nativeSessionId,
        originalCwd,
        basis: input.basis,
        name,
        source,
        path: expectedPath ?? null,
        branch: null,
        status: 'reserved',
        revision: 1,
        phases: [],
        error: null,
        directoryPublication: 'pending',
        restore: { required: s.session.roleType === 'supervisor', confirmed: false, error: null },
        associations: [],
        lastInspection: null,
        createdAt: stamp(),
        updatedAt: stamp(),
        retention: 'retain',
        cleanup: null,
      };
      this.db
        .prepare('INSERT INTO worktree_record(id,operation_id,request_hash,data) VALUES(?,?,?,?)')
        .run(v.id, input.operationId, hash({ actor, input }), JSON.stringify(v));
      this.event(v, 'reserved', s.author, { input, source });
      return v;
    });
  }
  phase(id: string, name: string) {
    const v = this.raw(id);
    if (!['reserved', 'creating'].includes(v.status)) return v;
    v.status = 'creating';
    v.phases.push({ name, at: stamp() });
    this.save(v);
    return v;
  }
  ready(
    id: string,
    path: string,
    branch: string,
    head: string,
    restored: boolean,
    author?: RecordAuthor,
  ) {
    const v = this.raw(id);
    if (v.cleanup || !['reserved', 'creating', 'unknown', 'missing'].includes(v.status)) return v;
    v.path = path;
    v.branch = branch;
    v.lastInspection = { head, path, at: stamp() };
    v.directoryPublication = 'confirmed';
    v.restore.confirmed = !v.restore.required || restored;
    if (v.restore.required && !restored)
      throw new ProjectError('WORKTREE_DIRECTORY_UNKNOWN', '主管原目录恢复尚未核定');
    v.status = 'ready';
    v.error = null;
    v.revision++;
    this.save(v);
    this.event(v, 'ready', author ?? v.actor, { path, branch, head, restored });
    return v;
  }
  problem(id: string, error: string, path?: string, author?: RecordAuthor) {
    const v = this.raw(id);
    if (['ready', 'retained', 'removed'].includes(v.status) || v.cleanup) {
      this.event(v, 'late-creation-observation', author ?? v.actor, { error, path });
      return v;
    }
    v.status = 'unknown';
    v.error = error;
    v.directoryPublication = 'unknown';
    if (path) v.path = path;
    v.revision++;
    this.save(v);
    this.event(v, 'unknown', author ?? v.actor, { error, path });
    return v;
  }
  associate(
    actor: WorkbenchActor,
    id: string,
    executionId: string,
    head: string,
    observation?: { changes: WorktreeSource['changes']; indexPaths: string[] },
  ) {
    const v = this.get(actor, id),
      e = this.executions.get(executionId),
      author = this.wb.author(actor);
    if (!['ready', 'retained'].includes(v.status) || !v.path || !withinPath(v.path, e.cwd))
      throw new ProjectError('WORKTREE_ASSOCIATION', '原工作树尚未核定或执行不在该树');
    if (
      actor.kind !== 'session' ||
      (author.roleType !== 'supervisor' && actor.sessionId !== e.sessionId)
    )
      throw new ProjectError('WORKTREE_ASSOCIATION', '仅主管或本次原主关联本票');
    if (!v.associations.some((a) => a.executionId === e.id)) {
      v.associations.push({
        ticketId: e.ticketId,
        executionId: e.id,
        cwd: e.cwd,
        head,
        baselineVersionId: null,
        changes: observation?.changes ?? [],
        indexPaths: observation?.indexPaths ?? [],
        author,
        at: stamp(),
      });
      v.revision++;
      this.save(v);
      this.event(v, 'associated', author, { executionId, head });
    }
    return v;
  }
  baselineLinked(id: string, executionId: string, versionId: string, head: string) {
    const v = this.raw(id),
      a = v.associations.find((a) => a.executionId === executionId);
    if (!a || a.head !== head)
      throw new ProjectError(
        'WORKTREE_BASELINE_CHANGED',
        '实际Git基线在启动采样期间已变化，未创建Goal',
      );
    if (a.baselineVersionId && a.baselineVersionId !== versionId)
      throw new ProjectError('WORKTREE_BASELINE_REBIND', '已关联实际基线，不重绑原件');
    a.baselineVersionId = versionId;
    this.save(v);
  }
  pendingForExecution(id: string) {
    return this.list({ kind: 'user' }).find(
      (v) =>
        v.executionId === id && ['reserved', 'creating', 'unknown', 'missing'].includes(v.status),
    );
  }
  cleanupExisting(actor: WorkbenchActor, id: string, raw: unknown) {
    const input = worktreeCleanupInputSchema.parse(raw),
      v = this.get(actor, id),
      author = this.wb.author(actor);
    if (
      actor.kind !== 'session' ||
      author.roleType !== 'supervisor' ||
      this.sessions.get(actor.sessionId).status !== 'bound' ||
      this.sessions.get(actor.sessionId).communicationState !== 'active'
    )
      throw new ProjectError('WORKTREE_CLEANUP_MANAGER', '清理须由实际主管在明确授权内安排');
    const h = hash({ actor, id, input });
    if (v.cleanup?.operationId === input.operationId) {
      if (v.cleanup.requestHash !== h)
        throw new ProjectError('WORKTREE_OPERATION', '原清理操作身份已使用但来源/内容不同');
      return v;
    }
    if (v.status === 'removed') return v;
    if (v.cleanup && ['running', 'unknown'].includes(v.cleanup.state))
      throw new ProjectError('WORKTREE_CLEANUP_UNKNOWN', '原清理结果未核定，先回读，不再次remove');
    return undefined;
  }
  cleanupStart(
    actor: WorkbenchActor,
    id: string,
    raw: unknown,
    nativeSessionId: string,
    callId?: string,
  ) {
    const input = worktreeCleanupInputSchema.parse(raw),
      old = this.cleanupExisting(actor, id, input);
    if (old) return old;
    const v = this.get(actor, id),
      author = this.wb.author(actor);
    if (v.revision !== input.expectedRevision || !['ready', 'retained'].includes(v.status))
      throw new ProjectError('WORKTREE_REVISION', '工作树记录已变化或尚未核定，先回读');
    if (
      actor.kind !== 'session' ||
      this.sessions.get(actor.sessionId).nativeSessionId !== nativeSessionId
    )
      throw new ProjectError('WORKTREE_NATIVE_SOURCE', '清理不是实际主管原生会话');
    this.gitGuard?.(v.source.commonDir);
    if (
      this.list({ kind: 'user' }).some(
        (other) =>
          other.id !== id &&
          other.source.commonDir === v.source.commonDir &&
          ['reserved', 'creating', 'unknown', 'removing'].includes(other.status),
      )
    )
      throw new ProjectError('WORKTREE_GIT_BUSY', '原共同仓库仍有未核定创建或清理，先沿原记录核对');
    v.cleanup = {
      operationId: input.operationId,
      requestHash: hash({ actor, id, input }),
      actor: author,
      basis: input.basis,
      head: input.expectedHead,
      nativeSessionId,
      nativeCallId: callId ?? null,
      state: 'running',
      ranges: [],
      process: null,
      proof: null,
      error: null,
      createdAt: stamp(),
    };
    v.status = 'removing';
    v.revision++;
    this.save(v);
    this.event(v, 'cleanup-started', author, { input, nativeSessionId, callId });
    return v;
  }
  cleanupResult(
    id: string,
    process: NonNullable<WorktreeRecord['cleanup']>['process'],
    proof: NonNullable<WorktreeRecord['cleanup']>['proof'],
    error: string | null,
    author?: RecordAuthor,
  ) {
    const v = this.raw(id),
      cleanup = v.cleanup;
    if (!cleanup) throw new ProjectError('WORKTREE_CLEANUP_MISSING', '没有原明确清理安排');
    if (cleanup.state === 'removed') return v;
    if (process) cleanup.process = process;
    if (proof) cleanup.proof = proof;
    cleanup.error = error;
    const stopped =
      cleanup.process?.rangeGone ||
      (cleanup.ranges.length > 0 && cleanup.ranges.every((r) => r.state === 'gone'));
    if (proof?.removed && proof.branchRetained && proof.retainedEvidence && stopped) {
      cleanup.state = 'removed';
      v.status = 'removed';
    } else {
      cleanup.state = 'unknown';
      v.status = 'unknown';
    }
    v.revision++;
    this.save(v);
    this.event(
      v,
      v.status === 'removed' ? 'cleanup-removed' : 'cleanup-unknown',
      author ?? cleanup.actor,
      { process: cleanup.process, proof: cleanup.proof, error },
    );
    return v;
  }
  cleanupRetained(
    id: string,
    proof: NonNullable<NonNullable<WorktreeRecord['cleanup']>['proof']>,
    author: RecordAuthor,
  ) {
    const v = this.raw(id);
    if (!v.cleanup || v.cleanup.state === 'removed') return v;
    v.cleanup.state = 'failed';
    v.cleanup.proof = proof;
    v.cleanup.error = '独立回读确认原检出完整保留，本次清理未发生；原命令结果另存';
    v.status = 'retained';
    v.revision++;
    this.save(v);
    this.event(v, 'cleanup-retained', author, { proof, process: v.cleanup.process });
    return v;
  }
  bindGitGuard(guard: (commonDir: string) => void) {
    this.gitGuard = guard;
  }
  saveManagedRange(session: string, fact: WorktreeRecord['ranges'][number]) {
    const values = this.list({ kind: 'user' }),
      cleanup = values.findLast(
        (v) =>
          v.cleanup?.actor.sessionId === session &&
          v.cleanup.nativeSessionId === fact.nativeOwner &&
          v.cleanup.nativeCallId === fact.callId &&
          ['running', 'unknown'].includes(v.cleanup.state),
      );
    if (cleanup?.cleanup) {
      const ranges = cleanup.cleanup.ranges,
        index = ranges.findIndex((r) => r.id === fact.id);
      if (index < 0) ranges.push(fact);
      else ranges[index] = fact;
      this.save(cleanup);
      return;
    }
    const v = values.findLast(
      (v) =>
        v.creatorSessionId === session &&
        v.nativeSessionId === fact.nativeOwner &&
        v.nativeCallId === fact.callId &&
        ['reserved', 'creating', 'unknown'].includes(v.status),
    );
    if (!v) return;
    const index = v.ranges.findIndex((r) => r.id === fact.id);
    if (index < 0) v.ranges.push(fact);
    else v.ranges[index] = fact;
    this.save(v);
  }
  missing(id: string, note: string) {
    const v = this.raw(id);
    if (['missing', 'removed', 'removing'].includes(v.status)) return v;
    v.status = 'missing';
    v.error = note;
    v.revision++;
    this.save(v);
    this.event(v, 'missing', v.actor, { note });
    return v;
  }
  busyRepository(commonDir: string) {
    return this.list({ kind: 'user' }).some(
      (v) =>
        v.source.commonDir === commonDir &&
        ['reserved', 'creating', 'unknown', 'removing'].includes(v.status),
    );
  }
}
