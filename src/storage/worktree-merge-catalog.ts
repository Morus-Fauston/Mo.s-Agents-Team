import { randomUUID, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import {
  mergeArrangeInputSchema,
  mergeInspectInputSchema,
  mergeReportInputSchema,
  mergeReconcileInputSchema,
  mergeRepairInputSchema,
  mergeReviewLinkInputSchema,
  gitMergeProofSchema,
  mergePreviewSchema,
  worktreeMergeSchema,
} from '../contracts/worktree-merges.ts';
import type { MergePreview, WorktreeMergeRecord } from '../contracts/worktree-merges.ts';
import type { SnapshotInput, WorkspaceSnapshot } from '../contracts/versions.ts';
import type { ExecutionRecord } from '../contracts/execution.ts';
import type { localCommitArrangeSchema } from '../contracts/local-commits.ts';
import type { LocalGitPlan, LocalCommitRecord } from '../contracts/local-commits.ts';
import { localCommitSchema } from '../contracts/local-commits.ts';
import type { z } from 'zod';
import type { requireReviewedDelivery } from '../services/delivery-approval.ts';
import { inspectWorkspace } from '../services/workspace-snapshot.ts';
import {
  localCommitNativeSchema,
  localCommitQuiescenceSchema,
} from '../contracts/local-commits.ts';
import type { ChatInput } from '../contracts/chat.ts';
import type { WorkbenchActor } from '../contracts/workbench.ts';
import type { WorkbenchCatalog } from './workbench-catalog.ts';
import type { SessionCatalog } from './session-catalog.ts';
import type { ExecutionCatalog } from './execution-catalog.ts';
import type { ControlCatalog } from './control-catalog.ts';
import {
  canonicalDirectory,
  canonicalWriteScope,
  scopesOverlap,
  withinPath,
} from '../services/write-scopes.ts';
import { ensureMergeMaterial } from '../services/ticket-materials.ts';
import { ProjectError } from '../services/errors.ts';
import { messageIdentity } from '../services/message-presentation.ts';
import { transaction } from './transaction.ts';
const now = () => new Date().toISOString(),
  hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex'),
  key = (v: string) => (process.platform === 'win32' ? v.toLowerCase() : v);
export function migrateWorktreeMerges(db: DatabaseSync) {
  db.exec(
    `CREATE TABLE worktree_merge(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,common_dir TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES session(id),data TEXT NOT NULL);CREATE TABLE worktree_merge_event(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,merge_id TEXT NOT NULL REFERENCES worktree_merge(id),data TEXT NOT NULL);CREATE TABLE worktree_merge_command(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,merge_id TEXT NOT NULL REFERENCES worktree_merge(id));PRAGMA user_version=18;`,
  );
}
export class WorktreeMergeCatalog {
  private readonly db: DatabaseSync;
  private readonly sessions: SessionCatalog;
  private readonly wb: WorkbenchCatalog;
  private readonly executions: ExecutionCatalog;
  private readonly controls: ControlCatalog;
  private readonly root: string;
  private workerGuard: ((session: string) => void) | undefined;
  private gitGuard: ((commonDir: string) => void) | undefined;
  private approval: ((versionId: string) => ReturnType<typeof requireReviewedDelivery>) | undefined;
  bindDeliveryApproval(approval: NonNullable<WorktreeMergeCatalog['approval']>) {
    this.approval = approval;
  }
  constructor(
    db: DatabaseSync,
    sessions: SessionCatalog,
    wb: WorkbenchCatalog,
    executions: ExecutionCatalog,
    controls: ControlCatalog,
    root: string,
  ) {
    this.db = db;
    this.sessions = sessions;
    this.wb = wb;
    this.executions = executions;
    this.controls = controls;
    this.root = root;
  }
  requireManager(actor: WorkbenchActor, original?: WorktreeMergeRecord) {
    const a = this.wb.author(actor);
    if (actor.kind !== 'session' || a.roleType !== 'supervisor')
      throw new ProjectError('MERGE_MANAGER', '合入须由实际主管安排');
    if (original && actor.sessionId !== original.managerSessionId)
      throw new ProjectError('MERGE_ORIGINAL_MANAGER', '须沿原实际主管办理，不隐式迁移原合入责任');
    const s = this.sessions.get(actor.sessionId);
    if (s.status !== 'bound' || s.communicationState !== 'active' || s.error)
      throw new ProjectError('MERGE_MANAGER', '主管当前受控制或未实际绑定');
    return a;
  }
  private raw(id: string) {
    const row = this.db.prepare('SELECT data FROM worktree_merge WHERE id=?').get(id);
    if (!row) throw new ProjectError('MERGE_NOT_FOUND', '原合入事项不存在');
    return worktreeMergeSchema.parse(JSON.parse(String(row.data)));
  }
  private canRead(actor: WorkbenchActor, v: WorktreeMergeRecord) {
    const a = this.wb.author(actor);
    return (
      actor.kind === 'user' ||
      a.roleType === 'supervisor' ||
      (actor.kind === 'session' &&
        (actor.sessionId === v.committerSessionId ||
          this.executions
            .list()
            .some(
              (e) =>
                e.sessionId === actor.sessionId &&
                [v.preview.source.ticketId, v.combinationTicketId, v.repair?.ticketId].includes(
                  e.ticketId,
                ),
            )))
    );
  }
  get(actor: WorkbenchActor, id: string) {
    const v = this.raw(id);
    if (!this.canRead(actor, v)) throw new ProjectError('MERGE_READ', '当前主体不能读取此合入');
    return v;
  }
  list(actor: WorkbenchActor) {
    return this.db
      .prepare('SELECT id FROM worktree_merge ORDER BY rowid')
      .all()
      .map((r) => this.raw(String(r.id)))
      .filter((v) => this.canRead(actor, v));
  }
  history(actor: WorkbenchActor, id: string) {
    this.get(actor, id);
    return this.db
      .prepare('SELECT data FROM worktree_merge_event WHERE merge_id=? ORDER BY seq')
      .all(id)
      .map((r) => JSON.parse(String(r.data)) as unknown);
  }
  private save(v: WorktreeMergeRecord) {
    v.updatedAt = now();
    this.db.prepare('UPDATE worktree_merge SET data=? WHERE id=?').run(JSON.stringify(v), v.id);
  }
  private event(v: WorktreeMergeRecord, actor: WorkbenchActor, kind: string, data: unknown) {
    const e = { id: randomUUID(), author: this.wb.author(actor), kind, data, at: now() };
    this.db
      .prepare('INSERT INTO worktree_merge_event(id,merge_id,data) VALUES(?,?,?)')
      .run(e.id, v.id, JSON.stringify(e));
  }
  existingArrangement(actor: WorkbenchActor, raw: unknown) {
    const input = mergeArrangeInputSchema.parse(raw),
      row = this.db
        .prepare('SELECT id,request_hash FROM worktree_merge WHERE operation_id=?')
        .get(input.operationId);
    if (!row) return undefined;
    if (row.request_hash !== hash({ actor, input }))
      throw new ProjectError('MERGE_OPERATION', '原操作身份已使用但来源或输入不同');
    return this.get(actor, String(row.id));
  }
  arrange(
    actor: WorkbenchActor,
    raw: unknown,
    rawPreview: MergePreview,
    native: WorktreeMergeRecord['native'],
  ) {
    const author = this.requireManager(actor),
      input = mergeArrangeInputSchema.parse(raw),
      old = this.existingArrangement(actor, input);
    if (old) return old;
    this.controls.requireDispatch();
    const preview = mergePreviewSchema.parse(rawPreview),
      target = this.sessions.get(input.sessionId);
    localCommitNativeSchema.parse(native);
    if (
      target.roleType !== 'committer' ||
      target.status !== 'bound' ||
      target.communicationState !== 'active' ||
      target.error ||
      target.nativeSessionId !== native.nativeSessionId
    )
      throw new ProjectError('MERGE_COMMITTER', '须绑定原提交类型的实际可用会话');
    if (input.expectedFingerprint !== preview.fingerprint)
      throw new ProjectError('MERGE_FINGERPRINT', '原合入预核指纹不同，先回读');
    if (
      input.sourceWorktreeId !== preview.sourceWorktreeId ||
      input.sourceVersionId !== preview.source.versionId ||
      input.sourceResultId !== preview.source.resultId ||
      input.sourceCommit !== preview.plan.sourceCommit ||
      key(realpathSync(input.targetRepository)) !== key(preview.plan.target.repository)
    )
      throw new ProjectError('MERGE_PREVIEW_SOURCE', '预核来源和原安排输入不符');
    this.wb.getTicket(preview.source.ticketId);
    this.wb.getTicket(input.combinationTicketId);
    if (input.combinationTicketId === preview.source.ticketId)
      throw new ProjectError(
        'MERGE_COMBINATION_TICKET',
        '组合验证须有明确另行安排，不能把源票旧意见当组合结果',
      );
    return transaction(this.db, () => {
      const prior = this.existingArrangement(actor, input);
      if (prior) return prior;
      if (this.busyRepository(preview.plan.target.commonDir))
        throw new ProjectError('MERGE_BUSY', '原共同仓库有未办合入或未知结果，先核对');
      this.gitGuard?.(preview.plan.target.commonDir);
      this.workerGuard?.(target.id);
      if (
        this.currentForSession(target.id) ||
        this.executions.currentForSession(target.id) ||
        this.db
          .prepare("SELECT id FROM collaboration WHERE session_id=? AND state!='completed'")
          .get(target.id) ||
        this.db
          .prepare(
            "SELECT id FROM review WHERE json_extract(data,'$.sessionId')=? AND json_extract(data,'$.status')!='decided'",
          )
          .get(target.id)
      )
        throw new ProjectError('MERGE_TARGET_BUSY', '原提交者仍有执行、协作、独审或合入责任');
      if (
        this.executions
          .list()
          .some(
            (e) =>
              e.writeOccupancy !== 'released' &&
              e.writeScopes.some((s) =>
                [preview.plan.target.repository, preview.plan.source.repository].some((p) =>
                  scopesOverlap(s, p),
                ),
              ),
          )
      )
        throw new ProjectError('MERGE_WRITER_BUSY', '源或目标仍有执行写入占用，先协调');
      const id = randomUUID(),
        value: WorktreeMergeRecord = {
          id,
          operationId: input.operationId,
          author,
          managerSessionId: actor.kind === 'session' ? actor.sessionId : '',
          committerSessionId: target.id,
          committerRoleId: target.roleId,
          basis: input.basis,
          taskId: randomUUID(),
          materialPath: ensureMergeMaterial(this.root, id, target.id),
          preview,
          combinationTicketId: input.combinationTicketId,
          status: 'arranged',
          revision: 1,
          native,
          lastInspection: null,
          lastProof: null,
          integrated: null,
          correctionReceiptIds: [],
          combinationAttempts: [],
          conflictSnapshot: null,
          lastQuiescence: null,
          report: null,
          repair: null,
          combination: null,
          notices: [],
          createdAt: now(),
          updatedAt: now(),
        };
      value.notices.push({
        id: messageIdentity('worktree-merge-arrangement:' + id),
        kind: 'arrangement',
        targetSessionId: target.id,
        revision: 1,
        state: 'pending',
        receipt: null,
        error: null,
      });
      this.db
        .prepare(
          'INSERT INTO worktree_merge(id,operation_id,request_hash,common_dir,session_id,data) VALUES(?,?,?,?,?,?)',
        )
        .run(
          id,
          input.operationId,
          hash({ actor, input }),
          preview.plan.target.commonDir,
          target.id,
          JSON.stringify(value),
        );
      this.wb.mergeArranged(actor, value);
      this.event(value, actor, 'arranged', { input, native });
      return value;
    });
  }
  requireWorker(actor: WorkbenchActor, value: WorktreeMergeRecord) {
    const author = this.wb.author(actor);
    if (
      actor.kind !== 'session' ||
      actor.sessionId !== value.committerSessionId ||
      author.roleType !== 'committer'
    )
      throw new ProjectError('MERGE_WORKER', '须由原提交类型实际会话办理');
    const session = this.sessions.get(actor.sessionId);
    if (
      session.status !== 'bound' ||
      session.communicationState !== 'active' ||
      session.nativeSessionId !== value.native.nativeSessionId ||
      session.error
    )
      throw new ProjectError('MERGE_WORKER', '原提交者身份或当前入口不可用');
    return author;
  }
  private command(
    actor: WorkbenchActor,
    id: string,
    kind: string,
    input: { operationId: string; expectedRevision: number },
    apply: (value: WorktreeMergeRecord) => void,
  ) {
    return transaction(this.db, () => {
      const requestHash = hash({ actor, id, kind, input }),
        old = this.db
          .prepare('SELECT request_hash,merge_id FROM worktree_merge_command WHERE id=?')
          .get(input.operationId);
      if (old) {
        if (old.request_hash !== requestHash || old.merge_id !== id)
          throw new ProjectError('MERGE_OPERATION', '原操作身份已使用但来源或正文不同');
        return this.get(actor, id);
      }
      const value = this.get(actor, id);
      if (value.revision !== input.expectedRevision)
        throw new ProjectError('MERGE_REVISION', '原合入修订已变化，先回读');
      apply(value);
      value.revision++;
      if (['report', 'reconcile'].includes(kind))
        value.notices.push({
          id: messageIdentity('worktree-merge-result:' + id + ':' + value.revision),
          kind: 'result',
          targetSessionId: value.managerSessionId,
          revision: value.revision,
          state: 'pending',
          receipt: null,
          error: null,
        });
      this.save(value);
      this.db
        .prepare('INSERT INTO worktree_merge_command(id,request_hash,merge_id) VALUES(?,?,?)')
        .run(input.operationId, requestHash, id);
      this.wb.mergeChanged(actor, value, kind);
      this.event(value, actor, kind, {
        input,
        status: value.status,
        inspection: value.lastInspection,
        proof: value.lastProof,
        quiet: value.lastQuiescence,
        repairVersion: value.repair?.version ?? null,
        combination: value.combination,
      });
      return value;
    });
  }
  inspected(
    actor: WorkbenchActor,
    id: string,
    raw: unknown,
    inspection: NonNullable<WorktreeMergeRecord['lastInspection']>,
    quiet: NonNullable<WorktreeMergeRecord['lastQuiescence']>,
    staged?: { tree: string; indexFingerprint: string },
  ) {
    const input = mergeInspectInputSchema.parse(raw);
    this.requireWorker(actor, this.get(actor, id));
    return this.command(actor, id, 'inspect', input, (v) => {
      if (!['arranged', 'ready', 'blocked'].includes(v.status))
        throw new ProjectError(
          'MERGE_NOT_INSPECTABLE',
          '原合入未知或已有结果，先沿原id核对，不重新授权Git',
        );
      v.lastInspection = inspection;
      if (staged) {
        if (!v.repair?.version || inspection.mode !== 'continue-commit' || !inspection.ready)
          throw new ProjectError('MERGE_REPAIR_STAGE', '没有原已审修正，不保存继续提交树');
        v.repair.expectedTree = staged.tree;
        v.repair.stagedIndexFingerprint = staged.indexFingerprint;
      }
      v.lastQuiescence = localCommitQuiescenceSchema.parse(quiet);
      v.status = inspection.ready && quiet.state === 'confirmed' ? 'ready' : 'unknown';
    });
  }
  private applyProof(
    value: WorktreeMergeRecord,
    proof: NonNullable<WorktreeMergeRecord['lastProof']>,
    quiet: NonNullable<WorktreeMergeRecord['lastQuiescence']>,
    allowBlocked: boolean,
  ) {
    value.lastProof = gitMergeProofSchema.parse(proof);
    value.lastQuiescence = localCommitQuiescenceSchema.parse(quiet);
    if (quiet.state !== 'confirmed') value.status = 'unknown';
    else if (proof.state === 'verified') {
      value.status = 'awaiting-verification';
      value.integrated ??= {
        head: proof.resultHead,
        tree: proof.resultTree,
        parents: proof.parents,
        observedAt: proof.observedAt,
      };
      value.correctionReceiptIds = proof.receiptIds ?? [];
    } else if (proof.state === 'conflict')
      value.status = value.repair?.version ? 'ready' : value.repair ? 'repairing' : 'conflict';
    else if (
      allowBlocked &&
      proof.state === 'not-observed' &&
      proof.currentHead === value.preview.plan.target.head
    )
      value.status = 'blocked';
    else value.status = 'unknown';
  }
  correctionChain(value: WorktreeMergeRecord) {
    if (!value.integrated) return [];
    const records = this.db
      .prepare('SELECT data FROM local_commit_arrangement ORDER BY rowid')
      .all()
      .map((r) => localCommitSchema.parse(JSON.parse(String(r.data))))
      .filter((r) => r.mergeId === value.id && r.status !== 'cancelled');
    let head = value.integrated.head;
    const chain: LocalCommitRecord[] = [];
    for (const r of records) {
      if (
        r.status !== 'completed' ||
        r.lastProof?.state !== 'verified' ||
        r.lastQuiescence?.state !== 'confirmed' ||
        r.plan.head !== head ||
        r.lastProof.parents.length !== 1 ||
        r.lastProof.parents[0] !== head ||
        !r.lastProof.commit ||
        !r.lastProof.tree ||
        key(r.plan.repository) !== key(value.preview.plan.target.repository)
      )
        throw new ProjectError(
          'MERGE_CORRECTION_CHAIN',
          '原组合必要提交回执链尚未核定，保留原合入输入和恢复条件',
        );
      head = r.lastProof.commit;
      chain.push(r);
    }
    return chain;
  }
  authorizeCorrectionCommit(
    actor: WorkbenchActor,
    input: z.infer<typeof localCommitArrangeSchema>,
    plan: LocalGitPlan,
  ) {
    if (!input.mergeId) return;
    this.requireManager(actor);
    const value = this.get(actor, input.mergeId);
    this.requireManager(actor, value);
    if (
      !value.integrated ||
      value.status !== 'awaiting-verification' ||
      value.committerSessionId !== input.sessionId ||
      plan.kind !== 'commit' ||
      input.versionIds.length !== 1 ||
      key(plan.repository) !== key(value.preview.plan.target.repository) ||
      key(plan.commonDir) !== key(value.preview.plan.target.commonDir) ||
      key(plan.gitDir) !== key(value.preview.plan.target.gitDir) ||
      plan.branch !== value.preview.plan.target.branch ||
      !this.approval
    )
      throw new ProjectError(
        'MERGE_CORRECTION_AUTHORITY',
        '必要提交只沿原合入、原提交者及当前已审组合交付安排',
      );
    const approved = this.approval(input.versionIds[0]!),
      root = approved.version.snapshot.roots.find(
        (r) => r.kind === 'git' && key(r.root) === key(plan.repository),
      );
    const chain = this.correctionChain(value),
      tip = chain.at(-1)?.lastProof?.commit ?? value.integrated.head;
    if (
      approved.execution.mergeId !== value.id ||
      approved.execution.ticketId !== value.combinationTicketId ||
      !root ||
      key(root.commonDir ?? '') !== key(plan.commonDir) ||
      root.head !== plan.head ||
      plan.head !== tip ||
      input.ticketIds.some((id) => id !== value.combinationTicketId)
    )
      throw new ProjectError(
        'MERGE_CORRECTION_VERSION',
        '必要提交不对应原组合新固定版本及已核定结果HEAD',
      );
    const current = inspectWorkspace({ cwd: plan.repository, storage: value.materialPath })
      .roots[0]!;
    const files = (r: typeof root) =>
      r.files.map(({ path, sha256, size, mode }) => [path, sha256, size, mode]);
    const actual = [
      ...new Set(
        plan.worktreeChanges.flatMap((c) => [c.path, ...(c.originalPath ? [c.originalPath] : [])]),
      ),
    ].sort();
    if (
      JSON.stringify(files(current)) !== JSON.stringify(files(root)) ||
      JSON.stringify(actual) !== JSON.stringify(plan.files.map((f) => f.path).sort()) ||
      plan.files.some(
        (f) =>
          !approved.execution.writeScopes.some((scope) =>
            withinPath(scope, canonicalWriteScope(plan.repository + '/' + f.path)),
          ),
      )
    )
      throw new ProjectError(
        'MERGE_CORRECTION_SCOPE',
        '准确必要提交须对应全部当前已审修正和原批准范围，不吸收范围外成果',
      );
  }
  existingCommand(
    actor: WorkbenchActor,
    id: string,
    kind: string,
    input: { operationId: string; expectedRevision: number },
  ) {
    const old = this.db
      .prepare('SELECT request_hash,merge_id FROM worktree_merge_command WHERE id=?')
      .get(input.operationId);
    if (!old) return;
    if (old.request_hash !== hash({ actor, id, kind, input }) || old.merge_id !== id)
      throw new ProjectError('MERGE_OPERATION', '原操作身份已使用但来源或正文不同');
    return this.get(actor, id);
  }
  reported(
    actor: WorkbenchActor,
    id: string,
    raw: unknown,
    proof: NonNullable<WorktreeMergeRecord['lastProof']>,
    quiet: NonNullable<WorktreeMergeRecord['lastQuiescence']>,
  ) {
    const input = mergeReportInputSchema.parse(raw),
      author = this.requireWorker(actor, this.get(actor, id));
    return this.command(actor, id, 'report', input, (v) => {
      if (['completed', 'cancelled', 'awaiting-verification'].includes(v.status))
        throw new ProjectError('MERGE_ALREADY_RECORDED', '原Git结果已经核定，不重放回报或合入');
      v.report = { author, state: input.state, content: input.content, at: now() };
      this.applyProof(v, proof, quiet, input.state === 'blocked');
    });
  }
  reconciled(
    actor: WorkbenchActor,
    id: string,
    raw: unknown,
    proof: NonNullable<WorktreeMergeRecord['lastProof']>,
    quiet: NonNullable<WorktreeMergeRecord['lastQuiescence']>,
  ) {
    this.requireManager(actor);
    const input = mergeReconcileInputSchema.parse(raw);
    return this.command(actor, id, 'reconcile', input, (v) => {
      if (['completed', 'cancelled'].includes(v.status))
        throw new ProjectError('MERGE_ALREADY_RECORDED', '原合入已办结，读取原结果即可');
      this.applyProof(v, proof, quiet, v.report?.state === 'blocked');
    });
  }
  conflictCaptured(
    id: string,
    proof: NonNullable<WorktreeMergeRecord['lastProof']>,
    snapshot: WorkspaceSnapshot,
  ) {
    const v = this.raw(id);
    if (
      v.status !== 'conflict' ||
      v.lastQuiescence?.state !== 'confirmed' ||
      v.lastProof?.indexFingerprint !== proof.indexFingerprint ||
      snapshot.roots[0]?.indexState?.indexFingerprint !== proof.indexFingerprint
    )
      throw new ProjectError('MERGE_CONFLICT_CAPTURE', '原冲突事实或停稳已变化，未保存交接现场');
    if (!v.conflictSnapshot) {
      v.conflictSnapshot = snapshot;
      this.save(v);
    }
    return v;
  }
  prepareRepair(actor: WorkbenchActor, id: string, raw: unknown) {
    const author = this.requireManager(actor),
      input = mergeRepairInputSchema.parse(raw);
    this.controls.requireDispatch();
    return this.command(actor, id, 'prepare-repair', input, (v) => {
      if (
        v.status !== 'conflict' ||
        !v.conflictSnapshot ||
        v.lastProof?.state !== 'conflict' ||
        v.lastQuiescence?.state !== 'confirmed'
      )
        throw new ProjectError('MERGE_REPAIR_NOT_READY', '须先固定原实际冲突和原提交者停稳');
      const ticket = this.wb.getTicket(input.ticketId);
      if (
        ticket.kind !== 'development' ||
        ticket.state !== 'todo' ||
        [v.preview.source.ticketId, v.combinationTicketId].includes(ticket.id)
      )
        throw new ProjectError(
          'MERGE_REPAIR_TICKET',
          '修正须有明确未派工的开发票，不借源旧意见或组合票',
        );
      const writeScopes = input.writeScopes.map(canonicalWriteScope);
      if (writeScopes.some((s) => !withinPath(v.preview.plan.target.repository, s)))
        throw new ProjectError('MERGE_REPAIR_SCOPE', '修正范围越出原目标');
      if (
        this.executions
          .list()
          .some(
            (e) =>
              e.writeOccupancy !== 'released' &&
              e.writeScopes.some((s) => scopesOverlap(s, v.preview.plan.target.repository)),
          )
      )
        throw new ProjectError('MERGE_REPAIR_WRITER', '原写入尚未释放，不交接给修正执行');
      v.repair = {
        operationId: input.operationId,
        ticketId: ticket.id,
        author,
        basis: input.basis,
        writeScopes,
        executionId: null,
        version: null,
        expectedTree: null,
        paths: [],
        indexFingerprint: v.lastProof.indexFingerprint,
        stagedIndexFingerprint: null,
        at: now(),
      };
      v.status = 'repairing';
      v.lastInspection = null;
    });
  }
  repairReviewed(
    actor: WorkbenchActor,
    id: string,
    raw: unknown,
    reviewed: NonNullable<NonNullable<WorktreeMergeRecord['repair']>['version']>,
    paths: string[],
  ) {
    this.requireManager(actor);
    const input = mergeReviewLinkInputSchema.parse(raw);
    return this.command(actor, id, 'repair-reviewed', input, (v) => {
      if (
        v.status !== 'repairing' ||
        !v.repair ||
        v.repair.executionId !== reviewed.executionId ||
        input.versionId !== reviewed.versionId ||
        input.resultId !== reviewed.resultId
      )
        throw new ProjectError('MERGE_REPAIR_REVIEW', '意见或执行不对应原修正交接');
      v.repair.version = reviewed;
      v.repair.paths = paths;
      v.status = 'ready';
      v.lastInspection = null;
      v.notices.push({
        id: messageIdentity('worktree-merge-repair-ready:' + id + ':' + reviewed.versionId),
        kind: 'arrangement',
        targetSessionId: v.committerSessionId,
        revision: v.revision + 1,
        state: 'pending',
        receipt: null,
        error: null,
      });
    });
  }
  combinationReviewed(
    actor: WorkbenchActor,
    id: string,
    raw: unknown,
    reviewed: NonNullable<WorktreeMergeRecord['combination']>,
    proof: NonNullable<WorktreeMergeRecord['lastProof']>,
    quiet: NonNullable<WorktreeMergeRecord['lastQuiescence']>,
  ) {
    this.requireManager(actor);
    const input = mergeReviewLinkInputSchema.parse(raw);
    return this.command(actor, id, 'combination-reviewed', input, (v) => {
      if (
        v.status !== 'awaiting-verification' ||
        input.versionId !== reviewed.versionId ||
        input.resultId !== reviewed.resultId ||
        reviewed.head !== proof.resultHead ||
        proof.resultHead !== v.lastProof?.resultHead
      )
        throw new ProjectError(
          'MERGE_COMBINATION_REVIEW',
          '组合版本、Git结果或原提交者停稳不对应原事项',
        );
      const passed = proof.state === 'verified' && quiet.state === 'confirmed';
      v.combinationAttempts.push({
        versionId: reviewed.versionId,
        resultId: reviewed.resultId,
        executionId: reviewed.executionId,
        state: passed ? 'passed' : 'needs-correction',
        basis: input.basis,
        reason: passed
          ? '同结果HEAD的新组合检查及指定意见已对应，Git与原生停稳独立核定'
          : proof.reason +
            '；' +
            quiet.note +
            '。保留原合入；实质修正须新交付/指定pass和明确必要提交，在新HEAD重新组合验证。',
        issues: [],
        author: this.wb.author(actor),
        at: now(),
      });
      if (!passed) return;
      v.combination = reviewed;
      v.lastProof = proof;
      v.lastQuiescence = quiet;
      v.status = 'completed';
    });
  }
  combinationReturned(
    actor: WorkbenchActor,
    id: string,
    raw: unknown,
    evidence: { executionId: string; issues: string[] },
  ) {
    const author = this.requireManager(actor),
      input = mergeReviewLinkInputSchema.parse(raw);
    return this.command(actor, id, 'combination-returned', input, (v) => {
      if (v.status !== 'awaiting-verification')
        throw new ProjectError('MERGE_COMBINATION_NOT_READY', '原合入尚未进入组合核验或已经办结');
      v.combinationAttempts.push({
        versionId: input.versionId,
        resultId: input.resultId,
        executionId: evidence.executionId,
        state: 'returned',
        basis: input.basis,
        reason:
          '保留原合入及失败固定版本。原组合执行按指定退回意见修正，重新验证并送审；实质变化另由主管明确必要提交及新HEAD组合补做，不自动重做merge或清理。',
        issues: evidence.issues,
        author,
        at: now(),
      });
    });
  }
  cancelled(
    actor: WorkbenchActor,
    id: string,
    raw: unknown,
    proof: NonNullable<WorktreeMergeRecord['lastProof']>,
    quiet: NonNullable<WorktreeMergeRecord['lastQuiescence']>,
  ) {
    this.requireManager(actor);
    const input = mergeReconcileInputSchema.parse(raw);
    return this.command(actor, id, 'cancel', input, (v) => {
      if (
        ['completed', 'cancelled'].includes(v.status) ||
        proof.state !== 'not-observed' ||
        proof.currentHead !== v.preview.plan.target.head ||
        proof.mergeHeads.length ||
        quiet.state !== 'confirmed'
      )
        throw new ProjectError(
          'MERGE_CANCEL_UNKNOWN',
          '只有独立核定原合入未发生且原提交者安静才撤销；不自动清理冲突',
        );
      v.lastProof = proof;
      v.lastQuiescence = quiet;
      v.status = 'cancelled';
    });
  }
  validateDispatch(
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
  ) {
    if (!input.mergeId) {
      this.guardScopes(input.writeScopes);
      return;
    }
    this.requireManager(actor);
    const v = this.get(actor, input.mergeId),
      repair = v.status === 'repairing' && v.repair?.ticketId === input.ticket;
    this.requireManager(actor, v);
    const combination =
      v.status === 'awaiting-verification' && v.combinationTicketId === input.ticket;
    if (
      (!repair && !combination) ||
      input.roleType !== 'developer' ||
      input.additionalRepositories.length ||
      key(canonicalDirectory(input.cwd)) !== key(v.preview.plan.target.repository)
    )
      throw new ProjectError(
        'MERGE_DISPATCH',
        '合入关联只授权原明确修正或组合票、目标目录与开发角色',
      );
    const allowed = repair ? v.repair!.writeScopes : [v.preview.plan.target.repository];
    if (input.writeScopes.some((s) => !allowed.some((a) => withinPath(a, s))))
      throw new ProjectError('MERGE_DISPATCH_SCOPE', '本次范围超出原主管明确交接');
    if (repair && v.repair!.executionId)
      throw new ProjectError('MERGE_REPAIR_EXECUTION', '已有原修正执行，不自动迁移责任');
    if (input.worktreeId) {
      const row = this.db
        .prepare('SELECT data FROM worktree_record WHERE id=?')
        .get(input.worktreeId);
      const path = row ? (JSON.parse(String(row.data)) as { path?: string }).path : undefined;
      if (!path || key(path) !== key(v.preview.plan.target.repository))
        throw new ProjectError('MERGE_DISPATCH_WORKTREE', '派工工作树与原目标不符');
    }
    this.guardScopes(input.writeScopes, v.id);
  }
  linkExecution(e: ExecutionRecord) {
    if (!e.mergeId) return;
    const v = this.raw(e.mergeId);
    if (v.status === 'repairing' && v.repair?.ticketId === e.ticketId) {
      if (v.repair.executionId && v.repair.executionId !== e.id)
        throw new ProjectError('MERGE_REPAIR_EXECUTION', '修正执行不可替换');
      v.repair.executionId = e.id;
      this.save(v);
    }
  }
  snapshotContext(executionId: string): SnapshotInput['mergeRepair'] {
    const e = this.executions.get(executionId);
    if (!e.mergeId) return;
    const v = this.raw(e.mergeId);
    if (v.repair?.executionId !== e.id || e.ticketId !== v.repair.ticketId) return;
    return {
      repository: v.preview.plan.target.repository,
      expectedHead: v.preview.plan.target.head,
      expectedMergeHeads: [v.preview.plan.sourceCommit],
      expectedIndexFingerprint: v.repair.indexFingerprint,
    };
  }
  recoveryLink(executionId: string, scopes: string[]): string | undefined {
    const e = this.executions.get(executionId);
    if (!e.mergeId) return undefined;
    const v = this.raw(e.mergeId),
      target = v.preview.plan.target.repository;
    const allowed =
      v.status === 'repairing' && v.repair?.executionId === e.id && e.ticketId === v.repair.ticketId
        ? v.repair.writeScopes
        : v.status === 'awaiting-verification' && e.ticketId === v.combinationTicketId
          ? [target]
          : undefined;
    if (
      !allowed ||
      key(e.cwd) !== key(target) ||
      scopes.some((path) => !allowed.some((root) => withinPath(root, path)))
    )
      throw new ProjectError('MERGE_SCOPE_BUSY', '原执行已不对应有效合入交接或范围');
    return v.id;
  }
  noticeRecorded(
    id: string,
    noticeId: string,
    receipt: WorktreeMergeRecord['notices'][number]['receipt'],
    error: string | null,
  ) {
    const v = this.raw(id),
      n = v.notices.find((n) => n.id === noticeId);
    if (!n) throw new ProjectError('MERGE_NOTICE', '原合入通知不存在');
    if (
      receipt &&
      (receipt.messageId !== noticeId || receipt.targetSessionId !== n.targetSessionId)
    )
      throw new ProjectError('MERGE_NOTICE_TARGET', '实际通知回执目标与原安排不同');
    n.receipt = receipt;
    n.state =
      receipt?.memoryAcceptedAt && receipt.durableAcceptedAt && receipt.nativeMessageId === noticeId
        ? 'confirmed'
        : 'unknown';
    n.error = error ?? receipt?.error ?? null;
    this.save(v);
    return v;
  }
  noticeInput(id: string, noticeId: string): ChatInput {
    const v = this.raw(id),
      notice = v.notices.find((n) => n.id === noticeId);
    if (!notice) throw new ProjectError('MERGE_NOTICE', '没有原合入事务保存的指定通知');
    const target = notice.kind === 'arrangement' ? v.committerSessionId : v.managerSessionId,
      role = notice.kind === 'arrangement' ? 'committer' : 'supervisor';
    if (notice.targetSessionId !== target || this.sessions.get(target).roleType !== role)
      throw new ProjectError('MERGE_NOTICE', '通知不对应原提交者或原主管');
    return {
      id: notice.id,
      target,
      content:
        notice.kind === 'arrangement'
          ? `MAT跨树合入安排 ${id}。先用mat_merge query完整读取固定源版本、源commit、目标及原授权，再inspect。只有ready才按明确mode办理一次普通merge或已审修正后的continue；命令须保护ignored内容。unknown先回读，conflict交主管安排业务修正；不自行abort、重做、stash/reset或选择业务一边。结果report，组合核验另行记录。`
          : `MAT原合入 ${id} 修订 ${notice.revision} 已保存实际回报/核对。用mat_merge query读取Git事实、停稳、冲突交接与组合结果；通知接纳不表示组合通过或结票。`,
      references: [],
    };
  }
  isCurrentNotice(id: string) {
    const row = this.db
      .prepare(
        "SELECT m.id FROM worktree_merge m,json_each(m.data,'$.notices') n WHERE json_extract(n.value,'$.id')=?",
      )
      .get(id);
    if (!row) return true;
    const value = this.raw(String(row.id)),
      notice = value.notices.find((n) => n.id === id)!;
    return notice.kind === 'arrangement'
      ? ['arranged', 'ready'].includes(value.status) &&
          (!value.repair?.version ||
            notice.id ===
              messageIdentity(
                'worktree-merge-repair-ready:' + value.id + ':' + value.repair.version.versionId,
              ))
      : notice.revision === value.revision;
  }
  saveManagedRange(session: string, fact: WorktreeMergeRecord['native']['ranges'][number]) {
    const v = this.currentForSession(session);
    if (!v || v.native.nativeSessionId !== fact.nativeOwner) return;
    const at = v.native.ranges.findIndex((r) => r.id === fact.id);
    if (at < 0) v.native.ranges.push(fact);
    else v.native.ranges[at] = fact;
    this.save(v);
  }
  currentForSession(session: string) {
    return this.list({ kind: 'user' }).findLast(
      (v) => v.committerSessionId === session && !['completed', 'cancelled'].includes(v.status),
    );
  }
  busyRepository(common: string, authorizedCorrectionId?: string) {
    return this.list({ kind: 'user' }).some(
      (v) =>
        v.id !== authorizedCorrectionId &&
        key(v.preview.plan.target.commonDir) === key(common) &&
        !['completed', 'cancelled'].includes(v.status),
    );
  }
  guardScopes(scopes: string[], authorizedMergeId?: string) {
    for (const value of this.list({ kind: 'user' })) {
      if (['completed', 'cancelled'].includes(value.status)) continue;
      if (value.id === authorizedMergeId) continue;
      const roots =
        value.status === 'awaiting-verification'
          ? [value.preview.plan.target.repository]
          : [value.preview.plan.target.repository, value.preview.plan.source.repository];
      if (scopes.some((scope) => roots.some((root) => scopesOverlap(scope, root))))
        throw new ProjectError('MERGE_SCOPE_BUSY', '原合入或组合核验仍占用此范围，先沿原安排交接');
    }
  }
  bindWorkerGuard(guard: (session: string) => void) {
    this.workerGuard = guard;
  }
  bindGitGuard(guard: (commonDir: string) => void) {
    this.gitGuard = guard;
  }
}
