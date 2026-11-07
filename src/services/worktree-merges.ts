import type { LocalCommitObservation } from './local-commits.ts';
import type { SavedMessage } from '../contracts/chat.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { WorkbenchActor } from '../contracts/workbench.ts';
import type { ProjectService } from './project-service.ts';
import type { ProjectConnection } from './project.ts';
import type { MergePreview, WorktreeMergeRecord } from '../contracts/worktree-merges.ts';
import {
  mergePreviewInputSchema,
  mergeArrangeInputSchema,
  mergeInspectInputSchema,
  mergeReportInputSchema,
  mergeReconcileInputSchema,
  mergeRepairInputSchema,
  mergeReviewLinkInputSchema,
} from '../contracts/worktree-merges.ts';
import {
  captureMergeGit,
  verifyMergeGit,
  captureMergeIndexTree,
  inspectMergeTargetRegistration,
} from './worktree-merge-git.ts';
import type { SnapshotRoot } from '../contracts/versions.ts';
import { resolve } from 'node:path';
import { inspectWorkspace, captureWorkspace } from './workspace-snapshot.ts';
import { ensureMergeMaterial } from './ticket-materials.ts';
import { canonicalDirectory, withinPath } from './write-scopes.ts';
import { ProjectError } from './errors.ts';
import { requireReviewedDelivery } from './delivery-approval.ts';
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex'),
  key = (v: string) => (process.platform === 'win32' ? v.toLowerCase() : v);
const rawFiles = (root: SnapshotRoot) =>
  root.files.map(({ path, sha256, mode, size }) => [path, sha256, mode, size]);
