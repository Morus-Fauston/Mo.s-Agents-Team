import type { ProjectService } from './project-service.ts';
import type { NativeAgent, NativeEvent } from '../host/native.ts';
import type { ModelChange } from '../contracts/model-policy.ts';
import type { ExecutionConfiguration } from '../contracts/project.ts';
import { ProjectError } from './errors.ts';
import { messageIdentity } from './message-presentation.ts';
const same = (a: ExecutionConfiguration | undefined, b: ExecutionConfiguration) =>
  !!a &&
  a.provider === b.provider &&
  a.model === b.model &&
  a.reasoningEffort === b.reasoningEffort;
export const modelAvailabilityFailureCodes = new Set([
  'NO_ADAPTER',
  'AUTH',
  'RATE_LIMIT',
  'QUOTA',
  'ACCOUNT_QUOTA',
  'INVALID_CREDENTIAL',
  'MODEL_NOT_FOUND',
  'MODEL_UNAVAILABLE',
  'UNAVAILABLE',
  'NETWORK',
  'TIMEOUT',
  'HTTP',
  'SERVER',
  'UNSUPPORTED_REASONING_EFFORT',
]);
export function modelFaultMatches(events: NativeEvent[], storedError: string): boolean {
  const reason = events.findLast((e) => e.type === 'turn/end')?.data.reason as
    { kind?: string; error?: { code?: unknown; message?: unknown } } | undefined;
  return (
    reason?.kind === 'error' &&
    typeof reason.error?.code === 'string' &&
    modelAvailabilityFailureCodes.has(reason.error.code) &&
    reason.error.message === storedError
  );
}
export interface ModelConfigurationHost {
  peek(project: string, session: string): NativeAgent | undefined;
  flush(agent: NativeAgent): Promise<boolean>;
  canContinue(project: string, session: string, agent: NativeAgent): boolean;
  canSwitch(agent: NativeAgent): boolean;
  classify(error: unknown): string | null;
  recoverableFault?(agent: NativeAgent, error: string): boolean;
  fault(
    project: string,
    session: string,
    agent: NativeAgent,
    input: { error: unknown; turn?: number; step?: number },
  ): void;
}
export class ModelConfigurationService {
  private readonly runs = new Map<string, Promise<void>>();
  private closed = false;
  private readonly projects: ProjectService;
  private readonly host: ModelConfigurationHost;
  constructor(projects: ProjectService, host: ModelConfigurationHost) {
    this.projects = projects;
    this.host = host;
  }
  private source(project: string, session: string, agent: NativeAgent) {
    if (this.closed) throw new ProjectError('MODEL_CONFIGURATION_CLOSED', '模型配置服务正在关闭');
    const c = this.projects.forProject(project);
    if (
      c.session(session).nativeSessionId !== agent.id ||
      this.host.peek(project, session) !== agent
    )
      throw new ProjectError('MODEL_SESSION_MISMATCH', '配置切换只能面向实际绑定原会话');
    return c;
  }
  admission(project: string, session: string) {
    return !this.projects.forProject(project).modelPolicies().state(session).pendingChangeId;
  }
  recovering(project: string, session: string) {
    const s = this.projects.forProject(project).modelPolicies().state(session);
    return s.fallbackState === 'attempting';
  }
  recoveryForTurn(
    project: string,
    session: string,
    turn: unknown,
    code: unknown,
  ): string | undefined {
    if (!Number.isSafeInteger(turn) || typeof code !== 'string') return undefined;
    return this.projects
      .forProject(project)
      .modelPolicies()
      .history(session)
      .find(
        (change) =>
          change.source === 'fallback' &&
          change.failureId?.split(':')[0] === String(turn) &&
          change.failureCode === code &&
          ['reserved', 'confirmed', 'unknown'].includes(change.status),
      )?.id;
  }
  modelError(
    project: string,
    session: string,
    agent: NativeAgent,
    input: { error: unknown; turn?: number; step?: number },
  ): boolean {
    if (this.closed) return false;
    const c = this.source(project, session, agent),
      catalog = c.modelPolicies();
    if (
      !Number.isSafeInteger(input.turn) ||
      input.turn! < 1 ||
      !Number.isSafeInteger(input.step) ||
      input.step! < 0
    )
      return false;
    const failureId = String(input.turn) + ':' + String(input.step);
    // A delayed repeat still belongs to the original failed step, even after selection settles.
    if (
      catalog
        .history(session)
        .some((change) => change.source === 'fallback' && change.failureId === failureId)
    )
      return true;
    const code = this.host.classify(input.error);
    if (catalog.state(session).fallbackState === 'selected') {
      catalog.fallbackFailed(
        session,
        '指定备用后的原生执行失败（' +
          (code ?? 'HOST_FAILURE') +
          '）；未尝试其他模型。选择持久确认与实际请求结果分别保留。',
      );
      return false;
    }
    if (!code) return false;
    if (!this.host.canContinue(project, session, agent)) return false;
    const change = catalog.reserveFallback(session, {
      failureId,
      code,
      message:
        '原配置模型失败（' + code + '）；按本会话捕获策略仅尝试指定备用。原始诊断见DSH会话。',
    });
    if (!change || change.status !== 'reserved') return false;
    if (this.runs.has(change.id)) return true;
    c.recordSessionError(session, change.reason);
    const run = (async () => {
      try {
        await agent.whenIdle();
        this.source(project, session, agent);
        if (!this.host.canContinue(project, session, agent))
          throw new ProjectError(
            'MODEL_CONTROL_CHANGED',
            '原工作已受控制，未因备用选择解除控制或唤醒',
          );
        const applied = await this.apply(project, change.id, agent);
        if (applied.status === 'confirmed' && this.host.canContinue(project, session, agent)) {
          c.recordSessionError(session, null);
          agent.steer({
            id: messageIdentity('model-fallback:' + change.id),
            role: 'user',
            source: { kind: 'mat-model-change', changeId: change.id },
            content: [
              {
                type: 'text',
                text:
                  'MAT已按此会话预先启用的单一备用策略切换原生配置。原模型失败不等于任何工具已重做；沿本票原上下文及原Goal核对已完成事实后继续，不重放已完成工具，不扩大范围。切换记录 ' +
                  change.id +
                  '；实际请求与usage另行记录。',
              },
            ],
          });
        }
      } catch (error) {
        catalog.problem(change.id, error instanceof Error ? error.message : '备用选择结果未知');
        c.recordSessionError(session, '单一备用切换未完成，保留原诊断及未知结果；未遍历其他模型');
        if (this.host.canContinue(project, session, agent))
          this.host.fault(project, session, agent, input);
      }
    })();
    this.runs.set(change.id, run);
    void run.finally(() => {
      if (this.runs.get(change.id) === run) this.runs.delete(change.id);
    });
    return true;
  }
  async explicit(project: string, session: string, raw: unknown) {
    const c = this.projects.forProject(project),
      agent = this.host.peek(project, session);
    if (!agent)
      throw new ProjectError('MODEL_SESSION_NOT_LOADED', '原会话未加载，未创建替代或猜测切换成功');
    this.source(project, session, agent);
    const current = c.session(session);
    if (
      current.status !== 'bound' ||
      ['terminated', 'archived'].includes(current.communicationState) ||
      !this.host.canSwitch(agent)
    )
      throw new ProjectError(
        'MODEL_SWITCH_UNSAFE',
        '原会话仍忙碌、Goal已武装或入口已关闭；请先明确暂停并核对安全边界',
      );
    const faultSeq = agent.session.snapshotEvents().findLast((e) => e.type === 'turn/end')?.seq;
    const modelFault =
      current.error && faultSeq !== undefined && this.host.recoverableFault?.(agent, current.error)
        ? { nativeSessionId: agent.id, turnEndSeq: faultSeq, error: current.error }
        : null;
    const change = c.modelPolicies().reserveExplicit(session, raw, modelFault);
    const applied = await this.apply(project, change.id, agent);
    this.clearUserModelFault(project, applied, agent);
    return applied;
  }
  async retry(project: string, session: string, id: string) {
    const c = this.projects.forProject(project),
      agent = this.host.peek(project, session),
      change = c.modelPolicies().get(id);
    if (change.sessionId !== session)
      throw new ProjectError('MODEL_CHANGE_SCOPE', '原配置切换不属于此会话');
    if (!agent || !this.host.canSwitch(agent))
      throw new ProjectError(
        'MODEL_SWITCH_UNSAFE',
        '原会话未加载、尚未空闲或Goal已武装，未猜测补核结果',
      );
    this.source(project, session, agent);
    const applied = await this.apply(project, id, agent);
    this.clearUserModelFault(project, applied, agent);
    return applied;
  }
  private clearUserModelFault(project: string, change: ModelChange, agent: NativeAgent) {
    const fault = change.modelFault;
    if (
      change.source !== 'user' ||
      change.status !== 'confirmed' ||
      !fault ||
      fault.nativeSessionId !== agent.id
    )
      return;
    const c = this.source(project, change.sessionId, agent);
    if (
      c.session(change.sessionId).error === fault.error &&
      agent.session.snapshotEvents().findLast((e) => e.type === 'turn/end')?.seq ===
        fault.turnEndSeq &&
      same(agent.model.current(), change.configuration) &&
      this.host.recoverableFault?.(agent, fault.error)
    )
      c.recordSessionError(change.sessionId, null);
  }
  private async apply(project: string, id: string, agent: NativeAgent): Promise<ModelChange> {
    let c = this.projects.forProject(project),
      catalog = c.modelPolicies(),
      change = catalog.get(id);
    if (change.status === 'confirmed') return change;
    this.source(project, change.sessionId, agent);
    if (agent.status !== 'idle')
      throw new ProjectError('MODEL_SESSION_BUSY', '原生会话尚未空闲，未在在途步骤热切换');
    try {
      if (change.selectionSeq === null) {
        if (!same(agent.model.current(), change.previous))
          throw new ProjectError(
            'MODEL_SELECTION_DRIFT',
            '原生当前配置与原记录不符，不能覆盖未知切换',
          );
        const before = agent.session.snapshotEvents().at(-1)?.seq ?? -1;
        agent.model.select(change.configuration);
        const selected = agent.session
          .snapshotEvents()
          .findLast(
            (e) =>
              e.type === 'model/selection' &&
              e.seq > before &&
              same(e.data as ExecutionConfiguration, change.configuration),
          );
        if (!selected)
          throw new ProjectError(
            'MODEL_SELECTION_UNCONFIRMED',
            '没有本次实际原生model/selection事件，未冒充切换',
          );
        change = catalog.selected(id, { nativeSessionId: agent.id, selectionSeq: selected.seq });
      }
      if (
        !same(agent.model.current(), change.configuration) ||
        !agent.session
          .snapshotEvents()
          .some(
            (e) =>
              e.seq === change.selectionSeq &&
              e.type === 'model/selection' &&
              same(e.data as ExecutionConfiguration, change.configuration),
          )
      )
        throw new ProjectError('MODEL_SELECTION_UNCONFIRMED', '原生配置或原选择事件不能回读');
      if (!(await this.host.flush(agent)))
        throw new ProjectError('MODEL_SELECTION_DURABILITY', '原生配置选择未确认持久接纳');
      c = this.source(project, change.sessionId, agent);
      catalog = c.modelPolicies();
      if (!same(agent.model.current(), change.configuration))
        throw new ProjectError('MODEL_SELECTION_DRIFT', '持久确认期间原生配置已变化，保留未知');
      return catalog.confirm(id, {
        nativeSessionId: agent.id,
        selectionSeq: change.selectionSeq!,
        durableAt: new Date().toISOString(),
      });
    } catch (error) {
      catalog.problem(id, error instanceof Error ? error.message : '模型切换结果未知');
      throw error;
    }
  }
  async close() {
    this.closed = true;
    await Promise.allSettled(this.runs.values());
  }
}
