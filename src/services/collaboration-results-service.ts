import type { ProjectService } from './project-service.ts';
import type { CommunicationService } from './chat-service.ts';
import type { NativeAgent } from '../host/native.ts';
import type { AssistantRecord } from '../contracts/collaboration.ts';
import type { CollaborationResult, CollaborationWait } from '../contracts/collaboration-results.ts';
import type { StoppedObservation } from '../contracts/controls.ts';
import { ProjectError } from './errors.ts';
import { setTimeout as delay } from 'node:timers/promises';
import { messageIdentity } from './message-presentation.ts';
export interface CollaborationResultsHost {
  peek(project: string, session: string): NativeAgent | undefined;
  pause(project: string, wait: CollaborationWait, agent: NativeAgent): Promise<void>;
  resume(project: string, wait: CollaborationWait, agent: NativeAgent): Promise<void>;
  inspect(
    project: string,
    assistant: AssistantRecord,
    agent: NativeAgent,
  ): Promise<StoppedObservation>;
}
export class CollaborationResultsService {
  private readonly runs = new Map<string, Promise<void>>();
  private readonly wakes = new Map<string, Promise<void>>();
  private readonly pauses = new Map<string, Promise<void>>();
  private closed = false;
  private readonly projects: ProjectService;
  private readonly communication: CommunicationService;
  private readonly host: CollaborationResultsHost;
  constructor(
    projects: ProjectService,
    communication: CommunicationService,
    host: CollaborationResultsHost,
  ) {
    this.projects = projects;
    this.communication = communication;
    this.host = host;
  }
  private source(project: string, session: string, agent: NativeAgent) {
    if (this.closed) throw new ProjectError('COLLABORATION_CLOSED', '协作回传服务正在关闭');
    const c = this.projects.forProject(project);
    if (
      this.host.peek(project, session) !== agent ||
      c.session(session).nativeSessionId !== agent.id
    )
      throw new ProjectError('COLLABORATION_CALLER_MISMATCH', '交回只能来自实际绑定原生会话');
    return c;
  }
  async wait(
    project: string,
    session: string,
    agent: NativeAgent,
    raw: unknown,
  ): Promise<CollaborationWait> {
    const c = this.source(project, session, agent),
      catalog = c.collaborationResults(),
      w = catalog.wait(session, raw);
    if (w.state !== 'waiting') return w;
    return this.settleWait(project, w, agent);
  }
  async reconcileWait(project: string, id: string): Promise<CollaborationWait> {
    if (this.closed) throw new ProjectError('COLLABORATION_CLOSED', '协作回传服务正在关闭');
    if (this.wakes.has(id) || this.pauses.has(id))
      throw new ProjectError('WAIT_RECONCILING', '原等待正在核对暂停或接续，请回读原记录');
    const c = this.projects.forProject(project),
      original = c.collaborationResults().getWait(id),
      agent = this.host.peek(project, original.sessionId);
    if (!agent || c.session(original.sessionId).nativeSessionId !== agent.id)
      throw new ProjectError('COLLABORATION_NOT_LOADED', '原主会话未加载，不另开替代执行');
    const w = c.collaborationResults().retryWait(id);
    return this.settleWait(project, w, agent);
  }
  async retryWait(project: string, session: string, agent: NativeAgent, id: string) {
    const c = this.source(project, session, agent),
      w = c.collaborationResults().getWait(id);
    if (session !== w.sessionId && c.session(session).roleType !== 'supervisor')
      throw new ProjectError('WAIT_RETRY_FORBIDDEN', '只有原主负责人或实际主管可补核等待');
    return this.reconcileWait(project, id);
  }
  private async settleWait(project: string, w: CollaborationWait, agent: NativeAgent) {
    const catalog = this.projects.forProject(project).collaborationResults();
    try {
      let pause = this.pauses.get(w.id);
      if (!pause) {
        pause = this.host.pause(project, w, agent);
        this.pauses.set(w.id, pause);
      }
      await pause;
      const c = this.projects.forProject(project);
      for (const id of w.dependencies) {
        const a = c.collaborations().get(id);
        if (
          !a.faultId ||
          (!['error', 'unknown', 'terminated'].includes(a.state) &&
            catalog.fault(a.faultId).kind !== 'control')
        )
          continue;
        const staged = await this.communication.stageCollaborationFault(project, a.faultId);
        if (staged.receipt.durableAcceptedAt === null)
          throw new ProjectError('FAULT_DELIVERY_UNKNOWN', '原协作故障尚未持久送入原主会话');
      }
    } catch (error) {
      return this.waitProblem(
        project,
        w.id,
        error instanceof Error ? error.message : '原Goal挂起未确认',
      );
    } finally {
      this.pauses.delete(w.id);
    }
    await this.wake(project, w.executionId);
    return catalog.getWait(w.id);
  }
  private async waitProblem(project: string, id: string, error: string) {
    const c = this.projects.forProject(project),
      w = c.collaborationResults().problem(id, error);
    await Promise.allSettled(
      c
        .executions()
        .get(w.executionId)
        .managerSessionIds.map(async (target) => {
          await this.communication.sendSystem(project, {
            id: messageIdentity('collaboration-wait-problem:' + id + ':' + target + ':' + error),
            target,
            content: JSON.stringify({
              waitId: id,
              executionId: w.executionId,
              error,
              dependencies: w.dependencies,
              note: '原等待暂停或接续未知。核对控制后可用mat_chat retryWaitId补核同一已加载会话与原Goal，不创建替代执行。',
            }),
          });
        }),
    );
    return w;
  }
  report(project: string, session: string, agent: NativeAgent, raw: unknown): CollaborationResult {
    const c = this.source(project, session, agent),
      v = c.collaborationResults().report(session, raw);
    this.queue(project, v.id, agent);
    return v;
  }
  reconcile(project: string, session: string): void {
    if (this.closed) return;
    const c = this.projects.forProject(project),
      a = c.collaborations().currentForSession(session),
      agent = this.host.peek(project, session);
    if (a?.lastResultId && agent) this.queue(project, a.lastResultId, agent);
  }
  fault(project: string, collaborationId: string): void {
    if (this.closed) return;
    const c = this.projects.forProject(project),
      a = c.collaborations().get(collaborationId);
    if (!a.faultId) return;
    const id = a.faultId,
      key = 'fault:' + id;
    if (this.runs.has(key)) return;
    const running = (async () => {
      const staged = await this.communication.stageCollaborationFault(project, id);
      if (this.closed || staged.receipt.durableAcceptedAt === null) return;
      await this.wake(project, a.executionId);
      if (
        c.executions().get(a.executionId).lifecycleState === 'active' &&
        c.executions().scopeForSession(a.parentSessionId)?.allowAssist
      )
        await this.communication.sendCollaborationFault(project, id);
    })();
    this.runs.set(key, running);
    void running.finally(() => this.runs.delete(key)).catch(() => {});
  }
  retry(project: string, session: string, agent: NativeAgent, id: string): CollaborationResult {
    const c = this.source(project, session, agent),
      v = c.collaborationResults().get(id);
    if (v.parentSessionId !== session && v.sessionId !== session)
      throw new ProjectError(
        'COLLABORATION_RETRY_FORBIDDEN',
        '只能补核本协作原发送方或主负责人的正式结果',
      );
    const helper = this.host.peek(project, v.sessionId);
    if (!helper) throw new ProjectError('COLLABORATION_NOT_LOADED', '原辅助未加载，不另开替代执行');
    this.queue(project, id, helper);
    return v;
  }
  private queue(project: string, id: string, agent: NativeAgent): void {
    if (this.runs.has(id) || this.closed) return;
    const running = (async () => {
      const c = this.projects.forProject(project),
        catalog = c.collaborationResults();
      let result = catalog.get(id);
      if (result.progress !== 'confirmed') {
        for (let attempt = 0; attempt < 20 && agent.status !== 'idle' && !this.closed; attempt++)
          await delay(100);
        if (this.closed) return;
        try {
          const a = c.collaborations().get(result.collaborationId);
          if (a.nativeSessionId !== agent.id)
            throw new ProjectError('COLLABORATION_NATIVE_MISMATCH', '原生辅助身份变化');
          const observation = await this.host.inspect(project, a, agent);
          if (this.closed) return;
          result = catalog.observe(id, observation);
        } catch (error) {
          result = catalog.resultProblem(
            id,
            error instanceof Error ? error.message : '原生停稳观察未知',
          );
        }
      }
      if (this.closed) return;
      try {
        const staged = await this.communication.stageCollaborationResult(project, id);
        if (staged.receipt.durableAcceptedAt === null) {
          catalog.deliveryProblem(id, staged.receipt.error ?? '正式结果尚未持久送入原主会话');
          return;
        }
        await this.wake(project, result.executionId);
        if (
          c.executions().get(result.executionId).lifecycleState === 'active' &&
          c.executions().scopeForSession(result.parentSessionId)?.allowAssist
        )
          await this.communication.sendCollaborationResult(project, id);
        catalog.deliveryProblem(id, null);
      } catch (error) {
        catalog.deliveryProblem(id, error instanceof Error ? error.message : '结果投递未确认');
      }
    })();
    this.runs.set(id, running);
    void running.finally(() => this.runs.delete(id)).catch(() => {});
  }
  async reconcileExecution(project: string, executionId: string): Promise<void> {
    if (this.closed) throw new ProjectError('COLLABORATION_CLOSED', '协作回传正在关闭');
    await this.wake(project, executionId);
  }
  private async wake(project: string, executionId: string): Promise<void> {
    const c = this.projects.forProject(project),
      catalog = c.collaborationResults();
    for (const w of catalog.waits(executionId)) {
      const pause = this.pauses.get(w.id);
      if (pause) {
        try {
          await pause;
        } catch {
          continue;
        }
      }
      if (!catalog.canWake(w.id)) continue;
      let running = this.wakes.get(w.id);
      if (!running) {
        running = (async () => {
          const agent = this.host.peek(project, w.sessionId);
          if (!agent) {
            await this.waitProblem(project, w.id, '原主会话未加载，保留等待，不另开替代');
            return;
          }
          try {
            await this.host.resume(project, w, agent);
            if (this.closed) return;
            catalog.signalled(w.id);
          } catch (error) {
            await this.waitProblem(
              project,
              w.id,
              error instanceof Error ? error.message : '原Goal接续未知',
            );
          }
        })();
        this.wakes.set(w.id, running);
        void running.finally(() => this.wakes.delete(w.id)).catch(() => {});
      }
      await running;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([
      ...this.runs.values(),
      ...this.wakes.values(),
      ...this.pauses.values(),
    ]);
  }
}
