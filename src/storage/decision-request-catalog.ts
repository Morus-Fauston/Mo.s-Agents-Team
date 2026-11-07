import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  decisionCreateSchema,
  decisionReplySchema,
  decisionEscalateSchema,
  decisionWithdrawSchema,
  decisionSupplementSchema,
  decisionRequestSchema,
  decisionNoticeSchema,
} from '../contracts/decision-requests.ts';
import type {
  DecisionRequest,
  DecisionResponsibility,
  DecisionNotice,
} from '../contracts/decision-requests.ts';
import type { WorkbenchActor } from '../contracts/workbench.ts';
import type { WorkbenchCatalog } from './workbench-catalog.ts';
import type { ExecutionCatalog } from './execution-catalog.ts';
import type { SessionCatalog } from './session-catalog.ts';
import type { CollaborationCatalog } from './collaboration-catalog.ts';
import { transaction } from './transaction.ts';
import { ProjectError } from '../services/errors.ts';
import { messageIdentity } from '../services/message-presentation.ts';
import { normalizeWriteScopes } from '../services/write-scopes.ts';
const now = () => new Date().toISOString();
export function migrateDecisionRequests(db: DatabaseSync): void {
  db.exec(`CREATE TABLE decision_request(id TEXT PRIMARY KEY,execution_id TEXT NOT NULL REFERENCES execution(id),data TEXT NOT NULL);
  CREATE TABLE decision_request_notice(id TEXT PRIMARY KEY,request_id TEXT NOT NULL REFERENCES decision_request(id),data TEXT NOT NULL);
  CREATE TABLE decision_request_command(operation_id TEXT PRIMARY KEY,request_hash TEXT NOT NULL,request_id TEXT NOT NULL REFERENCES decision_request(id));
  PRAGMA user_version=14;`);
}
export class DecisionRequestCatalog {
  private readonly db: DatabaseSync;
  private readonly wb: WorkbenchCatalog;
  private readonly executions: ExecutionCatalog;
  private readonly sessions: SessionCatalog;
  private readonly collaborations: CollaborationCatalog;
  constructor(
    db: DatabaseSync,
    wb: WorkbenchCatalog,
    executions: ExecutionCatalog,
    sessions: SessionCatalog,
    collaborations: CollaborationCatalog,
  ) {
    this.db = db;
    this.wb = wb;
    this.executions = executions;
    this.sessions = sessions;
    this.collaborations = collaborations;
  }
  record(id: string): DecisionRequest {
    const row = this.db.prepare('SELECT data FROM decision_request WHERE id=?').get(id);
    if (!row) throw new ProjectError('DECISION_NOT_FOUND', '决定请求不存在');
    return decisionRequestSchema.parse(JSON.parse(String(row.data)));
  }
  notices(id: string): DecisionNotice[] {
    this.record(id);
    return this.db
      .prepare('SELECT data FROM decision_request_notice WHERE request_id=? ORDER BY rowid')
      .all(id)
      .map((row) => decisionNoticeSchema.parse(JSON.parse(String(row.data))));
  }
  noticeDelivery(id: string, delivery: DecisionNotice['delivery'], note: string | null): void {
    const row = this.db.prepare('SELECT data FROM decision_request_notice WHERE id=?').get(id);
    if (!row) throw new ProjectError('DECISION_NOTICE_NOT_FOUND', '请求通知不存在');
    const n = decisionNoticeSchema.parse(JSON.parse(String(row.data)));
    n.delivery = delivery;
    n.deliveryNote = note;
    this.db
      .prepare('UPDATE decision_request_notice SET data=? WHERE id=?')
      .run(JSON.stringify(n), id);
  }
  private manager(actor: WorkbenchActor, r: DecisionRequest): boolean {
    return (
      actor.kind === 'session' &&
      actor.sessionId === r.managerSessionId &&
      this.sessions.get(actor.sessionId).roleType === 'supervisor'
    );
  }
  private same(actor: WorkbenchActor, target: DecisionResponsibility): boolean {
    return (
      actor.kind === target.kind && (actor.kind === 'user' || actor.sessionId === target.sessionId)
    );
  }
  private requester(actor: WorkbenchActor, r: DecisionRequest): boolean {
    return (
      actor.kind === r.requester.kind &&
      (actor.kind === 'user' || actor.sessionId === r.requester.sessionId)
    );
  }
  get(actor: WorkbenchActor, id: string): DecisionRequest {
    const r = this.record(id);
    if (
      actor.kind !== 'user' &&
      !this.requester(actor, r) &&
      !this.same(actor, r.assignee) &&
      actor.sessionId !== r.parentSessionId &&
      !this.manager(actor, r)
    )
      throw new ProjectError('DECISION_READ_FORBIDDEN', '只能读取本次职责内请求');
    return r;
  }
  list(actor: WorkbenchActor): DecisionRequest[] {
    return this.db
      .prepare('SELECT id FROM decision_request ORDER BY rowid')
      .all()
      .flatMap((row) => {
        try {
          return [this.get(actor, String(row.id))];
        } catch (e) {
          if (e instanceof ProjectError && e.code === 'DECISION_READ_FORBIDDEN') return [];
          throw e;
        }
      });
  }
  pending(actor: WorkbenchActor): DecisionRequest[] {
    return this.list(actor).filter((r) =>
      r.state === 'pending'
        ? this.same(actor, r.assignee)
        : r.state === 'needs-info' && this.requester(actor, r),
    );
  }
  private source(actor: WorkbenchActor): void {
    this.wb.author(actor);
    if (
      actor.kind === 'session' &&
      this.sessions.get(actor.sessionId).communicationState !== 'active'
    )
      throw new ProjectError(
        'DECISION_SOURCE_CONTROLLED',
        '请求操作来源暂停或受控，不借业务动作解除控制',
      );
  }
  private command(
    actor: WorkbenchActor,
    action: string,
    input: { operationId: string },
    run: () => DecisionRequest,
  ): DecisionRequest {
    this.source(actor);
    const hash = createHash('sha256')
      .update(JSON.stringify({ actor, action, input }))
      .digest('hex');
    return transaction(this.db, () => {
      const previous = this.db
        .prepare(
          'SELECT request_hash,request_id FROM decision_request_command WHERE operation_id=?',
        )
        .get(input.operationId);
      if (previous) {
        if (previous.request_hash !== hash)
          throw new ProjectError('DECISION_COMMAND_CONFLICT', '请求操作身份、来源或正文冲突');
        return this.record(String(previous.request_id));
      }
      const r = run();
      this.db
        .prepare(
          'INSERT INTO decision_request_command(operation_id,request_hash,request_id) VALUES(?,?,?)',
        )
        .run(input.operationId, hash, r.id);
      return r;
    });
  }
  private save(
    r: DecisionRequest,
    actor: WorkbenchActor,
    action: DecisionRequest['history'][number]['action'],
    data: Record<string, unknown>,
  ): DecisionRequest {
    const at = now();
    r.updatedAt = at;
    r.history.push({ revision: r.revision, action, actor: this.wb.author(actor), at, data });
    const parsed = decisionRequestSchema.parse(r);
    this.db
      .prepare(
        'INSERT INTO decision_request(id,execution_id,data) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(r.id, r.executionId, JSON.stringify(parsed));
    this.db
      .prepare('INSERT INTO ui_event(kind,object_id) VALUES(?,?)')
      .run('decision-request-changed', r.ticketId);
    const kind = action === 'reply' ? 'reply' : action === 'withdraw' ? 'withdrawal' : 'request';
    const requester: DecisionResponsibility = {
      kind: r.requester.kind === 'user' ? 'user' : 'session',
      sessionId: r.requester.sessionId,
    };
    const targets =
      action === 'reply'
        ? [requester]
        : action === 'escalate' || action === 'withdraw'
          ? [r.assignee, requester]
          : [r.assignee];
    for (const target of new Map(
      targets.map((target) => [target.sessionId ?? 'user', target]),
    ).values()) {
      const notice: DecisionNotice = {
        id: messageIdentity(
          'decision:' + r.id + ':' + r.revision + ':' + (target.sessionId ?? 'user'),
        ),
        requestId: r.id,
        revision: r.revision,
        target,
        kind,
        delivery: 'pending',
        deliveryNote: null,
        content: JSON.stringify({
          requestId: r.id,
          revision: r.revision,
          action,
          state: r.state,
          subject: r.subject,
          assignee: r.assignee,
          requester: r.requester,
          ticketId: r.ticketId,
          executionId: r.executionId,
          collaborationId: r.collaborationId,
          ...(r.scopeProposal ? { scopeProposal: r.scopeProposal } : {}),
          ...(kind === 'reply'
            ? { reply: r.reply }
            : kind === 'request'
              ? { question: r.question, impact: r.impact, reason: r.reason }
              : {}),
          note: '沿此稳定请求查询最新记录。答复仅覆盖明确事项和限制，不改变票据、文件权限或控制。已读、普通回复及接受安排不代表工作已交付。',
        }),
      };
      this.db
        .prepare('INSERT INTO decision_request_notice(id,request_id,data) VALUES(?,?,?)')
        .run(notice.id, r.id, JSON.stringify(notice));
    }
    return parsed;
  }
  private revision(r: DecisionRequest, expected: number): void {
    if (r.revision !== expected)
      throw new ProjectError('DECISION_REVISION_CONFLICT', '请求修订已变化，先回读原对象');
  }
  private pendingState(r: DecisionRequest): void {
    if (r.state !== 'pending')
      throw new ProjectError('DECISION_NOT_PENDING', '原请求不在待答复状态');
  }
  private unavailable(r: DecisionRequest): boolean {
    const p = this.sessions.get(r.parentSessionId),
      e = this.executions.get(r.executionId);
    return (
      p.status !== 'bound' ||
      ['terminated', 'archived'].includes(p.communicationState) ||
      e.failure !== null ||
      ['terminated', 'closed', 'error'].includes(e.lifecycleState)
    );
  }
  create(actor: WorkbenchActor, raw: unknown): DecisionRequest {
    const input = decisionCreateSchema.parse(raw);
    return this.command(actor, 'create', input, () => {
      if (actor.kind !== 'session')
        throw new ProjectError('DECISION_EXECUTOR_REQUIRED', '正式执行请求由真实主执行或辅助提出');
      const a = this.collaborations.currentForSession(actor.sessionId),
        scope =
          this.collaborations.scopeForSession(actor.sessionId) ??
          this.executions.scopeForSession(actor.sessionId);
      if (!scope?.allowWrite || scope.shutdownOnly)
        throw new ProjectError('DECISION_EXECUTOR_REQUIRED', '没有当前可工作的执行或协作范围');
      const e = this.executions.get(scope.executionId),
        manager = e.managerSessionIds.length === 1 ? e.managerSessionIds[0] : undefined;
      if (!manager || this.sessions.get(manager).roleType !== 'supervisor')
        throw new ProjectError(
          'DECISION_MANAGER_AMBIGUOUS',
          '原执行管理入口不唯一或缺失，不能猜责任人',
        );
      if (!a && input.reason === 'parent-unavailable')
        throw new ProjectError(
          'DECISION_ESCALATION_INVALID',
          '主执行不能把自己声明为不可用来改变责任',
        );
      if (input.reason === 'human-decision')
        throw new ProjectError(
          'DECISION_ESCALATION_INVALID',
          '普通执行请求先交原管理链，不能直指用户',
        );
      if (input.requestedWriteScopes && (a || input.reason !== 'scope-change' || e.mergeId))
        throw new ProjectError(
          'DECISION_SCOPE_PROPOSAL',
          '只有普通主执行可为本次声明范围提出明确调整请求；辅助不得自行扩权',
        );
      const parent = a?.parentSessionId ?? actor.sessionId,
        at = now();
      const r: DecisionRequest = {
        id: randomUUID(),
        ticketId: scope.ticketId,
        executionId: scope.executionId,
        collaborationId: a?.id ?? null,
        requester: this.wb.author(actor),
        managerSessionId: manager,
        parentSessionId: parent,
        assignee: {
          kind: 'session',
          sessionId: a && input.reason === 'clarification' ? parent : manager,
        },
        subject: input.subject,
        question: input.question,
        impact: input.impact,
        reason: input.reason,
        references: input.references,
        scopeProposal: input.requestedWriteScopes
          ? {
              writeScopes: normalizeWriteScopes(e.cwd, input.requestedWriteScopes),
              scopeRevision: e.scopeAdjustments.length,
              cwd: e.cwd,
            }
          : null,
        revision: 1,
        state: 'pending',
        handled: false,
        reply: null,
        createdAt: at,
        updatedAt: at,
        history: [],
      };
      if (input.reason === 'parent-unavailable' && !this.unavailable(r))
        throw new ProjectError('DECISION_PARENT_AVAILABLE', '忙碌、等待或暂停不等于主负责人不可用');
      return this.save(r, actor, 'create', input);
    });
  }
  reply(actor: WorkbenchActor, id: string, raw: unknown): DecisionRequest {
    const input = decisionReplySchema.parse(raw);
    return this.command(actor, 'reply:' + id, input, () => {
      const r = this.get(actor, id);
      this.revision(r, input.expectedRevision);
      this.pendingState(r);
      if (r.scopeProposal && input.choice === 'accept' && input.restrictions.trim())
        throw new ProjectError(
          'DECISION_SCOPE_RESTRICTIONS',
          '带额外限制的范围不能按原完整提案通过；请要求提交准确的新范围',
        );
      if (!this.same(actor, r.assignee))
        throw new ProjectError(
          'DECISION_RESPONDER_REQUIRED',
          '当前调用者不是原请求责任入口，查看不等于代办',
        );
      if (
        actor.kind === 'session' &&
        actor.sessionId === r.parentSessionId &&
        !this.manager(actor, r)
      ) {
        const scope = this.executions.scopeForSession(actor.sessionId);
        if (
          scope?.executionId !== r.executionId ||
          !scope.allowAssist ||
          r.reason !== 'clarification'
        )
          throw new ProjectError(
            'DECISION_PARENT_SCOPE',
            '主负责人仅答复本次已有授权内澄清，其他决定须升级',
          );
      }
      r.reply = {
        choice: input.choice,
        answer: input.answer,
        restrictions: input.restrictions,
        author: this.wb.author(actor),
        requestRevision: r.revision,
        at: now(),
      };
      r.state =
        input.choice === 'need-info'
          ? 'needs-info'
          : input.choice === 'reject'
            ? 'rejected'
            : 'answered';
      r.handled = true;
      r.revision++;
      return this.save(r, actor, 'reply', input);
    });
  }
  escalate(actor: WorkbenchActor, id: string, raw: unknown): DecisionRequest {
    const input = decisionEscalateSchema.parse(raw);
    return this.command(actor, 'escalate:' + id, input, () => {
      const r = this.get(actor, id);
      this.revision(r, input.expectedRevision);
      this.pendingState(r);
      if (input.reason === 'clarification')
        throw new ProjectError('DECISION_ESCALATION_INVALID', '普通澄清先由原主负责人处理');
      if (input.reason === 'parent-unavailable' && !this.unavailable(r))
        throw new ProjectError('DECISION_PARENT_AVAILABLE', '忙碌、等待或暂停不等于主负责人不可用');
      if (input.reason === 'human-decision') {
        if (!this.manager(actor, r) || !this.same(actor, r.assignee))
          throw new ProjectError(
            'DECISION_MANAGER_REQUIRED',
            '只有当前承接的实际主管可明确升级用户',
          );
        r.assignee = { kind: 'user', sessionId: null };
      } else {
        if (
          r.assignee.kind !== 'session' ||
          r.assignee.sessionId !== r.parentSessionId ||
          r.parentSessionId === r.managerSessionId
        )
          throw new ProjectError(
            'DECISION_ESCALATION_INVALID',
            '该请求已在管理入口，不重复升级或改派',
          );
        if (
          !this.requester(actor, r) &&
          !this.same(actor, r.assignee) &&
          !(this.manager(actor, r) && input.reason === 'parent-unavailable')
        )
          throw new ProjectError('DECISION_ESCALATION_FORBIDDEN', '只能沿本次真实责任链升级');
        r.assignee = { kind: 'session', sessionId: r.managerSessionId };
      }
      r.reason = input.reason;
      r.revision++;
      return this.save(r, actor, 'escalate', input);
    });
  }
  supplement(actor: WorkbenchActor, id: string, raw: unknown): DecisionRequest {
    const input = decisionSupplementSchema.parse(raw);
    return this.command(actor, 'supplement:' + id, input, () => {
      const r = this.get(actor, id);
      this.revision(r, input.expectedRevision);
      if (!this.requester(actor, r))
        throw new ProjectError('DECISION_REQUESTER_REQUIRED', '只有原提出者可补充');
      if (r.state !== 'needs-info')
        throw new ProjectError(
          'DECISION_SUPPLEMENT_INVALID',
          '只有待补充请求可沿原ID补齐，已答复变化另提请求',
        );
      r.question = input.question;
      r.impact = input.impact;
      r.references = input.references;
      r.state = 'pending';
      r.revision++;
      return this.save(r, actor, 'supplement', input);
    });
  }
  withdraw(actor: WorkbenchActor, id: string, raw: unknown): DecisionRequest {
    const input = decisionWithdrawSchema.parse(raw);
    return this.command(actor, 'withdraw:' + id, input, () => {
      const r = this.get(actor, id);
      this.revision(r, input.expectedRevision);
      if (!this.requester(actor, r))
        throw new ProjectError('DECISION_REQUESTER_REQUIRED', '只有原提出者可撤回');
      if (r.handled || r.state !== 'pending')
        throw new ProjectError('DECISION_ALREADY_HANDLED', '已处理，不能撤回或回滚实际副作用');
      r.state = 'withdrawn';
      r.revision++;
      return this.save(r, actor, 'withdraw', input);
    });
  }
}
