import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { deliveryVersionInputSchema, deliveryVersionSchema } from '../契约/版本.ts';
import type { DeliveryVersion, SnapshotInput } from '../契约/版本.ts';
import type { WorkbenchActor } from '../契约/票据.ts';
import type { ExecutionCatalog } from './执行记录.ts';
import type { WorkbenchCatalog } from './工作台记录.ts';
import type { SessionCatalog } from './会话记录.ts';
import { transaction } from './事务.ts';
import { ProjectError } from '../业务/错误.ts';
import {
  captureWorkspace,
  inspectWorkspace,
  compareWorkspaces,
  readSnapshotFile,
} from '../业务/工作区快照.ts';
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
          sequence: 0,
          actor: execution.actor,
          ticket: this.wb.getTicket(execution.ticketId),
          summary: '实际派工基线',
          scope: '实际源码仓库、明确其他仓库与本次执行材料',
          evidencePaths: [],
          checklistItemIds: [],
          snapshot,
          createdAt: snapshot.createdAt,
        },
        hash({ executionId, kind: 'baseline' }),
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
    if (input.checklistItemIds.some((id) => !ticket.checklist.some((item) => item.id === id)))
      throw new ProjectError('VERSION_CHECKLIST_MISMATCH', '交付引用了不属于原票的Checklist');
    const snapshot = captureWorkspace(this.input(executionId));
    return transaction(this.db, () =>
      this.save(
        {
          id: randomUUID(),
          operationId: input.operationId,
          executionId,
          kind: 'delivery',
          sequence: previous.length,
          actor: author,
          ticket,
          summary: input.summary,
          scope: input.scope,
          evidencePaths: input.evidencePaths,
          checklistItemIds: input.checklistItemIds,
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
          ? list.find((version) => version.kind === 'baseline')
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
      sequence: record.sequence,
      summary: record.summary,
      scope: record.scope,
      createdAt: record.createdAt,
      fingerprint: snapshot.fingerprint,
      roots: snapshot.roots.map(({ files, ...root }) => ({ ...root, fileCount: files.length })),
    }));
  }
}
