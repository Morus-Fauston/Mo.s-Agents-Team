import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { z } from 'zod';
import { transaction } from './事务.ts';
import { ProjectError } from '../业务/错误.ts';
import { ensureMaterialSubdomain, materialDirectory } from '../业务/票据材料.ts';
import { materialDomainSchema } from '../契约/票据.ts';
import type { MaterialDomain } from '../契约/票据.ts';
import { SessionCatalog } from './会话记录.ts';
import { RoleCatalog } from './角色登记.ts';
import {
  phaseInputSchema,
  categoryInputSchema,
  ticketInputSchema,
  ticketUpdateSchema,
  appendLogSchema,
  logUpdateSchema,
  checklistUpdateSchema,
  conditionUpdateSchema,
  feedbackInputSchema,
  phaseSchema,
  categorySchema,
  ticketSchema,
  logSchema,
  feedbackSchema,
  historyEntrySchema,
  supervisorTaskSchema,
  operationSchema,
  conditionInputSchema,
} from '../契约/票据.ts';
import type {
  WorkbenchActor,
  RecordAuthor,
  PhaseRecord,
  TicketRecord,
  LogRecord,
  ChecklistItem,
  HistoryEntry,
  SupervisorTask,
} from '../契约/票据.ts';
export function migrateWorkbench(db: DatabaseSync): void {
  db.exec(`CREATE TABLE phase(id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,ordinal INTEGER,parent_id TEXT UNIQUE REFERENCES phase(id),data TEXT NOT NULL);
 CREATE TABLE ticket_category(id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,data TEXT NOT NULL);
 CREATE TABLE ticket(id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,origin_phase TEXT NOT NULL REFERENCES phase(id),origin_category TEXT NOT NULL REFERENCES ticket_category(id),ordinal INTEGER NOT NULL,supplement_of TEXT REFERENCES ticket(id),data TEXT NOT NULL);
 CREATE UNIQUE INDEX ticket_base_number ON ticket(origin_phase,origin_category,ordinal) WHERE supplement_of IS NULL;
 CREATE TABLE ticket_dependency(ticket_id TEXT NOT NULL REFERENCES ticket(id),dependency_id TEXT NOT NULL REFERENCES ticket(id),PRIMARY KEY(ticket_id,dependency_id));
 CREATE TABLE work_log(ticket_id TEXT NOT NULL REFERENCES ticket(id),id TEXT NOT NULL,ordinal INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(ticket_id,id),UNIQUE(ticket_id,ordinal));
 CREATE TABLE workbench_revision(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,object_id TEXT NOT NULL,data TEXT NOT NULL);
 CREATE TABLE workbench_command(id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,result TEXT NOT NULL);
 CREATE TABLE project_history(seq INTEGER PRIMARY KEY AUTOINCREMENT,data TEXT NOT NULL);
 CREATE TABLE supervisor_task(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE system_feedback(id TEXT PRIMARY KEY,ordinal INTEGER NOT NULL UNIQUE,data TEXT NOT NULL);
 CREATE TABLE material_domain(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES ticket(id),session_id TEXT NOT NULL REFERENCES session(id),kind TEXT NOT NULL,reference_id TEXT NOT NULL,data TEXT NOT NULL,UNIQUE(ticket_id,session_id,kind,reference_id));
 PRAGMA user_version=5;`);
}
export interface TicketExecutionScope {
  ticketId: string;
  executionId: string;
  kind: 'main' | 'assistant' | 'review';
  checklistIds: string[];
  delegationId?: string;
  reviewId?: string;
}
const stamp = () => new Date().toISOString();
function omit<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !keys.includes(key as K)),
  ) as Omit<T, K>;
}
const numbered = (prefix: string, n: number) => prefix + String(n).padStart(3, '0');
const parseRow = <T>(
  row: Record<string, unknown> | undefined,
  schema: z.ZodType<T>,
  label: string,
): T => {
  if (!row) throw new ProjectError('WORKBENCH_NOT_FOUND', label + '不存在');
  return schema.parse(JSON.parse(String(row.data)));
};
export class WorkbenchCatalog {
  private scope: ((sessionId: string) => TicketExecutionScope | undefined) | undefined;
  private readonly db: DatabaseSync;
  private readonly root: string;
  private readonly sessions: SessionCatalog;
  private readonly roles: RoleCatalog;
  constructor(db: DatabaseSync, root: string, sessions: SessionCatalog, roles: RoleCatalog) {
    this.db = db;
    this.root = root;
    this.sessions = sessions;
    this.roles = roles;
  }
  /** The execution adapter supplies persisted responsibility; tools never accept a scope from arguments. */
  bindExecutionAccess(resolve: (sessionId: string) => TicketExecutionScope | undefined): void {
    this.scope = resolve;
  }
  author(actor: WorkbenchActor): RecordAuthor {
    if (actor.kind === 'user')
      return {
        kind: 'user',
        sessionId: null,
        roleId: null,
        roleCode: null,
        roleType: null,
        address: null,
      };
    const session = this.sessions.get(actor.sessionId),
      role = this.roles.list().find((role) => role.id === session.roleId)!;
    if (
      session.status !== 'bound' ||
      ['terminated', 'archived'].includes(session.communicationState)
    )
      throw new ProjectError('SOURCE_UNAVAILABLE', '来源不是当前有效会话');
    return {
      kind: 'session',
      sessionId: session.id,
      roleId: role.id,
      roleCode: role.code,
      roleType: role.type,
      address: session.addresses.readable,
    };
  }
  private manager(actor: WorkbenchActor): RecordAuthor {
    const author = this.author(actor);
    if (author.kind !== 'user' && author.roleType !== 'supervisor')
      throw new ProjectError('MANAGER_REQUIRED', '此动作仅主管或用户可维护');
    return author;
  }
  private user(actor: WorkbenchActor): RecordAuthor {
    if (actor.kind !== 'user')
      throw new ProjectError(
        'USER_CONFIRMATION_REQUIRED',
        '此动作需要用户入口明确确认，不能由正文自报批准',
      );
    return this.author(actor);
  }
  private writer(
    actor: WorkbenchActor,
    ticketId: string,
  ): { author: RecordAuthor; scope?: TicketExecutionScope } {
    const author = this.author(actor);
    if (actor.kind === 'user') return { author };
    const scope = this.scope?.(actor.sessionId);
    if (
      !['developer', 'investigator'].includes(author.roleType ?? '') ||
      !scope ||
      scope.ticketId !== ticketId ||
      scope.kind === 'review'
    )
      throw new ProjectError(
        'CURRENT_EXECUTION_REQUIRED',
        '尚无本票实际执行责任，记录或聊天不产生派工资格',
      );
    return { author, scope };
  }
  private command<T>(
    actor: WorkbenchActor,
    kind: string,
    input: { operationId: string },
    run: () => T,
  ): T {
    this.author(actor);
    const hash = createHash('sha256').update(JSON.stringify({ kind, actor, input })).digest('hex');
    return transaction(this.db, () => {
      const previous = this.db
        .prepare('SELECT * FROM workbench_command WHERE id=?')
        .get(input.operationId);
      if (previous) {
        if (previous.request_hash !== hash)
          throw new ProjectError('COMMAND_CONFLICT', '操作身份已存在但来源或内容不同');
        return JSON.parse(String(previous.result)) as T;
      }
      const result = run();
      this.db
        .prepare('INSERT INTO workbench_command(id,request_hash,result) VALUES(?,?,?)')
        .run(input.operationId, hash, JSON.stringify(result));
      return result;
    });
  }
  private history(
    kind: string,
    objectId: string,
    author: RecordAuthor,
    reason: string,
    references: string[] = [],
    corrects: string | null = null,
  ): HistoryEntry {
    const entry = {
      id: randomUUID(),
      kind,
      objectId,
      actor: author,
      at: stamp(),
      reason,
      references,
      corrects,
    };
    this.db.prepare('INSERT INTO project_history(data) VALUES(?)').run(JSON.stringify(entry));
    this.db
      .prepare('INSERT INTO ui_event(kind,object_id) VALUES(?,?)')
      .run('workbench-changed', objectId);
    return entry;
  }
  private revision(
    kind: string,
    id: string,
    value: unknown,
    author: RecordAuthor,
    reason: string,
  ): void {
    this.db
      .prepare('INSERT INTO workbench_revision(kind,object_id,data) VALUES(?,?,?)')
      .run(kind, id, JSON.stringify({ value, author, reason, at: stamp() }));
  }
  private revisions(
    kind: string,
    id: string,
  ): { value: unknown; author: RecordAuthor; reason: string; at: string }[] {
    return this.db
      .prepare('SELECT data FROM workbench_revision WHERE kind=? AND object_id=? ORDER BY seq')
      .all(kind, id)
      .map((row) => JSON.parse(String(row.data)));
  }
  private item(input: z.infer<typeof conditionInputSchema>, n: number): ChecklistItem {
    return {
      ...input,
      id: numbered('C', n),
      revision: 1,
      checked: false,
      result: '',
      logId: null,
      author: null,
      updatedAt: null,
    };
  }
  phases(): PhaseRecord[] {
    return this.db
      .prepare('SELECT data FROM phase ORDER BY rowid')
      .all()
      .map((row) => phaseSchema.parse(JSON.parse(String(row.data))));
  }
  getPhase(id: string): PhaseRecord {
    return parseRow(
      this.db.prepare('SELECT data FROM phase WHERE id=? OR code=?').get(id, id),
      phaseSchema,
      '期次',
    );
  }
  categories() {
    return this.db
      .prepare('SELECT data FROM ticket_category ORDER BY rowid')
      .all()
      .map((row) => categorySchema.parse(JSON.parse(String(row.data))));
  }
  private category(id: string) {
    return parseRow(
      this.db.prepare('SELECT data FROM ticket_category WHERE id=?').get(id),
      categorySchema,
      '类别',
    );
  }
  createPhase(actor: WorkbenchActor, raw: unknown): PhaseRecord {
    const input = phaseInputSchema.parse(raw),
      author = this.manager(actor);
    return this.command(actor, 'create-phase', input, () => {
      let code,
        ordinal: number | null = null;
      if (input.parentId) {
        const parent = this.getPhase(input.parentId);
        if (parent.parentId !== null) throw new ProjectError('INVALID_SP_PARENT', 'SP不能再创建SP');
        if (this.db.prepare('SELECT id FROM phase WHERE parent_id=?').get(parent.id))
          throw new ProjectError('SP_EXISTS', '每期最多一个SP');
        code = parent.code + 'SP';
      } else {
        ordinal = Number(
          this.db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM phase').get()!.n,
        );
        if (ordinal > 999)
          throw new ProjectError('PHASE_NUMBER_EXHAUSTED', '三位期次编号已耗尽，需要明确后续规则');
        code = numbered('P', ordinal);
      }
      const value: PhaseRecord = {
        id: randomUUID(),
        code,
        name: input.name,
        goal: input.goal,
        basis: input.basis,
        note: input.note,
        parentId: input.parentId ?? null,
        state: 'unopened',
        checklist: input.checklist.map((item, n) => this.item(item, n + 1)),
        author,
        createdAt: stamp(),
        revision: 1,
      };
      this.db
        .prepare('INSERT INTO phase(id,code,ordinal,parent_id,data) VALUES(?,?,?,?,?)')
        .run(value.id, code, ordinal, value.parentId, JSON.stringify(value));
      this.revision('phase', value.id, value, author, '建立未开放计划');
      this.history('phase-created', value.id, author, '建立期次，不授权执行');
      return value;
    });
  }
  updatePhase(actor: WorkbenchActor, id: string, raw: unknown): PhaseRecord {
    const input = operationSchema
        .extend({
          expectedRevision: z.number().int().positive(),
          reason: z.string().min(1),
          name: z.string().min(1).optional(),
          goal: z.string().min(1).optional(),
          basis: z.string().min(1).optional(),
          note: z.string().optional(),
        })
        .strict()
        .parse(raw),
      author = this.manager(actor);
    return this.command(actor, 'update-phase:' + id, input, () => {
      const phase = this.getPhase(id);
      if (phase.revision !== input.expectedRevision)
        throw new ProjectError('REVISION_CONFLICT', '期次版本已经变化');
      const reason = input.reason,
        patch = omit(input, 'operationId', 'expectedRevision', 'reason');
      Object.assign(phase, patch, { revision: phase.revision + 1 });
      this.db.prepare('UPDATE phase SET data=? WHERE id=?').run(JSON.stringify(phase), phase.id);
      this.revision('phase', phase.id, phase, author, reason);
      this.history('phase-updated', phase.id, author, reason);
      return phase;
    });
  }
  openPhase(actor: WorkbenchActor, id: string, raw: unknown): PhaseRecord {
    const input = operationSchema
        .extend({ reason: z.string().min(1) })
        .strict()
        .parse(raw),
      author = this.user(actor);
    return this.command(actor, 'open-phase:' + id, input, () => {
      const phase = this.getPhase(id);
      if (phase.state !== 'unopened')
        throw new ProjectError('PHASE_ALREADY_OPENED', '期次不是未开放计划，不能覆盖已有结果');
      phase.state = 'opened';
      phase.revision++;
      this.db.prepare('UPDATE phase SET data=? WHERE id=?').run(JSON.stringify(phase), phase.id);
      this.revision('phase', phase.id, phase, author, input.reason);
      this.history('phase-opened', phase.id, author, input.reason);
      return phase;
    });
  }
  createCategory(actor: WorkbenchActor, raw: unknown) {
    const input = categoryInputSchema.parse(raw),
      author = this.manager(actor);
    return this.command(actor, 'create-category', input, () => {
      if (this.categories().some((category) => category.code === input.code))
        throw new ProjectError('CATEGORY_EXISTS', '项目类别标识已存在');
      const value = {
        id: randomUUID(),
        code: input.code,
        name: input.name,
        author,
        createdAt: stamp(),
      };
      this.db
        .prepare('INSERT INTO ticket_category(id,code,data) VALUES(?,?,?)')
        .run(value.id, value.code, JSON.stringify(value));
      this.history('category-created', value.id, author, '明确建立票据类别');
      return value;
    });
  }
  getTicket(id: string): TicketRecord {
    const ticket = parseRow(
      this.db.prepare('SELECT data FROM ticket WHERE id=? OR code=?').get(id, id),
      ticketSchema,
      '票据',
    );
    ticket.materialRoot = join(this.root, '.TEAM', '票据材料', ticket.code);
    return ticket;
  }
  listTickets(
    filter: {
      phaseId?: string | undefined;
      categoryId?: string | undefined;
      state?: TicketRecord['state'] | undefined;
    } = {},
  ): TicketRecord[] {
    return this.db
      .prepare('SELECT id FROM ticket ORDER BY rowid')
      .all()
      .map((row) => this.getTicket(String(row.id)))
      .filter(
        (ticket) =>
          (!filter.phaseId || ticket.phaseId === filter.phaseId) &&
          (!filter.categoryId || ticket.categoryId === filter.categoryId) &&
          (!filter.state || ticket.state === filter.state),
      );
  }
  private dependencies(id: string, deps: string[]): string[] {
    const unique = [...new Set(deps)];
    for (const dependency of unique) {
      this.getTicket(dependency);
      const walk = (current: string, seen: Set<string>): void => {
        if (current === id) throw new ProjectError('DEPENDENCY_CYCLE', '依赖不能形成自环或循环');
        if (seen.has(current)) return;
        seen.add(current);
        for (const next of this.db
          .prepare('SELECT dependency_id FROM ticket_dependency WHERE ticket_id=?')
          .all(current))
          walk(String(next.dependency_id), seen);
      };
      walk(dependency, new Set());
    }
    return unique;
  }
  private saveDependencies(ticket: TicketRecord): void {
    this.db.prepare('DELETE FROM ticket_dependency WHERE ticket_id=?').run(ticket.id);
    for (const id of ticket.dependencies)
      this.db
        .prepare('INSERT INTO ticket_dependency(ticket_id,dependency_id) VALUES(?,?)')
        .run(ticket.id, id);
  }
  private saveTicket(value: TicketRecord): void {
    this.db.prepare('UPDATE ticket SET data=? WHERE id=?').run(JSON.stringify(value), value.id);
  }
  createTicket(actor: WorkbenchActor, raw: unknown): TicketRecord {
    const input = ticketInputSchema.parse(raw),
      author = this.user(actor);
    return this.command(actor, 'create-ticket', input, () => {
      const phase = this.getPhase(input.phaseId),
        category = this.category(input.categoryId);
      const id = randomUUID();
      let ordinal: number, code: string;
      if (input.supplementOf) {
        const parent = this.getTicket(input.supplementOf);
        if (parent.supplementOf)
          throw new ProjectError('NESTED_SUPPLEMENT_UNDEFINED', '不扩展递归补票命名');
        const row = this.db
          .prepare('SELECT COUNT(*) AS n FROM ticket WHERE supplement_of=?')
          .get(parent.id)!;
        const suffix = Number(row.n);
        if (suffix >= 26)
          throw new ProjectError('SUPPLEMENT_EXHAUSTED', '补充票后缀已耗尽，需要明确后续规则');
        ordinal = Number(
          this.db.prepare('SELECT ordinal FROM ticket WHERE id=?').get(parent.id)!.ordinal,
        );
        code = parent.code + '-' + String.fromCharCode(97 + suffix);
      } else {
        ordinal = Number(
          this.db
            .prepare(
              'SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM ticket WHERE origin_phase=? AND origin_category=? AND supplement_of IS NULL',
            )
            .get(phase.id, category.id)!.n,
        );
        if (ordinal > 999)
          throw new ProjectError('TICKET_NUMBER_EXHAUSTED', '三位票号已耗尽，需要明确后续规则');
        code = phase.code + '-' + category.code + '-' + String(ordinal).padStart(3, '0');
      }
      const value: TicketRecord = {
        id,
        code,
        phaseId: phase.id,
        categoryId: category.id,
        title: input.title,
        goal: input.goal,
        included: input.included,
        excluded: input.excluded,
        dependencies: this.dependencies(id, input.dependencies),
        supplementOf: input.supplementOf ?? null,
        state: 'todo',
        revision: 1,
        checklist: input.conditions.map((condition, n) => this.item(condition, n + 1)),
        author,
        createdAt: stamp(),
        currentExecution: null,
        materialRoot: join(this.root, '.TEAM', '票据材料', code),
      };
      this.db
        .prepare(
          'INSERT INTO ticket(id,code,origin_phase,origin_category,ordinal,supplement_of,data) VALUES(?,?,?,?,?,?,?)',
        )
        .run(id, code, phase.id, category.id, ordinal, value.supplementOf, JSON.stringify(value));
      this.saveDependencies(value);
      this.revision('ticket', id, value, author, '用户确认建立正式票据');
      this.history('ticket-created', id, author, '建立待办票据，不派工');
      return value;
    });
  }
  updateTicket(actor: WorkbenchActor, id: string, raw: unknown): TicketRecord {
    const input = ticketUpdateSchema.parse(raw),
      author = this.manager(actor);
    return this.command(actor, 'update-ticket:' + id, input, () => {
      const value = this.getTicket(id);
      if (value.revision !== input.expectedRevision)
        throw new ProjectError('REVISION_CONFLICT', '票据版本已经变化，请读取当前要求');
      if (input.phaseId) this.getPhase(input.phaseId);
      if (input.categoryId) this.category(input.categoryId);
      const reason = input.reason,
        patch = omit(input, 'operationId', 'expectedRevision', 'reason');
      if (patch.dependencies) patch.dependencies = this.dependencies(value.id, patch.dependencies);
      Object.assign(value, patch, { revision: value.revision + 1 });
      this.saveTicket(value);
      this.saveDependencies(value);
      this.revision('ticket', value.id, value, author, reason);
      this.history('ticket-requirements-updated', value.id, author, reason);
      return value;
    });
  }
  ticketHistory(id: string) {
    return this.revisions('ticket', this.getTicket(id).id);
  }
  checklistHistory(id: string) {
    return this.revisions('checklist', this.getTicket(id).id);
  }
  private appendLogInside(
    actor: WorkbenchActor,
    ticket: TicketRecord,
    input: z.infer<typeof appendLogSchema>,
  ): LogRecord {
    const { author, scope } = this.writer(actor, ticket.id);
    if (input.corrects) this.getLog(ticket.id, input.corrects);
    const n = Number(
      this.db
        .prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM work_log WHERE ticket_id=?')
        .get(ticket.id)!.n,
    );
    const body = omit(input, 'operationId');
    const value: LogRecord = {
      ...body,
      id: numbered('L', n),
      ticketId: ticket.id,
      corrects: input.corrects ?? null,
      archived: false,
      archiveReason: null,
      author,
      createdAt: stamp(),
      executionId: scope?.executionId ?? null,
    };
    this.db
      .prepare('INSERT INTO work_log(ticket_id,id,ordinal,data) VALUES(?,?,?,?)')
      .run(ticket.id, value.id, n, JSON.stringify(value));
    this.revision('log', ticket.id + ':' + value.id, value, author, '追加Log');
    this.history('log-created', ticket.id, author, value.title, [ticket.id + ':' + value.id]);
    return value;
  }
  appendLog(actor: WorkbenchActor, id: string, raw: unknown): LogRecord {
    const input = appendLogSchema.parse(raw);
    return this.command(actor, 'append-log:' + id, input, () =>
      this.appendLogInside(actor, this.getTicket(id), input),
    );
  }
  getLog(ticketId: string, id: string): LogRecord {
    const ticket = this.getTicket(ticketId);
    return parseRow(
      this.db.prepare('SELECT data FROM work_log WHERE ticket_id=? AND id=?').get(ticket.id, id),
      logSchema,
      'Log',
    );
  }
  logs(ticketId: string, mode: 'active' | 'archived' | 'all' = 'active'): LogRecord[] {
    const ticket = this.getTicket(ticketId);
    return this.db
      .prepare('SELECT data FROM work_log WHERE ticket_id=? ORDER BY ordinal')
      .all(ticket.id)
      .map((row) => logSchema.parse(JSON.parse(String(row.data))))
      .filter((log) => mode === 'all' || log.archived === (mode === 'archived'));
  }
  updateLog(actor: WorkbenchActor, ticketId: string, id: string, raw: unknown): LogRecord {
    const input = logUpdateSchema.parse(raw);
    return this.command(actor, 'update-log:' + ticketId + ':' + id, input, () => {
      const ticket = this.getTicket(ticketId),
        { author, scope } = this.writer(actor, ticket.id),
        value = this.getLog(ticket.id, id);
      if (scope?.kind === 'assistant' && value.author.sessionId !== author.sessionId)
        throw new ProjectError(
          'LOG_OWNER_REQUIRED',
          '辅助只能整理自己的Log；纠正他人正文请追加记录',
        );
      if (input.type) value.type = input.type;
      if (input.importance) value.importance = input.importance;
      if (input.archived !== undefined) {
        value.archived = input.archived;
        value.archiveReason = input.archived ? input.reason : null;
      }
      this.db
        .prepare('UPDATE work_log SET data=? WHERE ticket_id=? AND id=?')
        .run(JSON.stringify(value), ticket.id, id);
      this.revision('log', ticket.id + ':' + id, value, author, input.reason);
      this.history('log-metadata-updated', ticket.id, author, input.reason, [ticket.id + ':' + id]);
      return value;
    });
  }
  logHistory(ticketId: string, id: string) {
    this.getLog(ticketId, id);
    return this.revisions('log', this.getTicket(ticketId).id + ':' + id);
  }
  updateChecklist(actor: WorkbenchActor, ticketId: string, raw: unknown): TicketRecord {
    const input = checklistUpdateSchema.parse(raw);
    return this.command(actor, 'update-checklist:' + ticketId, input, () => {
      const ticket = this.getTicket(ticketId),
        { author, scope } = this.writer(actor, ticket.id);
      if ((input.logId === undefined) === (input.newLog === undefined))
        throw new ProjectError('LOG_REQUIRED', 'Checklist更新须且只能提供同票已有Log或同次新Log');
      const log = input.newLog
        ? this.appendLogInside(actor, ticket, { ...input.newLog, operationId: input.operationId })
        : this.getLog(ticket.id, input.logId!);
      const seen = new Set<string>();
      for (const update of input.updates) {
        if (seen.has(update.id))
          throw new ProjectError('DUPLICATE_CHECKLIST_ITEM', '同一次更新不能重复同项');
        seen.add(update.id);
        const item = ticket.checklist.find((item) => item.id === update.id);
        if (!item) throw new ProjectError('CHECKLIST_NOT_FOUND', 'Checklist项不存在');
        if (item.revision !== update.expectedRevision)
          throw new ProjectError(
            'CONDITION_REVISION_CONFLICT',
            '条件版本已经变化，请重新读取并确认结果；不能沿用旧条件的提交',
          );
        if (actor.kind !== 'user' && item.verification === 'manual')
          throw new ProjectError('MANUAL_RESULT_REQUIRED', '不能代填用户人工验收');
        if (scope?.kind === 'assistant' && !scope.checklistIds.includes(item.id))
          throw new ProjectError('CHECKLIST_GRANT_REQUIRED', '此辅助未获该项最新系统授权');
        Object.assign(item, {
          checked: update.checked,
          result: update.result,
          logId: log.id,
          author,
          updatedAt: stamp(),
        });
      }
      this.saveTicket(ticket);
      this.revision('checklist', ticket.id, ticket.checklist, author, '依Log更新结果');
      this.history('checklist-updated', ticket.id, author, '结果关联Log，不自动转态', [
        ticket.id + ':' + log.id,
      ]);
      return ticket;
    });
  }
  updateCondition(actor: WorkbenchActor, ticketId: string, id: string, raw: unknown): TicketRecord {
    const input = conditionUpdateSchema.parse(raw),
      author = this.manager(actor);
    return this.command(actor, 'update-condition:' + ticketId + ':' + id, input, () => {
      const ticket = this.getTicket(ticketId),
        item = ticket.checklist.find((item) => item.id === id);
      if (!item) throw new ProjectError('CHECKLIST_NOT_FOUND', 'Checklist项不存在');
      if (item.revision !== input.expectedRevision)
        throw new ProjectError('REVISION_CONFLICT', '条件版本已经变化');
      if (item.condition !== input.condition || item.verification !== input.verification)
        Object.assign(item, {
          condition: input.condition,
          verification: input.verification,
          revision: item.revision + 1,
          checked: false,
          result: '条件已变化，原结果失效',
          logId: null,
          author: null,
          updatedAt: stamp(),
        });
      ticket.revision++;
      this.saveTicket(ticket);
      this.revision('ticket', ticket.id, ticket, author, input.reason);
      this.history('checklist-condition-updated', ticket.id, author, input.reason, [id]);
      return ticket;
    });
  }
  submitFeedback(actor: WorkbenchActor, raw: unknown) {
    const input = feedbackInputSchema.parse(raw),
      author = this.author(actor);
    if (actor.kind !== 'session')
      throw new ProjectError('SESSION_SOURCE_REQUIRED', '测试期反馈使用真实成员会话来源');
    return this.command(actor, 'submit-feedback', input, () => {
      const session = this.sessions.get(actor.sessionId);
      const request = this.db
        .prepare('SELECT id FROM model_request WHERE session_id=? ORDER BY rowid DESC LIMIT 1')
        .get(session.id);
      const n = Number(
        this.db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS n FROM system_feedback').get()!.n,
      );
      const body = omit(input, 'operationId');
      const value = {
        ...body,
        id: numbered('F', n),
        author,
        createdAt: stamp(),
        executionId: this.scope?.(session.id)?.executionId ?? null,
        background: {
          configuration: session.configuration,
          requestId: request ? String(request.id) : null,
          nativeSessionId: session.nativeSessionId,
        },
      };
      this.db
        .prepare('INSERT INTO system_feedback(id,ordinal,data) VALUES(?,?,?)')
        .run(value.id, n, JSON.stringify(value));
      this.db
        .prepare('INSERT INTO ui_event(kind,object_id) VALUES(?,?)')
        .run('feedback-saved', value.id);
      return value;
    });
  }
  feedback() {
    return this.db
      .prepare('SELECT data FROM system_feedback ORDER BY ordinal')
      .all()
      .map((row) => feedbackSchema.parse(JSON.parse(String(row.data))));
  }
  projectHistory(): HistoryEntry[] {
    return this.db
      .prepare('SELECT data FROM project_history ORDER BY seq')
      .all()
      .map((row) => historyEntrySchema.parse(JSON.parse(String(row.data))));
  }
  addHistory(actor: WorkbenchActor, raw: unknown): HistoryEntry {
    const input = operationSchema
        .extend({
          content: z.string().min(1),
          references: z.array(z.string()).default([]),
          corrects: z.uuid().optional(),
        })
        .strict()
        .parse(raw),
      author = this.manager(actor);
    return this.command(actor, 'add-history', input, () => {
      if (input.corrects && !this.projectHistory().some((entry) => entry.id === input.corrects))
        throw new ProjectError('HISTORY_NOT_FOUND', '被纠正历史不存在');
      return this.history(
        'management-note',
        randomUUID(),
        author,
        input.content,
        input.references,
        input.corrects ?? null,
      );
    });
  }
  tasks(includeCompleted = false): SupervisorTask[] {
    return this.db
      .prepare('SELECT data FROM supervisor_task ORDER BY rowid')
      .all()
      .map((row) => supervisorTaskSchema.parse(JSON.parse(String(row.data))))
      .filter((task) => includeCompleted || task.state !== 'checked');
  }
  getTask(id: string): SupervisorTask {
    return parseRow(
      this.db.prepare('SELECT data FROM supervisor_task WHERE id=?').get(id),
      supervisorTaskSchema,
      '主管清单项',
    );
  }
  createTask(actor: WorkbenchActor, raw: unknown): SupervisorTask {
    const input = operationSchema
        .extend({
          level: z.enum(['long', 'short']),
          title: z.string().min(1),
          basis: z.string().min(1),
          parentId: z.uuid().optional(),
          ticketIds: z.array(z.uuid()).default([]),
        })
        .strict()
        .parse(raw),
      author = this.manager(actor);
    if (input.level === 'long') this.user(actor);
    return this.command(actor, 'create-supervisor-task', input, () => {
      if (input.parentId) {
        const parent = this.getTask(input.parentId);
        if (input.level !== 'short' || parent.level !== 'long')
          throw new ProjectError('INVALID_TASK_PARENT', '只有短期安排可关联长期目标');
      }
      for (const id of input.ticketIds) this.getTicket(id);
      const body = omit(input, 'operationId');
      const value: SupervisorTask = {
        ...body,
        id: randomUUID(),
        parentId: input.parentId ?? null,
        state: 'unchecked',
        author,
        createdAt: stamp(),
        revision: 1,
      };
      this.db
        .prepare('INSERT INTO supervisor_task(id,data) VALUES(?,?)')
        .run(value.id, JSON.stringify(value));
      this.revision('supervisor-task', value.id, value, author, input.basis);
      this.history('supervisor-task-created', value.id, author, input.basis, input.ticketIds);
      return value;
    });
  }
  updateTask(actor: WorkbenchActor, id: string, raw: unknown): SupervisorTask {
    const input = operationSchema
        .extend({
          expectedRevision: z.number().int().positive(),
          reason: z.string().min(1),
          title: z.string().min(1).optional(),
          state: z.enum(['unchecked', 'held', 'checked']).optional(),
          basis: z.string().min(1),
          ticketIds: z.array(z.uuid()).optional(),
        })
        .strict()
        .parse(raw),
      author = this.manager(actor);
    return this.command(actor, 'update-supervisor-task:' + id, input, () => {
      const task = this.getTask(id);
      if (task.revision !== input.expectedRevision)
        throw new ProjectError('REVISION_CONFLICT', '主管清单版本已经变化');
      if (task.level === 'long' && input.title !== undefined) this.user(actor);
      const ids = input.ticketIds ?? task.ticketIds;
      for (const ticketId of ids) {
        const ticket = this.getTicket(ticketId);
        if ((input.state ?? task.state) === 'checked' && ticket.state !== 'completed')
          throw new ProjectError(
            'TASK_RESULT_INCOMPLETE',
            '关联票据尚未完成，不能以清单勾选绕过必要审阅或验收',
          );
      }
      const reason = input.reason,
        patch = omit(input, 'operationId', 'expectedRevision', 'reason');
      Object.assign(task, patch, { revision: task.revision + 1 });
      this.db.prepare('UPDATE supervisor_task SET data=? WHERE id=?').run(JSON.stringify(task), id);
      this.revision('supervisor-task', id, task, author, reason);
      this.history('supervisor-task-updated', id, author, reason, ids);
      return task;
    });
  }
  taskHistory(id: string) {
    this.getTask(id);
    return this.revisions('supervisor-task', id);
  }
  materialDomains(ticketId: string): MaterialDomain[] {
    const ticket = this.getTicket(ticketId);
    return this.db
      .prepare('SELECT data FROM material_domain WHERE ticket_id=? ORDER BY rowid')
      .all(ticket.id)
      .map((row) => {
        const domain = materialDomainSchema.parse(JSON.parse(String(row.data)));
        domain.path = join(ticket.materialRoot, domain.relativePath);
        try {
          materialDirectory(ticket.materialRoot, domain.relativePath);
          domain.available = true;
          domain.error = null;
        } catch (error) {
          domain.available = false;
          domain.error = error instanceof Error ? error.message : '材料子域不可用';
        }
        return domain;
      });
  }
  allocateCurrentMaterial(sessionId: string): MaterialDomain {
    const scope = this.scope?.(sessionId);
    if (!scope)
      throw new ProjectError(
        'CURRENT_EXECUTION_REQUIRED',
        '没有实际执行或审阅关联，不能创建虚构材料域',
      );
    const author = this.author({ kind: 'session', sessionId }),
      ticket = this.getTicket(scope.ticketId),
      referenceId =
        scope.kind === 'review'
          ? scope.reviewId
          : scope.kind === 'assistant'
            ? scope.delegationId
            : scope.executionId;
    if (!referenceId)
      throw new ProjectError(
        'MATERIAL_REFERENCE_REQUIRED',
        '材料子域缺少本次执行、协作或独审的真实关联',
      );
    if (scope.kind === 'review' && author.roleType !== 'reviewer')
      throw new ProjectError('REVIEW_ROLE_REQUIRED', '独审材料域需要实际审阅角色');
    return transaction(this.db, () => {
      const existing = this.materialDomains(ticket.id).find(
        (domain) =>
          domain.sessionId === sessionId &&
          domain.kind === scope.kind &&
          domain.referenceId === referenceId,
      );
      if (existing) {
        if (!existing.available)
          throw new ProjectError(
            'MATERIAL_UNAVAILABLE',
            '既有材料域缺件或不可访问，未悄悄重建为空目录',
          );
        return existing;
      }
      const id = randomUUID(),
        path = ensureMaterialSubdomain(this.root, ticket.code, scope.kind, id),
        relativePath =
          (scope.kind === 'review' ? '审阅' : scope.kind === 'assistant' ? '协作' : '执行') +
          '/' +
          id;
      const domain: MaterialDomain = {
        id,
        ticketId: ticket.id,
        sessionId,
        roleId: author.roleId!,
        roleCode: author.roleCode!,
        address: author.address!,
        kind: scope.kind,
        referenceId,
        relativePath,
        path,
        available: true,
        error: null,
      };
      this.db
        .prepare(
          'INSERT INTO material_domain(id,ticket_id,session_id,kind,reference_id,data) VALUES(?,?,?,?,?,?)',
        )
        .run(id, ticket.id, sessionId, scope.kind, referenceId, JSON.stringify(domain));
      this.history('material-domain-allocated', ticket.id, author, '按实际责任分配独立材料子域', [
        id,
      ]);
      return domain;
    });
  }
  addCondition(actor: WorkbenchActor, ticketId: string, raw: unknown): TicketRecord {
    const input = operationSchema
        .extend(conditionInputSchema.shape)
        .extend({ reason: z.string().min(1) })
        .strict()
        .parse(raw),
      author = this.manager(actor);
    return this.command(actor, 'add-condition:' + ticketId, input, () => {
      const ticket = this.getTicket(ticketId);
      const n = Math.max(0, ...ticket.checklist.map((item) => Number(item.id.slice(1)))) + 1;
      ticket.checklist.push(
        this.item({ condition: input.condition, verification: input.verification }, n),
      );
      ticket.revision++;
      this.saveTicket(ticket);
      this.revision('ticket', ticket.id, ticket, author, input.reason);
      this.history('checklist-condition-added', ticket.id, author, input.reason);
      return ticket;
    });
  }
  maintainPhaseChecklist(actor: WorkbenchActor, phaseId: string, raw: unknown): PhaseRecord {
    const input = z
        .union([
          operationSchema
            .extend(conditionInputSchema.shape)
            .extend({ action: z.literal('add'), reason: z.string().min(1) })
            .strict(),
          operationSchema
            .extend(conditionInputSchema.shape)
            .extend({
              action: z.literal('condition'),
              id: z.string(),
              expectedRevision: z.number().int().positive(),
              reason: z.string().min(1),
            })
            .strict(),
          operationSchema
            .extend({
              action: z.literal('result'),
              id: z.string(),
              checked: z.boolean(),
              expectedRevision: z.number().int().positive(),
              result: z.string().min(1),
              reason: z.string().min(1),
            })
            .strict(),
        ])
        .parse(raw),
      author = this.manager(actor);
    return this.command(actor, 'phase-checklist:' + phaseId, input, () => {
      const phase = this.getPhase(phaseId);
      if (input.action === 'add')
        phase.checklist.push(
          this.item(
            { condition: input.condition, verification: input.verification },
            Math.max(0, ...phase.checklist.map((item) => Number(item.id.slice(1)))) + 1,
          ),
        );
      else {
        const item = phase.checklist.find((item) => item.id === input.id);
        if (!item) throw new ProjectError('CHECKLIST_NOT_FOUND', '期次Checklist项不存在');
        if (input.action === 'condition') {
          if (item.revision !== input.expectedRevision)
            throw new ProjectError('REVISION_CONFLICT', '期次条件已经变化');
          if (item.condition !== input.condition || item.verification !== input.verification)
            Object.assign(item, {
              condition: input.condition,
              verification: input.verification,
              revision: item.revision + 1,
              checked: false,
              result: '条件已变化，原结果失效',
              logId: null,
              author: null,
              updatedAt: stamp(),
            });
        } else {
          if (item.revision !== input.expectedRevision)
            throw new ProjectError(
              'CONDITION_REVISION_CONFLICT',
              '期次条件版本已经变化，请重新读取后确认结果',
            );
          if (actor.kind !== 'user' && item.verification === 'manual')
            throw new ProjectError('MANUAL_RESULT_REQUIRED', '不能代填用户人工验收');
          Object.assign(item, {
            checked: input.checked,
            result: input.result,
            author,
            updatedAt: stamp(),
          });
        }
      }
      phase.revision++;
      this.db.prepare('UPDATE phase SET data=? WHERE id=?').run(JSON.stringify(phase), phase.id);
      this.revision('phase', phase.id, phase, author, input.reason);
      this.history('phase-checklist-updated', phase.id, author, input.reason);
      return phase;
    });
  }
}
