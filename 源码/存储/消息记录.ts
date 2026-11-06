import { randomUUID, createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  chatInputSchema,
  chatMessageSchema,
  conversationSchema,
  deliverySchema,
} from '../契约/私聊.ts';
import type {
  ChatActor,
  ChatInput,
  ChatMessage,
  ChatConversation,
  DeliveryRecord,
  SavedMessage,
} from '../契约/私聊.ts';
import type { SessionRecord } from '../契约/会话.ts';
import { ProjectError } from '../业务/错误.ts';
import { transaction } from './事务.ts';
import { SessionCatalog } from './会话记录.ts';
import { RoleCatalog } from './角色登记.ts';
export function migrateMessages(db: DatabaseSync): void {
  db.exec(`ALTER TABLE session ADD COLUMN communication_state TEXT NOT NULL DEFAULT 'active' CHECK(communication_state IN('active','paused','terminated','archived'));
 CREATE TABLE conversation(id TEXT PRIMARY KEY,party_a TEXT NOT NULL,party_b TEXT NOT NULL,opened_by_user INTEGER NOT NULL CHECK(opened_by_user IN(0,1)),UNIQUE(party_a,party_b));
 CREATE TABLE chat_message(id TEXT PRIMARY KEY,conversation_id TEXT NOT NULL REFERENCES conversation(id),ordinal INTEGER NOT NULL UNIQUE,request_hash TEXT NOT NULL,data TEXT NOT NULL);
 CREATE TABLE message_delivery(message_id TEXT PRIMARY KEY REFERENCES chat_message(id),target_session_id TEXT REFERENCES session(id),data TEXT NOT NULL);
 CREATE TABLE ui_event(seq INTEGER PRIMARY KEY AUTOINCREMENT,kind TEXT NOT NULL,object_id TEXT NOT NULL);
 PRAGMA user_version=4;`);
}
export class MessageCatalog {
  private controlledResult: ((id: string, sessionId: string) => ChatInput | undefined) | undefined;
  private controlMessage: ((id: string, kind: 'request' | 'resume') => ChatInput) | undefined;
  bindControlledMessages(
    result: (id: string, sessionId: string) => ChatInput | undefined,
    control: (id: string, kind: 'request' | 'resume') => ChatInput,
  ): void {
    this.controlledResult = result;
    this.controlMessage = control;
  }
  recordControlledResult(id: string, sessionId: string): SavedMessage {
    const input = this.controlledResult?.(id, sessionId);
    if (!input) throw new ProjectError('CONTROL_RESULT_REQUIRED', '没有此会话已保存的正式挂起回报');
    return this.recordOutput({ kind: 'session', sessionId }, input);
  }
  recordControl(id: string, kind: 'request' | 'resume'): SavedMessage {
    if (!this.controlMessage) throw new ProjectError('CONTROL_UNAVAILABLE', '控制消息尚未接入');
    return this.saveInternal({ kind: 'system' }, this.controlMessage(id, kind), false);
  }
  private allowsControlledResult(id: string, sessionId: string): boolean {
    const expected = this.controlledResult?.(id, sessionId);
    if (!expected) return false;
    const saved = this.get(id);
    return (
      saved.message.sender.sessionId === sessionId &&
      saved.message.content === expected.content &&
      saved.receipt.targetSessionId === this.resolveTarget(expected.target).id &&
      saved.message.references.length === 0
    );
  }
  private readonly db: DatabaseSync;
  private readonly sessions: SessionCatalog;
  private readonly roles: RoleCatalog;
  private readonly projectId: string;
  constructor(db: DatabaseSync, sessions: SessionCatalog, roles: RoleCatalog, projectId: string) {
    this.db = db;
    this.sessions = sessions;
    this.roles = roles;
    this.projectId = projectId;
  }
  resolveTarget(target: string): SessionRecord {
    const all = this.sessions.list();
    const exact = all.find(
      (session) =>
        session.id === target ||
        session.addresses.readable === target ||
        session.addresses.numeric === target,
    );
    if (exact) return exact;
    const [identifier, ordinal] = target.split('#');
    const role = this.roles
      .list()
      .find((role) => role.id === identifier || role.aliases.includes(identifier!));
    const candidates = role
      ? all.filter(
          (session) =>
            session.roleId === role.id &&
            (ordinal === undefined || String(session.ordinal) === ordinal),
        )
      : [];
    if (candidates.length > 1)
      throw new ProjectError('AMBIGUOUS_TARGET', '角色有多个会话，请使用系统返回的完整会话地址');
    if (candidates.length === 1) return candidates[0]!;
    throw new ProjectError('TARGET_NOT_FOUND', '当前项目没有此会话入口，不猜测目标');
  }
  private participant(actor: ChatActor | { kind: 'system' }): ChatMessage['sender'] {
    if (actor.kind === 'system')
      return { kind: 'system', sessionId: null, roleId: null, roleCode: 'MAT' };
    if (actor.kind === 'user')
      return { kind: 'user', sessionId: null, roleId: null, roleCode: null };
    const session = this.sessions.get(actor.sessionId);
    const role = this.roles.get(session.roleId);
    return { kind: 'session', sessionId: session.id, roleId: role.id, roleCode: role.code };
  }
  private conversation(row: Record<string, unknown>): ChatConversation {
    return conversationSchema.parse({
      id: row.id,
      participants: [row.party_a, row.party_b],
      openedByUser: row.opened_by_user === 1,
    });
  }
  private emit(kind: string, id: string): void {
    this.db.prepare('INSERT INTO ui_event(kind,object_id) VALUES(?,?)').run(kind, id);
  }
  get(id: string): SavedMessage {
    const row = this.db.prepare('SELECT data FROM chat_message WHERE id=?').get(id);
    const delivery = this.db
      .prepare('SELECT data FROM message_delivery WHERE message_id=?')
      .get(id);
    if (!row || !delivery) throw new ProjectError('MESSAGE_NOT_FOUND', '消息或其投递依据不存在');
    return {
      message: chatMessageSchema.parse(JSON.parse(String(row.data))),
      receipt: deliverySchema.parse(JSON.parse(String(delivery.data))),
    };
  }
  save(actor: ChatActor, raw: ChatInput): SavedMessage {
    return this.saveInternal(actor, raw, false);
  }
  saveSystem(raw: ChatInput): SavedMessage {
    const input = chatInputSchema.parse(raw);
    if (
      input.target === 'user' ||
      input.replyTo ||
      input.references.length ||
      this.resolveTarget(input.target).roleType !== 'supervisor'
    )
      throw new ProjectError(
        'INVALID_SYSTEM_NOTIFICATION',
        '平台通知只投递明确主管入口，不冒充用户或携带引用授权',
      );
    return this.saveInternal({ kind: 'system' }, input, false);
  }
  recordOutput(actor: Extract<ChatActor, { kind: 'session' }>, raw: ChatInput): SavedMessage {
    return this.saveInternal(actor, raw, true);
  }
  private saveInternal(
    actor: ChatActor | { kind: 'system' },
    raw: ChatInput,
    output: boolean,
  ): SavedMessage {
    const input = chatInputSchema.parse(raw);
    return transaction(this.db, () => {
      const sender = this.participant(actor);
      const target =
        input.target === 'user'
          ? { kind: 'user' as const }
          : { kind: 'session' as const, sessionId: this.resolveTarget(input.target).id };
      const recipient = this.participant(target);
      const senderKey = sender.kind === 'system' ? 'mat-platform' : (sender.sessionId ?? 'user'),
        recipientKey = recipient.sessionId ?? 'user';
      if (senderKey === recipientKey)
        throw new ProjectError('INVALID_TARGET', '私聊需要另一个明确联系入口');
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            sender: senderKey,
            recipient: recipientKey,
            content: input.content,
            replyTo: input.replyTo ?? null,
            references: input.references,
          }),
        )
        .digest('hex');
      const existing = this.db
        .prepare('SELECT request_hash FROM chat_message WHERE id=?')
        .get(input.id);
      if (existing) {
        if (existing.request_hash !== fingerprint)
          throw new ProjectError('MESSAGE_ID_CONFLICT', '相同消息身份不能更改来源、目标或正文');
        return this.get(input.id);
      }
      if (
        !output &&
        actor.kind === 'session' &&
        this.sessions.get(actor.sessionId).status !== 'bound'
      )
        throw new ProjectError('SENDER_UNAVAILABLE', '发送会话尚未绑定或已经结束');
      if (
        !output &&
        recipient.sessionId !== null &&
        this.sessions.get(recipient.sessionId).status !== 'bound'
      )
        throw new ProjectError(
          'TARGET_UNAVAILABLE',
          '目标会话尚未绑定或已经结束，历史消息不复活旧入口',
        );
      if (
        actor.kind === 'session' &&
        !output &&
        this.sessions.get(actor.sessionId).communicationState !== 'active'
      )
        throw new ProjectError(
          'SENDER_CONTROLLED',
          '发送会话受暂停、终止或封存限制，普通Chat不解除控制',
        );
      const targetState =
        recipient.sessionId === null
          ? null
          : this.sessions.get(recipient.sessionId).communicationState;
      if (!output && (targetState === 'terminated' || targetState === 'archived'))
        throw new ProjectError('TARGET_CONTROLLED', '目标已终止或封存，历史回复不能恢复入口');
      const [a, b] = [senderKey, recipientKey].sort();
      let row = this.db
        .prepare('SELECT * FROM conversation WHERE party_a=? AND party_b=?')
        .get(a!, b!);
      if (
        recipient.kind === 'user' &&
        actor.kind === 'session' &&
        this.sessions.get(actor.sessionId).roleType !== 'supervisor' &&
        (!row || row.opened_by_user !== 1)
      )
        throw new ProjectError('USER_CHAT_NOT_OPEN', '普通成员只能回复用户已开启的私聊');
      if (!row) {
        const id = randomUUID();
        this.db
          .prepare('INSERT INTO conversation VALUES(?,?,?,?)')
          .run(id, a!, b!, actor.kind === 'user' ? 1 : 0);
        row = this.db.prepare('SELECT * FROM conversation WHERE id=?').get(id)!;
      } else if (actor.kind === 'user' && row.opened_by_user !== 1) {
        this.db.prepare('UPDATE conversation SET opened_by_user=1 WHERE id=?').run(String(row.id));
        row = { ...row, opened_by_user: 1 };
      }
      const conversationId = String(row.id);
      if (input.replyTo && this.get(input.replyTo).message.conversationId !== conversationId)
        throw new ProjectError(
          'CROSS_CONVERSATION_REPLY',
          '回复必须属于当前私聊，不能向其他聊天插话',
        );
      const ordinal = Number(
        this.db.prepare('SELECT COALESCE(MAX(ordinal),0)+1 AS next FROM chat_message').get()?.next,
      );
      const message: ChatMessage = {
        id: input.id,
        projectId: this.projectId,
        conversationId,
        ordinal,
        sender,
        recipient,
        content: input.content,
        replyTo: input.replyTo ?? null,
        references: input.references,
        savedAt: new Date().toISOString(),
      };
      const receipt: DeliveryRecord = {
        messageId: message.id,
        targetSessionId: recipient.sessionId,
        transport: recipient.kind === 'user' ? 'ui-only' : 'mat-steer',
        nativeMessageId: recipient.kind === 'user' ? null : message.id,
        state:
          recipient.kind === 'user'
            ? 'none'
            : targetState !== 'active' || this.sessions.get(recipient.sessionId!).status !== 'bound'
              ? 'held'
              : 'pending',
        memoryAcceptedAt: null,
        durableAcceptedAt: null,
        enteredAt: null,
        nativeAttemptId: null,
        modelRequestId: null,
        handledRecord: null,
        error: targetState === 'paused' ? '目标暂停：消息已保存，未唤醒' : null,
      };
      this.db
        .prepare('INSERT INTO chat_message VALUES(?,?,?,?,?)')
        .run(message.id, conversationId, ordinal, fingerprint, JSON.stringify(message));
      this.db
        .prepare('INSERT INTO message_delivery VALUES(?,?,?)')
        .run(message.id, recipient.sessionId, JSON.stringify(receipt));
      this.emit('message-saved', message.id);
      return { message, receipt };
    });
  }
  conversations(actor: ChatActor): ChatConversation[] {
    return this.db
      .prepare('SELECT * FROM conversation ORDER BY rowid')
      .all()
      .map((row) => this.conversation(row))
      .filter(
        (conversation) =>
          actor.kind === 'user' || conversation.participants.includes(actor.sessionId),
      );
  }
  contacts(actor: ChatActor, identifier?: string) {
    const roles = this.roles.list();
    const selected =
      identifier === undefined
        ? undefined
        : roles.find((role) => role.id === identifier || role.aliases.includes(identifier));
    const entries = this.sessions
      .list()
      .filter(
        (session) =>
          session.status === 'bound' &&
          !['terminated', 'archived'].includes(session.communicationState) &&
          (actor.kind === 'user' || session.id !== actor.sessionId) &&
          (identifier === undefined || session.roleId === selected?.id),
      )
      .map((session) => ({
        target: session.addresses.readable,
        alternateTarget: session.addresses.numeric,
        sessionId: session.id,
        roleId: session.roleId,
        roleCode: roles.find((role) => role.id === session.roleId)!.code,
        name: session.name,
        purpose: session.purpose,
        type: session.roleType,
        communicationState: session.communicationState,
        configuration: session.configuration,
        configurationBasis: 'session-snapshot',
        responsibility: '未由聊天推定派工责任',
      }));
    const userAllowed =
      actor.kind === 'session' &&
      (this.sessions.get(actor.sessionId).roleType === 'supervisor' ||
        this.conversations(actor).some(
          (conversation) => conversation.participants.includes('user') && conversation.openedByUser,
        ));
    return { entries, userTarget: userAllowed ? 'user' : null, groups: [] };
  }
  history(
    actor: ChatActor,
    conversationId: string,
  ): { conversation: ChatConversation; messages: SavedMessage[] } {
    const row = this.db.prepare('SELECT * FROM conversation WHERE id=?').get(conversationId);
    if (!row) throw new ProjectError('CONVERSATION_NOT_FOUND', '私聊不存在');
    const conversation = this.conversation(row);
    if (actor.kind === 'session' && !conversation.participants.includes(actor.sessionId))
      throw new ProjectError('CONVERSATION_FORBIDDEN', '当前会话不属于此私聊');
    const messages = this.db
      .prepare('SELECT id FROM chat_message WHERE conversation_id=? ORDER BY ordinal')
      .all(conversationId)
      .map((row) => this.get(String(row.id)));
    return { conversation, messages };
  }
  events(after: number): { seq: number; kind: string; objectId: string }[] {
    return this.db
      .prepare('SELECT * FROM ui_event WHERE seq>? ORDER BY seq LIMIT 200')
      .all(after)
      .map((row) => ({
        seq: Number(row.seq),
        kind: String(row.kind),
        objectId: String(row.object_id),
      }));
  }
  private changeReceipt(id: string, change: (receipt: DeliveryRecord) => void): SavedMessage {
    return transaction(this.db, () => {
      const saved = this.get(id);
      const before = JSON.stringify(saved.receipt);
      change(saved.receipt);
      if (JSON.stringify(saved.receipt) !== before) {
        this.db
          .prepare('UPDATE message_delivery SET data=? WHERE message_id=?')
          .run(JSON.stringify(saved.receipt), id);
        this.emit('delivery-changed', id);
      }
      return saved;
    });
  }
  beginDelivery(id: string): SavedMessage {
    return this.changeReceipt(id, (receipt) => {
      if (receipt.targetSessionId === null || receipt.enteredAt !== null) return;
      const target = this.sessions.get(receipt.targetSessionId);
      if (target.error !== null) {
        receipt.state = 'held';
        receipt.error = '目标运行异常，消息保留待有权核对或恢复：' + target.error;
        return;
      }
      const sender = this.get(id).message.sender;
      if (sender.sessionId !== null) {
        const source = this.sessions.get(sender.sessionId);
        if (
          (source.status !== 'bound' || source.communicationState !== 'active') &&
          !this.allowsControlledResult(id, source.id)
        ) {
          receipt.state = 'held';
          receipt.error = '来源已受控制或结束：保留旧消息，不自动推进';
          return;
        }
      }
      if (target.status !== 'bound' || target.communicationState !== 'active') {
        receipt.state = 'held';
        receipt.error = '目标暂停、结束或受控制限制：仅保留消息，不唤醒';
        return;
      }
      receipt.state = 'sending';
      receipt.error = null;
    });
  }
  recordMemoryAccepted(id: string): SavedMessage {
    return this.changeReceipt(id, (receipt) => {
      receipt.memoryAcceptedAt ??= new Date().toISOString();
      receipt.state = 'accepted';
      receipt.error = null;
    });
  }
  recordDurableAccepted(id: string): SavedMessage {
    return this.changeReceipt(id, (receipt) => {
      receipt.memoryAcceptedAt ??= new Date().toISOString();
      receipt.durableAcceptedAt ??= new Date().toISOString();
      receipt.state = 'accepted';
      receipt.error = null;
    });
  }
  recordNativeInput(id: string, nativeMessageId: string): SavedMessage {
    return this.changeReceipt(id, (receipt) => {
      receipt.transport = 'native-user';
      receipt.nativeMessageId = nativeMessageId;
      receipt.memoryAcceptedAt ??= new Date().toISOString();
      receipt.state = 'accepted';
    });
  }
  recordEntered(id: string, nativeAttemptId: string, modelRequestId?: string): SavedMessage {
    return this.changeReceipt(id, (receipt) => {
      receipt.memoryAcceptedAt ??= new Date().toISOString();
      receipt.enteredAt ??= new Date().toISOString();
      receipt.nativeAttemptId ??= nativeAttemptId;
      receipt.modelRequestId ??= modelRequestId ?? null;
      if (receipt.error === null || receipt.durableAcceptedAt !== null) receipt.state = 'accepted';
    });
  }
  recordFailure(id: string, error: string): SavedMessage {
    return this.changeReceipt(id, (receipt) => {
      receipt.state = receipt.memoryAcceptedAt === null ? 'failed' : 'unknown';
      receipt.error = error;
    });
  }
  forTarget(targetSessionId: string): SavedMessage[] {
    return this.db
      .prepare('SELECT message_id FROM message_delivery WHERE target_session_id=? ORDER BY rowid')
      .all(targetSessionId)
      .map((row) => this.get(String(row.message_id)));
  }
  notifySession(id: string): void {
    this.sessions.get(id);
    this.emit('session-changed', id);
  }
  latestEventSeq(): number {
    return Number(this.db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM ui_event').get()?.seq);
  }
  pending(targetSessionId: string): SavedMessage[] {
    return this.db
      .prepare('SELECT message_id FROM message_delivery WHERE target_session_id=? ORDER BY rowid')
      .all(targetSessionId)
      .map((row) => this.get(String(row.message_id)))
      .filter(
        (saved) =>
          saved.receipt.transport === 'mat-steer' &&
          saved.receipt.enteredAt === null &&
          saved.receipt.state !== 'none',
      );
  }
}
