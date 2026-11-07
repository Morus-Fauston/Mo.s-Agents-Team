import { createHash } from 'node:crypto';
import { join, relative, resolve } from 'node:path';
import { realpathSync, lstatSync } from 'node:fs';
import type { NativeAgent } from '../host/native.ts';
import type { WorkbenchActor } from '../contracts/workbench.ts';
import type { WorktreeRecord } from '../contracts/worktrees.ts';
import {
  worktreeCreateSchema,
  worktreeResultSchema,
  worktreeReconcileSchema,
  worktreeCleanupInputSchema,
} from '../contracts/worktrees.ts';
import type { ProjectService } from './project-service.ts';
import {
  inspectWorktreeSource,
  inspectRegisteredWorktree,
  assertWorktreeDestinationUnused,
  inspectWorktreeCleanup,
  inspectWorktreeRemoval,
  verifyRetainedGitSnapshots,
} from './local-git.ts';
import { canonicalDirectory, canonicalWriteScope, withinPath } from './write-scopes.ts';
import { ProjectError } from './errors.ts';
export interface WorktreeHost {
  remove?(
    agent: NativeAgent,
    source: string,
    path: string,
    signal: AbortSignal,
  ): Promise<{ exitCode: number | null; output: string; rangeGone: boolean }>;
  poolDirectory: string | undefined;
  peek(project: string, session: string): NativeAgent | undefined;
  directory(agent: NativeAgent): string;
  setDirectory(agent: NativeAgent, path: string): Promise<string>;
  flush(agent: NativeAgent): Promise<boolean>;
  safe(
    project: string,
    session: string,
    callId?: string,
    executionId?: string,
  ): { state: 'confirmed' | 'unknown'; note: string };
  create(
    agent: NativeAgent,
    input: { name: string; from: string },
    signal: AbortSignal,
    onPhase: (phase: string) => void,
  ): Promise<unknown>;
}
const key = (v: string) => (process.platform === 'win32' ? v.toLowerCase() : v);
export class WorktreeService {
  private readonly projects: ProjectService;
  private readonly host: WorktreeHost;
  private readonly lifetime = new AbortController();
  private readonly runs = new Map<string, { hash: string; promise: Promise<WorktreeRecord> }>();
  private readonly other = new Set<Promise<unknown>>();
  private closed = false;
  constructor(projects: ProjectService, host: WorktreeHost) {
    this.projects = projects;
    this.host = host;
  }
  get available() {
    return !!this.host.poolDirectory;
  }
  private agent(project: string, session: string) {
    const c = this.projects.forProject(project),
      agent = this.host.peek(project, session);
    if (!agent || c.session(session).nativeSessionId !== agent.id)
      throw new ProjectError('WORKTREE_NATIVE_MISSING', '原实际会话未加载，不另开替代');
    return agent;
  }
  private safe(project: string, session: string, callId?: string, executionId?: string) {
    const s = this.host.safe(project, session, callId, executionId);
    if (s.state !== 'confirmed') throw new ProjectError('WORKTREE_NATIVE_BUSY', s.note);
  }
  create(
    project: string,
    actor: WorkbenchActor,
    raw: unknown,
    callId?: string,
    signal?: AbortSignal,
  ): Promise<WorktreeRecord> {
    if (this.closed)
      return Promise.reject(new ProjectError('WORKTREE_CLOSED', '工作树服务正在关闭'));
    const input = worktreeCreateSchema.parse(raw),
      id = project + ':' + input.operationId,
      h = createHash('sha256').update(JSON.stringify({ actor, input })).digest('hex'),
      old = this.runs.get(id);
    if (old) {
      if (old.hash !== h)
        return Promise.reject(new ProjectError('WORKTREE_OPERATION', '原创建身份的来源或输入不同'));
      return old.promise;
    }
    const promise = this.createOnce(project, actor, input, callId, signal);
    this.runs.set(id, { hash: h, promise });
    return promise.finally(() => {
      if (this.runs.get(id)?.promise === promise) this.runs.delete(id);
    });
  }
  private async createOnce(
    project: string,
    actor: WorkbenchActor,
    input: ReturnType<typeof worktreeCreateSchema.parse>,
    callId?: string,
    signal?: AbortSignal,
  ) {
    const c = this.projects.forProject(project),
      catalog = c.worktrees(),
      prior = catalog.existing(actor, input);
    if (prior) return prior;
    const s = catalog.source(actor, input.ticketId),
      agent = this.agent(project, s.session.id);
    c.controls().requireDispatch();
    if (!this.host.poolDirectory)
      throw new ProjectError(
        'WORKTREE_UNAVAILABLE',
        '当前宿主没有已核对的官方worktrees服务配置，不启动替代服务',
      );
    this.safe(project, s.session.id, callId, s.execution?.id);
    const originalCwd = this.host.directory(agent),
      requested = canonicalDirectory(input.repository ?? originalCwd),
      known = [
        c.snapshot().root,
        ...c
          .executions()
          .list()
          .flatMap((e) => e.additionalRepositories),
      ];
    if (!known.some((root) => withinPath(root, requested)))
      throw new ProjectError('WORKTREE_REPOSITORY', '创建前须明确固定项目或其他已授权仓库');
    const source = await inspectWorktreeSource(requested, input.from),
      name = input.name ?? 'mat-' + input.operationId.slice(0, 8);
    if (s.execution) {
      if (s.execution.worktreeId) {
        const existing = catalog.get(actor, s.execution.worktreeId);
        if (
          (input.name && input.name !== existing.name) ||
          (input.from && source.commit !== existing.source.commit)
        )
          throw new ProjectError(
            'WORKTREE_ALREADY_ASSOCIATED',
            '原票已有工作树，不从新名称或基线自动迁移；先交主管协调',
          );
        return existing;
      }
      if (!withinPath(source.repository, s.execution.cwd))
        throw new ProjectError('WORKTREE_SOURCE_MISMATCH', '原主只能从本次实际源码仓库创建');
      c.versions().assertSourceUnchanged(s.execution.id);
      if (
        c
          .collaborations()
          .list()
          .some((a) => a.executionId === s.execution!.id && a.state !== 'completed')
      )
        throw new ProjectError(
          'WORKTREE_ASSISTANTS_ACTIVE',
          '仍有本票活动协作，先协调共树，不搬迁在途工作',
        );
    }
    const declared = resolve(source.repository, this.host.poolDirectory, name),
      expected = canonicalWriteScope(declared);
    if (key(expected) !== key(declared) || !withinPath(source.repository, expected))
      throw new ProjectError('WORKTREE_POOL_SCOPE', '官方池目录或祖先含链接/越界，未扩大源码授权');
    await assertWorktreeDestinationUnused(source.repository, expected, name);
    catalog.source(actor, input.ticketId);
    if (
      key(canonicalDirectory(this.host.directory(agent))) !== key(canonicalDirectory(originalCwd))
    )
      throw new ProjectError('WORKTREE_CWD_CHANGED', '只读核对期间原调用会话cwd已变化，未继续创建');
    c.controls().requireDispatch();
    this.safe(project, s.session.id, callId, s.execution?.id);
    if (c.localCommits().busyRepository(source.commonDir))
      throw new ProjectError('WORKTREE_GIT_BUSY', '原共同仓库仍有本地提交事项，先沿原记录核定');
    const value = catalog.reserve(actor, input, source, agent.id, originalCwd, expected, callId);
    let path: string | undefined = expected;
    try {
      const opSignal = signal
        ? AbortSignal.any([signal, this.lifetime.signal])
        : this.lifetime.signal;
      opSignal.throwIfAborted();
      await this.host.setDirectory(agent, source.repository);
      this.safe(project, s.session.id, callId, s.execution?.id);
      if (key(canonicalDirectory(this.host.directory(agent))) !== key(source.repository))
        throw new ProjectError('WORKTREE_CWD_CHANGED', '官方创建前源码仓库目录未核定');
      catalog.phase(value.id, 'native-create');
      const result = worktreeResultSchema.parse(
        await this.host.create(
          agent,
          { name: value.name, from: source.commit },
          opSignal,
          (phase) => {
            catalog.phase(value.id, phase);
          },
        ),
      );
      path = result.path;
      if (
        key(canonicalDirectory(path)) !== key(expected) ||
        key(canonicalDirectory(result.repositoryRoot)) !== key(source.repository) ||
        result.branch !== value.name ||
        result.baseCommit !== source.commit
      )
        throw new ProjectError(
          'WORKTREE_NATIVE_RESULT',
          '官方返回不对应原准确目录/分支/基线，保留产物待核对',
        );
      await this.finish(project, actor, catalog.get(actor, value.id), agent, callId);
      return catalog.get(actor, value.id);
    } catch (error) {
      return catalog.problem(
        value.id,
        error instanceof Error ? error.message : '官方创建结果未知',
        path,
      );
    }
  }
  private async finish(
    project: string,
    actor: WorkbenchActor,
    value: WorktreeRecord,
    agent: NativeAgent,
    callId?: string,
  ) {
    const c = this.projects.forProject(project),
      catalog = c.worktrees();
    if (!value.path)
      throw new ProjectError('WORKTREE_PATH_UNKNOWN', '原创建没有可核对目录，不重建');
    const actual = await inspectRegisteredWorktree(value.source.repository, value.path);
    if (actual.head !== value.source.commit || actual.branch !== 'refs/heads/' + value.name)
      throw new ProjectError(
        'WORKTREE_BASELINE_MISMATCH',
        '原创建目录不再对应明确基线/分支，先协调',
      );
    this.safe(project, value.creatorSessionId, callId, value.executionId ?? undefined);
    if (c.session(value.creatorSessionId).nativeSessionId !== agent.id)
      throw new ProjectError('WORKTREE_NATIVE_SOURCE', '原创建者实际绑定已变化');
    let restored = false;
    if (value.restore.required) {
      await this.host.setDirectory(agent, value.originalCwd);
      restored =
        key(canonicalDirectory(this.host.directory(agent))) ===
        key(canonicalDirectory(value.originalCwd));
      if (!restored) throw new ProjectError('WORKTREE_RESTORE_UNKNOWN', '主管原cwd恢复未核定');
    } else if (value.executionId) {
      const e = c.executions().get(value.executionId);
      if (
        e.lifecycleState !== 'active' ||
        e.waitingReviewId ||
        c.controls().revision(e.id) !== value.controlRevision
      )
        throw new ProjectError(
          'WORKTREE_EXECUTION_CHANGED',
          '原执行责任或控制已变化，不推进工作树',
        );
      if (actual.changes.length)
        throw new ProjectError('WORKTREE_BASELINE_DIRTY', '新树已有未核定变化，不能晚拍为创建基线');
      c.versions().assertSourceUnchanged(e.id, value.originalCwd);
      const desired = join(actual.path, relative(value.source.repository, value.originalCwd));
      await this.host.setDirectory(agent, desired);
    }
    if (!(await this.host.flush(agent)))
      throw new ProjectError(
        'WORKTREE_PUBLICATION_UNKNOWN',
        '原目录事件未确认持久接纳，保留原创建先回读',
      );
    if (this.closed) throw new ProjectError('WORKTREE_CLOSED', '宿主关闭期间只保留已观察产物');
    this.safe(project, value.creatorSessionId, callId, value.executionId ?? undefined);
    if (value.executionId) {
      c.controls().requireDispatch();
      const e = c.executions().get(value.executionId),
        desired = join(actual.path, relative(value.source.repository, value.originalCwd));
      c.executions().worktreeEntered(
        e.id,
        value.id,
        value.source.repository,
        actual.path,
        value.originalCwd,
        desired,
      );
      c.versions().workspaceBaseline(actor, e.id, value.id);
    }
    catalog.ready(
      value.id,
      actual.path,
      value.name,
      actual.head,
      restored,
      c.workbench().author(actor),
    );
    if (value.executionId) catalog.associate(actor, value.id, value.executionId, actual.head);
  }
  reconcile(project: string, actor: WorkbenchActor, id: string, raw: unknown, callId?: string) {
    if (this.closed)
      return Promise.reject(new ProjectError('WORKTREE_CLOSED', '工作树服务正在关闭'));
    const run = (async () => {
      const input = worktreeReconcileSchema.parse(raw),
        c = this.projects.forProject(project),
        catalog = c.worktrees(),
        value = catalog.get(actor, id),
        author = c.workbench().author(actor);
      if (
        actor.kind !== 'session' ||
        (author.roleType !== 'supervisor' && actor.sessionId !== value.creatorSessionId)
      )
        throw new ProjectError('WORKTREE_RECONCILE', '只有主管或原创建者核对原记录');
      if (['ready', 'retained', 'removed'].includes(value.status)) return value;
      if (value.revision !== input.expectedRevision)
        throw new ProjectError('WORKTREE_REVISION', '原创建已更新，先回读');
      if (value.cleanup) return this.reconcileCleanup(project, actor, value);
      const agent = this.agent(project, value.creatorSessionId);
      try {
        await this.finish(
          project,
          actor,
          value,
          agent,
          actor.sessionId === value.creatorSessionId ? callId : undefined,
        );
        return catalog.get(actor, id);
      } catch (error) {
        return catalog.problem(
          id,
          error instanceof Error ? error.message : '原工作树核定仍未知',
          undefined,
          author,
        );
      }
    })();
    this.other.add(run);
    return run.finally(() => this.other.delete(run));
  }
  private async retainedEvidence(project: string, value: WorktreeRecord) {
    const c = this.projects.forProject(project);
    if (
      !value.path ||
      withinPath(value.path, c.snapshot().root) ||
      withinPath(value.path, c.versions().storage) ||
      withinPath(value.path, value.source.commonDir)
    )
      throw new ProjectError(
        'WORKTREE_UNIQUE_EVIDENCE',
        '待清理路径包含固定项目、材料或Git共同目录，不清理',
      );
    const roots: Parameters<typeof verifyRetainedGitSnapshots>[1] = [];
    for (const e of c.executions().list())
      for (const version of c.versions().list(e.id))
        for (let index = 0; index < version.snapshot.roots.length; index++) {
          const root = version.snapshot.roots[index]!;
          if (root.commonDir && withinPath(value.path, root.commonDir))
            throw new ProjectError(
              'WORKTREE_UNIQUE_EVIDENCE',
              '有固定原件的Git目录仍位于待清理树中',
            );
          if (!withinPath(value.path, root.root)) continue;
          if (root.kind === 'git') roots.push(root);
          else for (const file of root.files) c.versions().file(version.id, index, file.path);
        }
    await verifyRetainedGitSnapshots(value.source.commonDir, roots);
  }
  private cleanupResponsibilities(project: string, value: WorktreeRecord) {
    const c = this.projects.forProject(project),
      ids = new Set(value.associations.map((a) => a.executionId)),
      sessions = new Set<string>();
    for (const e of c.executions().list()) {
      if (
        value.path &&
        (withinPath(value.path, e.cwd) ||
          e.additionalRepositories.some((p) => withinPath(value.path!, p)) ||
          e.worktreeId === value.id)
      ) {
        ids.add(e.id);
        if (!['closed', 'terminated'].includes(e.lifecycleState) || e.writeOccupancy !== 'released')
          throw new ProjectError('WORKTREE_EXECUTION_BUSY', '工作树仍有未收尾执行/写域，不清理');
        if (e.sessionId) sessions.add(e.sessionId);
      }
    }
    for (const a of c.collaborations().list())
      if (ids.has(a.executionId)) {
        if (a.state !== 'completed')
          throw new ProjectError('WORKTREE_ASSISTANTS_ACTIVE', '仍有本票活动协作，不清理');
        if (a.sessionId) sessions.add(a.sessionId);
      }
    for (const r of c.reviews().list())
      if (ids.has(r.executionId)) {
        if (r.status !== 'decided' || r.closure?.state !== 'confirmed')
          throw new ProjectError('WORKTREE_REVIEW_ACTIVE', '仍有正式独审或停稳未核定，不清理');
        if (r.sessionId) sessions.add(r.sessionId);
      }
    for (const id of sessions) {
      const agent = this.host.peek(project, id);
      if (!agent) {
        const s = c.session(id);
        if (s.status === 'bound')
          throw new ProjectError('WORKTREE_NATIVE_MISSING', '相关原生会话未加载，不能猜测后台已停');
        continue;
      }
      if (value.path && withinPath(value.path, this.host.directory(agent))) this.safe(project, id);
    }
  }
  cleanup(
    project: string,
    actor: WorkbenchActor,
    id: string,
    raw: unknown,
    callId?: string,
    signal?: AbortSignal,
  ) {
    if (this.closed) return Promise.reject(new ProjectError('WORKTREE_CLOSED', '工作树服务已关闭'));
    const run = (async () => {
      const input = worktreeCleanupInputSchema.parse(raw),
        c = this.projects.forProject(project),
        catalog = c.worktrees(),
        old = catalog.cleanupExisting(actor, id, input);
      if (old) return old;
      if (actor.kind !== 'session')
        throw new ProjectError('WORKTREE_CLEANUP_MANAGER', '仅实际主管清理');
      c.controls().requireDispatch();
      let value = catalog.get(actor, id);
      if (
        value.revision !== input.expectedRevision ||
        !value.path ||
        !['ready', 'retained'].includes(value.status)
      )
        throw new ProjectError('WORKTREE_REVISION', '原记录已变化，先回读');
      if (!this.host.remove)
        throw new ProjectError(
          'WORKTREE_REMOVAL_UNAVAILABLE',
          '当前宿主没有已核对的受管Git清理接缝，不启动替代服务',
        );
      const agent = this.agent(project, actor.sessionId);
      this.safe(project, actor.sessionId, callId);
      this.prepareDispatch(project, actor, id);
      this.cleanupResponsibilities(project, value);
      const observed = await inspectWorktreeCleanup(value.source.repository, value.path);
      if (
        observed.head !== input.expectedHead ||
        observed.branch !== 'refs/heads/' + value.name ||
        observed.commonDir !== value.source.commonDir
      )
        throw new ProjectError('WORKTREE_CLEANUP_HEAD', '准确分支/HEAD或共同仓库与清理安排不同');
      if (!observed.clean)
        throw new ProjectError(
          'WORKTREE_CLEANUP_DIRTY',
          '工作树有未提交、暂存或被忽略的文件，保留现场不清理',
        );
      if (!observed.merged)
        throw new ProjectError(
          'WORKTREE_CLEANUP_UNMERGED',
          '分支成果尚未合入共同源码HEAD，不删除唯一现场',
        );
      await this.retainedEvidence(project, value);
      if (this.closed) throw new ProjectError('WORKTREE_CLOSED', '核对期间服务关闭');
      c.controls().requireDispatch();
      this.safe(project, actor.sessionId, callId);
      this.cleanupResponsibilities(project, value);
      if (value.path && withinPath(value.path, this.host.directory(agent))) {
        await this.host.setDirectory(agent, value.source.repository);
        if (!(await this.host.flush(agent)))
          throw new ProjectError(
            'WORKTREE_PUBLICATION_UNKNOWN',
            '清理前主管离开目标目录的持久接纳未知，未删除检出',
          );
      }
      signal?.throwIfAborted();
      value = catalog.cleanupStart(actor, id, input, agent.id, callId);
      try {
        const process = await this.host.remove(
          agent,
          value.source.repository,
          value.path!,
          signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal,
        );
        catalog.cleanupResult(id, process, null, '原生清理已返回，仍待独立Git及证据回读');
        return await this.reconcileCleanup(project, actor, catalog.get(actor, id));
      } catch (error) {
        return catalog.cleanupResult(
          id,
          null,
          null,
          error instanceof Error ? error.message : '清理结果未知',
        );
      }
    })();
    this.other.add(run);
    return run.finally(() => this.other.delete(run));
  }
  private async reconcileCleanup(project: string, actor: WorkbenchActor, value: WorktreeRecord) {
    const c = this.projects.forProject(project),
      catalog = c.worktrees(),
      author = c.workbench().author(actor);
    if (actor.kind !== 'session' || author.roleType !== 'supervisor')
      throw new ProjectError('WORKTREE_CLEANUP_MANAGER', '清理结果由实际主管沿原记录核对');
    if (value.cleanup?.state === 'removed') return value;
    if (!value.cleanup || !value.path)
      throw new ProjectError('WORKTREE_CLEANUP_MISSING', '没有原清理记录');
    try {
      const proof = await inspectWorktreeRemoval(
        value.source.repository,
        value.path,
        value.name,
        value.cleanup.head,
      );
      if (!proof.removed || !proof.branchRetained) {
        const stopped =
          value.cleanup.process?.rangeGone ||
          (value.cleanup.ranges.length > 0 &&
            value.cleanup.ranges.every((r) => r.state === 'gone'));
        if (stopped && proof.registered && proof.branchRetained) {
          try {
            const intact = await inspectWorktreeCleanup(value.source.repository, value.path);
            if (
              intact.clean &&
              intact.merged &&
              intact.head === value.cleanup.head &&
              key(intact.path) === key(resolve(value.path))
            ) {
              await this.retainedEvidence(project, value);
              return catalog.cleanupRetained(
                value.id,
                { ...proof, retainedEvidence: true },
                author,
              );
            }
          } catch {
            /* Partial or uncertain removal stays unknown. */
          }
        }
        return catalog.cleanupResult(
          value.id,
          null,
          { ...proof, retainedEvidence: false },
          '原目录或登记仍存在，或原分支不符；保留未知，不再remove',
          author,
        );
      }
      await this.retainedEvidence(project, value);
      return catalog.cleanupResult(
        value.id,
        null,
        { ...proof, retainedEvidence: true },
        null,
        author,
      );
    } catch (error) {
      return catalog.cleanupResult(
        value.id,
        null,
        null,
        error instanceof Error ? error.message : '原清理证据仍未核定',
        author,
      );
    }
  }
  prepareDispatch(project: string, actor: WorkbenchActor, id: string, cwd?: string) {
    if (this.closed) throw new ProjectError('WORKTREE_CLOSED', '工作树服务已关闭');
    const c = this.projects.forProject(project),
      author = c.workbench().author(actor),
      v = c.worktrees().get(actor, id);
    if (actor.kind !== 'session' || author.roleType !== 'supervisor')
      throw new ProjectError('WORKTREE_DISPATCH', '续用须由实际主管明确派本票');
    if (!['ready', 'retained'].includes(v.status) || !v.path)
      throw new ProjectError('WORKTREE_UNCONFIRMED', '原工作树或目录未核定，不能回旧根派工');
    let path: string;
    try {
      path = canonicalDirectory(v.path);
      if (lstatSync(v.path).isSymbolicLink() || key(path) !== key(resolve(v.path)))
        throw new Error('工作树原路径已被链接或替换');
    } catch {
      c.worktrees().missing(v.id, '明确续用时目录已丢失');
      throw new ProjectError('WORKTREE_DIRECTORY_UNAVAILABLE', '原工作树目录缺失，不回旧根启动');
    }
    const target = canonicalDirectory(cwd ?? path);
    if (!withinPath(path, target))
      throw new ProjectError('WORKTREE_DISPATCH_SCOPE', '明确cwd不在原工作树内');
    return target;
  }
  admitExecution(project: string, executionId: string, cwd: string) {
    const run = this.admitExecutionOnce(project, executionId, cwd);
    this.other.add(run);
    return run.finally(() => this.other.delete(run));
  }
  private async admitExecutionOnce(project: string, executionId: string, cwd: string) {
    if (this.closed) throw new ProjectError('WORKTREE_CLOSED', '工作树服务已关闭');
    const c = this.projects.forProject(project),
      e = c.executions().get(executionId),
      catalog = c.worktrees();
    let v = e.worktreeId
      ? catalog.get({ kind: 'user' }, e.worktreeId)
      : catalog
          .list({ kind: 'user' })
          .filter((v) => v.path && withinPath(v.path, cwd))
          .sort((a, b) => b.path!.length - a.path!.length)[0];
    if (!v) return;
    if (!['ready', 'retained'].includes(v.status) || !v.path)
      throw new ProjectError('WORKTREE_UNCONFIRMED', '本次目录关联的原工作树未核定');
    const observed = await inspectRegisteredWorktree(v.source.repository, v.path);
    if (
      key(observed.path) !== key(resolve(v.path)) ||
      observed.commonDir !== v.source.commonDir ||
      observed.branch !== 'refs/heads/' + v.name ||
      !withinPath(observed.path, canonicalDirectory(cwd))
    )
      throw new ProjectError('WORKTREE_MEMBERSHIP', '本次目录、分支或共同仓库与原工作树不符');
    if (this.closed)
      throw new ProjectError('WORKTREE_CLOSED', '工作树核对期间宿主关闭，未继续启动');
    c.controls().requireDispatch();
    const latest = c.executions().get(executionId);
    if (latest.cwd !== cwd || latest.goalId)
      throw new ProjectError('WORKTREE_EXECUTION_CHANGED', '启动期间目录或Goal已变化');
    if (!latest.worktreeId) c.executions().linkStartupWorktree(executionId, v.id);
    if (e.actor.kind !== 'session' || !e.actor.sessionId)
      throw new ProjectError('WORKTREE_DISPATCH_SOURCE', '没有原实际主管派工来源');
    v = catalog.associate(
      { kind: 'session', sessionId: e.actor.sessionId },
      v.id,
      e.id,
      observed.head,
      observed,
    );
    return v;
  }
  confirmStartupBaseline(project: string, executionId: string, versionId: string) {
    const c = this.projects.forProject(project),
      e = c.executions().get(executionId);
    if (!e.worktreeId) return;
    const version = c.versions().get(versionId),
      source = version.snapshot.roots[0];
    if (!source?.head)
      throw new ProjectError('WORKTREE_BASELINE_UNKNOWN', '实际工作树启动基线缺少本地HEAD');
    c.worktrees().baselineLinked(e.worktreeId, executionId, versionId, source.head);
  }
  assertBusinessDirectory(project: string, session: string, actualCwd: string) {
    const c = this.projects.forProject(project),
      collaboration = c.collaborations().currentForSession(session),
      local = c.localCommits().currentForSession(session),
      merge = c.worktreeMerges().currentForSession(session),
      execution =
        c.executions().currentForSession(session) ??
        (collaboration ? c.executions().get(collaboration.executionId) : undefined),
      pending = execution ? c.worktrees().pendingForExecution(execution.id) : undefined;
    if (pending)
      throw new ProjectError(
        'WORKTREE_UNCONFIRMED',
        '原工作树创建/目录结果未核定，不回旧根展开业务',
      );
    const record = execution?.worktreeId
      ? c.worktrees().get({ kind: 'user' }, execution.worktreeId)
      : local
        ? c
            .worktrees()
            .list({ kind: 'user' })
            .find((v) => v.path && withinPath(v.path, local.plan.repository))
        : merge
          ? c
              .worktrees()
              .list({ kind: 'user' })
              .find((v) => v.path && withinPath(v.path, merge.preview.plan.target.repository))
          : undefined;
    if (!record) {
      if (
        merge &&
        (!lstatSync(merge.preview.plan.target.repository).isDirectory() ||
          lstatSync(merge.preview.plan.target.repository).isSymbolicLink() ||
          key(realpathSync(merge.preview.plan.target.repository)) !==
            key(resolve(merge.preview.plan.target.repository)))
      )
        throw new ProjectError(
          'MERGE_DIRECTORY_UNAVAILABLE',
          '原合入目录已替换或含链接，不继续办理Git',
        );
      if (
        merge &&
        key(canonicalDirectory(actualCwd)) !==
          key(canonicalDirectory(merge.preview.plan.target.repository))
      )
        throw new ProjectError(
          'MERGE_CWD_CHANGED',
          '原提交者目录偏离原合入目标，不在其他目录办理Git',
        );
      if (execution) {
        const expected = collaboration?.cwd ?? execution.cwd;
        canonicalDirectory(actualCwd);
        if (
          !(
            execution.cwdMode === 'preserve-current' &&
            ['registered', 'creating-session', 'session-prepared'].includes(execution.startupState)
          ) &&
          key(canonicalDirectory(actualCwd)) !== key(canonicalDirectory(expected))
        )
          throw new ProjectError('EXECUTION_CWD_CHANGED', '实际目录偏离本次执行，不回旧根继续业务');
      }
      return;
    }
    try {
      if (
        !['ready', 'retained'].includes(record.status) ||
        !record.path ||
        !lstatSync(record.path).isDirectory() ||
        lstatSync(record.path).isSymbolicLink() ||
        key(realpathSync(record.path)) !== key(resolve(record.path))
      )
        throw new Error('目录缺失、不是普通目录或记录未核定');
      const expected =
        collaboration?.cwd ??
        execution?.cwd ??
        local?.plan.repository ??
        merge!.preview.plan.target.repository;
      if (
        key(canonicalDirectory(actualCwd)) !== key(canonicalDirectory(expected)) ||
        !withinPath(record.path, actualCwd)
      )
        throw new Error('原生cwd偏离已关联空间');
    } catch (error) {
      c.worktrees().missing(
        record.id,
        error instanceof Error ? error.message : '工作树目录不可核对',
      );
      throw new ProjectError(
        'WORKTREE_DIRECTORY_UNAVAILABLE',
        '工作树目录缺失或偏离，不让原生ensure回退旧根继续业务',
      );
    }
  }
  async close() {
    this.closed = true;
    this.lifetime.abort(new Error('工作树服务关闭'));
    await Promise.allSettled(
      [...this.runs.values()]
        .map((r) => r.promise)
        .concat([...this.other] as Promise<WorktreeRecord>[]),
    );
  }
}
