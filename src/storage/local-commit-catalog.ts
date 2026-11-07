import { randomUUID, createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  localCommitArrangeSchema,
  localCommitInspectSchema,
  localCommitReportSchema,
  localCommitReconcileSchema,
  localCommitSchema,
  localGitPlanSchema,
  localGitProofSchema,
  localCommitQuiescenceSchema,
} from '../contracts/local-commits.ts';
import type {
  LocalCommitRecord,
  LocalGitPlan,
  LocalGitProof,
  LocalCommitQuiescence,
} from '../contracts/local-commits.ts';
import type { WorkbenchActor, RecordAuthor } from '../contracts/workbench.ts';
import type { DeliveryRecord, ChatInput } from '../contracts/chat.ts';
import type { SessionCatalog } from './session-catalog.ts';
import type { WorkbenchCatalog } from './workbench-catalog.ts';
import type { ExecutionCatalog } from './execution-catalog.ts';
import type { VersionCatalog } from './version-catalog.ts';
import { ensureLocalCommitMaterial } from '../services/ticket-materials.ts';
import { withinPath, scopesOverlap } from '../services/write-scopes.ts';
import { messageIdentity } from '../services/message-presentation.ts';
import { ProjectError } from '../services/errors.ts';
import { transaction } from './transaction.ts';
const key = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
const stamp = () => new Date().toISOString(),
  hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
