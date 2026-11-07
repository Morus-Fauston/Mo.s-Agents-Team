import type { ProjectConnection } from '../services/project.ts';
import type { NativeAgent, NativeMessage } from './native.ts';
import { messageIdentity } from '../services/message-presentation.ts';
interface Pending {
  message: NativeMessage;
  notices: { ticketId: string; logId: string }[];
}
/** A passive contribution to an already admitted model request. Never steers or opens an Agent. */
export class AssistantLogNotices {
  private readonly pending = new WeakMap<NativeAgent, Pending>();
  prepare(c: ProjectConnection, sessionId: string, agent: NativeAgent): NativeMessage | undefined {
    const scope = c.executions().scopeForSession(sessionId),
      session = c.session(sessionId);
    if (
      session.nativeSessionId !== agent.id ||
      session.communicationState !== 'active' ||
      scope?.kind !== 'main' ||
      !scope.allowWrite ||
      c.executions().get(scope.executionId).lifecycleState !== 'active'
    ) {
      this.pending.delete(agent);
      return;
    }
    const notices = c.workbench().pendingAssistantLogs(sessionId, scope.executionId).slice(0, 8);
    if (!notices.length) {
      this.pending.delete(agent);
      return;
    }
    const body = JSON.stringify({
      note: '辅助新增Log的合并轻提醒；无需回复，不表示已读正文，不替代Chat或正式交回。按需读取。',
      entries: notices.map((n) => ({
        ticket: n.ticketCode,
        logId: n.logId,
        title: n.title,
        source: n.author,
        read: { tool: 'mat_ticket', ticket: n.ticketCode, section: 'log', logId: n.logId },
      })),
    });
    const message: NativeMessage = {
      id: messageIdentity('assistant-log-notices:' + sessionId + ':' + body),
      role: 'user',
      source: {
        kind: 'mat-assistant-log-notices',
        targetSessionId: sessionId,
        executionId: scope.executionId,
      },
      content: [{ type: 'text', text: body }],
    };
    this.pending.set(agent, { message, notices });
    if (!agent.session.deriveMessages().some((m) => m.id === message.id)) return message;
  }
  entered(c: ProjectConnection, sessionId: string, agent: NativeAgent, requestId: string): void {
    const pending = this.pending.get(agent);
    if (!pending || c.session(sessionId).nativeSessionId !== agent.id) return;
    const expected = pending.message;
    if (
      !agent.session
        .deriveMessages()
        .some(
          (m) =>
            m.id === expected.id &&
            m.role === expected.role &&
            JSON.stringify(m.source) === JSON.stringify(expected.source) &&
            JSON.stringify(m.content) === JSON.stringify(expected.content),
        )
    )
      return;
    c.workbench().acceptAssistantLogNotices(sessionId, pending.notices, requestId);
    this.pending.delete(agent);
  }
}