export interface WorktreeMergeHost {
  inspect?(
    project: string,
    session: string,
    callId?: string,
    value?: WorktreeMergeRecord,
  ): LocalCommitObservation;
  allowed?(project: string, session: string): boolean;
  notify?(project: string, id: string, noticeId: string): Promise<SavedMessage>;
}
export class WorktreeMergeService {
  private readonly projects: ProjectService;
  private readonly host: WorktreeMergeHost;
  private readonly runs = new Set<Promise<unknown>>();
  private readonly notifying = new Map<string, Promise<void>>();
  private closed = false;
  constructor(projects: ProjectService, host: WorktreeMergeHost) {
    this.projects = projects;
    this.host = host;
  }
  private track<T>(run: () => Promise<T>) {
    if (this.closed) return Promise.reject(new ProjectError('MERGE_CLOSED', '合入服务正在关闭'));
    const p = run();
    this.runs.add(p);
    return p.finally(() => this.runs.delete(p));
  }
  private manager(project: string, actor: WorkbenchActor, repository?: string) {
    const c = this.projects.forProject(project);
    c.worktreeMerges().requireManager(actor);
    if (repository) {
      const requested = canonicalDirectory(repository);
      if (
        ![
          c.snapshot().root,
          ...c
            .executions()
            .list()
            .flatMap((e) => e.additionalRepositories),
        ].some((root) => withinPath(root, requested))
      )
        throw new ProjectError('MERGE_REPOSITORY', '目标须为固定宿主项目或明确已授权仓库');
    }
    c.controls().requireDispatch();
    return c;
  }
  private source(
    c: ProjectConnection,
    actor: WorkbenchActor,
    input: ReturnType<typeof mergePreviewInputSchema.parse>,
  ) {
    const tree = c.worktrees().get(actor, input.sourceWorktreeId),
      version = c.versions().get(input.sourceVersionId),
      result = c.reviewResults().get(input.sourceResultId),
      execution = c.executions().get(version.executionId),
      review = c.reviews().get(result.reviewId);
    if (
      version.kind !== 'delivery' ||
      result.versionId !== version.id ||
      result.executionId !== version.executionId ||
      result.ticketId !== version.ticket.id ||
      result.verdict !== 'pass' ||
      result.progress.state !== 'confirmed' ||
      result.authorAction.state !== 'confirmed' ||
      result.authorGoalClear?.state !== 'confirmed' ||
      execution.reviewResultId !== result.id ||
      execution.lifecycleState !== 'closed' ||
      execution.writeOccupancy !== 'released' ||
      review.versionId !== version.id ||
      review.status !== 'decided' ||
      review.closure?.state !== 'confirmed' ||
      c.reviewResults().list(execution.id).at(-1)?.id !== result.id
    )
      throw new ProjectError(
        'MERGE_SOURCE_REVIEW',
        '源版本尚无对应已核定整票pass或原执行/独审未收尾',
      );
    const rootIndex = version.snapshot.roots.findIndex(
        (root) => root.kind === 'git' && tree.path && key(root.root) === key(tree.path),
      ),
      root = version.snapshot.roots[rootIndex];
    if (
      !tree.path ||
      !['ready', 'retained'].includes(tree.status) ||
      !root ||
      !root.head ||
      version.worktreeId !== tree.id ||
      execution.worktreeId !== tree.id ||
      !tree.associations.some(
        (a) => a.executionId === execution.id && a.ticketId === version.ticket.id,
      ) ||
      !root.commonDir ||
      key(root.commonDir) !== key(tree.source.commonDir)
    )
      throw new ProjectError('MERGE_SOURCE_VERSION', '源工作树、执行、固定版本或共同Git归属不符');
    const current = inspectWorkspace({
        cwd: tree.path,
        storage: c.versions().storage,
        materialRoots: [],
      }),
      actual = current.roots.find((r) => r.kind === 'git' && key(r.root) === key(tree.path!));
    const files = (r: typeof root) =>
      r.files
        .map((f) => [f.path, f.mode, f.sha256, f.size])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    if (!actual || JSON.stringify(files(actual)) !== JSON.stringify(files(root)))
      throw new ProjectError(
        'MERGE_SOURCE_CHANGED',
        '实际源码已不对应受审固定版本，旧pass不能为后来差异背书',
      );
    const receipts: string[] = [];
    if (root.head !== input.sourceCommit) {
      let cursor = input.sourceCommit;
      const available = c.localCommits().list(actor),
        seen = new Set<string>();
      while (cursor !== root.head) {
        if (seen.has(cursor) || seen.size >= 512)
          throw new ProjectError('MERGE_SOURCE_COMMIT', '源提交链不能核定到受审基线');
        seen.add(cursor);
        const receipt = available.find(
          (r) =>
            r.status === 'completed' &&
            r.lastProof?.state === 'verified' &&
            r.lastProof.commit === cursor &&
            r.versionIds.includes(version.id) &&
            key(r.plan.repository) === key(tree.path!) &&
            r.lastQuiescence?.state === 'confirmed',
        );
        if (
          !receipt ||
          !receipt.plan.head ||
          receipt.lastProof!.parents.length !== 1 ||
          receipt.lastProof!.parents[0] !== receipt.plan.head
        )
          throw new ProjectError('MERGE_SOURCE_COMMIT', '源commit未对应受审版本及已核定本地提交链');
        receipts.push(receipt.id);
        cursor = receipt.plan.head;
      }
    }
    return {
      tree,
      evidence: {
        ticketId: version.ticket.id,
        executionId: execution.id,
        versionId: version.id,
        resultId: result.id,
        versionFingerprint: version.snapshot.fingerprint,
        rootIndex,
        receiptId: receipts[0] ?? null,
        receiptIds: receipts,
        rawFingerprint: hash(files(root)),
      },
    };
  }
  private async capture(
    c: ProjectConnection,
    readActor: WorkbenchActor,
    input: ReturnType<typeof mergePreviewInputSchema.parse>,
    session: string,
  ): Promise<MergePreview> {
    const before = this.source(c, readActor, input),
      material = ensureMergeMaterial(c.snapshot().root, randomUUID(), session);
    const plan = await captureMergeGit(
      input.targetRepository,
      before.tree.path!,
      input.sourceCommit,
      material + '/objects',
    );
    const after = this.source(c, readActor, input);
    if (this.closed) throw new ProjectError('MERGE_CLOSED', '关闭期间只保留预核材料，不发布新安排');
    if (
      JSON.stringify(before.evidence) !== JSON.stringify(after.evidence) ||
      plan.source.branch !== 'refs/heads/' + after.tree.name ||
      key(plan.source.commonDir) !== key(after.tree.source.commonDir)
    )
      throw new ProjectError('MERGE_SOURCE_CHANGED', '预核期间原受审来源或实际分支已变化');
    return {
      plan,
      sourceWorktreeId: after.tree.id,
      source: after.evidence,
      fingerprint: hash({
        git: plan.fingerprint,
        sourceWorktreeId: after.tree.id,
        source: after.evidence,
      }),
    };
  }
  preview(project: string, actor: WorkbenchActor, raw: unknown) {
    return this.track(async () => {
      const input = mergePreviewInputSchema.parse(raw),
        c = this.manager(project, actor, input.targetRepository),
        preview = await this.capture(
          c,
          actor,
          input,
          actor.kind === 'session' ? actor.sessionId : '',
        );
      this.manager(project, actor, preview.plan.target.repository);
      return preview;
    });
  }
  private observe(
    project: string,
    value: WorktreeMergeRecord,
    callId?: string,
  ): LocalCommitObservation {
    if (!this.host.inspect)
      throw new ProjectError('MERGE_NATIVE_UNAVAILABLE', '缺少原生合入观察，不推定停稳');
    const observation = this.host.inspect(project, value.committerSessionId, callId, value);
    if (
      observation.nativeSessionId !== value.native.nativeSessionId ||
      observation.epoch !== value.native.epoch
    )
      return {
        ...observation,
        state: 'unknown',
        note: '原生身份或宿主epoch与原安排不同，不用新观察抹掉原未知',
      };
    return observation;
  }
  arrange(project: string, actor: WorkbenchActor, raw: unknown) {
    return this.track(async () => {
      const input = mergeArrangeInputSchema.parse(raw),
        c = this.manager(project, actor, input.targetRepository),
        catalog = c.worktreeMerges(),
        old = catalog.existingArrangement(actor, input);
      if (old) return old;
      if (!this.host.inspect || !this.host.allowed?.(project, input.sessionId))
        throw new ProjectError('MERGE_NATIVE_UNAVAILABLE', '原提交入口不可用或原生观察缺件');
      const before = this.host.inspect(project, input.sessionId);
      if (before.state !== 'confirmed') throw new ProjectError('MERGE_NATIVE_BUSY', before.note);
      const preview = await this.capture(
        c,
        actor,
        input,
        actor.kind === 'session' ? actor.sessionId : '',
      );
      this.manager(project, actor, preview.plan.target.repository);
      const after = this.host.inspect(project, input.sessionId);
      if (
        !this.host.allowed(project, input.sessionId) ||
        after.state !== 'confirmed' ||
        before.nativeSessionId !== after.nativeSessionId ||
        before.epoch !== after.epoch
      )
        throw new ProjectError('MERGE_NATIVE_BUSY', '预核期间提交者身份或原生在途发生变化');
      const value = catalog.arrange(actor, input, preview, {
        nativeSessionId: after.nativeSessionId,
        epoch: after.epoch,
        boundary: after.boundary,
        ranges: after.ranges,
      });
      await this.notify(project, value.id);
      return catalog.get(actor, value.id);
    });
  }
  inspect(project: string, actor: WorkbenchActor, id: string, raw: unknown, callId?: string) {
    return this.track(async () => {
      const input = mergeInspectInputSchema.parse(raw),
        c = this.projects.forProject(project),
        catalog = c.worktreeMerges(),
        value = catalog.get(actor, id);
      catalog.requireWorker(actor, value);
      c.controls().requireDispatch();
      const previous = catalog.existingCommand(actor, id, 'inspect', input);
      if (previous) return previous;
      if (['completed', 'cancelled', 'awaiting-verification'].includes(value.status)) return value;
      if (value.status === 'unknown')
        throw new ProjectError('MERGE_UNKNOWN', '原结果未知，先沿原id reconcile，不重新授权merge');
      let ready = true,
        fingerprint: string | null = null,
        note = '原固定来源、目标基线、索引及占用核对一致';
      const before = this.observe(project, value, callId);
      if (value.repair?.version)
        return this.inspectContinuation(project, actor, value, input, callId);
      try {
        if (before.state !== 'confirmed' || !this.host.allowed?.(project, value.committerSessionId))
          throw new ProjectError('MERGE_NATIVE_BUSY', before.note);
        // System re-reads only the immutable sources selected by the saved manager arrangement.
        const preview = await this.capture(
          c,
          { kind: 'user' },
          {
            targetRepository: value.preview.plan.target.repository,
            sourceWorktreeId: value.preview.sourceWorktreeId,
            sourceVersionId: value.preview.source.versionId,
            sourceResultId: value.preview.source.resultId,
            sourceCommit: value.preview.plan.sourceCommit,
          },
          value.committerSessionId,
        );
        fingerprint = preview.fingerprint;
        if (fingerprint !== value.preview.fingerprint)
          throw new ProjectError(
            'MERGE_INPUT_CHANGED',
            '原源/目标或预计合并树已变化，不执行旧安排',
          );
      } catch (error) {
        ready = false;
        note = error instanceof Error ? error.message : '原合入输入未核定';
      }
      c.controls().requireDispatch();
      const after = this.observe(project, value, callId);
      if (after.state !== 'confirmed') {
        ready = false;
        note = after.note;
      }
      return catalog.inspected(
        actor,
        id,
        input,
        {
          ready,
          fingerprint,
          note,
          mode: value.preview.plan.mode === 'already-contained' ? 'already-contained' : 'merge',
          observedAt: new Date().toISOString(),
        },
        after,
      );
    });
  }
  private approved(c: ProjectConnection, versionId: string, resultId: string) {
    return requireReviewedDelivery(
      {
        versions: c.versions(),
        executions: c.executions(),
        reviews: c.reviews(),
        reviewResults: c.reviewResults(),
      },
      versionId,
      resultId,
    );
  }
  private async proof(c: ProjectConnection, value: WorktreeMergeRecord) {
    const chain = c.worktreeMerges().correctionChain(value),
      tip = chain.at(-1);
    const proof = await verifyMergeGit(
      value.preview.plan,
      tip?.lastProof?.tree ?? value.repair?.expectedTree ?? value.preview.plan.mergeTree,
      tip ? { head: tip.lastProof!.commit!, parents: tip.lastProof!.parents } : undefined,
    );
    return { ...proof, receiptIds: chain.map((r) => r.id) };
  }
  admitExecution(project: string, executionId: string, cwd: string, recovery = false) {
    return this.track(async () => {
      const c = this.projects.forProject(project),
        e = c.executions().get(executionId);
      if (!e.mergeId) return false;
      const catalog = c.worktreeMerges(),
        value = catalog.get({ kind: 'user' }, e.mergeId),
        repair = value.repair?.executionId === e.id;
      if (
        e.actor.kind !== 'session' ||
        !e.actor.sessionId ||
        e.roleType !== 'developer' ||
        (recovery
          ? !e.goalId || e.lifecycleState !== 'paused' || e.writeOccupancy !== 'released'
          : !!e.goalId) ||
        key(canonicalDirectory(cwd)) !== key(value.preview.plan.target.repository) ||
        key(e.cwd) !== key(canonicalDirectory(cwd)) ||
        e.additionalRepositories.length ||
        (repair
          ? value.status !== 'repairing' ||
            e.ticketId !== value.repair!.ticketId ||
            e.writeScopes.some((s) => !value.repair!.writeScopes.some((a) => withinPath(a, s)))
          : value.status !== 'awaiting-verification' || e.ticketId !== value.combinationTicketId)
      )
        throw new ProjectError(
          'MERGE_EXECUTION_CHANGED',
          '原合入交接、执行目录、角色或范围已变化，不启动Goal',
        );
      if (this.observe(project, value).state !== 'confirmed')
        throw new ProjectError('MERGE_NATIVE_BUSY', '原提交者尚未核定停稳，不启动修正或组合');
      const proof = await this.proof(c, value);
      if (
        repair
          ? proof.state !== 'conflict' || proof.indexFingerprint !== value.repair!.indexFingerprint
          : proof.state !== 'verified' || proof.resultHead !== value.lastProof?.resultHead
      )
        throw new ProjectError('MERGE_EXECUTION_GIT', '原实际合入现场或结果已变化，不沿旧交接开工');
      const observation = await inspectMergeTargetRegistration(value.preview.plan, proof);
      const tree = c
        .worktrees()
        .list({ kind: 'user' })
        .find((v) => v.path && key(v.path) === key(value.preview.plan.target.repository));
      if (e.worktreeId && e.worktreeId !== tree?.id)
        throw new ProjectError('MERGE_EXECUTION_TREE', '执行工作树不是原目标');
      if (tree) {
        if (
          key(tree.source.commonDir) !== key(value.preview.plan.target.commonDir) ||
          'refs/heads/' + tree.name !== value.preview.plan.target.branch
        )
          throw new ProjectError('MERGE_EXECUTION_TREE', '目标工作树归属已变化');
        if (recovery) {
          if (e.worktreeId !== tree.id)
            throw new ProjectError('MERGE_EXECUTION_TREE', '恢复核对的工作树归属未确认');
          c.controls().requireDispatch();
          return true;
        }
        if (!e.worktreeId) c.executions().linkStartupWorktree(e.id, tree.id);
        c.worktrees().associate(
          { kind: 'session', sessionId: e.actor.sessionId },
          tree.id,
          e.id,
          proof.currentHead,
          observation,
        );
      }
      c.controls().requireDispatch();
      return true;
    });
  }
  confirmStartupBaseline(project: string, executionId: string, versionId: string) {
    const c = this.projects.forProject(project),
      e = c.executions().get(executionId);
    if (!e.mergeId) return;
    const value = c.worktreeMerges().get({ kind: 'user' }, e.mergeId),
      version = c.versions().get(versionId),
      root = version.snapshot.roots[0],
      repair = value.repair?.executionId === e.id;
    if (
      version.executionId !== e.id ||
      version.kind !== 'baseline' ||
      !root ||
      key(root.root) !== key(value.preview.plan.target.repository) ||
      key(root.commonDir ?? '') !== key(value.preview.plan.target.commonDir) ||
      (repair
        ? root.head !== value.preview.plan.target.head ||
          root.indexState?.indexFingerprint !== value.repair!.indexFingerprint
        : root.head !== value.lastProof?.resultHead)
    )
      throw new ProjectError('MERGE_BASELINE_CHANGED', '实际启动快照不对应原合入交接，不武装Goal');
  }
  cancel(project: string, actor: WorkbenchActor, id: string, raw: unknown) {
    return this.track(async () => {
      const input = mergeReconcileInputSchema.parse(raw),
        c = this.manager(project, actor),
        catalog = c.worktreeMerges(),
        old = catalog.existingCommand(actor, id, 'cancel', input);
      if (old) return old;
      const value = catalog.get(actor, id),
        proof = await verifyMergeGit(value.preview.plan),
        quiet = this.observe(project, value);
      this.manager(project, actor);
      return catalog.cancelled(actor, id, input, proof, quiet);
    });
  }
  retry(project: string, actor: WorkbenchActor, id: string) {
    return this.track(async () => {
      const c = this.projects.forProject(project),
        value = c.worktreeMerges().get(actor, id);
      const author = c.workbench().author(actor);
      if (
        actor.kind !== 'session' ||
        (author.roleType !== 'supervisor' && actor.sessionId !== value.committerSessionId)
      )
        throw new ProjectError('MERGE_NOTICE_ACTOR', '仅实际主管或原提交者补原通知');
      await this.notify(project, id);
      return c.worktreeMerges().get(actor, id);
    });
  }
  private reviewed(
    c: ProjectConnection,
    actor: WorkbenchActor,
    versionId: string,
    resultId: string,
    target: string,
  ) {
    const records = this.approved(c, versionId, resultId),
      root = records.version.snapshot.roots.find(
        (r) => r.kind === 'git' && key(r.root) === key(target),
      );
    if (!root?.head || !root.tree)
      throw new ProjectError('MERGE_REVIEW_ROOT', '固定版本没有原目标的完整Git源码');
    return {
      ...records,
      root,
      link: {
        executionId: records.execution.id,
        versionId,
        resultId,
        head: root.head,
        tree: root.tree,
        rawFingerprint: hash(rawFiles(root)),
        author: c.workbench().author(actor),
        at: new Date().toISOString(),
      },
    };
  }
  confirmRepair(project: string, actor: WorkbenchActor, id: string, raw: unknown) {
    return this.track(async () => {
      const input = mergeReviewLinkInputSchema.parse(raw),
        c = this.manager(project, actor),
        catalog = c.worktreeMerges(),
        value = catalog.get(actor, id);
      const previous = catalog.existingCommand(actor, id, 'repair-reviewed', input);
      if (previous) return previous;
      if (value.status !== 'repairing' || !value.repair?.executionId || !value.conflictSnapshot)
        throw new ProjectError('MERGE_REPAIR_NOT_READY', '没有原明确修正执行');
      const reviewed = this.reviewed(
        c,
        actor,
        input.versionId,
        input.resultId,
        value.preview.plan.target.repository,
      );
      if (
        reviewed.execution.id !== value.repair.executionId ||
        reviewed.execution.ticketId !== value.repair.ticketId ||
        reviewed.execution.mergeId !== value.id ||
        reviewed.root.indexState?.indexFingerprint !== value.repair.indexFingerprint
      )
        throw new ProjectError('MERGE_REPAIR_REVIEW', '新意见没有绑定原修正执行和原冲突索引');
      const current = inspectWorkspace(this.conflictInput(c, value)).roots[0]!;
      if (JSON.stringify(rawFiles(current)) !== JSON.stringify(rawFiles(reviewed.root)))
        throw new ProjectError('MERGE_REPAIR_CHANGED', '实际修正源码与已审固定版本不符');
      const initial = value.conflictSnapshot.roots[0]!,
        before = new Map(initial.files.map((f) => [f.path, f])),
        after = new Map(reviewed.root.files.map((f) => [f.path, f]));
      const paths = [...new Set([...before.keys(), ...after.keys()])].filter(
        (p) =>
          before.get(p)?.sha256 !== after.get(p)?.sha256 ||
          before.get(p)?.mode !== after.get(p)?.mode,
      );
      const stagePaths = [...new Set([...paths, ...value.lastProof!.conflictPaths])].sort();
      if (
        stagePaths.some(
          (p) =>
            !value.repair!.writeScopes.some((s) =>
              withinPath(s, resolve(value.preview.plan.target.repository, p)),
            ),
        )
      )
        throw new ProjectError('MERGE_REPAIR_SCOPE', '修正差异或未解决路径超出原批准范围');
      if (this.observe(project, value).state !== 'confirmed')
        throw new ProjectError('MERGE_REPAIR_BUSY', '原提交者未停稳');
      this.manager(project, actor);
      const result = catalog.repairReviewed(actor, id, input, reviewed.link, stagePaths);
      await this.notify(project, id);
      return result;
    });
  }
  private async inspectContinuation(
    project: string,
    actor: WorkbenchActor,
    value: WorktreeMergeRecord,
    input: ReturnType<typeof mergeInspectInputSchema.parse>,
    callId?: string,
  ) {
    const c = this.projects.forProject(project),
      catalog = c.worktreeMerges(),
      repair = value.repair!;
    let ready = false,
      note = '原修正尚未核定',
      mode: 'continue-stage' | 'continue-commit' = 'continue-stage',
      staged: { tree: string; indexFingerprint: string } | undefined;
    try {
      if (
        this.observe(project, value, callId).state !== 'confirmed' ||
        !this.host.allowed?.(project, value.committerSessionId)
      )
        throw new ProjectError('MERGE_NATIVE_BUSY', '原提交者不安静或受控制');
      const reviewed = this.reviewed(
        c,
        actor,
        repair.version!.versionId,
        repair.version!.resultId,
        value.preview.plan.target.repository,
      );
      if (reviewed.execution.id !== repair.executionId)
        throw new ProjectError('MERGE_REPAIR_REVIEW', '修正执行已变化');
      const proof = await verifyMergeGit(value.preview.plan);
      if (proof.state !== 'conflict')
        throw new ProjectError('MERGE_REPAIR_CHANGED', '原MERGE_HEAD或目标基线已变化，先回读结果');
      if (proof.indexFingerprint === repair.indexFingerprint) {
        const current = inspectWorkspace(this.conflictInput(c, value)).roots[0]!;
        if (JSON.stringify(rawFiles(current)) !== JSON.stringify(rawFiles(reviewed.root)))
          throw new ProjectError('MERGE_REPAIR_CHANGED', '已审修正文件后来发生变化');
        note = '仅允许git add -A -- 后接repair.paths中的准确路径；不得commit，随后再次inspect';
      } else {
        staged = await captureMergeIndexTree(
          value.preview.plan,
          reviewed.root,
          value.materialPath + '/staged-' + randomUUID(),
        );
        mode = 'continue-commit';
        note =
          '实际stage0索引与已审raw源码对应；只允许git commit --no-edit沿原MERGE_HEAD继续，不再次merge';
      }
      ready = true;
    } catch (error) {
      note = error instanceof Error ? error.message : '原修正不能核定';
    }
    const quiet = this.observe(project, value, callId);
    if (quiet.state !== 'confirmed') {
      ready = false;
      staged = undefined;
      note = quiet.note;
    }
    c.controls().requireDispatch();
    return catalog.inspected(
      actor,
      value.id,
      input,
      {
        ready,
        mode,
        fingerprint: staged?.tree ?? repair.version!.rawFingerprint,
        note,
        observedAt: new Date().toISOString(),
      },
      quiet,
      staged,
    );
  }
  confirmCombination(project: string, actor: WorkbenchActor, id: string, raw: unknown) {
    return this.track(async () => {
      const input = mergeReviewLinkInputSchema.parse(raw),
        c = this.manager(project, actor),
        catalog = c.worktreeMerges(),
        value = catalog.get(actor, id);
      const previous = catalog.existingCommand(actor, id, 'combination-reviewed', input);
      if (previous) return previous;
      if (value.status !== 'awaiting-verification' || value.lastProof?.state !== 'verified')
        throw new ProjectError('MERGE_COMBINATION_NOT_READY', '原Git结果尚未独立核定');
      const reviewed = this.reviewed(
        c,
        actor,
        input.versionId,
        input.resultId,
        value.preview.plan.target.repository,
      );
      const baseline = c
        .versions()
        .list(reviewed.execution.id)
        .find((v) => v.kind === 'baseline');
      if (
        reviewed.execution.ticketId !== value.combinationTicketId ||
        reviewed.execution.mergeId !== value.id ||
        reviewed.root.head !== value.lastProof.resultHead ||
        baseline?.snapshot.roots[0]?.head !== value.lastProof.resultHead ||
        !reviewed.version.ticket.checklist.every((i) => i.checked)
      )
        throw new ProjectError(
          'MERGE_COMBINATION_REVIEW',
          '组合执行、当前结果HEAD、派工基线或必要检查不对应原合入',
        );
      const current = inspectWorkspace({
        cwd: value.preview.plan.target.repository,
        storage: c.versions().storage,
      }).roots[0]!;
      if (JSON.stringify(rawFiles(current)) !== JSON.stringify(rawFiles(reviewed.root)))
        throw new ProjectError(
          'MERGE_COMBINATION_CHANGED',
          '已审组合源码后来发生变化，旧意见不为新差异背书',
        );
      const proof = await this.proof(c, value),
        quiet = this.observe(project, value);
      this.manager(project, actor);
      return catalog.combinationReviewed(actor, id, input, reviewed.link, proof, quiet);
    });
  }
  recordCombinationFailure(project: string, actor: WorkbenchActor, id: string, raw: unknown) {
    return this.track(async () => {
      const input = mergeReviewLinkInputSchema.parse(raw),
        c = this.manager(project, actor),
        catalog = c.worktreeMerges(),
        value = catalog.get(actor, id);
      const previous = catalog.existingCommand(actor, id, 'combination-returned', input);
      if (previous) return previous;
      const version = c.versions().get(input.versionId),
        result = c.reviewResults().get(input.resultId),
        e = c.executions().get(version.executionId),
        review = c.reviews().get(result.reviewId);
      if (
        version.kind !== 'delivery' ||
        result.versionId !== version.id ||
        result.executionId !== e.id ||
        result.ticketId !== value.combinationTicketId ||
        e.ticketId !== value.combinationTicketId ||
        e.mergeId !== value.id ||
        result.verdict !== 'return' ||
        !result.issues.length ||
        review.versionId !== version.id ||
        review.status !== 'decided' ||
        review.closure?.state !== 'confirmed' ||
        c.reviewResults().list(e.id).at(-1)?.id !== result.id
      )
        throw new ProjectError(
          'MERGE_COMBINATION_FAILURE',
          '失败记录须绑定原组合执行的当前指定退回意见和固定版本',
        );
      return catalog.combinationReturned(actor, id, input, {
        executionId: e.id,
        issues: result.issues,
      });
    });
  }
  report(project: string, actor: WorkbenchActor, id: string, raw: unknown, callId?: string) {
    return this.track(async () => {
      const input = mergeReportInputSchema.parse(raw),
        c = this.projects.forProject(project),
        catalog = c.worktreeMerges(),
        value = catalog.get(actor, id);
      catalog.requireWorker(actor, value);
      c.controls().requireDispatch();
      const previous = catalog.existingCommand(actor, id, 'report', input);
      if (previous) return previous;
      const proof = await this.proof(c, value),
        quiet = this.observe(project, value, callId);
      c.controls().requireDispatch();
      let result = catalog.reported(actor, id, input, proof, quiet);
      result = this.captureConflict(c, result);
      await this.notify(project, id);
      return result;
    });
  }
  reconcile(project: string, actor: WorkbenchActor, id: string, raw: unknown) {
    return this.track(async () => {
      const input = mergeReconcileInputSchema.parse(raw),
        c = this.manager(project, actor),
        catalog = c.worktreeMerges(),
        value = catalog.get(actor, id);
      const previous = catalog.existingCommand(actor, id, 'reconcile', input);
      if (previous) return previous;
      if (['completed', 'cancelled'].includes(value.status)) return value;
      const proof = await this.proof(c, value),
        quiet = this.observe(project, value);
      this.manager(project, actor);
      let result = catalog.reconciled(actor, id, input, proof, quiet);
      result = this.captureConflict(c, result);
      await this.notify(project, id);
      return result;
    });
  }
  private conflictInput(c: ProjectConnection, value: WorktreeMergeRecord) {
    return {
      cwd: value.preview.plan.target.repository,
      storage: c.versions().storage,
      materialRoots: [],
      mergeRepair: {
        repository: value.preview.plan.target.repository,
        expectedHead: value.preview.plan.target.head,
        expectedMergeHeads: [value.preview.plan.sourceCommit],
        expectedIndexFingerprint: value.lastProof!.indexFingerprint,
      },
    };
  }
  private captureConflict(c: ProjectConnection, value: WorktreeMergeRecord) {
    if (value.status !== 'conflict' || value.conflictSnapshot || !value.lastProof) return value;
    const snapshot = captureWorkspace(this.conflictInput(c, value));
    return c.worktreeMerges().conflictCaptured(value.id, value.lastProof, snapshot);
  }
  prepareRepair(project: string, actor: WorkbenchActor, id: string, raw: unknown) {
    return this.track(async () => {
      const input = mergeRepairInputSchema.parse(raw),
        c = this.manager(project, actor),
        catalog = c.worktreeMerges(),
        value = catalog.get(actor, id);
      const previous = catalog.existingCommand(actor, id, 'prepare-repair', input);
      if (previous) return previous;
      if (value.status !== 'conflict' || !value.conflictSnapshot)
        throw new ProjectError('MERGE_REPAIR_NOT_READY', '须先固定原实际冲突现场');
      const quiet = this.observe(project, value);
      if (quiet.state !== 'confirmed') throw new ProjectError('MERGE_REPAIR_BUSY', quiet.note);
      const proof = await verifyMergeGit(value.preview.plan);
      if (
        proof.state !== 'conflict' ||
        proof.indexFingerprint !== value.lastProof?.indexFingerprint
      )
        throw new ProjectError('MERGE_REPAIR_CHANGED', '原冲突索引或Git状态已变化，先沿原id核对');
      const current = inspectWorkspace(this.conflictInput(c, value));
      if (current.fingerprint !== value.conflictSnapshot.fingerprint)
        throw new ProjectError(
          'MERGE_REPAIR_CHANGED',
          '原冲突文件在明确交接前已变化，不自动吸收未知成果',
        );
      if (this.observe(project, value).state !== 'confirmed')
        throw new ProjectError('MERGE_REPAIR_BUSY', '交接期间原提交者已不安静');
      this.manager(project, actor);
      return catalog.prepareRepair(actor, id, input);
    });
  }
  private async notify(project: string, id: string) {
    const old = this.notifying.get(id);
    if (old) return old;
    const run = this.notifyOnce(project, id);
    this.notifying.set(id, run);
    try {
      await run;
    } finally {
      if (this.notifying.get(id) === run) this.notifying.delete(id);
    }
  }
  private async notifyOnce(project: string, id: string) {
    const catalog = this.projects.forProject(project).worktreeMerges();
    for (const notice of catalog.get({ kind: 'user' }, id).notices) {
      if (notice.state === 'confirmed' || !catalog.isCurrentNotice(notice.id)) continue;
      try {
        if (!this.host.notify)
          throw new ProjectError('MERGE_NOTIFY_UNAVAILABLE', '合入通知接口缺件');
        const saved = await this.host.notify(project, id, notice.id);
        catalog.noticeRecorded(id, notice.id, saved.receipt, null);
      } catch (error) {
        catalog.noticeRecorded(
          id,
          notice.id,
          null,
          error instanceof Error ? error.message : '原合入通知未知',
        );
      }
    }
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.runs, ...this.notifying.values()]);
  }
}
