import type { WorktreeMergeRecord } from '../contracts/worktree-merges.ts';
import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { z } from 'zod';
import { transaction } from './transaction.ts';
import { ProjectError } from '../services/errors.ts';
import { ensureMaterialSubdomain, materialDirectory } from '../services/ticket-materials.ts';
import { materialDomainSchema } from '../contracts/workbench.ts';
import {
  acceptanceAssignmentSchema,
  acceptanceRecordSchema,
  ticketAcceptanceSchema,
  supplementSchema,
  escalationSchema,
} from '../contracts/acceptance.ts';
import type { MaterialDomain } from '../contracts/workbench.ts';
import type { LocalCommitRecord } from '../contracts/local-commits.ts';
import { SessionCatalog } from './session-catalog.ts';
import { RoleCatalog } from './role-catalog.ts';
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
  planInputSchema,
  planSchema,
  researchQuestionInputSchema,
  researchQuestionUpdateSchema,
  researchAnswerInputSchema,
  researchAnswerSchema,
} from '../contracts/workbench.ts';
import type {
  ResearchQuestion,
  ResearchAnswer,
  WorkbenchActor,
  RecordAuthor,
  PhaseRecord,
  TicketRecord,
  LogRecord,
  ChecklistItem,
  HistoryEntry,
  SupervisorTask,
  PlanRecord,
} from '../contracts/workbench.ts';
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
  allowWrite?: boolean;
  allowAssist?: boolean;
  shutdownOnly?: boolean;
  cwd?: string;
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
      (!['developer', 'investigator'].includes(author.roleType ?? '') &&
        scope?.kind !== 'assistant') ||
      !scope ||
      scope.ticketId !== ticketId ||
      scope.kind === 'review' ||
      scope.allowWrite === false
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
  plans(): PlanRecord[] {
    return this.db
      .prepare(
        "SELECT data FROM workbench_revision WHERE kind='plan' AND seq IN (SELECT MAX(seq) FROM workbench_revision WHERE kind='plan' GROUP BY object_id) ORDER BY seq",
      )
      .all()
      .map((row) => planSchema.parse(JSON.parse(String(row.data)).value));
  }
  getPlan(id: string): PlanRecord {
    const row = this.db
      .prepare(
        "SELECT data FROM workbench_revision WHERE kind='plan' AND object_id=? ORDER BY seq DESC LIMIT 1",
      )
      .get(id);
    if (!row) throw new ProjectError('PLAN_NOT_FOUND', '规划不存在');
    return planSchema.parse(JSON.parse(String(row.data)).value);
  }
  savePlan(actor: WorkbenchActor, raw: unknown): PlanRecord {
    const input = planInputSchema.parse(raw),
      author = this.manager(actor);
    return this.command(actor, 'save-plan', input, () => {
      this.getPhase(input.phaseId);
      const value: PlanRecord = {
        ...omit(input, 'operationId'),
        id: randomUUID(),
        author,
        createdAt: stamp(),
        revision: 1,
        confirmation: null,
      };
      this.revision('plan', value.id, value, author, '保存待确认规划');
      this.history('plan-created', value.id, author, '规划不产生开工授权', [value.phaseId]);
      return value;
    });
  }
  confirmPlan(actor: WorkbenchActor, id: string, raw: unknown): PlanRecord {
    const author = this.user(actor),
      input = operationSchema
        .extend({ expectedRevision: z.number().int().positive(), reason: z.string().trim().min(1) })
        .strict()
        .parse(raw);
    return this.command(actor, 'confirm-plan:' + id, input, () => {
      const value = this.getPlan(id);
      if (value.revision !== input.expectedRevision)
        throw new ProjectError('REVISION_CONFLICT', '规划版本已经变化');
      if (value.confirmation)
        throw new ProjectError('PLAN_ALREADY_CONFIRMED', '规划已经确认，请回读原记录');
      value.confirmation = { author, at: stamp(), reason: input.reason };
      value.revision++;
      this.revision('plan', id, value, author, input.reason);
      this.history('plan-confirmed', id, author, input.reason, [value.phaseId]);
      return value;
    });
  }
  createTicket(actor: WorkbenchActor, raw: unknown): TicketRecord {
    const input = ticketInputSchema.parse(raw),
      author = this.manager(actor);
    return this.command(actor, 'create-ticket', input, () => {
      if (input.kind !== 'research' && input.researchBody.trim())
        throw new ProjectError('RESEARCH_REQUIRED', '研究正文须明确关联研究票');
      if (author.kind !== 'user' && !input.planId)
        throw new ProjectError('CONFIRMED_PLAN_REQUIRED', '主管建票必须引用用户已确认的规划');
      if (input.planId) {
        const plan = this.getPlan(input.planId);
        if (!plan.confirmation)
          throw new ProjectError('CONFIRMED_PLAN_REQUIRED', '规划尚未由用户确认');
        if (plan.phaseId !== input.phaseId)
          throw new ProjectError('PLAN_PHASE_MISMATCH', '规划与票据期次不一致');
      }
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
        planId: input.planId ?? null,
        kind: input.kind,
        research: input.kind === 'research' ? { body: input.researchBody, questions: [] } : null,
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
      this.revision(
        'ticket',
        id,
        value,
        author,
        input.planId ? '依据已确认规划建立正式票据' : '用户确认建立正式票据',
      );
      this.history(
        'ticket-created',
        id,
        author,
        '建立待办票据，不派工',
        input.planId ? [input.planId] : [],
      );
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
        patch = omit(input, 'operationId', 'expectedRevision', 'reason', 'researchBody');
      if (input.researchBody !== undefined) {
        if (value.kind !== 'research' || !value.research)
          throw new ProjectError('RESEARCH_REQUIRED', '只有研究票可维护研究正文');
        value.research.body = input.researchBody;
      }
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
  private researchTicket(
    id: string,
  ): TicketRecord & { research: NonNullable<TicketRecord['research']> } {
    const ticket = this.getTicket(id);
    if (ticket.kind !== 'research' || !ticket.research)
      throw new ProjectError('RESEARCH_REQUIRED', '此操作仅用于研究票');
    return ticket as TicketRecord & { research: NonNullable<TicketRecord['research']> };
  }
  private researchQuestion(
    ticket: ReturnType<WorkbenchCatalog['researchTicket']>,
    id: string,
  ): ResearchQuestion {
    const question = ticket.research.questions.find((q) => q.id === id);
    if (!question) throw new ProjectError('RESEARCH_QUESTION_NOT_FOUND', '原票没有此QXX问题');
    return question;
  }
  addResearchQuestion(actor: WorkbenchActor, ticketId: string, raw: unknown): ResearchQuestion {
    const input = researchQuestionInputSchema.parse(raw),
      author = this.manager(actor);
    return this.command(actor, 'research-question-add:' + ticketId, input, () => {
      const ticket = this.researchTicket(ticketId),
        n = Math.max(0, ...ticket.research.questions.map((q) => Number(q.id.slice(1)))) + 1;
      const question: ResearchQuestion = {
        id: 'Q' + String(n).padStart(2, '0'),
        title: input.title,
        question: input.question,
        condition: input.condition,
        sources: input.sources ?? [],
        order: input.order ?? n,
        revision: 1,
        definitionRevision: 1,
      };
      ticket.research.questions.push(question);
      ticket.revision++;
      this.saveTicket(ticket);
      this.revision('ticket', ticket.id, ticket, author, '新增研究问题');
      this.revision(
        'research-question',
        ticket.id + ':' + question.id,
        question,
        author,
        '创建稳定问题',
      );
      this.history(
        'research-question-added',
        ticket.id,
        author,
        question.id + ' ' + question.title,
      );
      return question;
    });
  }
  updateResearchQuestion(
    actor: WorkbenchActor,
    ticketId: string,
    id: string,
    raw: unknown,
  ): ResearchQuestion {
    const input = researchQuestionUpdateSchema.parse(raw),
      author = this.manager(actor);
    return this.command(actor, 'research-question-update:' + ticketId + ':' + id, input, () => {
      const ticket = this.researchTicket(ticketId),
        question = this.researchQuestion(ticket, id);
      if (question.revision !== input.expectedRevision)
        throw new ProjectError('RESEARCH_QUESTION_REVISION', '问题修订已变化');
      const before = JSON.stringify([
        question.title,
        question.question,
        question.condition,
        question.sources,
      ]);
      Object.assign(question, omit(input, 'operationId', 'expectedRevision', 'reason'));
      if (
        before !==
        JSON.stringify([question.title, question.question, question.condition, question.sources])
      )
        question.definitionRevision++;
      question.revision++;
      ticket.revision++;
      this.saveTicket(ticket);
      this.revision('ticket', ticket.id, ticket, author, input.reason);
      this.revision('research-question', ticket.id + ':' + id, question, author, input.reason);
      this.history('research-question-updated', ticket.id, author, id + ' ' + input.reason);
      return question;
    });
  }
  researchAnswerHistory(ticketId: string, id: string): ResearchAnswer[] {
    this.researchQuestion(this.researchTicket(ticketId), id);
    return this.revisions('research-answer', ticketId + ':' + id).map((r) =>
      researchAnswerSchema.parse(r.value),
    );
  }
  researchQuestionHistory(ticketId: string, id: string) {
    this.researchQuestion(this.researchTicket(ticketId), id);
    return this.revisions('research-question', ticketId + ':' + id);
  }
  research(ticketId: string, id?: string) {
    const ticket = this.researchTicket(ticketId),
      questions = id
        ? [this.researchQuestion(ticket, id)]
        : [...ticket.research.questions].sort(
            (a, b) => a.order - b.order || a.id.localeCompare(b.id),
          );
    return {
      body: ticket.research.body,
      entries: questions.map((question) => {
        const answer = this.researchAnswerHistory(ticket.id, question.id).at(-1) ?? null;
        return {
          question,
          answer,
          coverage: !answer
            ? ('unanswered' as const)
            : answer.questionRevision === question.definitionRevision
              ? ('current' as const)
              : ('outdated' as const),
        };
      }),
    };
  }
  answerResearchQuestion(
    actor: WorkbenchActor,
    ticketId: string,
    id: string,
    raw: unknown,
  ): ResearchAnswer {
    const input = researchAnswerInputSchema.parse(raw),
      { author, scope } = this.writer(actor, ticketId);
    if (
      actor.kind !== 'session' ||
      author.roleType !== 'investigator' ||
      scope?.kind !== 'main' ||
      scope.shutdownOnly
    )
      throw new ProjectError(
        'RESEARCH_INVESTIGATOR_REQUIRED',
        '正式回答由本次实际调查主执行整合保存',
      );
    return this.command(actor, 'research-answer:' + ticketId + ':' + id, input, () => {
      const question = this.researchQuestion(this.researchTicket(ticketId), id),
        previous = this.researchAnswerHistory(ticketId, id).at(-1);
      if (question.definitionRevision !== input.expectedQuestionRevision)
        throw new ProjectError('RESEARCH_QUESTION_REVISION', '问题定义已变化，不能沿用旧条件答复');
      if ((previous?.revision ?? 0) !== input.expectedAnswerRevision)
        throw new ProjectError('RESEARCH_ANSWER_REVISION', '回答修订已变化，请回读最新记录');
      const answer: ResearchAnswer = {
        id: randomUUID(),
        questionId: id,
        questionRevision: question.definitionRevision,
        revision: (previous?.revision ?? 0) + 1,
        status: input.status,
        content: input.content,
        evidence: input.evidence,
        unconfirmed: input.unconfirmed,
        executionId: scope.executionId,
        author,
        createdAt: stamp(),
        previousAnswerId: previous?.id ?? null,
      };
      this.revision(
        'research-answer',
        ticketId + ':' + id,
        answer,
        author,
        '调查执行记录回答与证据，不表示采纳',
      );
      this.history('research-answer-saved', ticketId, author, id + ' 回答修订 ' + answer.revision);
      return answer;
    });
  }
  checklistHistory(id: string) {
    return this.revisions('checklist', this.getTicket(id).id);
  }
  private appendLogInside(
    actor: WorkbenchActor,
    ticket: TicketRecord,
    input: z.infer<typeof appendLogSchema>,
    acceptanceGrant?: { author: RecordAuthor; executionId: string },
  ): LogRecord {
    const { author, scope } = acceptanceGrant
      ? { author: acceptanceGrant.author, scope: { executionId: acceptanceGrant.executionId } }
      : this.writer(actor, ticket.id);
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
      collaborationId:
        'delegationId' in (scope ?? {})
          ? ((scope as TicketExecutionScope).delegationId ?? null)
          : null,
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
      if (
        scope?.kind === 'assistant' &&
        (value.author.sessionId !== author.sessionId ||
          value.collaborationId !== scope.delegationId)
      )
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
  private assistantLogs(parentSessionId: string, executionId?: string) {
    this.sessions.get(parentSessionId);
    return this.db
      .prepare(
        `SELECT l.data,c.execution_id AS execution_id FROM work_log l
      JOIN collaboration c ON c.id=json_extract(l.data,'$.collaborationId')
      WHERE json_extract(c.data,'$.parentSessionId')=? ORDER BY l.rowid`,
      )
      .all(parentSessionId)
      .filter((row) => !executionId || row.execution_id === executionId)
      .map((row) => {
        const log = logSchema.parse(JSON.parse(String(row.data)));
        return {
          ticketId: log.ticketId,
          ticketCode: this.getTicket(log.ticketId).code,
          collaborationId: log.collaborationId!,
          executionId: String(row.execution_id),
          logId: log.id,
          title: log.title,
          author: log.author,
          createdAt: log.createdAt,
        };
      });
  }
  pendingAssistantLogs(parentSessionId: string, executionId?: string) {
    return this.assistantLogs(parentSessionId, executionId).filter(
      (n) =>
        !this.db
          .prepare(
            "SELECT 1 FROM workbench_revision WHERE kind='assistant-log-receipt' AND object_id=? LIMIT 1",
          )
          .get(parentSessionId + ':' + n.ticketId + ':' + n.logId),
    );
  }
  acceptAssistantLogNotices(
    parentSessionId: string,
    notices: { ticketId: string; logId: string }[],
    requestId: string,
  ): void {
    transaction(this.db, () => {
      const row = this.db
        .prepare('SELECT data FROM model_request WHERE id=? AND session_id=?')
        .get(requestId, parentSessionId);
      if (!row)
        throw new ProjectError('LOG_NOTICE_REQUEST_REQUIRED', '提醒接纳缺少原主会话实际请求');
      const request = JSON.parse(String(row.data)),
        sources = this.assistantLogs(parentSessionId, request.executionId);
      for (const notice of notices) {
        const source = sources.find(
          (n) => n.ticketId === notice.ticketId && n.logId === notice.logId,
        );
        if (!source || !request.executionId || source.createdAt > request.startedAt)
          throw new ProjectError('LOG_NOTICE_SOURCE', '提醒不是本次实际请求可接纳的辅助Log');
      }
      for (const notice of notices) {
        const key = parentSessionId + ':' + notice.ticketId + ':' + notice.logId;
        if (
          this.db
            .prepare(
              "SELECT 1 FROM workbench_revision WHERE kind='assistant-log-receipt' AND object_id=? LIMIT 1",
            )
            .get(key)
        )
          continue;
        this.revision(
          'assistant-log-receipt',
          key,
          { ...notice, parentSessionId, requestId },
          this.author({ kind: 'session', sessionId: parentSessionId }),
          '合并提示已进入实际模型请求，不代表已阅读正文',
        );
      }
    });
  }
  updateChecklist(actor: WorkbenchActor, ticketId: string, raw: unknown): TicketRecord {
    const input = checklistUpdateSchema.parse(raw);
    return this.command(actor, 'update-checklist:' + ticketId, input, () => {
      const ticket = this.getTicket(ticketId),
        { author, scope } = this.writer(actor, ticket.id);
      if (scope?.shutdownOnly)
        throw new ProjectError('ASSISTANT_STOPPING', '辅助仅可收尾，不展开Checklist工作');
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
  reviewSubmitted(
    actor: WorkbenchActor,
    ticketId: string,
    executionId: string,
    reviewId: string,
    versionId: string,
    taskId: string,
  ): void {
    const { author } = this.writer(actor, ticketId),
      ticket = this.getTicket(ticketId);
    if (ticket.state !== 'in-progress' || ticket.currentExecution !== executionId)
      throw new ProjectError('REVIEW_TRANSITION_INVALID', '仅原进行中执行可联动待审阅');
    ticket.state = 'awaiting-review';
    ticket.revision++;
    this.db.prepare('UPDATE ticket SET data=? WHERE id=?').run(JSON.stringify(ticket), ticket.id);
    this.revision('ticket', ticket.id, ticket, author, '完成Chat固定版本，进入待审阅');
    const task = supervisorTaskSchema.parse({
      id: taskId,
      level: 'short',
      title: ticket.code + ' · 审核结果及必要安排',
      parentId: null,
      state: 'unchecked',
      basis:
        '完成Chat联动；版本 ' + versionId + '；审核 ' + reviewId + '。通知或已读不等于审核通过。',
      ticketIds: [ticket.id],
      author,
      createdAt: stamp(),
      revision: 1,
    });
    this.db
      .prepare('INSERT INTO supervisor_task(id,data) VALUES(?,?)')
      .run(task.id, JSON.stringify(task));
    this.revision('supervisor-task', task.id, task, author, '正式交付联动主管待处理');
    this.history('completion-submitted', ticket.id, author, '完成Chat保存版本、审核与等待', [
      executionId,
      versionId,
      reviewId,
      task.id,
    ]);
  }
  supplementPrepared(actor: WorkbenchActor, id: string): void {
    const author = this.author(actor),
      record = parseRow(
        this.db.prepare('SELECT data FROM execution_supplement WHERE id=?').get(id),
        supplementSchema,
        '补做安排',
      ),
      ticket = this.getTicket(record.ticketId);
    if (
      author.roleType !== 'supervisor' ||
      author.sessionId !== record.author.sessionId ||
      ticket.currentExecution !== record.previousExecutionId ||
      !['review-passed', 'awaiting-acceptance', 'completed'].includes(ticket.state)
    )
      throw new ProjectError(
        'SUPPLEMENT_SOURCE_INVALID',
        '补做安排不是当前已收尾成果的实际主管决定',
      );
    ticket.state = 'todo';
    ticket.currentExecution = null;
    ticket.revision++;
    for (const item of ticket.checklist)
      Object.assign(item, {
        checked: false,
        result: '',
        logId: null,
        author: null,
        updatedAt: null,
      });
    this.saveTicket(ticket);
    this.revision(
      'ticket',
      ticket.id,
      ticket,
      author,
      '已收尾成果退回补做；旧结果保留，登记关联新尝试',
    );
    this.revision('checklist', ticket.id, ticket.checklist, author, '新尝试重新取得对应版本结果');
    const task = supervisorTaskSchema.parse({
      id: record.id,
      level: 'short',
      title: ticket.code + ' · 补做跟进',
      parentId: null,
      state: 'unchecked',
      basis: record.reason + '；旧执行 ' + record.previousExecutionId + '；意见 ' + record.resultId,
      ticketIds: [ticket.id],
      author,
      createdAt: stamp(),
      revision: 1,
    });
    this.db
      .prepare('INSERT INTO supervisor_task(id,data) VALUES(?,?)')
      .run(task.id, JSON.stringify(task));
    this.revision('supervisor-task', task.id, task, author, '主管补做决定关联待处理');
    this.history('supplement-requested', ticket.id, author, record.reason, [
      record.id,
      record.previousExecutionId,
      record.resultId,
      record.versionId,
    ]);
  }
  reviewEscalated(actor: WorkbenchActor, id: string): void {
    const author = this.author(actor),
      record = parseRow(
        this.db.prepare('SELECT data FROM review_escalation WHERE id=?').get(id),
        escalationSchema,
        '审阅争议',
      );
    if (actor.kind !== 'session' || record.author.sessionId !== author.sessionId)
      throw new ProjectError('ESCALATION_SOURCE_INVALID', '不是已保存的实际争议来源');
    const task = supervisorTaskSchema.parse({
      id: record.taskId,
      level: 'short',
      title: this.getTicket(record.ticketId).code + ' · 明确升级 ' + record.kind,
      parentId: null,
      state: 'unchecked',
      basis: record.basis + '；原正式意见 ' + record.resultId,
      ticketIds: [record.ticketId],
      author,
      createdAt: stamp(),
      revision: 1,
    });
    this.db
      .prepare('INSERT INTO supervisor_task(id,data) VALUES(?,?)')
      .run(task.id, JSON.stringify(task));
    this.revision('supervisor-task', task.id, task, author, '原主执行显式争议升级');
    this.history('review-escalated', record.ticketId, author, record.basis, [
      record.id,
      record.resultId,
      record.taskId,
    ]);
  }
  acceptanceAssigned(actor: WorkbenchActor, assignmentId: string): void {
    const author = this.author(actor),
      assignment = parseRow(
        this.db.prepare('SELECT data FROM acceptance_assignment WHERE id=?').get(assignmentId),
        acceptanceAssignmentSchema,
        '指定验收',
      );
    const ticket = this.getTicket(assignment.ticketId);
    if (
      author.roleType !== 'supervisor' ||
      author.sessionId !== assignment.requester.sessionId ||
      !assignment.active ||
      ticket.currentExecution !== assignment.executionId ||
      !['review-passed', 'awaiting-acceptance'].includes(ticket.state)
    )
      throw new ProjectError('ACCEPTANCE_SOURCE_INVALID', '指定验收必须关联当前实际主管保存的安排');
    ticket.state = 'awaiting-acceptance';
    ticket.revision++;
    this.saveTicket(ticket);
    this.revision('ticket', ticket.id, ticket, author, '主管安排对应版本必要验收');
    this.history('acceptance-assigned', ticket.id, author, assignment.reason, [
      assignment.id,
      assignment.versionId,
      assignment.resultId,
    ]);
  }
  acceptanceRecorded(
    actor: WorkbenchActor,
    assignmentId: string,
    recordId: string,
    checkCondition: boolean,
  ): string | null {
    if (
      actor.kind === 'session' &&
      this.sessions.get(actor.sessionId).communicationState !== 'active'
    )
      throw new ProjectError('ACCEPTANCE_OWNER_CONTROLLED', '暂停会话不能以验收接缝写入新结果');
    const author = this.author(actor),
      assignment = parseRow(
        this.db.prepare('SELECT data FROM acceptance_assignment WHERE id=?').get(assignmentId),
        acceptanceAssignmentSchema,
        '指定验收',
      ),
      record = parseRow(
        this.db.prepare('SELECT data FROM acceptance_result WHERE id=?').get(recordId),
        acceptanceRecordSchema,
        '验收结果',
      );
    const ticket = this.getTicket(assignment.ticketId);
    const ownerMatches =
      assignment.owner.kind === 'user'
        ? actor.kind === 'user'
        : actor.kind === 'session' && actor.sessionId === assignment.owner.sessionId;
    if (
      !assignment.active ||
      !ownerMatches ||
      record.assignmentId !== assignment.id ||
      record.author.kind !== author.kind ||
      record.author.sessionId !== author.sessionId ||
      record.checkCondition !== checkCondition ||
      record.versionId !== assignment.versionId ||
      ticket.currentExecution !== assignment.executionId ||
      ticket.state !== 'awaiting-acceptance'
    )
      throw new ProjectError(
        'ACCEPTANCE_SOURCE_INVALID',
        '验收结果不是当前指定实际责任方的版本记录',
      );
    let logId: string | null = null;
    if (checkCondition && assignment.conditionId) {
      const item = ticket.checklist.find((item) => item.id === assignment.conditionId);
      if (
        !item ||
        item.revision !== assignment.conditionRevision ||
        (item.verification === 'manual' && actor.kind !== 'user')
      )
        throw new ProjectError('ACCEPTANCE_CONDITION_CHANGED', '人工来源或指定条件已变化');
      // This grant only writes this assigned condition and its same-transaction verification Log.
      const log = this.appendLogInside(
        actor,
        ticket,
        {
          operationId: record.id,
          title: '指定验收 · ' + item.id,
          content: record.basis,
          type: 'verification',
          importance: 'normal',
          references: [assignment.id, assignment.versionId, record.id, ...record.evidencePaths],
        },
        { author, executionId: assignment.executionId },
      );
      logId = log.id;
      Object.assign(item, {
        checked: record.decision === 'accept',
        result: record.basis,
        logId,
        author,
        updatedAt: stamp(),
      });
      this.saveTicket(ticket);
      this.revision('checklist', ticket.id, ticket.checklist, author, '指定验收结果关联同次Log');
    }
    this.history('acceptance-recorded', ticket.id, author, record.basis, [
      assignment.id,
      record.id,
      assignment.versionId,
      ...(logId ? [ticket.id + ':' + logId] : []),
    ]);
    return logId;
  }
  acceptanceConfirmed(actor: WorkbenchActor, acceptanceId: string): void {
    const author = this.author(actor),
      accepted = parseRow(
        this.db.prepare('SELECT data FROM ticket_acceptance WHERE id=?').get(acceptanceId),
        ticketAcceptanceSchema,
        '主管接受',
      ),
      ticket = this.getTicket(accepted.ticketId);
    if (
      author.roleType !== 'supervisor' ||
      author.sessionId !== accepted.author.sessionId ||
      ticket.currentExecution !== accepted.executionId ||
      !['review-passed', 'awaiting-acceptance'].includes(ticket.state)
    )
      throw new ProjectError('ACCEPTANCE_SOURCE_INVALID', '结票必须关联当前实际主管的完整核对记录');
    ticket.state = 'completed';
    ticket.revision++;
    this.saveTicket(ticket);
    this.revision('ticket', ticket.id, ticket, author, '主管核对对应版本并明确接受');
    for (const row of this.db
      .prepare(
        "SELECT json_extract(data,'$.taskId') AS task_id FROM completion WHERE execution_id=? UNION SELECT id AS task_id FROM execution_supplement WHERE json_extract(data,'$.executionId')=?",
      )
      .all(accepted.executionId, accepted.executionId)) {
      const task = this.getTask(String(row.task_id));
      if (task.state !== 'checked') {
        task.state = 'checked';
        task.basis = accepted.basis + '；接受记录 ' + accepted.id;
        task.revision++;
        this.db
          .prepare('UPDATE supervisor_task SET data=? WHERE id=?')
          .run(JSON.stringify(task), task.id);
        this.revision('supervisor-task', task.id, task, author, '主管接受业务办结关联待处理');
      }
    }
    this.history('ticket-accepted', ticket.id, author, accepted.basis, [
      accepted.id,
      accepted.versionId,
      accepted.resultId,
      ...accepted.assignmentResultIds,
    ]);
  }
  reviewDecided(
    actor: WorkbenchActor,
    ticketId: string,
    input: {
      resultId: string;
      reviewId: string;
      executionId: string;
      versionId: string;
      verdict: 'pass' | 'return';
      basis: string;
    },
  ): void {
    const author = this.author(actor),
      scope = actor.kind === 'session' ? this.scope?.(actor.sessionId) : undefined;
    if (
      author.roleType !== 'reviewer' ||
      scope?.kind !== 'review' ||
      scope.reviewId !== input.reviewId ||
      scope.executionId !== input.executionId ||
      scope.ticketId !== ticketId
    )
      throw new ProjectError('REVIEW_RESULT_SOURCE', '正式转态不是本次实际独审职责');
    const row = this.db.prepare('SELECT data FROM review_result WHERE id=?').get(input.resultId);
    if (!row)
      throw new ProjectError('REVIEW_RESULT_REQUIRED', '正式转态必须关联已保存的不可变审计意见');
    const result = JSON.parse(String(row.data)) as {
      reviewId: string;
      versionId: string;
      verdict: string;
      author: { sessionId: string };
    };
    if (
      result.reviewId !== input.reviewId ||
      result.versionId !== input.versionId ||
      result.verdict !== input.verdict ||
      result.author.sessionId !== author.sessionId
    )
      throw new ProjectError('REVIEW_RESULT_SOURCE', '审计来源或版本不符，未修改票据');
    const ticket = this.getTicket(ticketId);
    if (ticket.state !== 'awaiting-review' || ticket.currentExecution !== input.executionId)
      throw new ProjectError('REVIEW_TRANSITION_INVALID', '原交付不再处于当前待审阅');
    ticket.state = input.verdict === 'pass' ? 'review-passed' : 'in-progress';
    ticket.revision++;
    this.saveTicket(ticket);
    this.revision(
      'ticket',
      ticket.id,
      ticket,
      author,
      input.verdict === 'pass' ? '正式独审通过，不自动结票' : '正式退回原执行同次修正',
    );
    this.history('review-' + input.verdict, ticket.id, author, input.basis, [
      input.executionId,
      input.versionId,
      input.reviewId,
      input.resultId,
    ]);
  }
  localCommitArranged(actor: WorkbenchActor, value: LocalCommitRecord): void {
    const author = this.manager(actor);
    if (author.roleType !== 'supervisor' || author.sessionId !== value.managerSessionId)
      throw new ProjectError('LOCAL_COMMIT_MANAGER', '本地事项须来自原真实主管');
    const task = supervisorTaskSchema.parse({
      id: value.taskId,
      level: 'short',
      title:
        (value.kind === 'baseline' ? '初始基线' : '必要本地提交') + ' · ' + value.plan.repository,
      parentId: null,
      state: 'unchecked',
      basis: value.basis + '；原本地事项 ' + value.id,
      ticketIds: value.ticketIds,
      business: { kind: 'local-commit', id: value.id },
      author,
      createdAt: stamp(),
      revision: 1,
    });
    this.db
      .prepare('INSERT INTO supervisor_task(id,data) VALUES(?,?)')
      .run(task.id, JSON.stringify(task));
    this.revision('supervisor-task', task.id, task, author, '主管明确本地提交安排');
    this.history('local-commit-arranged', value.id, author, value.basis, [
      ...value.ticketIds,
      ...value.versionIds,
      value.taskId,
    ]);
  }
  mergeArranged(actor: WorkbenchActor, value: WorktreeMergeRecord): void {
    const author = this.author(actor);
    if (
      actor.kind !== 'session' ||
      author.roleType !== 'supervisor' ||
      actor.sessionId !== value.managerSessionId
    )
      throw new ProjectError('MERGE_SOURCE', '合入事项须来自原实际主管');
    const task = supervisorTaskSchema.parse({
      id: value.taskId,
      level: 'short',
      title: '跨树合入 · ' + value.preview.plan.target.repository,
      parentId: null,
      state: 'unchecked',
      basis: value.basis + '；原合入 ' + value.id,
      ticketIds: [value.preview.source.ticketId, value.combinationTicketId],
      business: { kind: 'worktree-merge', id: value.id },
      author,
      createdAt: stamp(),
      revision: 1,
    });
    this.db
      .prepare('INSERT INTO supervisor_task(id,data) VALUES(?,?)')
      .run(task.id, JSON.stringify(task));
    this.revision('supervisor-task', task.id, task, author, '主管明确跨树合入安排');
    this.history('worktree-merge-arranged', value.id, author, value.basis, [
      ...task.ticketIds,
      value.preview.source.versionId,
      value.taskId,
    ]);
  }
  mergeChanged(actor: WorkbenchActor, value: WorktreeMergeRecord, kind: string): void {
    const author = this.author(actor);
    if (
      actor.kind !== 'session' ||
      ![value.managerSessionId, value.committerSessionId].includes(actor.sessionId)
    )
      throw new ProjectError('MERGE_SOURCE', '合入进展须来自原实际安排');
    const task = this.getTask(value.taskId);
    if (task.business?.kind !== 'worktree-merge' || task.business.id !== value.id)
      throw new ProjectError('MERGE_TASK', '原合入与主管清单关联不同');
    task.state =
      value.status === 'completed' && value.lastProof?.state === 'verified' && value.combination
        ? 'checked'
        : ['unknown', 'conflict', 'repairing', 'awaiting-verification', 'blocked'].includes(
              value.status,
            )
          ? 'held'
          : 'unchecked';
    if (value.repair && !task.ticketIds.includes(value.repair.ticketId))
      task.ticketIds.push(value.repair.ticketId);
    task.basis =
      value.basis +
      '；原合入 ' +
      value.id +
      '；状态 ' +
      value.status +
      '。Git事实与组合核验分别保存。';
    task.revision++;
    this.db
      .prepare('UPDATE supervisor_task SET data=? WHERE id=?')
      .run(JSON.stringify(task), task.id);
    this.revision('supervisor-task', task.id, task, author, '原合入实际进展');
    this.history(
      'worktree-merge-' + kind,
      value.id,
      author,
      value.lastProof?.reason ?? value.lastInspection?.note ?? '原合入进展',
      [...task.ticketIds, value.preview.source.versionId, value.taskId],
    );
  }
  localCommitChanged(actor: WorkbenchActor, value: LocalCommitRecord, kind: string): void {
    const author = this.author(actor);
    if (
      actor.kind !== 'session' ||
      ![value.managerSessionId, value.committerSessionId].includes(actor.sessionId)
    )
      throw new ProjectError('LOCAL_COMMIT_SOURCE', '本地事项记录须来自原主管或原提交者');
    const task = this.getTask(value.taskId);
    if (task.business?.kind !== 'local-commit' || task.business.id !== value.id)
      throw new ProjectError('LOCAL_COMMIT_TASK', '原事项与待处理关联不符');
    task.state =
      value.status === 'completed' && value.lastProof?.state === 'verified'
        ? 'checked'
        : ['blocked', 'unknown'].includes(value.status)
          ? 'held'
          : 'unchecked';
    task.basis =
      value.basis +
      '；本地事项 ' +
      value.id +
      '；状态 ' +
      value.status +
      '。Git事实、原命令与业务验收分别核对。';
    task.revision++;
    this.db
      .prepare('UPDATE supervisor_task SET data=? WHERE id=?')
      .run(JSON.stringify(task), task.id);
    this.revision('supervisor-task', task.id, task, author, '本地事项实际进展');
    this.history(
      value.status === 'completed' ? 'local-commit-verified' : 'local-commit-' + kind,
      value.id,
      author,
      value.lastProof?.reason ?? value.lastInspection?.note ?? '原事项进展',
      [
        ...value.ticketIds,
        ...value.versionIds,
        value.taskId,
        ...(value.lastProof?.commit ? [value.lastProof.commit] : []),
      ],
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
      if (task.business?.kind === 'worktree-merge') {
        if (
          input.ticketIds &&
          JSON.stringify([...input.ticketIds].sort()) !== JSON.stringify([...task.ticketIds].sort())
        )
          throw new ProjectError('MERGE_TASK', '业务关联回到原合入维护，不能改挂清单');
        if ((input.state ?? task.state) === 'checked') {
          const row = this.db
              .prepare('SELECT data FROM worktree_merge WHERE id=?')
              .get(task.business.id),
            record = row ? JSON.parse(String(row.data)) : null;
          if (
            record?.taskId !== task.id ||
            record.status !== 'completed' ||
            record.lastProof?.state !== 'verified' ||
            !record.combination
          )
            throw new ProjectError(
              'MERGE_RESULT_REQUIRED',
              '合入与组合结果尚未核定，不能以清单勾选替代',
            );
        }
      }
      if (task.business?.kind === 'local-commit') {
        if (
          input.ticketIds &&
          JSON.stringify([...input.ticketIds].sort()) !== JSON.stringify([...task.ticketIds].sort())
        )
          throw new ProjectError('LOCAL_COMMIT_TASK', '业务关联回到原事项维护，不能改挂清单');
        if ((input.state ?? task.state) === 'checked') {
          const row = this.db
              .prepare('SELECT data FROM local_commit_arrangement WHERE id=?')
              .get(task.business.id),
            record = row ? JSON.parse(String(row.data)) : null;
          if (
            record?.taskId !== task.id ||
            record.status !== 'completed' ||
            record.lastProof?.state !== 'verified'
          )
            throw new ProjectError(
              'LOCAL_COMMIT_RESULT_REQUIRED',
              '本地Git结果未核定，清单勾选不能替代',
            );
        }
      }
      for (const ticketId of ids) {
        const ticket = this.getTicket(ticketId);
        if (
          !task.business &&
          (input.state ?? task.state) === 'checked' &&
          ticket.state !== 'completed'
        )
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
