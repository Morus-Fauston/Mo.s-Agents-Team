import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { NativeAgent, NativeContext, NativeEvent } from '../host/native.ts';
import type { WorkbenchActor } from '../contracts/workbench.ts';
import type {
  ControlRecord,
  RecoveryCheckpoint,
  StoppedObservation,
} from '../contracts/controls.ts';
import { controlInputSchema, nativeTerminalJobStatuses } from '../contracts/controls.ts';
import type { ProjectService } from './project-service.ts';
import type { DispatchService } from './dispatch-service.ts';
import type { CommunicationService } from './chat-service.ts';
import { ProjectError } from './errors.ts';
import { messageIdentity, presentMessage } from './message-presentation.ts';
import { canonicalDirectory } from './write-scopes.ts';
import { assembleContext } from './context.ts';
import { buildRecoveryCheckpoint, compareRecovery, recoveryPaths } from './recovery-checkpoint.ts';
import { retainVersionOriginal } from './workspace-snapshot.ts';
import {
  windowsProcessSnapshot,
  observeJobProcesses,
  processWitnessSchema,
  fingerprintPaths,
  inFlightNativeTools,
} from './quiescence.ts';
import type { ProcessSnapshot } from './quiescence.ts';
import type { AssistantControlService } from './assistant-controls.ts';
export interface ControlHost {
  unassociatedProcesses?(sessionId: string, associatedIds: string[]): number;
  native: NativeContext;
  peek(projectId: string, sessionId: string): NativeAgent | undefined;
  openControlled(projectId: string, sessionId: string): Promise<NativeAgent>;
  freshContext(projectId: string, sessionId: string, agent: NativeAgent): Promise<unknown>;
  checkMergeRecovery?(project: string, executionId: string, cwd: string): Promise<boolean>;
}
/** One queue per execution serializes native effects; durable control revisions fence stale work. */
export class ExecutionControlService {
  private readonly projects: ProjectService;
  private readonly dispatch: DispatchService;
  private readonly communication: CommunicationService;
  private readonly host: ControlHost;
  private readonly assistants: AssistantControlService | undefined;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly runs = new Map<string, Promise<void>>();
  private closed = false;
  private sample: Promise<void> | undefined;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(
    projects: ProjectService,
    dispatch: DispatchService,
    communication: CommunicationService,
    host: ControlHost,
    assistants?: AssistantControlService,
  ) {
    this.projects = projects;
    this.dispatch = dispatch;
    this.communication = communication;
    this.host = host;
    this.assistants = assistants;
    this.timer = setInterval(() => {
      void this.sampleActive().catch(() => {});
    }, 1000);
    this.timer.unref();
  }
  private connection(project: string) {
    return this.projects.forProject(project);
  }
  request(project: string, actor: WorkbenchActor, raw: unknown): ControlRecord {
    if (this.closed) throw new ProjectError('CONTROL_CLOSED', '执行控制正在关闭');
    const input = controlInputSchema.parse(raw),
      catalog = this.connection(project).controls(),
      value = catalog.request(actor, input, this.dispatch.epoch);
    if (
      !this.runs.has(value.id) &&
      ['requested', 'delivered', 'handoff', 'checking'].includes(value.status)
    ) {
      this.assistants?.propagate(project, value);
      const key = project + ':' + value.executionId,
        previous = this.queues.get(key) ?? Promise.resolve(),
        job = previous.catch(() => {}).then(() => this.perform(project, value.id));
      this.queues.set(key, job);
      this.runs.set(value.id, job);
      void job
        .finally(() => {
          this.runs.delete(value.id);
          if (this.queues.get(key) === job) this.queues.delete(key);
        })
        .catch(() => {});
    }
    return value;
  }
  private current(project: string, id: string): ControlRecord {
    if (this.closed) throw new ProjectError('CONTROL_CLOSED', '宿主正在关闭，未继续控制');
    const catalog = this.connection(project).controls(),
      value = catalog.get(id),
      latest = catalog.activeControl(value.executionId);
    if (latest && latest.revision > value.revision)
      throw new ProjectError('CONTROL_SUPERSEDED', '更晚控制已接纳；旧动作只保留历史');
    return value;
  }
  private goals() {
    const goals = this.host.native.goals;
    if (!goals) throw new ProjectError('HOST_GOALS_UNAVAILABLE', '宿主Goal服务未装配');
    return goals;
  }
  private relatedGoal(project: string, executionId: string, agent: NativeAgent) {
    const execution = this.connection(project).executions().get(executionId),
      goal = this.goals().get(agent);
    const missingAfterTermination = !goal && execution.lifecycleState === 'terminated';
    if (!missingAfterTermination && (goal?.id ?? null) !== execution.goalId) {
      const catalog = this.connection(project).controls(),
        control = catalog.activeControl(executionId);
      if (control) catalog.unconfirmed(control.id, '当前Goal与原执行不符，保留占用等待核对');
      throw new ProjectError(
        'GOAL_BINDING_MISMATCH',
        '当前Goal与原执行不符，未控制其他Goal，保留未知',
      );
    }
    return goal;
  }
  assertModelGoal(project: string, sessionId: string, agent: NativeAgent): void {
    const connection = this.connection(project),
      execution = connection.executions().currentForSession(sessionId);
    if (!execution) return;
    try {
      if (!execution.goalId || agent.id !== execution.nativeSessionId)
        throw new ProjectError('GOAL_BINDING_MISMATCH', '执行尚未关联原Goal或原生会话');
      this.relatedGoal(project, execution.id, agent);
    } catch (error) {
      connection.executions().fail(execution.id, {
        code: 'GOAL_BINDING_MISMATCH',
        message: '步骤前无法核对原Goal，未发起模型请求',
        unknown: true,
      });
      throw error;
    }
  }
  private async perform(project: string, id: string): Promise<void> {
    const connection = this.connection(project),
      catalog = connection.controls();
    try {
      const value = this.current(project, id),
        execution = connection.executions().get(value.executionId);
      if (value.action === 'resume') {
        await this.resume(project, id);
        return;
      }
      const agent = execution.sessionId ? this.host.peek(project, execution.sessionId) : undefined;
      if (!agent) {
        catalog.receipt(id, 'goal', {
          state: execution.goalId ? 'unknown' : 'unnecessary',
          note: execution.goalId ? '原会话未加载；查询不会复活或猜测原Goal' : '该次尚未创建Goal',
        });
        catalog.receipt(id, 'cancel', {
          state: execution.nativeSessionId ? 'unknown' : 'unnecessary',
          note: '没有当前可核实的原生Agent，不伪造取消回执',
        });
        if (value.action === 'terminate')
          catalog.terminateRecorded(id, {
            state: execution.goalId ? 'unknown' : 'unnecessary',
            note: '原Goal不可取得，终止本次业务入口并保留未知',
          });
        else catalog.setStatus(id, 'unknown');
        return;
      }
      if (agent.id !== execution.nativeSessionId)
        throw new ProjectError('CONTROL_BINDING_MISMATCH', '控制目标不是原生会话的实际绑定');
      this.relatedGoal(project, execution.id, agent);
      if (value.action === 'reconcile') {
        const goal = this.goals().get(agent);
        catalog.receipt(id, 'goal', {
          state: !goal || goal.activation === 'disarmed' ? 'confirmed' : 'unknown',
          note: !goal ? '当前原生Goal不存在' : `当前Goal ${goal.phase}/${goal.activation}`,
        });
        catalog.receipt(id, 'cancel', {
          state: agent.status === 'idle' ? 'unnecessary' : 'unknown',
          note: '只读核对实际会话，不补发cancel',
        });
        await this.observe(project, id, agent);
        return;
      }
      const goal = this.goals().disarm(agent);
      this.relatedGoal(project, execution.id, agent);
      catalog.receipt(id, 'goal', {
        state: !goal || goal.activation === 'disarmed' ? 'confirmed' : 'unknown',
        note: '只撤销后续Goal续轮；不代表当前工具或外部进程已停',
        ...(goal ? { goalId: goal.id } : {}),
      });
      this.current(project, id);
      if (value.stopMode === 'soft') {
        await this.communication.sendControl(project, id, 'request');
        this.current(project, id);
        this.relatedGoal(project, execution.id, agent);
        catalog.setStatus(id, 'delivered');
        return;
      }
      agent.cancel({ kind: 'user' }, { keepInbox: true });
      catalog.receipt(id, 'cancel', {
        state: 'requested',
        note: '已调用原生cancel；后台作业与外部停稳另验',
      });
      for (const job of catalog.jobs(execution.id)) {
        this.current(project, id);
        try {
          const native = this.host.native.jobs;
          if (!native) throw new Error('作业服务不可取得');
          const before = native.get(job.id, agent.id);
          if (before.owner !== agent.id) throw new Error('作业owner不匹配');
          if (['running', 'stopping'].includes(before.status)) {
            native.kill(job.id, agent.id, `MAT控制 ${id}`);
            catalog.jobKill(id, job.id, {
              state: 'requested',
              note: '已对登记的原owner作业请求kill；等待独立结束事实',
            });
          } else
            catalog.jobKill(id, job.id, {
              state: 'unnecessary',
              note: '原生查询已为终态；外部进程仍另验',
            });
        } catch {
          catalog.jobKill(id, job.id, {
            state: 'unknown',
            note: 'unknown job或原生控制不可确认；未控制其他作业',
          });
        }
      }
      // Bounded observation is an implementation window, never a timeout-based claim of safety.
      for (let attempt = 0; attempt < 20 && agent.status !== 'idle'; attempt++) {
        this.current(project, id);
        await delay(100);
      }
      this.current(project, id);
      catalog.receipt(id, 'cancel', {
        state: agent.status === 'idle' ? 'confirmed' : 'unknown',
        note:
          agent.status === 'idle'
            ? '原Agent当前idle；不等于后台和写入停稳'
            : '观察窗口内未核实原轮结束',
      });
      const latest = this.relatedGoal(project, execution.id, agent);
      if (latest?.phase === 'active') {
        this.goals().pause(agent, { id: latest.id, revision: latest.revision });
      }
      if (!(await this.observe(project, id, agent))) return;
      this.current(project, id);
      if (value.action === 'terminate') {
        await this.finishTermination(project, id, agent);
      }
    } catch (error) {
      const value = catalog.get(id);
      if (error instanceof ProjectError && error.code === 'CONTROL_SUPERSEDED') return;
      if (error instanceof ProjectError && error.code === 'GOAL_BINDING_MISMATCH') {
        catalog.unconfirmed(id, error.message);
        return;
      }
      if (value.action === 'resume') {
        const note = error instanceof Error ? error.message : '恢复接纳未知';
        if (
          error instanceof ProjectError &&
          [
            'RECOVERY_REVIEW_REQUIRED',
            'RECOVERY_DRIFT',
            'RECOVERY_UNREADABLE',
            'RECOVERY_SCOPE_CHANGED',
            'DEPENDENCY_NOT_READY',
            'WRITE_SCOPE_BUSY',
            'LOCAL_COMMIT_SCOPE_BUSY',
            'MERGE_SCOPE_BUSY',
            'MERGE_RECOVERY_UNAVAILABLE',
          ].includes(error.code) &&
          value.resumeSnapshot === null
        )
          catalog.resumeDeclined(id, note);
        else catalog.resumeFailed(id, note);
      } else {
        catalog.setStatus(id, 'unknown');
        catalog.receipt(id, 'goal', {
          state: 'unknown',
          note: error instanceof Error ? error.message : '控制未确认',
        });
      }
    }
  }
  async handoff(
    project: string,
    sessionId: string,
    id: string,
    content: string,
  ): Promise<ControlRecord> {
    const connection = this.connection(project),
      catalog = connection.controls(),
      initial = this.current(project, id),
      execution = connection.executions().get(initial.executionId);
    if (execution.sessionId !== sessionId)
      throw new ProjectError('HANDOFF_CALLER_MISMATCH', '当前实际会话不属于本次执行');
    const originalAgent = this.host.peek(project, sessionId);
    if (!originalAgent)
      throw new ProjectError('CONTROL_AGENT_UNAVAILABLE', '原生调用会话已不可取得');
    this.relatedGoal(project, execution.id, originalAgent);
    const ids = execution.managerSessionIds.map((target) =>
        messageIdentity('control-handoff:' + id + ':' + target),
      ),
      value = catalog.handoff(sessionId, id, content, ids);
    for (const messageId of value.report!.messageIds) {
      this.relatedGoal(project, execution.id, originalAgent);
      try {
        await this.communication.sendControlledResult(project, sessionId, messageId);
      } catch {
        /* Saved report and exact notification identities remain available for reconciliation. */
      }
    }
    this.current(project, id);
    const agent = this.host.peek(project, sessionId);
    if (!agent) throw new ProjectError('CONTROL_AGENT_UNAVAILABLE', '原生调用会话已不可取得');
    const goal = this.relatedGoal(project, execution.id, agent);
    if (goal && goal.id !== execution.goalId)
      throw new ProjectError('GOAL_BINDING_MISMATCH', '挂起不能控制另一个Goal');
    if (goal?.phase === 'active')
      this.goals().pause(agent, { id: goal.id, revision: goal.revision });
    catalog.receipt(id, 'goal', {
      state: 'confirmed',
      note: '真实执行者挂起回报后暂停原Goal',
      ...(goal ? { goalId: goal.id } : {}),
    });
    catalog.handoffPaused(id);
    // Return the tool result before observing idle; waiting here would deadlock its own turn.
    const key = project + ':handoff:' + id,
      job = (async () => {
        for (let attempt = 0; attempt < 30 && agent.status !== 'idle' && !this.closed; attempt++)
          await delay(100);
        if (!this.closed) {
          if (!(await this.observe(project, id, agent))) return;
          const latest = catalog.get(id);
          if (latest.action === 'terminate' && catalog.activeControl(execution.id)?.id === id) {
            await this.finishTermination(project, id, agent);
          }
        }
      })();
    this.queues.set(key, job);
    void job
      .finally(() => {
        if (this.queues.get(key) === job) this.queues.delete(key);
      })
      .catch(() => {});
    return catalog.get(id);
  }
  private async finishTermination(project: string, id: string, agent: NativeAgent): Promise<void> {
    const connection = this.connection(project),
      catalog = connection.controls();
    try {
      const value = this.current(project, id),
        execution = connection.executions().get(value.executionId),
        goal = this.relatedGoal(project, execution.id, agent);
      if (goal) this.goals().clear(agent, { id: goal.id, revision: goal.revision });
      const flushed = await this.host.native.sessions.flush(agent.session);
      this.current(project, id);
      if (!flushed || this.goals().get(agent)) {
        catalog.unconfirmed(id, 'clear后持久化或当前Goal状态未确认，未控制其他Goal');
        return;
      }
      catalog.terminateRecorded(id, {
        state: 'confirmed',
        note: goal
          ? '已clear原Goal并在flush后重新核对，无Goal；外部占用独立保留'
          : '原已终止执行仍无Goal，持久化核对完成',
        ...(goal ? { goalId: goal.id } : {}),
      });
    } catch (error) {
      if (error instanceof ProjectError && error.code === 'CONTROL_SUPERSEDED') return;
      catalog.unconfirmed(id, error instanceof Error ? error.message : '终止收尾未确认');
    }
  }
  nativeEvent(project: string, sessionId: string, agent: NativeAgent, event: NativeEvent): void {
    if (this.closed || !['job/registered', 'job/settled'].includes(event.type)) return;
    const connection = this.connection(project);
    if (connection.session(sessionId).nativeSessionId !== agent.id) return;
    try {
      connection.controls().recordJob(sessionId, event);
      void this.sampleActive().catch(() => {});
    } catch {
      const execution = connection.executions().currentForSession(sessionId);
      if (execution)
        connection.executions().fail(execution.id, {
          code: 'JOB_ASSOCIATION_UNCONFIRMED',
          message: '作业关联记录不完整，未释放范围，请核对原会话',
          unknown: true,
        });
    }
  }
  private async sampleActive(): Promise<void> {
    if (this.closed) return;
    if (this.sample) return this.sample;
    const job = (async () => {
      const targets = [];
      for (const entry of this.projects.list())
        if (!('unavailable' in entry))
          for (const execution of this.connection(entry.id).executions().list())
            for (const owned of this.connection(entry.id).controls().jobs(execution.id))
              if (
                owned.epoch === this.dispatch.epoch &&
                (['running', 'stopping'].includes(owned.status) ||
                  (owned.processWitness === null && Date.now() - owned.startedAt < 15000))
              )
                targets.push({ project: entry.id, execution, owned });
      if (!targets.length) return;
      const snapshot = await windowsProcessSnapshot();
      for (const { project, execution, owned } of targets) {
        if (this.closed) return;
        const parsed = processWitnessSchema.safeParse(owned.processWitness),
          host = parsed.success
            ? parsed.data.host
            : snapshot.processes.find((row) => row.pid === process.pid);
        if (!host || host.started <= 0) continue;
        const observed = observeJobProcesses(
          owned,
          snapshot,
          host,
          parsed.success ? parsed.data : undefined,
        );
        this.connection(project).controls().saveWitness(execution.id, owned.id, observed.witness);
      }
    })();
    this.sample = job;
    try {
      await job;
    } finally {
      if (this.sample === job) this.sample = undefined;
    }
  }
  private processJob(
    project: string,
    executionId: string,
    snapshot: ProcessSnapshot,
    reviewId?: string,
  ) {
    const connection = this.connection(project),
      catalog = connection.controls();
    return (reviewId ? connection.reviews().get(reviewId).jobs : catalog.jobs(executionId)).map(
      (job) => {
        const parsed = processWitnessSchema.safeParse(job.processWitness),
          host = parsed.success
            ? parsed.data.host
            : snapshot.processes.find((row) => row.pid === process.pid);
        let externalStatus: 'gone' | 'running' | 'unknown' = 'unknown';
        if (host && host.started > 0) {
          const result = observeJobProcesses(
            job,
            snapshot,
            host,
            parsed.success ? parsed.data : undefined,
          );
          externalStatus = result.state;
          if (reviewId) connection.reviews().saveWitness(reviewId, job.id, result.witness);
          else catalog.saveWitness(executionId, job.id, result.witness);
        }
        let nativeStatus = 'unknown';
        try {
          const value = this.host.native.jobs?.get(job.id, job.nativeOwner);
          if (value?.owner === job.nativeOwner) nativeStatus = value.status;
        } catch {
          /* A cold registry cannot prove settlement. */
        }
        if (nativeStatus === 'unknown' && job.settledSeq !== null && job.producerReported === true)
          nativeStatus = job.status;
        if (job.managedRanges.length) {
          const states = job.managedRanges.map((range) => range.state);
          if (states.includes('unknown')) externalStatus = 'unknown';
          else if (states.includes('pending'))
            externalStatus = externalStatus === 'gone' ? 'unknown' : 'running';
          else if (externalStatus !== 'running') externalStatus = 'gone';
        }
        return { jobId: job.id, nativeStatus, externalStatus };
      },
    );
  }
  private async observe(project: string, id: string, agent: NativeAgent): Promise<boolean> {
    const catalog = this.connection(project).controls(),
      value = catalog.get(id);
    try {
      const observation = await this.inspectExecution(
        project,
        value.executionId,
        agent,
        undefined,
        false,
        true,
      );
      if (this.closed) return false;
      catalog.observeStopped(id, observation);
      return true;
    } catch (error) {
      if (this.closed) return false;
      catalog.unconfirmed(id, error instanceof Error ? error.message : '原Goal不可核对');
      return false;
    }
  }
  async inspectExecution(
    project: string,
    executionId: string,
    agent: NativeAgent,
    reviewId?: string,
    afterResultClear = false,
    captureCheckpoint = false,
  ): Promise<StoppedObservation> {
    const connection = this.connection(project),
      catalog = connection.controls(),
      execution = connection.executions().get(executionId),
      materials = connection
        .workbench()
        .materialDomains(execution.ticketId)
        .filter((domain) => domain.referenceId === execution.id)
        .map((domain) => domain.path),
      review = reviewId ? connection.reviews().get(reviewId) : undefined,
      paths = review
        ? review.materialPath
          ? [review.materialPath]
          : []
        : [...execution.writeScopes, ...materials],
      excluded = [dirname(connection.snapshot().paths.database)],
      scopeOptions = { excluded, excludeGitMetadata: !review };
    if (review && (review.executionId !== executionId || !review.materialPath || !review.goalId))
      throw new ProjectError('REVIEW_SCOPE_UNCONFIRMED', '审阅身份、Goal或材料范围尚未明确');
    const sessionId = review?.sessionId ?? execution.sessionId,
      nativeSessionId = review?.nativeSessionId ?? execution.nativeSessionId,
      goalId = review?.goalId ?? execution.goalId;
    const ownedJobs = () =>
      reviewId ? connection.reviews().get(reviewId).jobs : catalog.jobs(execution.id);
    const clearResult = afterResultClear
      ? connection.reviewResults().list(execution.id).at(-1)
      : undefined;
    const allowedCleared =
      afterResultClear &&
      !review &&
      clearResult?.verdict === 'pass' &&
      clearResult.reviewId === execution.waitingReviewId &&
      ['prepared', 'confirmed'].includes(clearResult.authorGoalClear?.state ?? '');
    if (afterResultClear && !allowedCleared)
      throw new ProjectError('REVIEW_CLEAR_INTENT_REQUIRED', '缺少本次通过结果的原Goal清除意图');
    const assertGoal = () => {
      const goal = this.goals().get(agent);
      if (
        agent.id !== nativeSessionId ||
        (!(!review && !goal && (execution.lifecycleState === 'terminated' || allowedCleared)) &&
          (goal?.id ?? null) !== goalId)
      )
        throw new ProjectError('GOAL_BINDING_MISMATCH', '停稳核对目标不是原Agent的原Goal');
    };
    assertGoal();
    const first = fingerprintPaths(paths, scopeOptions);
    await delay(300);
    if (this.closed) throw new ProjectError('CONTROL_CLOSED', '停稳观察正在关闭');
    const originals = new Map<string, Buffer>();
    const second = fingerprintPaths(paths, {
        ...scopeOptions,
        ...(captureCheckpoint
          ? {
              retain: (sha: string, bytes: Buffer) => {
                originals.set(sha, bytes);
              },
            }
          : {}),
      }),
      snapshot = await windowsProcessSnapshot(),
      jobObservations = this.processJob(project, execution.id, snapshot, reviewId),
      calls = inFlightNativeTools(
        agent.session.snapshotEvents(),
        review?.startBoundarySeq ?? execution.startBoundarySeq ?? 0,
      );
    let ownedComplete = true;
    try {
      const live = this.host.native.jobs?.list(agent.id);
      ownedComplete =
        !!live &&
        !live.some(
          (job) => job.owner === agent.id && !ownedJobs().some((known) => known.id === job.id),
        );
    } catch {
      ownedComplete = false;
    }
    const associatedIds = ownedJobs().flatMap((job) => job.managedRanges.map((range) => range.id));
    if (sessionId && (this.host.unassociatedProcesses?.(sessionId, associatedIds) ?? 0) > 0)
      ownedComplete = false;
    const observation: StoppedObservation = {
      agentIdle: agent.status === 'idle',
      inFlightTools: calls.length > 0,
      filesStable: first.complete && second.complete ? first.digest === second.digest : null,
      fileFingerprint: second.digest,
      processesComplete:
        snapshot.complete &&
        ownedComplete &&
        jobObservations.every((job) => job.externalStatus === 'gone'),
      jobObservations,
      note: `两次范围指纹间隔至少300ms；${first.note}；${second.note}。仅覆盖可关联的进程与声明范围，未关联作业保持未知。`,
      observedAt: new Date().toISOString(),
      intervalMs: 300,
    };
    assertGoal();
    if (
      captureCheckpoint &&
      observation.agentIdle &&
      !observation.inFlightTools &&
      observation.filesStable &&
      observation.processesComplete
    ) {
      try {
        recoveryPaths(connection, execution);
        const norms = this.lastAppliedNorms(agent);
        if (!norms && execution.firstRequestId)
          throw new ProjectError('RECOVERY_UNREADABLE', '原会话缺少实际采用的规范来源记录');
        observation.checkpoint = buildRecoveryCheckpoint(
          connection,
          execution,
          second.manifest,
          norms ?? this.currentNorms(project, execution.id, agent),
        );
        for (const [sha, bytes] of originals)
          retainVersionOriginal(connection.versions().storage, sha, bytes);
      } catch (error) {
        delete observation.checkpoint;
        observation.note +=
          '；恢复比较基线未固定：' + (error instanceof Error ? error.message : '缺少有效记录');
      }
    }
    return observation;
  }
  private lastAppliedNorms(agent: NativeAgent): RecoveryCheckpoint['norms'] | undefined {
    const source = agent.session
      .deriveMessages()
      .findLast((message) => message.source.kind === 'mat-context')?.source;
    if (!Array.isArray(source?.sources)) return undefined;
    const rows = source.sources as RecoveryCheckpoint['norms'];
    if (!rows.every((row) => typeof row.path === 'string' && typeof row.sha256 === 'string'))
      return undefined;
    return rows.map(({ path, sha256 }) => ({ path, sha256 }));
  }
  private currentNorms(
    project: string,
    executionId: string,
    agent: NativeAgent,
  ): RecoveryCheckpoint['norms'] {
    const c = this.connection(project),
      e = c.executions().get(executionId);
    if (
      !e.sessionId ||
      e.nativeSessionId !== agent.id ||
      canonicalDirectory(this.host.native.workingDirectory.get(agent.session)) !== e.cwd
    )
      throw new ProjectError('RECOVERY_SCOPE_CHANGED', '原会话目录或绑定已变化');
    const session = c.session(e.sessionId),
      role = c.roles().find((row) => row.id === session.roleId);
    if (!role) throw new ProjectError('RECOVERY_UNREADABLE', '原角色规范入口缺失');
    return assembleContext(c.snapshot(), role, session, e.cwd).sources.map(({ path, sha256 }) => ({
      path,
      sha256,
    }));
  }
  recoveryPreview(project: string, id: string, offset = 0) {
    return this.readRecovery(project, id, this.connection(project).controls().revision(id), offset);
  }
  adjustScope(project: string, actor: WorkbenchActor, raw: unknown) {
    if (this.closed) throw new ProjectError('CONTROL_CLOSED', '执行控制正在关闭');
    return this.connection(project)
      .controls()
      .adjustScope(actor, raw, (execution, scopes) => {
        this.quietRecoveryAgent(project, execution.id);
        recoveryPaths(this.connection(project), execution);
        this.conflictGuard(project, execution.id, scopes);
      });
  }
  private quietRecoveryAgent(project: string, id: string) {
    const connection = this.connection(project),
      e = connection.executions().get(id),
      agent = e.sessionId ? this.host.peek(project, e.sessionId) : undefined,
      goal = agent && this.goals().get(agent),
      jobs = agent && this.host.native.jobs?.list(agent.id);
    if (
      !e.sessionId ||
      !agent ||
      !jobs ||
      agent.id !== e.nativeSessionId ||
      agent.status !== 'idle' ||
      !goal ||
      goal.id !== e.goalId ||
      goal.activation !== 'disarmed' ||
      goal.phase === 'complete' ||
      inFlightNativeTools(agent.session.snapshotEvents(), e.startBoundarySeq ?? 0).length ||
      jobs.some(
        (job) => job.owner === agent.id && !nativeTerminalJobStatuses.includes(job.status),
      ) ||
      (this.host.unassociatedProcesses?.(e.sessionId, []) ?? 0) > 0 ||
      connection
        .controls()
        .jobs(e.id)
        .some((job) => job.managedRanges.some((range) => range.state !== 'gone'))
    )
      throw new ProjectError(
        'RECOVERY_NATIVE_BUSY',
        '原会话身份、Goal、工具或受管范围仍未核定停稳',
      );
    return agent;
  }
  private readRecovery(
    project: string,
    id: string,
    revision: number,
    offset = 0,
    retain = false,
    admitted = false,
  ) {
    const c = this.connection(project),
      e = c.executions().get(id),
      controls = c.controls(),
      stop = controls.list(e.id).findLast((row) => ['hard-stop', 'soft-stop'].includes(row.action));
    if (
      (!admitted && (e.lifecycleState !== 'paused' || e.writeOccupancy !== 'released')) ||
      !stop ||
      stop.status !== 'stopped' ||
      !e.sessionId ||
      !e.goalId
    )
      throw new ProjectError('QUIESCENCE_REQUIRED', '原控制尚无已确认释放的停稳记录');
    const agent = this.quietRecoveryAgent(project, e.id);
    const { paths, excluded } = recoveryPaths(c, e);
    const options = { excluded, excludeGitMetadata: true };
    const files = fingerprintPaths(paths, {
      ...options,
      ...(retain
        ? {
            retain: (sha: string, bytes: Buffer) =>
              retainVersionOriginal(c.versions().storage, sha, bytes),
          }
        : {}),
    });
    if (!files.complete || fingerprintPaths(paths, options).digest !== files.digest)
      throw new ProjectError(
        'RECOVERY_UNREADABLE',
        '恢复范围无法完整读回或采样期间变化：' + files.note,
      );
    let norms: RecoveryCheckpoint['norms'];
    try {
      norms = this.currentNorms(project, id, agent);
    } catch (error) {
      throw new ProjectError(
        'RECOVERY_UNREADABLE',
        error instanceof Error ? error.message : '无法读取规范',
      );
    }
    const current = buildRecoveryCheckpoint(c, e, files.manifest, norms);
    return compareRecovery(
      e.id,
      revision,
      stop.id,
      stop.observation?.checkpoint,
      current,
      paths,
      offset,
    );
  }
  conflictGuard(project: string, executionId: string, scopes: string[]): void {
    for (const entry of this.projects.list()) {
      if ('unavailable' in entry) continue;
      const c = this.connection(entry.id),
        same = entry.id === project;
      c.executions().guardExistingScope(
        same ? executionId : '',
        scopes,
        same ? c.worktreeMerges().recoveryLink(executionId, scopes) : undefined,
      );
    }
  }
  private async resume(project: string, id: string): Promise<void> {
    const connection = this.connection(project),
      catalog = connection.controls(),
      value = this.current(project, id),
      execution = connection.executions().get(value.executionId);
    if (!execution.sessionId || !execution.goalId)
      throw new ProjectError(
        'RESUME_UNPREPARED',
        '原尝试尚无完整会话和Goal，不能猜测恢复或另建替代',
      );
    const agent = await this.host.openControlled(project, execution.sessionId);
    this.current(project, id);
    if (agent.id !== execution.nativeSessionId || agent.status !== 'idle')
      throw new ProjectError('RESUME_AGENT_BUSY', '原生身份不匹配或仍有在途工作，先核对');
    let goal = this.goals().get(agent);
    if (
      !goal ||
      goal.id !== execution.goalId ||
      goal.phase === 'complete' ||
      goal.activation !== 'disarmed'
    )
      throw new ProjectError(
        'RESUME_GOAL_UNCONFIRMED',
        '原Goal不可恢复或仍武装，不能复活或替换其他工作',
      );
    if (
      execution.mergeId &&
      !(await this.host.checkMergeRecovery?.(project, execution.id, execution.cwd))
    )
      throw new ProjectError('MERGE_RECOVERY_UNAVAILABLE', '未确认原Git交接，不能恢复关联执行');
    const recovery = this.readRecovery(project, execution.id, value.revision - 1, 0, true);
    if (
      recovery.hasChanges &&
      (value.reviewedRecoveryFingerprint !== recovery.fingerprint ||
        !value.actor.sessionId ||
        !execution.managerSessionIds.includes(value.actor.sessionId) ||
        connection.session(value.actor.sessionId).communicationState !== 'active')
    )
      throw new ProjectError(
        'RECOVERY_REVIEW_REQUIRED',
        '文件、规范、授权或依据有实质变化。由原管理入口读取本次恢复差异并明确确认。',
      );
    if (
      value.reviewedRecoveryFingerprint &&
      value.reviewedRecoveryFingerprint !== recovery.fingerprint
    )
      throw new ProjectError('RECOVERY_DRIFT', '恢复核对指纹已变化，请重新读取当前差异');
    const context = await this.host.freshContext(project, execution.sessionId, agent),
      ticket = connection.workbench().getTicket(execution.ticketId),
      snapshot = {
        ticketRevision: ticket.revision,
        goal: ticket.goal,
        included: ticket.included,
        excluded: ticket.excluded,
        context,
        recovery,
        unhandled: connection
          .messages()
          .pending(execution.sessionId)
          .map((saved) => ({
            id: saved.message.id,
            sender: saved.message.sender,
            state: saved.receipt.state,
          })),
        previousControls: catalog
          .list(execution.id)
          .map((item) => ({ id: item.id, action: item.action, status: item.status })),
      };
    this.current(project, id);
    catalog.resumeAdmitted(
      id,
      snapshot,
      this.dispatch.epoch,
      (current) => {
        this.conflictGuard(project, current.id, current.writeScopes);
        if (
          this.readRecovery(project, current.id, value.revision - 1).fingerprint !==
          recovery.fingerprint
        )
          throw new ProjectError('RECOVERY_DRIFT', '接纳前现场已变化，未恢复原Goal');
      },
      connection.executions().resolveDependencies(ticket.dependencies),
    );
    try {
      await this.communication.prepareResume(project, execution.sessionId, agent);
      this.current(project, id);
      if (agent.status !== 'idle')
        throw new ProjectError('RESUME_AGENT_BUSY', '准备期间出现其他在途工作，未继续恢复');
      if (
        this.readRecovery(project, execution.id, value.revision - 1, 0, false, true).fingerprint !==
        recovery.fingerprint
      )
        throw new ProjectError('RECOVERY_DRIFT', '准备输入后现场再次变化，未武装原Goal');
      const objective = this.dispatch.context(project, execution.sessionId, execution.cwd)?.message
        .content[0]?.text;
      if (!objective) throw new ProjectError('EXECUTION_CONTEXT_MISSING', '最新执行输入不可取得');
      goal = this.goals().get(agent);
      if (!goal || goal.id !== execution.goalId)
        throw new ProjectError('RESUME_GOAL_UNCONFIRMED', '准备期间Goal身份变化');
      if (goal.objective !== objective)
        goal = this.goals().edit(agent, { id: goal.id, revision: goal.revision }, { objective });
      const saved = connection.messages().recordControl(id, 'resume');
      catalog.setStatus(id, 'resumed');
      this.goals().resume(agent, { id: goal.id, revision: goal.revision });
      agent.steer(presentMessage(saved));
      connection.messages().recordMemoryAccepted(saved.message.id);
      if (!(await this.host.native.sessions.flush(agent.session)))
        throw new ProjectError(
          'RESUME_DURABILITY_UNCONFIRMED',
          '恢复已请求但持久回执未知，保留原身份核对',
        );
      connection.messages().recordDurableAccepted(saved.message.id);
      catalog.receipt(id, 'goal', {
        state: 'confirmed',
        goalId: goal.id,
        note: '沿原Goal明确恢复；实际模型请求与步骤另行观察',
      });
    } catch (error) {
      try {
        if (this.goals().get(agent)?.id === execution.goalId) this.goals().disarm(agent);
      } catch {
        /* Preserve unknown if native control is unavailable. */
      }
      throw error;
    }
  }
  admission(project: string, sessionId: string): boolean {
    const connection = this.connection(project),
      session = connection.session(sessionId);
    if (session.communicationState !== 'active') return false;
    const assistant = connection.collaborations().currentForSession(sessionId);
    if (assistant) {
      const scope = connection.collaborations().scopeForSession(sessionId);
      return (
        !!scope?.allowWrite &&
        (scope.shutdownOnly === true ||
          (connection.snapshot().started && connection.controls().project().state === 'running'))
      );
    }
    const execution = connection.executions().currentForSession(sessionId);
    if (execution) {
      const control = connection.controls().activeControl(execution.id);
      if (control?.action === 'resume' && control.status !== 'resumed') return false;
      return execution.lifecycleState === 'active' && !execution.failure;
    }
    return connection.snapshot().started && connection.controls().project().state === 'running';
  }
  query(project: string, executionId: string) {
    const catalog = this.connection(project).controls();
    return {
      revision: catalog.revision(executionId),
      controls: catalog.publicList(executionId),
      jobs: catalog.jobs(executionId),
      assistantTargets: this.connection(project).assistantControls().forExecution(executionId),
      assistants: this.connection(project).assistantControls().inventory(executionId),
    };
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.allSettled([
      ...this.queues.values(),
      ...this.runs.values(),
      ...(this.sample ? [this.sample] : []),
    ]);
  }
}
