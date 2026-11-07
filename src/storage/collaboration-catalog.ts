import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { assistantInputSchema, assistantSchema } from '../contracts/collaboration.ts';
import type { AssistantRecord } from '../contracts/collaboration.ts';
import type { ExecutionCatalog } from './execution-catalog.ts';
import type { SessionCatalog } from './session-catalog.ts';
import type { RoleCatalog } from './role-catalog.ts';
import type { WorkbenchCatalog, TicketExecutionScope } from './workbench-catalog.ts';
import { transaction } from './transaction.ts';
import { ProjectError } from '../services/errors.ts';
import { canonicalWriteScope, scopesOverlap, withinPath } from '../services/write-scopes.ts';
import { messageIdentity } from '../services/message-presentation.ts';
import { decisionRequestSchema, decisionNoticeSchema } from '../contracts/decision-requests.ts';
import { deliverySchema } from '../contracts/chat.ts';
export function migrateCollaboration(db: DatabaseSync): void {
  db.exec(`CREATE TABLE collaboration(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL UNIQUE,request_hash TEXT NOT NULL,execution_id TEXT NOT NULL REFERENCES execution(id),session_id TEXT REFERENCES session(id),state TEXT NOT NULL,data TEXT NOT NULL);
  CREATE UNIQUE INDEX collaboration_current_session ON collaboration(session_id) WHERE session_id IS NOT NULL AND state!='completed';
  PRAGMA user_version=11;`);
}
export class CollaborationCatalog {
  private controlAccess:
    | ((id: string) => { blocked: boolean; shutdownOnly: boolean; controlId: string | null })
    | undefined;
  bindControlAccess(
    resolve: (id: string) => { blocked: boolean; shutdownOnly: boolean; controlId: string | null },
  ): void {
    this.controlAccess = resolve;
  }
  private readonly db: DatabaseSync;
  private readonly sessions: SessionCatalog;
  private readonly roles: RoleCatalog;
  private readonly executions: ExecutionCatalog;
  private readonly wb: WorkbenchCatalog;
  constructor(
    db: DatabaseSync,
    sessions: SessionCatalog,
    roles: RoleCatalog,
    executions: ExecutionCatalog,
    wb: WorkbenchCatalog,
  ) {
    this.db = db;
    this.sessions = sessions;
    this.roles = roles;
    this.executions = executions;
    this.wb = wb;
  }
  get(id: string): AssistantRecord {
    const row = this.db.prepare('SELECT data FROM collaboration WHERE id=?').get(id);
    if (!row) throw new ProjectError('COLLABORATION_NOT_FOUND', '协作关联不存在');
    return assistantSchema.parse(JSON.parse(String(row.data)));
  }
  list(executionId?: string): AssistantRecord[] {
    return this.db
      .prepare('SELECT id FROM collaboration ORDER BY rowid')
      .all()
      .map((row) => this.get(String(row.id)))
      .filter((v) => !executionId || v.executionId === executionId);
  }
  currentForSession(id: string): AssistantRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT id FROM collaboration WHERE session_id=? AND state NOT IN('completed','terminated')",
      )
      .get(id);
    return row ? this.get(String(row.id)) : undefined;
  }
  unsettled(executionId: string): AssistantRecord[] {
    return this.list(executionId).filter(
      (v) =>
        !['completed', 'terminated'].includes(v.state) &&
        !(v.state === 'error' && v.sessionId === null),
    );
  }
  private save(v: AssistantRecord): AssistantRecord {
    v.updatedAt = new Date().toISOString();
    this.db
      .prepare('UPDATE collaboration SET session_id=?,state=?,data=? WHERE id=?')
      .run(v.sessionId, v.state, JSON.stringify(v), v.id);
    this.db
      .prepare('INSERT INTO ui_event(kind,object_id) VALUES(?,?)')
      .run('collaboration-changed', v.ticketId);
    return v;
  }
  requireMain(sessionId: string) {
    const session = this.sessions.get(sessionId),
      scope = this.executions.scopeForSession(sessionId);
    if (
      this.currentForSession(sessionId) ||
      !scope ||
      scope.kind !== 'main' ||
      !scope.allowWrite ||
      !scope.allowAssist ||
      !['developer', 'investigator'].includes(session.roleType) ||
      session.communicationState !== 'active' ||
      session.status !== 'bound'
    )
      throw new ProjectError(
        'PRIMARY_EXECUTOR_REQUIRED',
        '只有当前可执行的开发或调查主负责人可创建一层辅助',
      );
    return this.executions.get(scope.executionId);
  }
  assertSessionFree(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (
      session.status !== 'bound' ||
      session.communicationState !== 'active' ||
      session.error ||
      this.executions.currentForSession(sessionId) ||
      this.currentForSession(sessionId) ||
      this.db
        .prepare(
          "SELECT id FROM review WHERE json_extract(data,'$.sessionId')=? AND (json_extract(data,'$.status') NOT IN('decided','cancelled') OR COALESCE(json_extract(data,'$.closure.state'),'')!='confirmed')",
        )
        .get(sessionId)
    )
      throw new ProjectError(
        'ASSISTANT_SESSION_BUSY',
        '目标会话仍有执行责任、控制或未知状态，不能接管',
      );
  }
  register(sessionId: string, raw: unknown): { record: AssistantRecord; isNew: boolean } {
    const input = assistantInputSchema.parse(raw),
      author = this.wb.author({ kind: 'session', sessionId });
    const hash = createHash('sha256').update(JSON.stringify({ sessionId, input })).digest('hex');
    return transaction(this.db, () => {
      const prior = this.db
        .prepare('SELECT id,request_hash FROM collaboration WHERE operation_id=?')
        .get(input.operationId);
      if (prior) {
        if (prior.request_hash !== hash)
          throw new ProjectError('COLLABORATION_CONFLICT', '原操作来源或正文不同');
        return { record: this.get(String(prior.id)), isNew: false };
      }
      const main = this.requireMain(sessionId);
      const existing = input.sessionId ? this.sessions.get(input.sessionId) : undefined;
      const role = this.roles
        .list()
        .find((r) =>
          existing
            ? r.id === existing.roleId
            : r.id === input.roleId || r.aliases.includes(input.roleId!),
        );
      if (!role || !['developer', 'investigator', 'reviewer'].includes(role.type))
        throw new ProjectError(
          'ASSISTANT_ROLE_REQUIRED',
          '辅助只引用已有开发、调查或审阅角色，不调主管或提交角色',
        );
      if (existing) this.assertSessionFree(existing.id);
      const writeScopes = [...new Set(input.writeScopes.map(canonicalWriteScope))];
      if (
        writeScopes.some((scope) => !main.writeScopes.some((parent) => withinPath(parent, scope)))
      )
        throw new ProjectError('ASSISTANT_SCOPE_ESCAPE', '辅助源码写入范围不能超出主票授权');
      if (
        this.unsettled(main.id).some((other) =>
          other.writeScopes.some((old) => writeScopes.some((scope) => scopesOverlap(old, scope))),
        )
      )
        throw new ProjectError(
          'ASSISTANT_SCOPE_BUSY',
          '另一辅助仍负责重叠写域；先停稳并正式交回，或先做独立部分',
        );
      const v: AssistantRecord = {
        id: randomUUID(),
        operationId: input.operationId,
        ticketId: main.ticketId,
        executionId: main.id,
        parentSessionId: sessionId,
        author,
        roleId: role.id,
        name: input.name,
        purpose: input.purpose,
        cwd: main.cwd,
        writeScopes,
        configuration: input.configuration ?? null,
        reused: !!existing,
        requestedSessionId: existing?.id ?? null,
        sessionId: null,
        nativeSessionId: null,
        state: 'registered',
        lastResultId: null,
        faultId: null,
        checklistGrant: null,
        error: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      this.db
        .prepare(
          'INSERT INTO collaboration(id,operation_id,request_hash,execution_id,session_id,state,data) VALUES(?,?,?,?,?,?,?)',
        )
        .run(v.id, input.operationId, hash, main.id, v.sessionId, v.state, JSON.stringify(v));
      this.db
        .prepare('INSERT INTO ui_event(kind,object_id) VALUES(?,?)')
        .run('collaboration-changed', v.ticketId);
      return { record: v, isNew: true };
    });
  }
  reserved(id: string, sessionId: string): AssistantRecord {
    const v = this.get(id);
    if (v.state !== 'registered' || (v.requestedSessionId && v.requestedSessionId !== sessionId))
      throw new ProjectError('COLLABORATION_STATE', '协作准备状态已变化');
    this.requireMain(v.parentSessionId);
    if (v.reused) this.assertSessionFree(sessionId);
    if (this.sessions.get(sessionId).roleId !== v.roleId)
      throw new ProjectError('COLLABORATION_ROLE_MISMATCH', '原生准备会话与协作角色不同');
    v.sessionId = sessionId;
    v.state = 'creating';
    return this.save(v);
  }
  active(id: string): AssistantRecord {
    const v = this.get(id),
      session = v.sessionId ? this.sessions.get(v.sessionId) : undefined;
    if (v.state !== 'creating' || session?.status !== 'bound')
      throw new ProjectError('COLLABORATION_STATE', '协作尚未实际绑定');
    v.nativeSessionId = session.nativeSessionId;
    v.state = 'active';
    return this.save(v);
  }
  problem(id: string, error: string, unknown = false): AssistantRecord {
    return transaction(this.db, () => {
      const v = this.get(id);
      v.error = error;
      v.state = unknown ? 'unknown' : 'error';
      const faultId = randomUUID();
      v.faultId = faultId;
      this.db.prepare('INSERT INTO workbench_revision(kind,object_id,data) VALUES(?,?,?)').run(
        'collaboration-fault',
        faultId,
        JSON.stringify({
          value: {
            id: faultId,
            collaborationId: v.id,
            executionId: v.executionId,
            parentSessionId: v.parentSessionId,
            error,
            createdAt: new Date().toISOString(),
          },
        }),
      );
      return this.save(v);
    });
  }
  reportStarted(id: string, resultId: string): void {
    const v = this.get(id);
    if (v.state !== 'active')
      throw new ProjectError('COLLABORATION_NOT_ACTIVE', '协作不在可交回状态');
    v.state = 'reporting';
    v.faultId = null;
    v.lastResultId = resultId;
    this.save(v);
  }
  reportObserved(id: string, resultId: string, state: 'unknown' | 'waiting' | 'completed'): void {
    const v = this.get(id);
    if (v.lastResultId !== resultId)
      throw new ProjectError('STALE_COLLABORATION_RESULT', '结果不属于当前协作');
    v.state = state;
    this.save(v);
  }
  resumeForMessage<T>(parentSessionId: string, targetSessionId: string, commit: () => T): T {
    const a = this.list().findLast((v) => v.sessionId === targetSessionId);
    if (!a || a.parentSessionId !== parentSessionId || !['waiting', 'completed'].includes(a.state))
      return commit();
    return transaction(this.db, () => {
      const main = this.requireMain(parentSessionId),
        session = this.sessions.get(targetSessionId);
      if (
        main.id !== a.executionId ||
        this.executions.currentForSession(targetSessionId) ||
        (this.currentForSession(targetSessionId)?.id ?? a.id) !== a.id ||
        session.status !== 'bound' ||
        (a.state === 'completed'
          ? session.communicationState !== 'archived'
          : session.communicationState !== 'active')
      )
        throw new ProjectError(
          'COLLABORATION_RESUME_FORBIDDEN',
          '原协作已转交其他工作或受控制，普通Chat不能接管或解除暂停',
        );
      if (a.state === 'completed') this.sessions.communicationState(targetSessionId, 'active');
      a.state = 'active';
      a.error = null;
      this.save(a);
      return commit();
    });
  }
  chat<T>(
    parent: string,
    target: string,
    messageId: string,
    ids: string[] | undefined,
    commit: () => T,
  ): T {
    return transaction(this.db, () =>
      this.resumeForMessage(parent, target, () => {
        if (ids !== undefined) {
          const main = this.requireMain(parent),
            a = this.currentForSession(target);
          if (
            !a ||
            a.parentSessionId !== parent ||
            a.executionId !== main.id ||
            a.state !== 'active'
          )
            throw new ProjectError(
              'CHECKLIST_GRANT_SOURCE',
              '只有当前原主负责人可授权本次实际辅助',
            );
          const ticket = this.wb.getTicket(a.ticketId);
          for (const id of ids) {
            const item = ticket.checklist.find((item) => item.id === id);
            if (!item || item.verification === 'manual')
              throw new ProjectError('CHECKLIST_GRANT_ITEM', '授权项须属于本票且不能代填人工');
          }
          a.checklistGrant = {
            ids: [...new Set(ids)],
            messageId,
            author: this.wb.author({ kind: 'session', sessionId: parent }),
            createdAt: new Date().toISOString(),
          };
          this.save(a);
          this.db
            .prepare('INSERT INTO workbench_revision(kind,object_id,data) VALUES(?,?,?)')
            .run(
              'collaboration-checklist-grant',
              a.id,
              JSON.stringify({ value: a.checklistGrant }),
            );
        }
        return commit();
      }),
    );
  }
  scopeForSession(sessionId: string): TicketExecutionScope | undefined {
    const v = this.currentForSession(sessionId);
    if (!v || v.state !== 'active') return undefined;
    const parent = this.executions.scopeForSession(v.parentSessionId),
      control = this.controlAccess?.(v.id);
    return {
      ticketId: v.ticketId,
      executionId: v.executionId,
      kind: 'assistant',
      delegationId: v.id,
      checklistIds: v.checklistGrant?.ids ?? [],
      cwd: v.cwd,
      shutdownOnly: control?.shutdownOnly ?? false,
      allowWrite:
        ((!!parent?.allowAssist && parent.executionId === v.executionId && !control?.blocked) ||
          control?.shutdownOnly === true) &&
        this.sessions.get(sessionId).communicationState === 'active',
    };
  }
  activateAfterControl(id: string): void {
    const a = this.get(id);
    this.requireMain(a.parentSessionId);
    if (!['active', 'waiting'].includes(a.state))
      throw new ProjectError('ASSISTANT_CONTROL_ENDED', '当前协作不允许恢复');
    a.state = 'active';
    a.error = null;
    if (a.faultId) {
      const row = this.db
        .prepare(
          "SELECT data FROM workbench_revision WHERE kind='collaboration-fault' AND object_id=?",
        )
        .get(a.faultId);
      if (row && JSON.parse(String(row.data)).value.kind === 'control') a.faultId = null;
    }
    this.save(a);
  }
  resumeForDecision(requestId: string): boolean {
    return transaction(this.db, () => {
      const row = this.db.prepare('SELECT data FROM decision_request WHERE id=?').get(requestId);
      if (!row) return false;
      const r = decisionRequestSchema.parse(JSON.parse(String(row.data)));
      if (
        !r.collaborationId ||
        !r.requester.sessionId ||
        !['answered', 'rejected', 'needs-info'].includes(r.state)
      )
        return false;
      const accepted = this.db
        .prepare('SELECT data FROM decision_request_notice WHERE request_id=?')
        .all(r.id)
        .some((row) => {
          const n = decisionNoticeSchema.parse(JSON.parse(String(row.data)));
          if (
            n.kind !== 'reply' ||
            n.revision !== r.revision ||
            n.target.sessionId !== r.requester.sessionId
          )
            return false;
          const saved = this.db
            .prepare('SELECT data FROM message_delivery WHERE message_id=?')
            .get(n.id);
          if (!saved) return false;
          const receipt = deliverySchema.parse(JSON.parse(String(saved.data)));
          return (
            receipt.targetSessionId === r.requester.sessionId &&
            receipt.nativeMessageId === n.id &&
            receipt.memoryAcceptedAt !== null &&
            receipt.durableAcceptedAt !== null
          );
        });
      if (!accepted) return false;
      const a = this.get(r.collaborationId),
        s = this.sessions.get(r.requester.sessionId),
        parent = this.executions.scopeForSession(a.parentSessionId);
      if (
        a.state !== 'waiting' ||
        a.sessionId !== s.id ||
        a.executionId !== r.executionId ||
        a.parentSessionId !== r.parentSessionId ||
        s.status !== 'bound' ||
        s.communicationState !== 'active' ||
        this.currentForSession(s.id)?.id !== a.id ||
        !parent?.allowAssist ||
        this.controlAccess?.(a.id).blocked
      )
        return false;
      a.state = 'active';
      this.save(a);
      return true;
    });
  }
  controlOutcome(id: string, controlId: string, status: string): AssistantRecord {
    return transaction(this.db, () => {
      const a = this.get(id),
        row = this.db.prepare('SELECT data FROM assistant_control WHERE id=?').get(controlId);
      const source = row ? JSON.parse(String(row.data)) : null;
      if (!source || source.collaborationId !== id || source.status !== status)
        throw new ProjectError('ASSISTANT_CONTROL_SOURCE', '辅助控制结果缺少真实持久来源');
      if (a.state === 'completed') return a;
      const faultId = messageIdentity('assistant-control-outcome:' + controlId + ':' + status);
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM workbench_revision WHERE kind='collaboration-fault' AND object_id=?",
          )
          .get(faultId)
      )
        this.db.prepare('INSERT INTO workbench_revision(kind,object_id,data) VALUES(?,?,?)').run(
          'collaboration-fault',
          faultId,
          JSON.stringify({
            value: {
              id: faultId,
              collaborationId: id,
              executionId: a.executionId,
              parentSessionId: a.parentSessionId,
              kind: 'control',
              controlId,
              controlStatus: status,
              error: '辅助控制状态为' + status + '；原控制说明：' + source.reason,
              createdAt: new Date().toISOString(),
            },
          }),
        );
      a.faultId = faultId;
      if (status === 'terminated') a.state = 'terminated';
      return this.save(a);
    });
  }
}
