import type { ProjectService } from './项目服务.ts';
import type { ChatActor, ChatInput, SavedMessage } from '../契约/私聊.ts';
import type { NativeAgent, NativeMessage } from '../宿主/原生接口.ts';
import type { NativeEvent } from '../宿主/原生接口.ts';
import { z } from 'zod';
import { matchesMessage, presentMessage, messageIdentity } from './消息呈递.ts';
import { checkReferences } from './引用文件.ts';
import { ProjectError } from './错误.ts';
export interface MessageHost {
  open(projectId: string, sessionId: string): Promise<NativeAgent>;
  flush(agent: NativeAgent): Promise<boolean>;
}
export class CommunicationService {
  private readonly projects: ProjectService;
  private readonly host: MessageHost;
  private readonly queues = new Map<string, Promise<void>>();
  private closed = false;
  private readonly routes = new Map<string, { turn: number; messageId: string }>();
  constructor(projects: ProjectService, host: MessageHost) {
    this.projects = projects;
    this.host = host;
  }
  async send(projectId: string, actor: ChatActor, input: ChatInput): Promise<SavedMessage> {
    if (this.closed) throw new ProjectError('COMMUNICATION_CLOSED', '通信服务正在关闭');
    const connection = this.projects.forProject(projectId);
    const references = checkReferences(connection, actor, input.target, input.references ?? []);
    const saved = connection.messages().save(actor, { ...input, references });
    if (saved.receipt.targetSessionId !== null)
      await this.enqueue(projectId, saved.receipt.targetSessionId, saved.message.id);
    return connection.messages().get(saved.message.id);
  }
  async retry(projectId: string, actor: ChatActor, id: string): Promise<SavedMessage> {
    if (this.closed) throw new ProjectError('COMMUNICATION_CLOSED', '通信服务正在关闭');
    const catalog = this.projects.forProject(projectId).messages();
    const saved = catalog.get(id);
    if (
      (actor.kind === 'user' && saved.message.sender.kind !== 'user') ||
      (actor.kind === 'session' && saved.message.sender.sessionId !== actor.sessionId)
    )
      throw new ProjectError('MESSAGE_RETRY_FORBIDDEN', '只能重试自己原来的消息，不能改绑发送来源');
    if (saved.receipt.targetSessionId !== null)
      await this.enqueue(projectId, saved.receipt.targetSessionId, id);
    return catalog.get(id);
  }
  async sendSystem(projectId: string, input: ChatInput): Promise<SavedMessage> {
    if (this.closed) throw new ProjectError('COMMUNICATION_CLOSED', '通信服务正在关闭');
    const catalog = this.projects.forProject(projectId).messages(),
      saved = catalog.saveSystem(input);
    await this.enqueue(projectId, saved.receipt.targetSessionId!, saved.message.id);
    return catalog.get(saved.message.id);
  }
  private enqueue(projectId: string, sessionId: string, reconcileId?: string): Promise<void> {
    const key = `${projectId}:${sessionId}`;
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        await this.deliver(projectId, sessionId, reconcileId);
        if (reconcileId) await this.reconcileEntered(projectId, sessionId, reconcileId);
      });
    this.queues.set(key, current);
    void current
      .finally(() => {
        if (this.queues.get(key) === current) this.queues.delete(key);
      })
      .catch(() => {});
    return current;
  }
  private async reconcileEntered(projectId: string, sessionId: string, id: string): Promise<void> {
    const connection = this.projects.forProject(projectId),
      catalog = connection.messages();
    const saved = catalog.get(id);
    if (saved.receipt.enteredAt === null || saved.receipt.durableAcceptedAt !== null) return;
    const target = connection.sessions().find((session) => session.id === sessionId)!;
    if (target.status !== 'bound' || target.communicationState !== 'active' || target.error) return;
    try {
      const agent = await this.host.open(projectId, sessionId);
      const nativeId = saved.receipt.nativeMessageId ?? id;
      const existing = [...agent.session.deriveMessages(), ...agent.inbox.nextStep].find(
        (message) => message.id === nativeId,
      );
      if (
        !existing ||
        (saved.receipt.transport === 'mat-steer' && !matchesMessage(existing, saved))
      )
        throw new ProjectError(
          'NATIVE_MESSAGE_UNCONFIRMED',
          '原消息的请求事实已记录，但宿主当前历史无法对账；不重新投递或唤醒',
        );
      if (!(await this.host.flush(agent)))
        throw new ProjectError('DURABILITY_UNCONFIRMED', '宿主持久接纳仍未确认');
      catalog.recordDurableAccepted(id);
    } catch (error) {
      catalog.recordFailure(id, error instanceof Error ? error.message : '旧消息持久回执待核对');
    }
  }
  private async deliver(projectId: string, sessionId: string, messageId?: string): Promise<void> {
    const catalog = this.projects.forProject(projectId).messages();
    for (const pending of catalog.pending(sessionId)) {
      if (messageId && pending.message.id !== messageId) continue;
      const saved = catalog.beginDelivery(pending.message.id);
      if (saved.receipt.state !== 'sending') continue;
      try {
        const agent = await this.host.open(projectId, sessionId);
        const message = presentMessage(saved);
        const inHistory = agent.session
          .deriveMessages()
          .find((existing) => existing.id === message.id);
        const inInbox = agent.inbox.nextStep.find((existing) => existing.id === message.id);
        if (inHistory || inInbox) {
          if (!matchesMessage((inHistory ?? inInbox)!, saved))
            throw new ProjectError(
              'NATIVE_MESSAGE_CONFLICT',
              '原生消息身份存在但来源或正文不同，停止补投并保留核对',
            );
        } else {
          if (saved.receipt.memoryAcceptedAt !== null)
            throw new ProjectError(
              'NATIVE_MESSAGE_UNCONFIRMED',
              '曾经接纳的原消息在宿主中无法对账；结果未知，不盲目重投',
            );
          agent.steer(message);
        }
        catalog.recordMemoryAccepted(message.id);
        if (!(await this.host.flush(agent)))
          throw new ProjectError(
            'DURABILITY_UNCONFIRMED',
            '宿主未确认任何持久化监听者，不能把内存接纳作为持久接纳',
          );
        catalog.recordDurableAccepted(message.id);
        if (inHistory && catalog.get(message.id).receipt.enteredAt === null)
          catalog.recordFailure(
            message.id,
            '原生历史已含原消息，进入请求或办理的旧回执尚需核对；未重复投递原文',
          );
        else if (inInbox && agent.status === 'idle') {
          const recoveryId = messageIdentity('recovery:' + agent.id + ':' + message.id);
          if (
            !agent.session.deriveMessages().some((existing) => existing.id === recoveryId) &&
            !agent.inbox.nextStep.some((existing) => existing.id === recoveryId)
          )
            agent.steer({
              id: recoveryId,
              role: 'user',
              source: { kind: 'mat-recovery', messageId: message.id },
              content: [
                {
                  type: 'text',
                  text: `恢复说明：原消息 ${message.id} 已保存并在收件箱中。请沿原来源核对未办理事项；不要重复已办或结果未知的副作用。此说明不增加工作授权。`,
                },
              ],
            });
        }
      } catch (error) {
        catalog.recordFailure(
          saved.message.id,
          error instanceof Error ? error.message : '投递失败，保留原身份核对',
        );
      }
    }
  }
  noteEntered(
    projectId: string,
    sessionId: string,
    agent: NativeAgent,
    attemptId: string,
    requestId: string,
  ): void {
    const catalog = this.projects.forProject(projectId).messages();
    for (const message of agent.session.deriveMessages())
      if (message.source.kind === 'mat-message') {
        const saved = catalog.get(message.id);
        if (saved.receipt.targetSessionId !== sessionId || !matchesMessage(message, saved))
          throw new ProjectError(
            'MESSAGE_SOURCE_MISMATCH',
            '原生实际请求中的消息不属于当前绑定入口',
          );
        if (saved.receipt.enteredAt === null)
          catalog.recordEntered(message.id, attemptId, requestId);
      } else if (message.source.kind === 'user') {
        const saved = catalog
          .forTarget(sessionId)
          .find(
            (saved) =>
              saved.receipt.transport === 'native-user' &&
              saved.receipt.nativeMessageId === message.id,
          );
        if (saved && saved.receipt.enteredAt === null)
          catalog.recordEntered(saved.message.id, attemptId, requestId);
      }
  }
  async admit(
    projectId: string,
    sessionId: string,
    agent: NativeAgent,
    turn: number,
    incoming: NativeMessage[],
  ): Promise<{ messages: NativeMessage[]; grants: NativeMessage[] }> {
    const connection = this.projects.forProject(projectId),
      catalog = connection.messages();
    const messages: NativeMessage[] = [],
      grants: NativeMessage[] = [];
    let origin: string | undefined;
    for (const input of incoming) {
      if (input.role !== 'user') {
        messages.push(input);
        continue;
      }
      if (input.source.kind === 'mat-message') {
        const saved = catalog.get(input.id);
        if (saved.receipt.targetSessionId !== sessionId || !matchesMessage(input, saved))
          throw new ProjectError('MESSAGE_SOURCE_MISMATCH', '输入消息与当前真实收件入口不一致');
        origin ??= saved.message.id;
        messages.push(input);
        if (saved.message.sender.kind === 'user')
          grants.push({
            ...input,
            source: { ...input.source, kind: 'user' },
            content: [{ type: 'text', text: saved.message.content }],
          });
      } else if (input.source.kind === 'user') {
        const content =
          input.content
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '')
            .join('\n') || '[原生非文本输入，详见DSH原会话]';
        const id = z.uuid().safeParse(input.id).success
          ? input.id
          : messageIdentity('native-user:' + agent.id + ':' + input.id);
        const saved = catalog.save({ kind: 'user' }, { id, target: sessionId, content });
        catalog.recordNativeInput(id, input.id);
        origin ??= id;
        const framed = { ...input, content: presentMessage(saved).content };
        messages.push(framed);
        grants.push(input);
        try {
          if (!(await this.host.flush(agent))) throw new Error('宿主未确认持久化监听者');
          catalog.recordDurableAccepted(id);
        } catch (error) {
          catalog.recordFailure(
            id,
            error instanceof Error ? error.message : '原生输入持久接纳未知',
          );
        }
      } else messages.push(input);
    }
    const previous = this.routes.get(agent.id);
    if (previous?.turn !== turn) {
      if (origin) this.routes.set(agent.id, { turn, messageId: origin });
      else if (previous) this.routes.set(agent.id, { ...previous, turn });
    }
    return { messages, grants };
  }
  observeOutput(
    projectId: string,
    sessionId: string,
    agent: NativeAgent,
    event: NativeEvent,
  ): void {
    if (
      this.closed ||
      event.type !== 'assistant/message' ||
      event.surfaceOp !== 'append' ||
      event.data.interrupted === true
    )
      return;
    const route = this.routes.get(agent.id);
    if (!route || route.turn !== event.data.turn) return;
    const message = event.data.message as NativeMessage;
    if (message.role !== 'assistant' || message.content.some((block) => block.type === 'tool-call'))
      return;
    const content = message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text ?? '')
      .join('\n');
    if (!content.trim()) return;
    const catalog = this.projects.forProject(projectId).messages();
    const origin = catalog.get(route.messageId).message;
    const saved = catalog.recordOutput(
      { kind: 'session', sessionId },
      {
        id: messageIdentity('native-output:' + agent.id + ':' + message.id),
        target: origin.sender.sessionId ?? 'user',
        content,
        ...(origin.sender.kind === 'system' ? {} : { replyTo: origin.id }),
      },
    );
    if (saved.receipt.targetSessionId !== null)
      void this.enqueue(projectId, saved.receipt.targetSessionId, saved.message.id).catch(
        (error) => {
          catalog.recordFailure(
            saved.message.id,
            error instanceof Error ? error.message : '回传投递未知',
          );
        },
      );
  }
  isUserInput(projectId: string, sessionId: string, message: NativeMessage): boolean {
    if (message.role !== 'user' || message.source.kind !== 'mat-message') return false;
    const saved = this.projects.forProject(projectId).messages().get(message.id);
    return (
      saved.message.sender.kind === 'user' &&
      saved.receipt.targetSessionId === sessionId &&
      matchesMessage(message, saved)
    );
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.queues.values()]);
  }
}
