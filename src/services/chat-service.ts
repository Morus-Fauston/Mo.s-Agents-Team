import type { ProjectService } from './project-service.ts';
import type { ChatActor, ChatInput, SavedMessage } from '../contracts/chat.ts';
import type { NativeAgent, NativeMessage } from '../host/native.ts';
import type { NativeEvent } from '../host/native.ts';
import { z } from 'zod';
import { matchesMessage, presentMessage, messageIdentity } from './message-presentation.ts';
import { checkReferences } from './file-references.ts';
import { ProjectError } from './errors.ts';
import { unstartedInput } from '../host/unstarted-input.ts';
export interface MessageHost {
  peek?(projectId: string, sessionId: string): NativeAgent | undefined;
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
    if (
      input.allowedChecklistIds !== undefined &&
      (actor.kind !== 'session' || input.target === 'user')
    )
      throw new ProjectError(
        'CHECKLIST_GRANT_SOURCE',
        '指定Checklist授权必须由原主负责人向当前辅助发送',
      );
    const references = checkReferences(connection, actor, input.target, input.references ?? []);
    let existing = false;
    try {
      connection.messages().get(input.id);
      existing = true;
    } catch (error) {
      if (!(error instanceof ProjectError) || error.code !== 'MESSAGE_NOT_FOUND') throw error;
    }
    const save = () => connection.messages().save(actor, { ...input, references });
    const saved =
      !existing && actor.kind === 'session' && input.target !== 'user'
        ? connection
            .collaborations()
            .chat(
              actor.sessionId,
              connection.messages().resolveTarget(input.target).id,
              input.id,
              input.allowedChecklistIds,
              save,
            )
        : save();
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
  async sendMergeNotice(project: string, id: string, notice: string): Promise<SavedMessage> {
    if (this.closed) throw new ProjectError('COMMUNICATION_CLOSED', '通信服务正在关闭');
    const catalog = this.projects.forProject(project).messages(),
      saved = catalog.saveMergeNotice(id, notice);
    await this.enqueue(project, saved.receipt.targetSessionId!, saved.message.id);
    return catalog.get(saved.message.id);
  }
  async sendLocalCommitNotice(project: string, id: string, notice: string): Promise<SavedMessage> {
    if (this.closed) throw new ProjectError('COMMUNICATION_CLOSED', '通信服务正在关闭');
    const catalog = this.projects.forProject(project).messages(),
      saved = catalog.saveLocalCommitNotice(id, notice);
    await this.enqueue(project, saved.receipt.targetSessionId!, saved.message.id);
    return catalog.get(saved.message.id);
  }
  async sendCollaborationResult(projectId: string, id: string): Promise<SavedMessage> {
    if (this.closed) throw new ProjectError('COMMUNICATION_CLOSED', '通信服务正在关闭');
    const connection = this.projects.forProject(projectId),
      notice = connection.collaborationResults().prepareNotice(id),
      saved = connection.messages().saveCollaborationResult(id, notice.id);
    await this.enqueue(projectId, notice.targetSessionId, saved.message.id);
    return connection.messages().get(saved.message.id);
  }
  async stageCollaborationResult(projectId: string, id: string): Promise<SavedMessage> {
    if (this.closed) throw new ProjectError('COMMUNICATION_CLOSED', '通信服务正在关闭');
    const c = this.projects.forProject(projectId),
      notice = c.collaborationResults().prepareNotice(id),
      catalog = c.messages();
    catalog.saveCollaborationResult(id, notice.id);
    return this.stageSaved(projectId, notice.id);
  }
  async stageCollaborationFault(projectId: string, id: string): Promise<SavedMessage> {
    this.projects.forProject(projectId).messages().saveCollaborationFault(id);
    return this.stageSaved(projectId, id);
  }
  async sendAssistantControl(
    projectId: string,
    id: string,
    kind: 'request' | 'resume',
  ): Promise<SavedMessage> {
    const c = this.projects.forProject(projectId),
      saved = c.messages().saveAssistantControl(id, kind);
    await this.enqueue(projectId, saved.receipt.targetSessionId!, saved.message.id);
    return c.messages().get(saved.message.id);
  }
  async stageAssistantControl(
    projectId: string,
    id: string,
    kind: 'request' | 'resume',
  ): Promise<SavedMessage> {
    const saved = this.projects.forProject(projectId).messages().saveAssistantControl(id, kind);
    return this.stageSaved(projectId, saved.message.id);
  }
  async sendCollaborationFault(projectId: string, id: string): Promise<SavedMessage> {
    const catalog = this.projects.forProject(projectId).messages(),
      saved = catalog.saveCollaborationFault(id);
    await this.enqueue(projectId, saved.receipt.targetSessionId!, id);
    return catalog.get(id);
  }
  private async stageSaved(projectId: string, id: string): Promise<SavedMessage> {
    if (this.closed) throw new ProjectError('COMMUNICATION_CLOSED', '通信服务正在关闭');
    const c = this.projects.forProject(projectId),
      catalog = c.messages();
    const saved = catalog.beginDelivery(id),
      targetSessionId = saved.receipt.targetSessionId!;
    if (saved.receipt.state !== 'sending') return saved;
    try {
      const target = this.host.peek?.(projectId, targetSessionId);
      if (!target || target.id !== c.session(targetSessionId).nativeSessionId)
        throw new ProjectError(
          'COLLABORATION_TARGET_NOT_LOADED',
          '原主会话未加载或身份不符，不另开替代',
        );
      const native = presentMessage(saved),
        existing = [...target.session.deriveMessages(), ...target.inbox.nextStep].find(
          (m) => m.id === native.id,
        );
      if (existing) {
        if (!matchesMessage(existing, saved))
          throw new ProjectError('NATIVE_MESSAGE_CONFLICT', '原正式结果输入内容不一致');
      } else {
        if (saved.receipt.memoryAcceptedAt !== null)
          throw new ProjectError(
            'NATIVE_MESSAGE_UNCONFIRMED',
            '原结果曾接纳但无法定位，不盲目重投',
          );
        target.inject(native);
      }
      catalog.recordMemoryAccepted(id);
      if (!(await this.host.flush(target)))
        throw new ProjectError('DURABILITY_UNCONFIRMED', '正式结果输入尚未确认持久接纳');
      catalog.recordDurableAccepted(id);
    } catch (error) {
      catalog.recordFailure(
        id,
        error instanceof Error ? error.message : '正式结果输入持久接纳未知',
      );
    }
    return catalog.get(id);
  }
  async sendAcceptanceNotice(projectId: string, id: string): Promise<SavedMessage> {
    if (this.closed) throw new ProjectError('COMMUNICATION_CLOSED', '通信服务正在关闭');
    const catalog = this.projects.forProject(projectId).messages(),
      saved = catalog.saveAcceptanceNotice(id);
    await this.enqueue(projectId, saved.receipt.targetSessionId!, saved.message.id);
    return catalog.get(saved.message.id);
  }
  async stageDecisionNotice(projectId: string, id: string): Promise<SavedMessage> {
    const saved = this.projects.forProject(projectId).messages().saveDecisionNotice(id);
    return saved.receipt.targetSessionId === null ? saved : this.stageSaved(projectId, id);
  }
  async sendDecisionNotice(projectId: string, id: string): Promise<SavedMessage> {
    const catalog = this.projects.forProject(projectId).messages(),
      saved = catalog.saveDecisionNotice(id);
    if (saved.receipt.targetSessionId !== null)
      await this.enqueue(projectId, saved.receipt.targetSessionId, id);
    return catalog.get(id);
  }
  async sendReviewResult(
    projectId: string,
    resultId: string,
    messageId: string,
  ): Promise<SavedMessage> {
    if (this.closed) throw new ProjectError('COMMUNICATION_CLOSED', '通信服务正在关闭');
    const catalog = this.projects.forProject(projectId).messages(),
      saved = catalog.saveReviewResult(resultId, messageId);
    await this.enqueue(projectId, saved.receipt.targetSessionId!, saved.message.id);
    return catalog.get(saved.message.id);
  }
  async sendControl(
    projectId: string,
    id: string,
    kind: 'request' | 'resume',
  ): Promise<SavedMessage> {
    const catalog = this.projects.forProject(projectId).messages(),
      saved = catalog.recordControl(id, kind);
    await this.enqueue(projectId, saved.receipt.targetSessionId!, saved.message.id);
    return catalog.get(saved.message.id);
  }
  async sendControlledResult(
    projectId: string,
    sessionId: string,
    messageId: string,
  ): Promise<SavedMessage> {
    const catalog = this.projects.forProject(projectId).messages(),
      saved = catalog.recordControlledResult(messageId, sessionId);
    await this.enqueue(projectId, saved.receipt.targetSessionId!, saved.message.id);
    return catalog.get(saved.message.id);
  }
  async prepareResume(projectId: string, sessionId: string, agent: NativeAgent): Promise<void> {
    const key = `${projectId}:${sessionId}`,
      previous = this.queues.get(key) ?? Promise.resolve(),
      catalog = this.projects.forProject(projectId).messages();
    const job = previous
      .catch(() => {})
      .then(async () => {
        for (const pending of catalog.pending(sessionId)) {
          const saved = catalog.beginDelivery(pending.message.id);
          if (saved.receipt.state !== 'sending') continue;
          const message = presentMessage(saved),
            history = agent.session.deriveMessages().find((item) => item.id === message.id),
            inbox = agent.inbox.nextStep.find((item) => item.id === message.id);
          if (history || inbox) {
            if (!matchesMessage((history ?? inbox)!, saved))
              throw new ProjectError('NATIVE_MESSAGE_CONFLICT', '恢复输入身份或正文不一致，不重放');
            if (history && saved.receipt.enteredAt === null)
              throw new ProjectError(
                'NATIVE_MESSAGE_UNCONFIRMED',
                '原文已在历史但进入请求回执未核对，不重放未知输入',
              );
          } else {
            if (
              saved.receipt.memoryAcceptedAt !== null &&
              !unstartedInput(agent.session.snapshotEvents(), message)
            )
              throw new ProjectError(
                'NATIVE_MESSAGE_UNCONFIRMED',
                '原输入曾接纳却无法定位，恢复暂停核对',
              );
            agent.inject(message);
          }
          catalog.recordMemoryAccepted(message.id);
        }
        if (!(await this.host.flush(agent)))
          throw new ProjectError('DURABILITY_UNCONFIRMED', '恢复前输入的持久接纳未确认');
        for (const pending of catalog.pending(sessionId))
          if (
            pending.receipt.memoryAcceptedAt !== null &&
            agent.inbox.nextStep.some((item) => item.id === pending.message.id)
          )
            catalog.recordDurableAccepted(pending.message.id);
      });
    this.queues.set(key, job);
    try {
      await job;
    } finally {
      if (this.queues.get(key) === job) this.queues.delete(key);
    }
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
        if (catalog.holdObsoleteDecisionNotice(input.id)) continue;
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
