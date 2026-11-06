import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { WorkbenchActor, TicketRecord, RecordAuthor } from '../contracts/workbench.ts';
import {
  acceptanceAssignmentInputSchema,
  acceptanceRecordInputSchema,
  ticketAcceptanceInputSchema,
  acceptanceAssignmentSchema,
  acceptanceRecordSchema,
  ticketAcceptanceSchema,
} from '../contracts/acceptance.ts';
import type {
  AcceptanceAssignment,
  AcceptanceRecord,
  TicketAcceptance,
} from '../contracts/acceptance.ts';
import type { WorkbenchCatalog } from './workbench-catalog.ts';
import type { ExecutionCatalog } from './execution-catalog.ts';
import type { VersionCatalog } from './version-catalog.ts';
import type { ReviewResultCatalog } from './review-results-catalog.ts';
import type { ReviewCatalog } from './review-catalog.ts';
import type { SessionCatalog } from './session-catalog.ts';
import { transaction } from './transaction.ts';
import { ProjectError } from '../services/errors.ts';
import {
  supplementInputSchema,
  supplementSchema,
  escalationInputSchema,
  escalationSchema,
  acceptanceNoticeSchema,
} from '../contracts/acceptance.ts';
import type { ExecutionRecord } from '../contracts/execution.ts';
const now = () => new Date().toISOString(),
  hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function ensureAcceptanceSchema(db: DatabaseSync) {
  // Idempotent while the unreleased schema-10 preview gains its remaining tables; no history is rewritten.
  db.exec(`CREATE TABLE IF NOT EXISTS acceptance_assignment(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES ticket(id),version_id TEXT NOT NULL REFERENCES execution_version(id),condition_key TEXT NOT NULL,active INTEGER NOT NULL CHECK(active IN(0,1)),data TEXT NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS acceptance_active_condition ON acceptance_assignment(ticket_id,version_id,condition_key) WHERE active=1;
CREATE TABLE IF NOT EXISTS acceptance_result(id TEXT PRIMARY KEY,assignment_id TEXT NOT NULL UNIQUE REFERENCES acceptance_assignment(id),data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ticket_acceptance(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES ticket(id),version_id TEXT NOT NULL REFERENCES execution_version(id),data TEXT NOT NULL,UNIQUE(ticket_id,version_id));
CREATE TABLE IF NOT EXISTS acceptance_command(operation_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS execution_supplement(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES ticket(id),data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS review_escalation(id TEXT PRIMARY KEY,result_id TEXT NOT NULL REFERENCES review_result(id),data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS acceptance_notice(id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL REFERENCES ticket(id),data TEXT NOT NULL);`);
}
export function ticketRequirementsHash(ticket: TicketRecord): string {
  return hash({
    id: ticket.id,
    title: ticket.title,
    phaseId: ticket.phaseId,
    categoryId: ticket.categoryId,
    goal: ticket.goal,
    included: ticket.included,
    excluded: ticket.excluded,
    dependencies: [...ticket.dependencies].sort(),
    conditions: ticket.checklist
      .map((item) => ({
        id: item.id,
        revision: item.revision,
        condition: item.condition,
        verification: item.verification,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });
}
export class AcceptanceCatalog {
  private readonly db: DatabaseSync;
  private readonly wb: WorkbenchCatalog;
  private readonly executions: ExecutionCatalog;
  private readonly versions: VersionCatalog;
  private readonly results: ReviewResultCatalog;
  private readonly reviews: ReviewCatalog;
  private readonly sessions: SessionCatalog;
  constructor(
    db: DatabaseSync,
    wb: WorkbenchCatalog,
    executions: ExecutionCatalog,
    versions: VersionCatalog,
    results: ReviewResultCatalog,
    reviews: ReviewCatalog,
    sessions: SessionCatalog,
  ) {
    this.db = db;
    this.wb = wb;
    this.executions = executions;
    this.versions = versions;
    this.results = results;
    this.reviews = reviews;
    this.sessions = sessions;
  }
  private manager(actor: WorkbenchActor): RecordAuthor {
    const author = this.wb.author(actor);
    if (
      actor.kind !== 'session' ||
      author.roleType !== 'supervisor' ||
      this.sessions.get(actor.sessionId).communicationState !== 'active'
    )
      throw new ProjectError(
        'ACCEPTANCE_SUPERVISOR_REQUIRED',
        '此动作仅实际主管可办理，用户接受不代主管结票',
      );
    return author;
  }
  private command<T>(
    actor: WorkbenchActor,
    kind: string,
    input: { operationId: string },
    run: () => T,
  ): T {
    const author = this.wb.author(actor),
      requestHash = hash({ kind, input, author });
    return transaction(this.db, () => {
      const previous = this.db
        .prepare('SELECT request_hash,data FROM acceptance_command WHERE operation_id=?')
        .get(input.operationId);
      if (previous) {
        if (previous.request_hash !== requestHash)
          throw new ProjectError('ACCEPTANCE_COMMAND_CONFLICT', '验收操作身份正文或来源冲突');
        return JSON.parse(String(previous.data)) as T;
      }
      const value = run();
      this.db
        .prepare('INSERT INTO acceptance_command(operation_id,request_hash,data) VALUES(?,?,?)')
        .run(input.operationId, requestHash, JSON.stringify(value));
      return value;
    });
  }
  currentVersion(ticketId: string, versionId: string, resultId: string, forSupplement = false) {
    const ticket = this.wb.getTicket(ticketId),
      version = this.versions.get(versionId),
      result = this.results.get(resultId),
      execution = this.executions.get(result.executionId),
      review = this.reviews.get(result.reviewId);
    if (
      !(
        forSupplement
          ? ['review-passed', 'awaiting-acceptance', 'completed']
          : ['review-passed', 'awaiting-acceptance']
      ).includes(ticket.state) ||
      ticket.currentExecution !== execution.id ||
      version.id !== result.versionId ||
      version.executionId !== execution.id ||
      result.ticketId !== ticket.id ||
      result.verdict !== 'pass' ||
      this.results.list(execution.id).at(-1)?.id !== result.id ||
      this.versions.list(execution.id).at(-1)?.id !== versionId
    )
      throw new ProjectError('ACCEPTANCE_VERSION_NOT_CURRENT', '不是本票当前有效审阅通过版本');
    if (
      result.progress.state !== 'confirmed' ||
      execution.lifecycleState !== 'closed' ||
      execution.writeOccupancy !== 'released' ||
      review.closure?.state !== 'confirmed' ||
      review.control?.state !== 'confirmed'
    )
      throw new ProjectError(
        'ACCEPTANCE_CLEANUP_REQUIRED',
        '原执行及审核尚未核实收尾，不按保存意见放行',
      );
    if (ticketRequirementsHash(ticket) !== ticketRequirementsHash(version.ticket))
      throw new ProjectError(
        'ACCEPTANCE_REQUIREMENTS_CHANGED',
        '票据条件已变化，旧版本审阅不能替现行要求背书',
      );
    const match = this.versions.check(versionId);
    if (match.matches !== true)
      throw new ProjectError(
        'ACCEPTANCE_VERSION_MISMATCH',
        '当前成果与已审版本不对应或无法核对，不能验收或结票',
      );
    return { ticket, version, result, execution };
  }
  assignment(id: string): AcceptanceAssignment {
    const row = this.db.prepare('SELECT data FROM acceptance_assignment WHERE id=?').get(id);
    if (!row) throw new ProjectError('ACCEPTANCE_ASSIGNMENT_NOT_FOUND', '指定验收安排不存在');
    return acceptanceAssignmentSchema.parse(JSON.parse(String(row.data)));
  }
  recordFor(assignmentId: string): AcceptanceRecord | undefined {
    const row = this.db
      .prepare('SELECT data FROM acceptance_result WHERE assignment_id=?')
      .get(assignmentId);
    return row ? acceptanceRecordSchema.parse(JSON.parse(String(row.data))) : undefined;
  }
  assignments(ticketId?: string): AcceptanceAssignment[] {
    return (
      ticketId
        ? this.db
            .prepare('SELECT data FROM acceptance_assignment WHERE ticket_id=? ORDER BY rowid')
            .all(this.wb.getTicket(ticketId).id)
        : this.db.prepare('SELECT data FROM acceptance_assignment ORDER BY rowid').all()
    ).map((row) => acceptanceAssignmentSchema.parse(JSON.parse(String(row.data))));
  }
  accepted(ticketId: string): TicketAcceptance[] {
    return this.db
      .prepare('SELECT data FROM ticket_acceptance WHERE ticket_id=? ORDER BY rowid')
      .all(this.wb.getTicket(ticketId).id)
      .map((row) => ticketAcceptanceSchema.parse(JSON.parse(String(row.data))));
  }
  assign(actor: WorkbenchActor, raw: unknown): AcceptanceAssignment {
    const input = acceptanceAssignmentInputSchema.parse(raw),
      requester = this.manager(actor);
    const saved = this.command(actor, 'assign-acceptance', input, () => {
      const { ticket, execution } = this.currentVersion(
          input.ticketId,
          input.versionId,
          input.resultId,
        ),
        condition = input.conditionId
          ? ticket.checklist.find((item) => item.id === input.conditionId)
          : undefined;
      if (input.conditionId && !condition)
        throw new ProjectError('ACCEPTANCE_CONDITION_NOT_FOUND', '对应Checklist条件不存在');
      if (!condition && !input.criterion)
        throw new ProjectError('ACCEPTANCE_CRITERION_REQUIRED', '额外验收须说明明确事项');
      if (
        condition &&
        !input.required &&
        this.assignments(ticket.id).some(
          (item) =>
            item.versionId === input.versionId &&
            item.conditionId === condition.id &&
            item.required,
        )
      )
        throw new ProjectError(
          'REQUIRED_ACCEPTANCE_DOWNGRADE',
          '本版本已有必需验收，不能重安排成可选来绕过原责任方结果',
        );
      if (condition?.verification === 'manual' && (input.owner.kind !== 'user' || !input.required))
        throw new ProjectError(
          'MANUAL_ACCEPTANCE_REQUIRED',
          '必需人工条件只能指定真实用户，不能改为成员或非必需',
        );
      if (input.owner.kind === 'session') {
        const session = this.sessions.get(input.owner.sessionId);
        if (session.status !== 'bound' || session.communicationState !== 'active')
          throw new ProjectError(
            'ACCEPTANCE_OWNER_UNAVAILABLE',
            '指定责任方不是当前活跃实际会话，不普通唤醒已收尾入口',
          );
      }
      const id = randomUUID(),
        key = condition?.id ?? 'extra:' + id;
      for (const previous of this.assignments(ticket.id).filter(
        (item) =>
          item.active && item.versionId === input.versionId && item.conditionId === condition?.id,
      )) {
        previous.active = false;
        this.db
          .prepare('UPDATE acceptance_assignment SET active=0,data=? WHERE id=?')
          .run(JSON.stringify(previous), previous.id);
      }
      const value: AcceptanceAssignment = {
        id,
        ticketId: ticket.id,
        executionId: execution.id,
        versionId: input.versionId,
        resultId: input.resultId,
        conditionId: condition?.id ?? null,
        conditionRevision: condition?.revision ?? null,
        criterion: condition?.condition ?? input.criterion!,
        owner: input.owner,
        required: input.required,
        active: true,
        requirementsHash: ticketRequirementsHash(ticket),
        reason: input.reason,
        requester,
        createdAt: now(),
      };
      this.db
        .prepare(
          'INSERT INTO acceptance_assignment(id,ticket_id,version_id,condition_key,active,data) VALUES(?,?,?,?,1,?)',
        )
        .run(
          id,
          ticket.id,
          input.versionId,
          key,
          JSON.stringify(acceptanceAssignmentSchema.parse(value)),
        );
      this.wb.acceptanceAssigned(actor, id);
      if (value.owner.kind === 'session')
        this.notice(
          value.ticketId,
          id,
          value.owner.sessionId,
          '主管指定验收：' +
            value.criterion +
            '；安排 ' +
            id +
            '；固定版本 ' +
            value.versionId +
            '。仅实际指定责任方记录依据与接受或退回；通知不代表接受或结票。',
        );
      this.emit(id);
      return value;
    });
    return this.assignment(saved.id);
  }
  record(actor: WorkbenchActor, raw: unknown): AcceptanceRecord {
    const input = acceptanceRecordInputSchema.parse(raw),
      author = this.wb.author(actor);
    return this.command(actor, 'record-acceptance', input, () => {
      const assignment = this.assignment(input.assignmentId);
      if (!assignment.active)
        throw new ProjectError(
          'ACCEPTANCE_ASSIGNMENT_SUPERSEDED',
          '旧安排已被替代，不办理旧版结果',
        );
      if (
        assignment.owner.kind === 'user'
          ? actor.kind !== 'user'
          : actor.kind !== 'session' || actor.sessionId !== assignment.owner.sessionId
      )
        throw new ProjectError('ACCEPTANCE_OWNER_REQUIRED', '不是指定真实验收责任方，不能代填结果');
      if (
        actor.kind === 'session' &&
        this.sessions.get(actor.sessionId).communicationState !== 'active'
      )
        throw new ProjectError(
          'ACCEPTANCE_OWNER_CONTROLLED',
          '指定责任会话已暂停或受控，不能办理新的验收',
        );
      const { ticket } = this.currentVersion(
        assignment.ticketId,
        assignment.versionId,
        assignment.resultId,
      );
      if (ticketRequirementsHash(ticket) !== assignment.requirementsHash)
        throw new ProjectError('ACCEPTANCE_ASSIGNMENT_CHANGED', '指定验收条件已变化');
      if (this.recordFor(assignment.id))
        throw new ProjectError('ACCEPTANCE_ALREADY_RECORDED', '已有不可变验收结果，不能覆盖');
      const request =
        actor.kind === 'session'
          ? this.db
              .prepare(
                'SELECT id FROM model_request WHERE session_id=? ORDER BY rowid DESC LIMIT 1',
              )
              .get(actor.sessionId)
          : undefined;
      const value: AcceptanceRecord = {
        id: randomUUID(),
        assignmentId: assignment.id,
        ticketId: ticket.id,
        versionId: assignment.versionId,
        decision: input.decision,
        basis: input.basis,
        evidencePaths: input.evidencePaths,
        checkCondition: input.checkCondition,
        logId: null,
        author,
        sourceRequestId: request ? String(request.id) : null,
        createdAt: now(),
      };
      this.db
        .prepare('INSERT INTO acceptance_result(id,assignment_id,data) VALUES(?,?,?)')
        .run(value.id, assignment.id, JSON.stringify(acceptanceRecordSchema.parse(value)));
      value.logId = this.wb.acceptanceRecorded(
        actor,
        assignment.id,
        value.id,
        input.checkCondition,
      );
      this.db
        .prepare('UPDATE acceptance_result SET data=? WHERE id=?')
        .run(JSON.stringify(value), value.id);
      for (const target of this.executions.get(assignment.executionId).managerSessionIds)
        this.notice(
          ticket.id,
          value.id,
          target,
          '指定验收已记录 ' +
            value.decision +
            '；结果 ' +
            value.id +
            '；安排 ' +
            assignment.id +
            '；版本 ' +
            assignment.versionId +
            '。请核对正式依据；用户或成员接受不等于主管结票，退回如需补做应明确建立关联新尝试。',
        );
      this.emit(value.id);
      return value;
    });
  }
  complete(actor: WorkbenchActor, raw: unknown): TicketAcceptance {
    const input = ticketAcceptanceInputSchema.parse(raw),
      author = this.manager(actor);
    return this.command(actor, 'confirm-ticket-acceptance', input, () => {
      const { ticket, version, execution } = this.currentVersion(
          input.ticketId,
          input.versionId,
          input.resultId,
        ),
        assignments = this.assignments(ticket.id).filter(
          (item) => item.active && item.versionId === version.id,
        ),
        records = assignments.map((assignment) => ({
          assignment,
          result: this.recordFor(assignment.id),
        }));
      for (const item of records)
        if (item.assignment.required && item.result?.decision !== 'accept')
          throw new ProjectError(
            'REQUIRED_ACCEPTANCE_MISSING',
            '必要指定验收未被责任方接受，不能结票',
          );
      for (const condition of ticket.checklist) {
        if (!condition.checked || !condition.result.trim() || !condition.logId)
          throw new ProjectError(
            'CHECKLIST_UNSATISFIED',
            'Checklist仍有未核实条件，不能靠点击结票',
          );
        const log = this.wb.getLog(ticket.id, condition.logId),
          frozen = version.ticket.checklist.find((item) => item.id === condition.id),
          matched = records.find(
            (item) =>
              item.assignment.conditionId === condition.id && item.result?.decision === 'accept',
          );
        if (
          condition.verification === 'manual' &&
          (!matched ||
            matched.assignment.owner.kind !== 'user' ||
            matched.result!.author.kind !== 'user')
        )
          throw new ProjectError('MANUAL_ACCEPTANCE_MISSING', '缺少对应版本实际用户的必要人工结果');
        const frozenEvidence =
          frozen?.checked && frozen.logId === condition.logId && frozen.result === condition.result;
        const boundEvidence =
          matched?.result &&
          (matched.result.logId === condition.logId ||
            (log.references.includes(version.id) && log.references.includes(matched.result.id)));
        if (!frozenEvidence && !boundEvidence)
          throw new ProjectError(
            'CHECKLIST_VERSION_UNBOUND',
            'Checklist依据未关联已审版本或指定验收',
          );
      }
      const value: TicketAcceptance = {
        id: randomUUID(),
        ticketId: ticket.id,
        executionId: execution.id,
        versionId: version.id,
        resultId: input.resultId,
        basis: input.basis,
        assignmentResultIds: records.filter((item) => item.result).map((item) => item.result!.id),
        checklistLogs: ticket.checklist.map((item) => item.logId!),
        author,
        createdAt: now(),
      };
      this.db
        .prepare('INSERT INTO ticket_acceptance(id,ticket_id,version_id,data) VALUES(?,?,?,?)')
        .run(value.id, ticket.id, version.id, JSON.stringify(ticketAcceptanceSchema.parse(value)));
      this.wb.acceptanceConfirmed(actor, value.id);
      this.emit(value.id);
      return value;
    });
  }
  supplements(ticketId: string) {
    return this.db
      .prepare('SELECT data FROM execution_supplement WHERE ticket_id=? ORDER BY rowid')
      .all(this.wb.getTicket(ticketId).id)
      .map((row) => supplementSchema.parse(JSON.parse(String(row.data))));
  }
  escalations(ticketId: string) {
    return this.db
      .prepare('SELECT data FROM review_escalation ORDER BY rowid')
      .all()
      .map((row) => escalationSchema.parse(JSON.parse(String(row.data))))
      .filter((value) => value.ticketId === this.wb.getTicket(ticketId).id);
  }
  supplement(actor: WorkbenchActor, raw: unknown, register: (input: unknown) => ExecutionRecord) {
    const input = supplementInputSchema.parse(raw),
      author = this.manager(actor);
    return this.command(actor, 'supplement-closed-delivery', input, () => {
      const { ticket, execution } = this.currentVersion(
        input.ticketId,
        input.versionId,
        input.resultId,
        true,
      );
      if (!input.dispatch.roleId)
        throw new ProjectError(
          'SUPPLEMENT_NEW_SESSION_REQUIRED',
          '补做须指定角色新建尝试及Goal，不普通唤醒已收尾会话',
        );
      const id = randomUUID(),
        value = {
          id,
          ticketId: ticket.id,
          previousExecutionId: execution.id,
          executionId: randomUUID() as string,
          versionId: input.versionId,
          resultId: input.resultId,
          reason: input.reason,
          author,
          createdAt: now(),
        };
      // Persist the authorization before the narrow transition, then bind the actual registered attempt atomically.
      this.db
        .prepare('INSERT INTO execution_supplement(id,ticket_id,data) VALUES(?,?,?)')
        .run(id, ticket.id, JSON.stringify(value));
      this.wb.supplementPrepared(actor, id);
      const next = register({
        ...input.dispatch,
        ticket: ticket.id,
        operationId: input.operationId,
        requirements:
          input.dispatch.requirements +
          '\n补做关联 ' +
          id +
          '；旧执行 ' +
          execution.id +
          '；正式意见 ' +
          input.resultId +
          '；原范围补做理由：' +
          input.reason,
      });
      value.executionId = next.id;
      for (const old of this.assignments(ticket.id).filter(
        (item) => item.active && item.versionId === input.versionId,
      )) {
        old.active = false;
        this.db
          .prepare('UPDATE acceptance_assignment SET active=0,data=? WHERE id=?')
          .run(JSON.stringify(old), old.id);
      }
      this.db
        .prepare('UPDATE execution_supplement SET data=? WHERE id=?')
        .run(JSON.stringify(supplementSchema.parse(value)), id);
      this.emit(id);
      return value;
    });
  }
  escalate(actor: WorkbenchActor, raw: unknown) {
    const input = escalationInputSchema.parse(raw),
      author = this.wb.author(actor);
    return this.command(actor, 'escalate-review', input, () => {
      const result = this.results.get(input.resultId),
        execution = this.executions.get(result.executionId);
      if (
        actor.kind !== 'session' ||
        actor.sessionId !== execution.sessionId ||
        this.sessions.get(actor.sessionId).communicationState !== 'active'
      )
        throw new ProjectError(
          'ESCALATION_AUTHOR_REQUIRED',
          '只接受原主执行实际会话的明确争议，不替他人广播',
        );
      const value = {
        id: randomUUID(),
        resultId: result.id,
        executionId: execution.id,
        ticketId: result.ticketId,
        versionId: result.versionId,
        kind: input.kind,
        basis: input.basis,
        evidencePaths: input.evidencePaths,
        author,
        taskId: randomUUID(),
        createdAt: now(),
      };
      this.db
        .prepare('INSERT INTO review_escalation(id,result_id,data) VALUES(?,?,?)')
        .run(value.id, result.id, JSON.stringify(escalationSchema.parse(value)));
      this.wb.reviewEscalated(actor, value.id);
      for (const target of execution.managerSessionIds)
        this.notice(
          value.ticketId,
          value.id,
          target,
          '原主执行明确升级 ' +
            value.kind +
            '；正式意见 ' +
            result.id +
            '；升级记录 ' +
            value.id +
            '；主管待处理 ' +
            value.taskId +
            '。不改变原审阅意见、票据要求或上级控制。',
        );
      this.emit(value.id);
      return value;
    });
  }
  notices(ticketId?: string) {
    return this.db
      .prepare('SELECT data FROM acceptance_notice ORDER BY rowid')
      .all()
      .map((row) => acceptanceNoticeSchema.parse(JSON.parse(String(row.data))))
      .filter((value) => !ticketId || value.ticketId === ticketId);
  }
  notified(id: string, state: 'saved' | 'unavailable', error: string | null) {
    const notice = this.notices().find((item) => item.id === id);
    if (!notice) throw new ProjectError('ACCEPTANCE_NOTICE_NOT_FOUND', '验收通知不存在');
    Object.assign(notice, { state, error });
    this.db
      .prepare('UPDATE acceptance_notice SET data=? WHERE id=?')
      .run(JSON.stringify(notice), id);
    this.emit(id);
  }
  private notice(ticketId: string, referenceId: string, targetSessionId: string, content: string) {
    const value = acceptanceNoticeSchema.parse({
      id: randomUUID(),
      ticketId,
      referenceId,
      targetSessionId,
      content,
      state: 'pending',
      error: null,
    });
    this.db
      .prepare('INSERT INTO acceptance_notice(id,ticket_id,data) VALUES(?,?,?)')
      .run(value.id, ticketId, JSON.stringify(value));
  }
  private emit(id: string) {
    this.db
      .prepare('INSERT INTO ui_event(kind,object_id) VALUES(?,?)')
      .run('acceptance-changed', id);
  }
}
