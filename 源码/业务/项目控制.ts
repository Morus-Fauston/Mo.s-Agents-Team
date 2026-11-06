import type { ProjectService } from './项目服务.ts';
import type { ExecutionControlService } from './执行控制.ts';
import type { CommunicationService } from './私聊服务.ts';
import type { SessionRecord } from '../契约/会话.ts';
import type { NativeAgent, NativeContext } from '../宿主/原生接口.ts';
import { ProjectError } from './错误.ts';
import { messageIdentity } from './消息呈递.ts';
export interface ProjectControlHost {
  unsettledProcesses?(sessionId: string): number;
  native: NativeContext;
  createManager(
    project: string,
    reserved: (session: SessionRecord) => void,
  ): Promise<SessionRecord>;
  openControlled(project: string, session: string): Promise<NativeAgent>;
  peek(project: string, session: string): NativeAgent | undefined;
}
export class ProjectControlService {
  private readonly projects: ProjectService;
  private readonly controls: ExecutionControlService;
  private readonly communication: CommunicationService;
  private readonly host: ProjectControlHost;
  private readonly epoch: string;
  private readonly pending = new Map<string, Promise<void>>();
  private closed = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    projects: ProjectService,
    controls: ExecutionControlService,
    communication: CommunicationService,
    host: ProjectControlHost,
    epoch: string,
  ) {
    this.projects = projects;
    this.controls = controls;
    this.communication = communication;
    this.host = host;
    this.epoch = epoch;
    for (const item of projects.list())
      if (!('unavailable' in item) && item.started)
        projects
          .forProject(item.id)
          .controls()
          .projectOutcome('starting', '重新接入，先核对原现场，不重放未知副作用', epoch);
    this.timer = setInterval(() => this.observeStops(), 1000);
    this.timer.unref();
  }
  startLoaded(): void {
    for (const item of this.projects.list())
      if (!('unavailable' in item) && item.started) this.launch(item.id, 'reload:' + this.epoch);
  }
  attached(project: string): void {
    const connection = this.projects.forProject(project);
    if (!connection.snapshot().started) return;
    if (connection.controls().project().epoch !== this.epoch)
      connection
        .controls()
        .projectOutcome('starting', '接入先前启动的项目，先核对原现场', this.epoch);
    if (connection.controls().project().state !== 'running')
      this.launch(project, 'attach:' + this.epoch);
  }
  start(project: string, input: { operationId: string; reason: string }) {
    if (this.closed) throw new ProjectError('CONTROL_CLOSED', '项目控制正在关闭');
    const connection = this.projects.forProject(project);
    if (!connection.skillSourceRoot())
      throw new ProjectError('SKILL_SOURCE_REQUIRED', '启动前须设置For MAT来源');
    connection.controls().startProject({ kind: 'user' }, input, this.epoch);
    if (!connection.snapshot().started) return connection.controls().project();
    if (connection.controls().project().state !== 'running')
      this.launch(project, input.operationId);
    return connection.controls().project();
  }
  private launch(project: string, operation: string): void {
    if (this.pending.has(project)) return;
    const job = this.prepare(project, operation);
    this.pending.set(project, job);
    void job
      .finally(() => {
        if (this.pending.get(project) === job) this.pending.delete(project);
      })
      .catch(() => {});
  }
  private async prepare(project: string, operation: string): Promise<void> {
    const connection = this.projects.forProject(project),
      catalog = connection.controls();
    try {
      let manager: SessionRecord;
      const prior = catalog.project().managerSessionId;
      if (prior) {
        manager = connection.session(prior);
        if (
          manager.status !== 'bound' ||
          ['archived', 'terminated'].includes(manager.communicationState)
        )
          throw new ProjectError(
            'MANAGER_UNAVAILABLE',
            '原管理入口不可继续，保留原身份，不自动另开',
          );
        await this.host.openControlled(project, prior);
      } else {
        manager = await this.host.createManager(project, (session) =>
          catalog.reserveManager(this.epoch, session.id),
        );
      }
      if (this.closed || !connection.snapshot().started) return;
      connection.setCommunicationState(manager.id, 'active');
      catalog.projectReady(this.epoch, manager.id);
      await this.communication.sendSystem(project, {
        id: messageIdentity('project-start:' + project + ':' + operation),
        target: manager.id,
        content:
          'MAT项目已启动或重新接入。请先核对现有票据、执行和未办输入；未知副作用不重放，不自行恢复暂停或终止执行。此次仅通知，不授权新增票据或批量派工。无可办事项则说明当前状态后等待明确输入。',
      });
    } catch (error) {
      if (connection.snapshot().started)
        catalog.projectOutcome(
          'error',
          error instanceof Error ? error.message : '项目接入未确认',
          this.epoch,
        );
    }
  }
  stop(project: string, input: { operationId: string; reason: string }, force = false) {
    const connection = this.projects.forProject(project),
      catalog = connection.controls(),
      result = catalog.stopProject({ kind: 'user' }, input, this.epoch);
    if (connection.snapshot().started) return this.query(project);
    const manager = catalog.project().managerSessionId;
    if (manager) connection.setCommunicationState(manager, 'paused');
    for (const id of result.executionIds) {
      const operationId = messageIdentity('project-stop:' + input.operationId + ':' + id);
      if (catalog.list(id).some((value) => value.operationId === operationId)) continue;
      const current = catalog.activeControl(id);
      if (current?.action === 'terminate') continue;
      this.controls.request(
        project,
        { kind: 'user' },
        {
          operationId,
          executionId: id,
          action: force ? 'hard-stop' : 'soft-stop',
          reason: input.reason,
          expectedRevision: catalog.revision(id),
        },
      );
    }
    if (force)
      catalog.projectOutcome(
        'forced-stopped',
        '用户明确强制退出本项目；不保证所有工具或外部进程停稳，原占用继续核对',
        this.epoch,
      );
    this.observeStops();
    return this.query(project);
  }
  query(project: string) {
    const connection = this.projects.forProject(project);
    return {
      runtime: connection.controls().project(),
      desiredStarted: connection.snapshot().started,
      executions: connection
        .executions()
        .list()
        .map((value) => ({
          id: value.id,
          state: value.lifecycleState,
          occupancy: value.writeOccupancy,
        })),
      note: '关闭网页不改变项目意图；停止本项目不退出DSH Host。',
    };
  }
  private observeStops(): void {
    if (this.closed) return;
    for (const item of this.projects.list()) {
      if ('unavailable' in item || item.started) continue;
      const connection = this.projects.forProject(item.id),
        catalog = connection.controls(),
        state = catalog.project();
      if (!['stopping', 'unknown'].includes(state.state)) continue;
      const executions = connection.executions().list(),
        settled = executions.every(
          (value) =>
            value.writeOccupancy === 'released' &&
            ['paused', 'terminated', 'closed'].includes(value.lifecycleState),
        );
      let managerQuiet = true;
      if (state.managerSessionId) {
        const session = connection.session(state.managerSessionId),
          agent = this.host.peek(item.id, session.id);
        if (agent) {
          try {
            managerQuiet =
              agent.status === 'idle' &&
              (this.host.unsettledProcesses?.(session.id) ?? 0) === 0 &&
              !!this.host.native.jobs &&
              !this.host.native.jobs.list(agent.id).some((job) => job.owner === agent.id);
          } catch {
            managerQuiet = false;
          }
        } else if (session.nativeSessionId) managerQuiet = false;
      }
      const next = settled && managerQuiet ? 'stopped' : 'unknown';
      if (state.state !== next)
        catalog.projectOutcome(
          next,
          next === 'stopped'
            ? '已按本项目已关联执行及管理入口核对停止'
            : '仍有未停稳执行、未加载入口或未关联管理作业；不宣称安全停止',
          this.epoch,
        );
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled([...this.pending.values()]);
  }
}