export function migrateLocalCommits(db: DatabaseSync) {
  db.exec(`CREATE TABLE local_commit_arrangement(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,session_id TEXT NOT NULL REFERENCES session(id),common_dir TEXT NOT NULL,data TEXT NOT NULL);
 CREATE TABLE local_commit_event(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,arrangement_id TEXT NOT NULL REFERENCES local_commit_arrangement(id),data TEXT NOT NULL);
 CREATE TABLE local_commit_command(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,arrangement_id TEXT NOT NULL REFERENCES local_commit_arrangement(id));PRAGMA user_version=16;`);
}
export class LocalCommitCatalog {
  private readonly db: DatabaseSync;
  private readonly sessions: SessionCatalog;
  private readonly wb: WorkbenchCatalog;
  private readonly executions: ExecutionCatalog;
  private readonly versions: VersionCatalog;
  private readonly root: string;
  private workerGuard: ((session: string, mergeId?: string) => void) | undefined;
  private gitGuard: ((commonDir: string, mergeId?: string) => void) | undefined;
  private mergeGuard:
    | ((
        actor: WorkbenchActor,
        input: ReturnType<typeof localCommitArrangeSchema.parse>,
        plan: LocalGitPlan,
      ) => void)
    | undefined;
  bindMergeGuard(guard: NonNullable<LocalCommitCatalog['mergeGuard']>) {
    this.mergeGuard = guard;
  }
  constructor(
    db: DatabaseSync,
    sessions: SessionCatalog,
    wb: WorkbenchCatalog,
    executions: ExecutionCatalog,
    versions: VersionCatalog,
    root: string,
  ) {
    this.db = db;
    this.sessions = sessions;
    this.wb = wb;
    this.executions = executions;
    this.versions = versions;
    this.root = root;
  }
  private raw(id: string): LocalCommitRecord {
    const row = this.db.prepare('SELECT data FROM local_commit_arrangement WHERE id=?').get(id);
    if (!row) throw new ProjectError('LOCAL_COMMIT_NOT_FOUND', '本地提交安排不存在');
    return localCommitSchema.parse(JSON.parse(String(row.data)));
  }
  private save(value: LocalCommitRecord) {
    value.updatedAt = stamp();
    this.db
      .prepare('UPDATE local_commit_arrangement SET data=? WHERE id=?')
      .run(JSON.stringify(value), value.id);
  }
  requireManager(actor: WorkbenchActor): RecordAuthor {
    const author = this.wb.author(actor);
    if (
      actor.kind !== 'session' ||
      author.roleType !== 'supervisor' ||
      this.sessions.get(actor.sessionId).status !== 'bound' ||
      this.sessions.get(actor.sessionId).communicationState !== 'active' ||
      this.sessions.get(actor.sessionId).error !== null
    )
      throw new ProjectError(
        'LOCAL_COMMIT_MANAGER',
        '本地提交由当前真实主管安排，不从聊天正文或普通成员推定',
      );
    return author;
  }
  private worker(actor: WorkbenchActor, value: LocalCommitRecord): RecordAuthor {
    const author = this.wb.author(actor);
    if (
      actor.kind !== 'session' ||
      actor.sessionId !== value.committerSessionId ||
      author.roleType !== 'committer'
    )
      throw new ProjectError('LOCAL_COMMIT_WORKER', '回报须来自原提交类型实际会话');
    return author;
  }
  private canRead(actor: WorkbenchActor, value: LocalCommitRecord): boolean {
    const a = this.wb.author(actor);
    return (
      actor.kind === 'user' ||
      a.roleType === 'supervisor' ||
      actor.sessionId === value.committerSessionId ||
      this.executions
        .list()
        .some((e) => e.sessionId === actor.sessionId && value.ticketIds.includes(e.ticketId))
    );
  }
  get(actor: WorkbenchActor, id: string): LocalCommitRecord {
    const value = this.raw(id);
    if (!this.canRead(actor, value))
      throw new ProjectError('LOCAL_COMMIT_SCOPE', '此入口没有原事项的关联责任');
    return value;
  }
  list(actor: WorkbenchActor): LocalCommitRecord[] {
    return this.db
      .prepare('SELECT id FROM local_commit_arrangement ORDER BY rowid')
      .all()
      .map((row) => this.raw(String(row.id)))
      .filter((v) => this.canRead(actor, v));
  }
  pending(actor: WorkbenchActor) {
    return this.list(actor).filter(
      (v) =>
        !['completed', 'cancelled'].includes(v.status) ||
        v.notices.some((n) => n.kind === 'result' && n.state !== 'confirmed'),
    );
  }
  currentForSession(sessionId: string): LocalCommitRecord | undefined {
    return this.db
      .prepare('SELECT id FROM local_commit_arrangement WHERE session_id=? ORDER BY rowid DESC')
      .all(sessionId)
      .map((row) => this.raw(String(row.id)))
      .find((v) => !['completed', 'cancelled'].includes(v.status));
  }
  history(actor: WorkbenchActor, id: string) {
    this.get(actor, id);
    return this.db
      .prepare('SELECT data FROM local_commit_event WHERE arrangement_id=? ORDER BY seq')
      .all(id)
      .map(
        (row) =>
          JSON.parse(String(row.data)) as {
            id: string;
            kind: string;
            author: RecordAuthor;
            at: string;
            data: Record<string, unknown>;
          },
      );
  }
  private event(value: LocalCommitRecord, kind: string, author: RecordAuthor, data: unknown) {
    const event = { id: randomUUID(), kind, author, at: stamp(), data };
    this.db
      .prepare('INSERT INTO local_commit_event(id,arrangement_id,data) VALUES(?,?,?)')
      .run(event.id, value.id, JSON.stringify(event));
  }
  private command(
    actor: WorkbenchActor,
    id: string,
    kind: string,
    input: { operationId: string; expectedRevision: number },
    run: (value: LocalCommitRecord, author: RecordAuthor) => void,
  ): LocalCommitRecord {
    const author = this.wb.author(actor),
      h = hash({ actor, id, kind, input });
    return transaction(this.db, () => {
      const old = this.db
        .prepare('SELECT request_hash,arrangement_id FROM local_commit_command WHERE id=?')
        .get(input.operationId);
      if (old) {
        if (old.request_hash !== h)
          throw new ProjectError('LOCAL_COMMIT_OPERATION', '操作身份已使用但回报或来源不同');
        return this.get(actor, String(old.arrangement_id));
      }
      const value = this.get(actor, id);
      if (['completed', 'cancelled'].includes(value.status)) return value;
      if (value.revision !== input.expectedRevision)
        throw new ProjectError('LOCAL_COMMIT_REVISION', '原事项修订已变化，请回读');
      run(value, author);
      value.revision++;
      this.save(value);
      this.db
        .prepare('INSERT INTO local_commit_command(id,request_hash,arrangement_id) VALUES(?,?,?)')
        .run(input.operationId, h, id);
      this.wb.localCommitChanged(actor, value, kind);
      return value;
    });
  }
  existingArrangement(actor: WorkbenchActor, raw: unknown): LocalCommitRecord | undefined {
    const input = localCommitArrangeSchema.parse(raw);
    this.requireManager(actor);
    const row = this.db
      .prepare('SELECT id,request_hash FROM local_commit_arrangement WHERE operation_id=?')
      .get(input.operationId);
    if (!row) return undefined;
    if (row.request_hash !== hash({ actor, input }))
      throw new ProjectError('LOCAL_COMMIT_OPERATION', '操作身份已使用但安排内容或来源不同');
    return this.get(actor, String(row.id));
  }
  arrange(
    actor: WorkbenchActor,
    raw: unknown,
    rawPlan: LocalGitPlan,
    native: LocalCommitRecord['native'] = null,
  ): LocalCommitRecord {
    const input = localCommitArrangeSchema.parse(raw),
      author = this.requireManager(actor),
      existing = this.existingArrangement(actor, input);
    if (existing) return existing;
    const plan = localGitPlanSchema.parse(rawPlan);
    if (
      plan.fingerprint !== input.expectedFingerprint ||
      plan.kind !== input.kind ||
      realpathSync(input.repository) !== plan.repository ||
      JSON.stringify(input.files.map((p) => key(p.replaceAll('\\', '/'))).sort()) !==
        JSON.stringify(plan.files.map((f) => key(f.path)).sort())
    )
      throw new ProjectError('LOCAL_COMMIT_PREVIEW', '当前差异与主管明确预览不一致');
    const known = [this.root, ...this.executions.list().flatMap((e) => e.additionalRepositories)];
    if (!known.some((root) => withinPath(root, plan.repository)))
      throw new ProjectError('LOCAL_COMMIT_REPOSITORY', '仓库不属于固定项目或已明确的其他仓库');
    const control = this.db.prepare('SELECT started FROM project WHERE singleton=1').get();
    if (control?.started !== 1)
      throw new ProjectError('LOCAL_COMMIT_PROJECT_STOPPED', '项目未启动，不安排新Git工作');
    const target = this.sessions.get(input.sessionId);
    if (
      target.roleType !== 'committer' ||
      target.status !== 'bound' ||
      target.communicationState !== 'active' ||
      target.error
    )
      throw new ProjectError('LOCAL_COMMIT_TARGET', '目标须为本项目可用提交类型实际会话');
    for (const id of input.ticketIds) this.wb.getTicket(id);
    const ticketIds = [
      ...new Set([
        ...input.ticketIds,
        ...input.versionIds.map((id) => this.versions.get(id).ticket.id),
      ]),
    ];
    return transaction(this.db, () => {
      const prior = this.existingArrangement(actor, input);
      if (prior) return prior;
      const active = this.list({ kind: 'user' }).filter(
        (v) => !['completed', 'cancelled'].includes(v.status),
      );
      if (active.length > 0)
        throw new ProjectError(
          'LOCAL_COMMIT_BUSY',
          '原安排尚未办结或Git结果未知，先核对原安排，不重复派工',
        );
      if (input.mergeId && !this.mergeGuard)
        throw new ProjectError(
          'LOCAL_COMMIT_MERGE_UNAVAILABLE',
          '缺少原合入必要修正资格核对，不授范围例外',
        );
      this.mergeGuard?.(actor, input, plan);
      this.gitGuard?.(plan.commonDir, input.mergeId);
      this.workerGuard?.(target.id, input.mergeId);
      const paths = plan.files.map((f) => join(plan.repository, f.path));
      if (
        this.executions
          .list()
          .some(
            (e) =>
              e.writeOccupancy !== 'released' &&
              e.writeScopes.some((scope) => paths.some((path) => scopesOverlap(scope, path))),
          )
      )
        throw new ProjectError(
          'LOCAL_COMMIT_WRITER_BUSY',
          '获准范围仍有执行写入占用，先协调本次在途工作',
        );
      if (
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
        throw new ProjectError('LOCAL_COMMIT_TARGET_BUSY', '目标仍有原执行、协作或独审责任');
      const id = randomUUID(),
        value: LocalCommitRecord = {
          id,
          operationId: input.operationId,
          author,
          managerSessionId: actor.kind === 'session' ? actor.sessionId : '',
          committerSessionId: target.id,
          committerRoleId: target.roleId,
          kind: input.kind,
          basis: input.basis,
          commitMessage: input.commitMessage,
          ticketIds,
          versionIds: input.versionIds,
          mergeId: input.mergeId ?? null,
          taskId: randomUUID(),
          materialPath: ensureLocalCommitMaterial(this.root, id, target.id),
          plan,
          native,
          status: 'arranged',
          revision: 1,
          lastInspection: null,
          lastProof: null,
          lastQuiescence: null,
          report: null,
          notices: [],
          createdAt: stamp(),
          updatedAt: stamp(),
        };
      value.notices.push({
        id: messageIdentity('local-commit-arrangement:' + id),
        kind: 'arrangement',
        targetSessionId: target.id,
        revision: 1,
        state: 'pending',
        receipt: null,
        error: null,
      });
      this.db
        .prepare(
          'INSERT INTO local_commit_arrangement(id,operation_id,request_hash,session_id,common_dir,data) VALUES(?,?,?,?,?,?)',
        )
        .run(
          id,
          input.operationId,
          hash({ actor, input }),
          target.id,
          plan.commonDir,
          JSON.stringify(value),
        );
      this.event(value, 'arranged', author, { input, plan });
      this.wb.localCommitArranged(actor, value);
      return value;
    });
  }
  inspected(
    actor: WorkbenchActor,
    id: string,
    raw: unknown,
    inspection: NonNullable<LocalCommitRecord['lastInspection']>,
  ) {
    const input = localCommitInspectSchema.parse(raw);
    this.worker(actor, this.get(actor, id));
    return this.command(actor, id, 'inspection', input, (value, author) => {
      value.lastInspection = inspection;
      value.status = inspection.ready ? 'ready' : 'blocked';
      this.event(value, 'inspection', author, inspection);
    });
  }
  report(
    actor: WorkbenchActor,
    id: string,
    raw: unknown,
    rawProof: LocalGitProof,
    quiescence: LocalCommitQuiescence = {
      state: 'unknown',
      note: '原生执行尚未核定',
      observedAt: stamp(),
    },
  ) {
    const input = localCommitReportSchema.parse(raw),
      proof = localGitProofSchema.parse(rawProof);
    this.worker(actor, this.get(actor, id));
    return this.command(actor, id, 'report', input, (value, author) => {
      value.lastProof = this.checkedProof(value, proof);
      value.lastQuiescence = localCommitQuiescenceSchema.parse(quiescence);
      value.report = { author, state: input.state, content: input.content, at: stamp() };
      value.status =
        value.lastProof.state === 'verified' && value.lastQuiescence.state === 'confirmed'
          ? 'completed'
          : input.state === 'blocked' &&
              value.lastProof.state === 'not-observed' &&
              value.lastProof.currentHead === value.plan.head &&
              value.lastQuiescence.state === 'confirmed'
            ? 'blocked'
            : 'unknown';
      this.event(value, 'report', author, { input, proof });
      this.resultNotice(value);
    });
  }
  reconcile(
    actor: WorkbenchActor,
    id: string,
    raw: unknown,
    rawProof: LocalGitProof,
    quiescence: LocalCommitQuiescence = {
      state: 'unknown',
      note: '原生执行尚未核定',
      observedAt: stamp(),
    },
  ) {
    const input = localCommitReconcileSchema.parse(raw),
      proof = localGitProofSchema.parse(rawProof),
      v = this.get(actor, id);
    if (
      actor.kind !== 'session' ||
      ![v.managerSessionId, v.committerSessionId].includes(actor.sessionId)
    )
      throw new ProjectError('LOCAL_COMMIT_RECONCILE', '只有原主管或原提交者可办理核对');
    return this.command(actor, id, 'reconcile', input, (value, author) => {
      value.lastProof = this.checkedProof(value, proof);
      value.lastQuiescence = localCommitQuiescenceSchema.parse(quiescence);
      value.status =
        value.lastProof.state === 'verified' && value.lastQuiescence.state === 'confirmed'
          ? 'completed'
          : 'unknown';
      this.event(value, 'reconcile', author, { input, proof });
      this.resultNotice(value);
    });
  }
  cancel(
    actor: WorkbenchActor,
    id: string,
    raw: unknown,
    proof: LocalGitProof,
    quiescence: LocalCommitQuiescence,
  ) {
    const input = localCommitReconcileSchema.parse(raw),
      value = this.get(actor, id);
    this.requireManager(actor);
    if (actor.kind !== 'session' || actor.sessionId !== value.managerSessionId)
      throw new ProjectError('LOCAL_COMMIT_CANCEL', '仅原主管撤销原安排');
    if (
      proof.state !== 'not-observed' ||
      proof.currentHead !== value.plan.head ||
      quiescence.state !== 'confirmed'
    )
      throw new ProjectError('LOCAL_COMMIT_CANCEL', 'Git对象或在途尚未核定，不能撤销后重复安排');
    return this.command(actor, id, 'cancel', input, (v, author) => {
      v.lastProof = localGitProofSchema.parse(proof);
      v.lastQuiescence = localCommitQuiescenceSchema.parse(quiescence);
      v.status = 'cancelled';
      this.event(v, 'cancel', author, { input, proof, quiescence });
      this.resultNotice(v);
    });
  }
  private checkedProof(value: LocalCommitRecord, proof: LocalGitProof): LocalGitProof {
    if (proof.state === 'verified' && proof.message?.trim() !== value.commitMessage.trim())
      return {
        ...proof,
        state: 'mismatch',
        reason: '实际提交说明与原明确安排不符，保留对象并核对',
      };
    return proof;
  }
  private resultNotice(value: LocalCommitRecord) {
    value.notices.push({
      id: messageIdentity('local-commit-result:' + value.id + ':' + (value.revision + 1)),
      kind: 'result',
      targetSessionId: value.managerSessionId,
      revision: value.revision + 1,
      state: 'pending',
      receipt: null,
      error: null,
    });
  }
  noticeInput(id: string, noticeId: string): ChatInput {
    const value = this.raw(id),
      notice = value.notices.find((n) => n.id === noticeId);
    if (!notice) throw new ProjectError('LOCAL_COMMIT_NOTICE', '没有原事项事务保存的指定通知');
    const expected =
        notice.kind === 'arrangement' ? value.committerSessionId : value.managerSessionId,
      role = notice.kind === 'arrangement' ? 'committer' : 'supervisor';
    if (notice.targetSessionId !== expected || this.sessions.get(expected).roleType !== role)
      throw new ProjectError('LOCAL_COMMIT_NOTICE', '通知不对应原提交者或原主管');
    return {
      id: notice.id,
      target: expected,
      content:
        notice.kind === 'arrangement'
          ? `MAT本地提交安排 ${id}。主管已明确仓库及准确文件；先用mat_local_commit query读取原依据，再inspect核对。只有ready才办理一次；unknown先reconcile，不重做。不是远程发布或业务验收。`
          : `MAT本地事项 ${id} 修订 ${notice.revision} 已保存回报/核对。用mat_local_commit query读Git对象、在途与原责任记录；通知接纳不表示已读或业务验收。`,
      references: [],
    };
  }
  noticeResult(id: string, noticeId: string, receipt: DeliveryRecord) {
    return transaction(this.db, () => {
      const value = this.raw(id),
        notice = value.notices.find((n) => n.id === noticeId);
      if (
        !notice ||
        notice.targetSessionId !== receipt.targetSessionId ||
        receipt.nativeMessageId !== noticeId
      )
        throw new ProjectError('LOCAL_COMMIT_NOTICE', '原通知或接纳来源不符');
      notice.receipt = receipt;
      notice.state =
        receipt.memoryAcceptedAt && receipt.durableAcceptedAt ? 'confirmed' : 'unknown';
      notice.error = receipt.error;
      this.save(value);
      return value;
    });
  }
  noticeFailed(id: string, noticeId: string, error: string) {
    const value = this.raw(id),
      notice = value.notices.find((n) => n.id === noticeId);
    if (notice) {
      notice.state = 'unknown';
      notice.error = error;
      this.save(value);
    }
  }
  saveManagedRange(
    session: string,
    fact: NonNullable<LocalCommitRecord['native']>['ranges'][number],
  ) {
    const value = this.currentForSession(session);
    if (!value?.native || value.native.nativeSessionId !== fact.nativeOwner) return;
    const index = value.native.ranges.findIndex((r) => r.id === fact.id);
    if (index < 0) value.native.ranges.push(fact);
    else value.native.ranges[index] = fact;
    this.save(value);
  }
  isCurrentNotice(id: string): boolean {
    const row = this.db
      .prepare(
        "SELECT a.id FROM local_commit_arrangement a,json_each(a.data,'$.notices') n WHERE json_extract(n.value,'$.id')=?",
      )
      .get(id);
    if (!row) return true;
    const v = this.raw(String(row.id)),
      n = v.notices.find((n) => n.id === id)!;
    return n.kind === 'arrangement'
      ? ['arranged', 'ready'].includes(v.status)
      : n.revision === v.revision;
  }
  bindWorkerGuard(guard: (session: string, mergeId?: string) => void) {
    this.workerGuard = guard;
  }
  bindGitGuard(guard: (commonDir: string, mergeId?: string) => void) {
    this.gitGuard = guard;
  }
  busyRepository(commonDir: string) {
    return this.list({ kind: 'user' }).some(
      (v) => !['completed', 'cancelled'].includes(v.status) && v.plan.commonDir === commonDir,
    );
  }
  guardScopes(scopes: string[]) {
    for (const value of this.list({ kind: 'user' }))
      if (
        !['completed', 'cancelled'].includes(value.status) &&
        value.plan.files.some((f) =>
          scopes.some((scope) => scopesOverlap(scope, join(value.plan.repository, f.path))),
        )
      )
        throw new ProjectError(
          'LOCAL_COMMIT_SCOPE_BUSY',
          '当前本地提交事项仍在核对，不能并行改写其明确文件范围',
        );
  }
}
