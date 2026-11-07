import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { join, relative, sep } from 'node:path';
import { isAbsolute } from 'node:path';
import { realpathSync, lstatSync } from 'node:fs';
import { withinPath } from '../services/write-scopes.ts';
import { deliveryVersionInputSchema, deliveryVersionSchema } from '../contracts/versions.ts';
import type { DeliveryVersion, SnapshotInput } from '../contracts/versions.ts';
import type { WorkbenchActor } from '../contracts/workbench.ts';
import type { ExecutionCatalog } from './execution-catalog.ts';
import type { WorkbenchCatalog } from './workbench-catalog.ts';
import type { SessionCatalog } from './session-catalog.ts';
import { transaction } from './transaction.ts';
import { ProjectError } from '../services/errors.ts';
import {
  captureWorkspace,
  inspectWorkspace,
  compareWorkspaces,
  readSnapshotFile,
} from '../services/workspace-snapshot.ts';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function migrateVersions(db: DatabaseSync) {
  db.exec(
    `CREATE TABLE execution_version(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,execution_id TEXT NOT NULL REFERENCES execution(id),sequence INTEGER NOT NULL,data TEXT NOT NULL,UNIQUE(execution_id,sequence));PRAGMA user_version=8;`,
  );
}
/** Immutable baseline and deliveries; snapshot I/O and version identity stay behind this boundary. */
export class VersionCatalog {
  private readonly db: DatabaseSync;
  private readonly executions: ExecutionCatalog;
  private readonly wb: WorkbenchCatalog;
  private readonly sessions: SessionCatalog;
  private readonly root: string;
  readonly storage: string;
  private mergeContext: ((executionId: string) => SnapshotInput['mergeRepair']) | undefined;
  bindMergeContext(context: NonNullable<VersionCatalog['mergeContext']>) {
    this.mergeContext = context;
  }
  constructor(
    db: DatabaseSync,
    executions: ExecutionCatalog,
    wb: WorkbenchCatalog,
    sessions: SessionCatalog,
    root: string,
  ) {
    this.db = db;
    this.executions = executions;
    this.wb = wb;
    this.sessions = sessions;
    this.root = root;
    this.storage = join(root, '.TEAM', '运行数据', '版本原件');
  }
  get(id: string): DeliveryVersion {
    const row = this.db.prepare('SELECT data FROM execution_version WHERE id=?').get(id);
    if (!row) throw new ProjectError('VERSION_NOT_FOUND', '固定版本不存在');
    return deliveryVersionSchema.parse(JSON.parse(String(row.data)));
  }
  list(executionId: string): DeliveryVersion[] {
    this.executions.get(executionId);
    return this.db
      .prepare('SELECT id FROM execution_version WHERE execution_id=? ORDER BY sequence')
      .all(executionId)
      .map((row) => this.get(String(row.id)));
  }
  private input(executionId: string): SnapshotInput {
    const execution = this.executions.get(executionId),
      domains = this.wb
        .materialDomains(execution.ticketId)
        .filter((domain) => domain.referenceId === execution.id);
    if (!execution.sessionId || !domains.length)
      throw new ProjectError(
        'VERSION_SCOPE_MISSING',
        '派工尚无原会话和实际材料域，不能猜测快照范围',
      );
    if (domains.some((domain) => domain.error))
      throw new ProjectError('VERSION_MATERIAL_MISSING', '本次材料域缺失或不可读取');
    return {
      cwd: execution.cwd,
      additionalRepositories: execution.additionalRepositories,
      materialRoots: domains.map((domain) => domain.path),
      storage: this.storage,
      excluded: [join(this.root, '.TEAM', '运行数据'), join(this.root, '.TEAM', '票据材料')],
      mergeRepair: this.mergeContext?.(executionId),
    };
  }
  private save(record: DeliveryVersion, requestHash: string): DeliveryVersion {
    const value = deliveryVersionSchema.parse(record);
    this.db
      .prepare(
        'INSERT INTO execution_version(id,operation_id,request_hash,execution_id,sequence,data) VALUES(?,?,?,?,?,?)',
      )
      .run(
        value.id,
        value.operationId,
        requestHash,
        value.executionId,
        value.sequence,
        JSON.stringify(value),
      );
    return value;
  }
  baseline(executionId: string): DeliveryVersion {
    const prior = this.list(executionId).find((version) => version.kind === 'baseline');
    if (prior) return prior;
    const execution = this.executions.get(executionId);
    if (
      execution.goalId ||
      execution.firstRequestId ||
      !['registered', 'creating-session', 'session-prepared'].includes(execution.startupState)
    )
      throw new ProjectError(
        'VERSION_BASELINE_LATE',
        '执行已经开始，不能用当前文件补写历史派工基线',
      );
    const snapshot = captureWorkspace(this.input(executionId));
    return transaction(this.db, () =>
      this.save(
        {
          id: randomUUID(),
          operationId: execution.dispatchId,
          executionId,
          kind: 'baseline',
          worktreeId: execution.worktreeId,
          sequence: 0,
          actor: execution.actor,
          ticket: this.wb.getTicket(execution.ticketId),
          summary: '实际派工基线',
          scope: '实际源码仓库、明确其他仓库与本次执行材料',
          evidencePaths: [],
          checklistItemIds: [],
          reportPaths: [],
          researchAnswers: [],
          snapshot,
          createdAt: snapshot.createdAt,
        },
        hash({ executionId, kind: 'baseline' }),
      ),
    );
  }
  assertSourceUnchanged(executionId: string, originalCwd?: string): void {
    const versions = this.list(executionId);
    if (versions.some((v) => v.kind === 'delivery'))
      throw new ProjectError(
        'WORKTREE_DELIVERY_EXISTS',
        '本次已有送审版本，不迁移其源码空间；请主管另行明确下一票',
      );
    const input = this.input(executionId),
      current = inspectWorkspace({ ...input, cwd: originalCwd ?? input.cwd, materialRoots: [] }),
      baseline = versions.findLast(
        (v) => v.kind === 'baseline' && v.snapshot.roots[0]?.root === current.roots[0]?.root,
      );
    if (!baseline) throw new ProjectError('WORKTREE_SOURCE_BASELINE', '没有原源码空间的实际基线');
    const normalize = (roots: typeof current.roots) =>
      roots
        .filter((r) => r.kind === 'git')
        .map((r) => ({
          root: r.root,
          head: r.head,
          files: r.files.map(({ path, sha256, mode, size }) => ({ path, sha256, mode, size })),
        }));
    if (
      JSON.stringify(normalize(current.roots)) !==
      JSON.stringify(normalize(baseline.snapshot.roots))
    )
      throw new ProjectError(
        'WORKTREE_SOURCE_CHANGED',
        '原源码自执行基线后已有变化，先协调成果，不把未提交工作当已迁入新树',
      );
  }
  workspaceBaseline(
    actor: WorkbenchActor,
    executionId: string,
    worktreeId: string,
  ): DeliveryVersion {
    const execution = this.executions.get(executionId),
      author = this.wb.author(actor);
    if (
      actor.kind !== 'session' ||
      (actor.sessionId !== execution.sessionId && author.roleType !== 'supervisor') ||
      execution.worktreeId !== worktreeId
    )
      throw new ProjectError('WORKTREE_BASELINE_SOURCE', '工作树基线须绑定本次原主及已核定新目录');
    const prior = this.list(executionId),
      existing = prior.find((v) => v.operationId === worktreeId);
    if (existing) return existing;
    if (prior.some((v) => v.kind === 'delivery'))
      throw new ProjectError('WORKTREE_DELIVERY_EXISTS', '不改已有送审版本的空间');
    const snapshot = captureWorkspace(this.input(executionId));
    return transaction(this.db, () =>
      this.save(
        {
          id: randomUUID(),
          operationId: worktreeId,
          executionId,
          kind: 'baseline',
          worktreeId,
          sequence: prior.length,
          actor: author,
          ticket: this.wb.getTicket(execution.ticketId),
          summary: '官方工作树实际空间基线；原启动基线保留',
          scope: '明确本地commit检出后的源码空间与原固定材料域，不搬运旧根未提交内容',
          evidencePaths: [],
          checklistItemIds: [],
          reportPaths: [],
          researchAnswers: [],
          snapshot,
          createdAt: snapshot.createdAt,
        },
        hash({ executionId, worktreeId, kind: 'workspace-baseline' }),
      ),
    );
  }
  delivery(actor: WorkbenchActor, executionId: string, raw: unknown): DeliveryVersion {
    const input = deliveryVersionInputSchema.parse(raw),
      author = this.wb.author(actor),
      execution = this.executions.get(executionId),
      requestHash = hash({ executionId, input, author });
    if (actor.kind !== 'session' || actor.sessionId !== execution.sessionId)
      throw new ProjectError('VERSION_AUTHOR_MISMATCH', '正式交付版本只能由原实际执行者形成');
    const existing = this.db
      .prepare('SELECT id,request_hash FROM execution_version WHERE operation_id=?')
      .get(input.operationId);
    if (existing) {
      if (existing.request_hash !== requestHash)
        throw new ProjectError(
          'VERSION_OPERATION_CONFLICT',
          '操作身份已使用，但交付正文或来源不同',
        );
      return this.get(String(existing.id));
    }
    if (
      execution.lifecycleState !== 'active' ||
      this.sessions.get(actor.sessionId).communicationState !== 'active'
    )
      throw new ProjectError(
        'VERSION_EXECUTION_CONTROLLED',
        '当前执行已等待、暂停或结束，不能以新操作修改交付',
      );
    const previous = this.list(executionId);
    if (!previous.some((version) => version.kind === 'baseline'))
      throw new ProjectError('VERSION_BASELINE_MISSING', '缺少真实派工基线，未用当前目录伪造');
    const ticket = this.wb.getTicket(execution.ticketId);
    if (ticket.kind === 'research' && execution.roleType !== 'investigator')
      throw new ProjectError('RESEARCH_INVESTIGATOR_REQUIRED', '研究报告由实际调查主执行交付');
    if (ticket.kind === 'research' && !input.reportPaths.length)
      throw new ProjectError(
        'RESEARCH_REPORT_REQUIRED',
        '研究报告须放在本次材料域并显式关联完成交付',
      );
    const domains = this.wb
      .materialDomains(ticket.id)
      .filter((domain) => domain.referenceId === execution.id);
    const reportPaths = [
      ...new Set(
        input.reportPaths.map((path) => {
          if (!isAbsolute(path))
            throw new ProjectError('REPORT_PATH_REQUIRED', '报告必须是本次材料域内的绝对文件路径');
          let canonical: string;
          try {
            canonical = realpathSync(path);
            if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())
              throw new Error('不是普通文件');
          } catch {
            throw new ProjectError('REPORT_UNAVAILABLE', '报告文件不存在或不是可核对的普通文件');
          }
          if (
            !domains.some(
              (domain) => domain.available && withinPath(realpathSync(domain.path), canonical),
            )
          )
            throw new ProjectError('REPORT_OUTSIDE_MATERIAL', '报告须来自本次主执行分配材料域');
          return canonical;
        }),
      ),
    ];
    const researchAnswers =
      ticket.kind === 'research'
        ? this.wb
            .research(ticket.id)
            .entries.flatMap((entry) => (entry.answer ? [entry.answer] : []))
        : [];
    if (input.checklistItemIds.some((id) => !ticket.checklist.some((item) => item.id === id)))
      throw new ProjectError('VERSION_CHECKLIST_MISMATCH', '交付引用了不属于原票的Checklist');
    const snapshot = captureWorkspace(this.input(executionId));
    for (const path of reportPaths)
      if (
        !snapshot.roots.some(
          (root) =>
            withinPath(root.root, path) &&
            root.files.some((file) => file.path === relative(root.root, path).split(sep).join('/')),
        )
      )
        throw new ProjectError(
          'REPORT_NOT_CAPTURED',
          '报告未进入本次固定原件，不能仅登记当前文件路径',
        );
    return transaction(this.db, () =>
      this.save(
        {
          id: randomUUID(),
          operationId: input.operationId,
          executionId,
          kind: 'delivery',
          worktreeId: execution.worktreeId,
          sequence: previous.length,
          actor: author,
          ticket,
          summary: input.summary,
          scope: input.scope,
          evidencePaths: input.evidencePaths,
          checklistItemIds: input.checklistItemIds,
          reportPaths,
          researchAnswers,
          snapshot,
          createdAt: snapshot.createdAt,
        },
        requestHash,
      ),
    );
  }
  check(id: string) {
    const saved = this.get(id);
    try {
      const current = inspectWorkspace(this.input(saved.executionId));
      return {
        versionId: id,
        matches: current.fingerprint === saved.snapshot.fingerprint,
        savedFingerprint: saved.snapshot.fingerprint,
        currentFingerprint: current.fingerprint,
        error: null,
      };
    } catch (error) {
      return {
        versionId: id,
        matches: null,
        savedFingerprint: saved.snapshot.fingerprint,
        currentFingerprint: null,
        error: error instanceof Error ? error.message : '当前工作区无法完整核对',
      };
    }
  }
  diff(id: string, mode: 'ticket' | 'repair') {
    const saved = this.get(id),
      list = this.list(saved.executionId),
      previous =
        mode === 'ticket'
          ? list
              .filter(
                (version) => version.kind === 'baseline' && version.sequence <= saved.sequence,
              )
              .at(-1)
          : list
              .filter((version) => version.kind === 'delivery' && version.sequence < saved.sequence)
              .at(-1);
    if (!previous)
      throw new ProjectError(
        'VERSION_PREVIOUS_MISSING',
        mode === 'repair' ? '没有上次送审版本，不能伪造返修差异' : '缺少原派工基线',
      );
    return {
      from: previous.id,
      to: saved.id,
      mode,
      ...compareWorkspaces(previous.snapshot, saved.snapshot, this.storage),
    };
  }
  file(id: string, rootIndex: number, path: string) {
    return readSnapshotFile(this.get(id).snapshot, rootIndex, path, this.storage);
  }
  headers(executionId: string) {
    return this.list(executionId).map(({ snapshot, ...record }) => ({
      id: record.id,
      executionId: record.executionId,
      kind: record.kind,
      worktreeId: record.worktreeId,
      ticketKind: record.ticket.kind,
      sequence: record.sequence,
      summary: record.summary,
      scope: record.scope,
      createdAt: record.createdAt,
      fingerprint: snapshot.fingerprint,
      roots: snapshot.roots.map(({ files, ...root }) => ({ ...root, fileCount: files.length })),
    }));
  }
}
