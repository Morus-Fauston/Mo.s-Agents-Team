import { setTimeout as delay } from 'node:timers/promises';
import { relative } from 'node:path';
import type { NativeAgent, NativeContext } from '../host/native.ts';
import type { AssistantRecord } from '../contracts/collaboration.ts';
import type { AssistantControlRecord } from '../contracts/assistant-controls.ts';
import { assistantControlInputSchema } from '../contracts/assistant-controls.ts';
import type { ControlRecord, StoppedObservation } from '../contracts/controls.ts';
import { nativeTerminalJobStatuses } from '../contracts/controls.ts';
import type { WorkbenchActor } from '../contracts/workbench.ts';
import type { ProjectService } from './project-service.ts';
import type { CommunicationService } from './chat-service.ts';
import { ProjectError } from './errors.ts';
import { canonicalDirectory, withinPath } from './write-scopes.ts';
import { z } from 'zod';
export interface AssistantControlHost {
  native: NativeContext;
  peek(project: string, session: string): NativeAgent | undefined;
  inspect(
    project: string,
    assistant: AssistantRecord,
    agent: NativeAgent,
  ): Promise<StoppedObservation>;
  freshContext(project: string, session: string, agent: NativeAgent): Promise<unknown>;
  changed(project: string, collaboration: string): void;
}
export class AssistantControlService {
  private readonly projects: ProjectService;
  private readonly communication: CommunicationService;
  private readonly host: AssistantControlHost;
  private readonly epoch: string;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly runs = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private closed = false;
  constructor(
    projects: ProjectService,
    communication: CommunicationService,
    host: AssistantControlHost,
    epoch: string,
  ) {
    this.projects = projects;
    this.communication = communication;
    this.host = host;
    this.epoch = epoch;
  }
  request(project: string, actor: WorkbenchActor, raw: unknown): AssistantControlRecord {
    if (this.closed) throw new ProjectError('ASSISTANT_CONTROL_CLOSED', '辅助控制正在关闭');
    const v = this.projects
      .forProject(project)
      .assistantControls()
      .request(actor, assistantControlInputSchema.parse(raw), this.epoch);
    this.queue(project, v.id);
    return v;
  }
  propagate(project: string, control: ControlRecord): void {
    for (const id of control.assistantTargetIds) this.queue(project, id);
  }
  retry(project: string, actor: WorkbenchActor, id: string, raw: unknown): AssistantControlRecord {
    const input = z
      .object({
        operationId: z.uuid(),
        expectedRevision: z.number().int().positive(),
        reason: z.string().trim().min(1),
      })
      .strict()
      .parse(raw);
    if (this.closed) throw new ProjectError('ASSISTANT_CONTROL_CLOSED', '辅助控制正在关闭');
    const v = this.projects
      .forProject(project)
      .assistantControls()
      .retry(actor, id, input.expectedRevision, input.operationId, input.reason);
    const catalog = this.projects.forProject(project).assistantControls();
    if (['stopped', 'terminated'].includes(v.status)) catalog.checking(v.id);
    const observeOnly =
      v.action !== 'resume' && !(v.stopMode === 'soft' && !v.report && v.handoffRequired);
    this.queue(project, v.id, observeOnly);
    return v;
  }
  reconcile(project: string, session: string, invalidating = false): void {
    if (this.closed) return;
    const c = this.projects.forProject(project),
      a = c
        .collaborations()
        .list()
        .findLast((a) => a.sessionId === session);
    const v = a ? c.assistantControls().current(a.id) : undefined;
    if (v && invalidating && ['stopped', 'terminated'].includes(v.status))
      c.assistantControls().problem(v.id, '停稳后又观察到本目标新启动的实际受管范围，重新保留未知');
    const current = a ? c.assistantControls().current(a.id) : undefined;
    if (
      current &&
      current.action !== 'resume' &&
      ['handoff', 'checking', 'unknown'].includes(current.status)
    )
      this.queue(project, current.id, true);
  }
  private current(project: string, id: string): AssistantControlRecord {
    if (this.closed) throw new ProjectError('ASSISTANT_CONTROL_CLOSED', '辅助控制正在关闭');
    const catalog = this.projects.forProject(project).assistantControls(),
      v = catalog.get(id);
    if (catalog.current(v.collaborationId)?.id !== id || v.epoch !== this.epoch)
      throw new ProjectError(
        'ASSISTANT_CONTROL_SUPERSEDED',
        '较新控制或宿主归属变化，旧动作只保留历史',
      );
    return v;
  }
  private agent(project: string, v: AssistantControlRecord, checkGoal = true): NativeAgent {
    const c = this.projects.forProject(project),
      agent = this.host.peek(project, v.sessionId);
    if (
      !agent ||
      !v.nativeSessionId ||
      agent.id !== v.nativeSessionId ||
      c.session(v.sessionId).nativeSessionId !== agent.id
    )
      throw new ProjectError('ASSISTANT_CONTROL_NATIVE', '原辅助未加载或身份变化，不打开替代会话');
    if (!checkGoal) return agent;
    if (!this.host.native.goals)
      throw new ProjectError('HOST_GOALS_UNAVAILABLE', '无法核对辅助Goal状态');
    if (this.host.native.goals.get(agent))
      throw new ProjectError(
        'ASSISTANT_GOAL_UNEXPECTED',
        '辅助存在未关联Goal，不控制或清除其他Goal',
      );
    return agent;
  }
  private queue(project: string, id: string, observeOnly = false): void {
    if (this.closed) return;
    if (this.runs.has(id)) {
      if (observeOnly) this.dirty.add(id);
      return;
    }
    const v = this.projects.forProject(project).assistantControls().get(id);
    if (['stopped', 'terminated', 'resumed'].includes(v.status)) return;
    const key = project + ':' + v.collaborationId,
      prior = this.queues.get(key) ?? Promise.resolve();
    const run = prior.catch(() => {}).then(() => this.perform(project, id, observeOnly));
    this.queues.set(key, run);
    this.runs.set(id, run);
    void run
      .finally(() => {
        this.runs.delete(id);
        if (this.queues.get(key) === run) this.queues.delete(key);
        if (this.dirty.delete(id) && !this.closed) this.queue(project, id, true);
      })
      .catch(() => {});
  }
  private async perform(project: string, id: string, observeOnly: boolean): Promise<void> {
    const c = this.projects.forProject(project),
      catalog = c.assistantControls();
    try {
      const v = this.current(project, id),
        hard = v.action !== 'resume' && v.stopMode === 'hard',
        agent = this.agent(project, v, !hard);
      if (v.action === 'resume') {
        if (!observeOnly) await this.resume(project, id, agent);
        return;
      }
      let goalKnown = false;
      try {
        goalKnown = !!this.host.native.goals && !this.host.native.goals.get(agent);
      } catch {
        /* Goal未知不阻断可确认归属的硬停止。 */
      }
      catalog.receipt(
        id,
        'goal',
        goalKnown
          ? {
              state: 'unnecessary',
              note: '已核对本次实际辅助没有Goal；未撤销或清除其他Goal',
            }
          : {
              state: 'unknown',
              note: '辅助Goal服务或当前Goal不能核对；继续可确认归属的硬停止，不撤销或清除其他Goal',
            },
      );
      if (observeOnly) {
        await this.observe(project, id, agent);
        return;
      }
      if (v.stopMode === 'soft') {
        if (v.handoffRequired && !v.report) {
          catalog.delivered(id);
          const saved = await this.communication.sendAssistantControl(project, id, 'request');
          this.current(project, id);
          if (saved.receipt.durableAcceptedAt === null)
            throw new ProjectError('ASSISTANT_CONTROL_DELIVERY', '原软停止要求持久投递尚未确认');
          return;
        }
        catalog.receipt(id, 'cancel', {
          state: 'unnecessary',
          note: '软停止不调用cancel或job/kill',
        });
      } else {
        this.current(project, id);
        agent.cancel({ kind: 'user' }, { keepInbox: true });
        catalog.receipt(id, 'cancel', {
          state: 'requested',
          note: '已请求取消本次实际辅助；后台和写入另验',
        });
        const a = c.collaborations().get(v.collaborationId);
        const jobs = agent.session
          .snapshotEvents()
          .filter(
            (e) =>
              e.type === 'job/registered' &&
              e.data.owner === agent.id &&
              Number(e.data.startedAt) >= Date.parse(a.createdAt),
          );
        for (const event of jobs) {
          this.current(project, id);
          const jobId = String(event.data.jobId);
          try {
            const native = this.host.native.jobs;
            if (!native) throw new Error('原生作业服务不可用');
            const job = native.get(jobId, agent.id);
            if (job.owner !== agent.id || job.startedAt !== Number(event.data.startedAt))
              throw new Error('作业来源不匹配');
            if (!nativeTerminalJobStatuses.includes(job.status)) {
              native.kill(jobId, agent.id, 'MAT辅助控制 ' + id);
              catalog.jobKill(id, jobId, {
                state: 'requested',
                note: '仅向实际辅助登记的原owner作业请求kill，退出另验',
              });
            } else
              catalog.jobKill(id, jobId, {
                state: 'unnecessary',
                note: '原生作业已为终态，外部范围仍另验',
              });
          } catch {
            catalog.jobKill(id, jobId, {
              state: 'unknown',
              note: '作业来源或原生控制不可确认，未控制其他作业',
            });
          }
        }
        for (let n = 0; n < 20 && agent.status !== 'idle'; n++) {
          await delay(100);
          this.current(project, id);
        }
        this.current(project, id);
        catalog.receipt(id, 'cancel', {
          state: agent.status === 'idle' ? 'confirmed' : 'unknown',
          note:
            agent.status === 'idle'
              ? '原辅助当前idle，后台与文件仍另验'
              : '有限观察内未核实原辅助结束',
        });
      }
      await this.observe(project, id, agent);
    } catch (error) {
      if (
        this.closed ||
        (error instanceof ProjectError && error.code === 'ASSISTANT_CONTROL_SUPERSEDED')
      )
        return;
      const v = catalog.problem(id, error instanceof Error ? error.message : '辅助控制未确认');
      if (catalog.current(v.collaborationId)?.id === id) {
        c.collaborations().controlOutcome(v.collaborationId, id, v.status);
        this.host.changed(project, v.collaborationId);
      }
    }
  }
  private async observe(project: string, id: string, agent: NativeAgent): Promise<void> {
    const c = this.projects.forProject(project),
      catalog = c.assistantControls(),
      v = this.current(project, id);
    catalog.checking(id);
    const observation = await this.host.inspect(
      project,
      c.collaborations().get(v.collaborationId),
      agent,
    );
    this.current(project, id);
    this.agent(project, v);
    let actual = catalog.observe(id, observation);
    if (actual.status === 'stopped' && actual.action === 'terminate')
      actual = catalog.terminateConfirmed(id);
    if (['stopped', 'terminated', 'unknown'].includes(actual.status)) {
      c.collaborations().controlOutcome(actual.collaborationId, id, actual.status);
      this.host.changed(project, actual.collaborationId);
    }
  }
  async handoff(
    project: string,
    session: string,
    agent: NativeAgent,
    id: string,
    content: string,
  ): Promise<AssistantControlRecord> {
    const c = this.projects.forProject(project),
      v = this.current(project, id);
    if (v.sessionId !== session || this.agent(project, v) !== agent)
      throw new ProjectError('ASSISTANT_HANDOFF_SOURCE', '不是当前实际辅助的控制回报');
    if (!content.trim())
      throw new ProjectError('ASSISTANT_HANDOFF_CONTENT', '软停止回报须说明保存内容与恢复位置');
    c.assistantControls().handoff(id, session, content);
    const key = project + ':handoff:' + id,
      job = (async () => {
        for (let n = 0; n < 30 && agent.status !== 'idle' && !this.closed; n++) await delay(100);
        if (!this.closed) await this.perform(project, id, true);
      })();
    this.queues.set(key, job);
    void job
      .finally(() => {
        if (this.queues.get(key) === job) this.queues.delete(key);
      })
      .catch(() => {});
    return c.assistantControls().get(id);
  }
  private async resume(project: string, id: string, agent: NativeAgent): Promise<void> {
    const c = this.projects.forProject(project),
      catalog = c.assistantControls(),
      v = this.current(project, id),
      a = c.collaborations().get(v.collaborationId),
      main = c.collaborations().requireMain(v.parentSessionId);
    if (
      a.writeScopes.some((scope) => !main.writeScopes.some((parent) => withinPath(parent, scope)))
    )
      throw new ProjectError('ASSISTANT_SCOPE_CHANGED', '原辅助写入范围已不在当前主票授权内');
    const context = await this.host.freshContext(project, v.sessionId, agent);
    const actual = context as { cwd?: unknown };
    if (
      typeof actual.cwd !== 'string' ||
      relative(canonicalDirectory(a.cwd), canonicalDirectory(actual.cwd)) !== ''
    )
      throw new ProjectError('ASSISTANT_CWD_CHANGED', '原辅助实际工作目录与本票不符');
    const observation = await this.host.inspect(project, a, agent);
    this.current(project, id);
    this.agent(project, v);
    if (
      observation.agentIdle !== true ||
      observation.inFlightTools !== false ||
      observation.filesStable !== true ||
      !observation.processesComplete ||
      observation.jobObservations.some(
        (j) => j.externalStatus !== 'gone' || !nativeTerminalJobStatuses.includes(j.nativeStatus),
      )
    )
      throw new ProjectError('ASSISTANT_RESUME_NOT_QUIET', '原辅助现场仍有未知，不恢复或重放');
    const previous = catalog
      .list(a.id)
      .filter((x) => x.revision < v.revision)
      .at(-1);
    const snapshot = {
      context,
      previousControlId: previous?.id ?? null,
      previousFingerprint: previous?.observation?.fileFingerprint ?? null,
      currentFingerprint: observation.fileFingerprint,
      ticketRevision: c.workbench().getTicket(a.ticketId).revision,
    };
    if (
      v.resumeSnapshot &&
      (v.resumeSnapshot as { currentFingerprint?: unknown }).currentFingerprint !==
        snapshot.currentFingerprint
    )
      throw new ProjectError(
        'ASSISTANT_RESUME_SITE_CHANGED',
        '上次恢复后现场又变化，先核对未知副作用',
      );
    catalog.beginResume(id, snapshot);
    await this.communication.prepareResume(project, v.sessionId, agent);
    this.current(project, id);
    this.agent(project, v);
    const staged = await this.communication.stageAssistantControl(project, id, 'resume');
    this.current(project, id);
    if (staged.receipt.durableAcceptedAt === null)
      throw new ProjectError('ASSISTANT_RESUME_DELIVERY', '原辅助恢复说明持久接纳尚未确认');
    catalog.resumed(id, catalog.get(id).resumeSnapshot);
    await this.communication.sendAssistantControl(project, id, 'resume');
  }
  query(project: string, collaborationId: string) {
    const c = this.projects.forProject(project).assistantControls();
    return { revision: c.revision(collaborationId), controls: c.list(collaborationId) };
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.runs.values(), ...this.queues.values()]);
  }
}
