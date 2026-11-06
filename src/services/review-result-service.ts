import { setTimeout as delay } from 'node:timers/promises';
import { reviewOpinionSchema } from '../contracts/review-results.ts';
import { ProjectError } from './errors.ts';
import type { WorkbenchActor } from '../contracts/workbench.ts';
import type { ProjectService } from './project-service.ts';
import type { CommunicationService } from './chat-service.ts';
import type { NativeAgent, NativeContext } from '../host/native.ts';
import type { StoppedObservation } from '../contracts/controls.ts';
export interface ReviewResultHost {
  native: NativeContext;
  epoch: string;
  peek(project: string, session: string): NativeAgent | undefined;
  openControlled(project: string, session: string): Promise<NativeAgent>;
  settleReviewer(project: string, reviewId: string): Promise<void>;
  inspectMain(
    project: string,
    executionId: string,
    agent: NativeAgent,
    afterClear: boolean,
  ): Promise<StoppedObservation>;
  freshExecution(
    project: string,
    sessionId: string,
    agent: NativeAgent,
  ): Promise<{ objective: string; version: string }>;
  assertWriteScope(project: string, executionId: string, scopes: string[]): void;
}
const at = () => new Date().toISOString();
export class ReviewResultService {
  private readonly projects: ProjectService;
  private readonly communication: CommunicationService;
  private readonly host: ReviewResultHost;
  private readonly runs = new Map<string, Promise<void>>();
  private readonly notices = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    projects: ProjectService,
    communication: CommunicationService,
    host: ReviewResultHost,
  ) {
    this.projects = projects;
    this.communication = communication;
    this.host = host;
  }
  private connection(project: string) {
    return this.projects.forProject(project);
  }
  private goals() {
    if (!this.host.native.goals)
      throw new ProjectError('HOST_GOALS_UNAVAILABLE', '原生Goal服务不可核对');
    return this.host.native.goals;
  }
  private current(project: string, id: string) {
    if (this.closed) throw new ProjectError('REVIEW_RESULT_CLOSED', '审计结果协调正在关闭');
    return this.connection(project).reviewResults().current(id);
  }
  private sameGoal(
    agent: NativeAgent,
    nativeId: string | null,
    goalId: string | null,
    allowMissing = false,
  ) {
    if (agent.id !== nativeId || !goalId)
      throw new ProjectError('REVIEW_RESULT_BINDING', '实际Agent不是原执行或审核身份');
    const goal = this.goals().get(agent);
    if (!goal && allowMissing) return undefined;
    if (!goal || goal.id !== goalId)
      throw new ProjectError('REVIEW_RESULT_GOAL_CHANGED', '当前Goal不是原Goal，不控制其他工作');
    return goal;
  }
  submit(project: string, session: string, agent: NativeAgent, raw: unknown) {
    if (this.closed) throw new ProjectError('REVIEW_RESULT_CLOSED', '审计结果协调正在关闭');
    const connection = this.connection(project),
      catalog = connection.reviewResults(),
      input = reviewOpinionSchema.parse(raw);
    if (
      this.host.peek(project, session) !== agent ||
      connection.session(session).nativeSessionId !== agent.id
    )
      throw new ProjectError('REVIEW_RESULT_CALLER', '正式意见只能来自实际绑定调用Agent');
    const prior = catalog.byOperation(input.operationId);
    if (!prior) {
      const review = connection.reviews().current(input.reviewId),
        goal = this.sameGoal(agent, review.nativeSessionId, review.goalId);
      if (review.sessionId !== session || goal?.phase !== 'active' || goal.activation !== 'armed')
        throw new ProjectError('REVIEW_RESULT_GOAL_INACTIVE', '不是当前指定独审的有效Goal');
    }
    const saved = catalog.submit({ kind: 'session', sessionId: session }, input);
    this.publish(project, saved.id);
    if (!prior) {
      try {
        this.pauseReviewer(project, saved.id, agent);
        this.queue(project, saved.id);
      } catch (error) {
        catalog.progress(saved.id, 'progress', {
          state: 'unknown',
          note: error instanceof Error ? error.message : '审核挂起未知',
          at: at(),
        });
      }
    }
    return catalog.get(saved.id);
  }
  private pauseReviewer(project: string, id: string, agent: NativeAgent) {
    const result = this.current(project, id),
      review = this.connection(project).reviews().get(result.reviewId);
    this.sameGoal(agent, review.nativeSessionId, review.goalId);
    this.goals().disarm(agent);
    this.current(project, id);
    let goal = this.sameGoal(agent, review.nativeSessionId, review.goalId)!;
    if (goal.phase === 'active')
      this.goals().pause(agent, { id: goal.id, revision: goal.revision });
    goal = this.sameGoal(agent, review.nativeSessionId, review.goalId)!;
    if (goal.phase === 'active' || goal.activation !== 'disarmed')
      throw new ProjectError('REVIEW_RESULT_PAUSE_UNKNOWN', '原独审Goal挂起尚未确认');
  }
  retry(project: string, actor: WorkbenchActor, id: string, raw: unknown) {
    if (this.closed) throw new ProjectError('REVIEW_RESULT_CLOSED', '结果协调正在关闭');
    if (this.runs.has(id))
      throw new ProjectError('REVIEW_RESULT_BUSY', '原结果动作尚未结束，先查询原进展');
    const saved = this.connection(project).reviewResults().retry(actor, id, raw);
    if (saved.enqueue) {
      this.publish(project, id);
      this.queue(project, id);
    }
    return saved.result;
  }
  private queue(project: string, id: string) {
    if (this.runs.has(id)) return;
    const job = Promise.resolve().then(() => this.run(project, id));
    this.runs.set(id, job);
    void job
      .finally(() => {
        if (this.runs.get(id) === job) this.runs.delete(id);
      })
      .catch(() => {});
  }
  private async run(project: string, id: string) {
    const connection = this.connection(project),
      catalog = connection.reviewResults();
    try {
      let result = this.current(project, id),
        review = connection.reviews().get(result.reviewId);
      const reviewer = await this.host.openControlled(project, review.sessionId!);
      this.current(project, id);
      this.pauseReviewer(project, id, reviewer);
      for (let n = 0; n < 30 && reviewer.status !== 'idle'; n++) {
        await delay(100);
        this.current(project, id);
      }
      await this.host.settleReviewer(project, review.id);
      this.current(project, id);
      review = connection.reviews().get(review.id);
      const goal = this.sameGoal(reviewer, review.nativeSessionId, review.goalId)!;
      if (
        review.control?.state !== 'confirmed' ||
        goal.phase === 'active' ||
        goal.activation !== 'disarmed'
      )
        throw new ProjectError(
          'REVIEW_RESULT_NOT_QUIET',
          '审核自身作业或材料范围尚未核清，不接续作者',
        );
      connection.reviews().closeAfterResult(review.id, goal.id, reviewer.id);
      catalog.progress(id, 'reviewCleanup', {
        state: 'confirmed',
        note: '指定独审已停稳并退出普通活跃入口，保留原Goal及记录',
        at: at(),
      });
      result = this.current(project, id);
      const execution = connection.executions().get(result.executionId),
        agent = await this.host.openControlled(project, execution.sessionId!);
      this.current(project, id);
      let original = this.sameGoal(
        agent,
        execution.nativeSessionId,
        execution.goalId,
        result.verdict === 'pass' && result.authorGoalClear !== null,
      );
      if (
        result.verdict === 'return' &&
        execution.reviewResultId === result.id &&
        result.authorAction.state === 'prepared' &&
        original?.phase === 'active' &&
        original.activation === 'armed'
      ) {
        if (!(await this.host.native.sessions.flush(agent.session)))
          throw new ProjectError('REVIEW_RETURN_DURABILITY', '原Goal接续持久回执未知');
        this.current(project, id);
        this.confirmReturn(project, id, agent);
        return;
      }
      if (original && (original.phase === 'active' || original.activation !== 'disarmed'))
        throw new ProjectError('REVIEW_AUTHOR_UNCONFIRMED', '原作者Goal尚未处于已挂起状态');
      const observation = await this.host.inspectMain(project, execution.id, agent, !original);
      this.current(project, id);
      this.sameGoal(agent, execution.nativeSessionId, execution.goalId, !original);
      catalog.authorObserved(id, observation);
      if (!catalog.mainIsQuiet(id))
        throw new ProjectError('REVIEW_AUTHOR_NOT_QUIET', '原作者作业及声明范围尚未核清');
      if (result.verdict === 'pass') {
        if (original) {
          catalog.progress(id, 'authorGoalClear', {
            state: 'prepared',
            note: '只清本次通过交付的原Goal；持久化和独立缺失另验',
            at: at(),
          });
          original = this.sameGoal(agent, execution.nativeSessionId, execution.goalId)!;
          this.goals().clear(agent, { id: original.id, revision: original.revision });
        }
        if (!(await this.host.native.sessions.flush(agent.session)))
          throw new ProjectError('REVIEW_CLEAR_DURABILITY', '原Goal清除持久回执未知');
        this.current(project, id);
        if (this.sameGoal(agent, execution.nativeSessionId, execution.goalId, true))
          throw new ProjectError('REVIEW_CLEAR_UNCONFIRMED', '原Goal仍存在，不能收尾或清其他Goal');
        const afterClear = await this.host.inspectMain(project, execution.id, agent, true);
        this.current(project, id);
        if (this.sameGoal(agent, execution.nativeSessionId, execution.goalId, true))
          throw new ProjectError('REVIEW_CLEAR_UNCONFIRMED', '观察期间出现Goal，未清新目标');
        catalog.authorObserved(id, afterClear);
        if (!catalog.mainIsQuiet(id))
          throw new ProjectError('REVIEW_AUTHOR_NOT_QUIET', '清除后原执行仍未独立停稳');
        catalog.progress(id, 'authorGoalClear', {
          state: 'confirmed',
          note: '原Goal已清除、持久化且独立缺失及停稳均核对',
          at: at(),
        });
        catalog.closeMain(id);
      } else {
        const fresh = await this.host.freshExecution(project, execution.sessionId!, agent);
        this.current(project, id);
        await this.communication.prepareResume(project, execution.sessionId!, agent);
        this.current(project, id);
        if (agent.status !== 'idle')
          throw new ProjectError('REVIEW_RETURN_BUSY', '原作者仍有在途工作');
        original = this.sameGoal(agent, execution.nativeSessionId, execution.goalId)!;
        if (original.phase !== 'paused' || original.activation !== 'disarmed')
          throw new ProjectError('REVIEW_RETURN_GOAL_CHANGED', '准备后原Goal挂起状态变化');
        catalog.admitReturn(id, this.host.epoch, () =>
          this.host.assertWriteScope(project, execution.id, execution.writeScopes),
        );
        if (original.objective !== fresh.objective)
          this.goals().edit(
            agent,
            { id: original.id, revision: original.revision },
            { objective: fresh.objective },
          );
        this.current(project, id);
        original = this.sameGoal(agent, execution.nativeSessionId, execution.goalId)!;
        this.goals().resume(agent, { id: original.id, revision: original.revision });
        this.activeAuthor(project, id, agent);
        if (!(await this.host.native.sessions.flush(agent.session)))
          throw new ProjectError('REVIEW_RETURN_DURABILITY', '原Goal接续已请求但持久回执未知');
        this.current(project, id);
        this.confirmReturn(project, id, agent);
      }
    } catch (error) {
      if (!this.closed) {
        // Only a still-current return may be conservatively disarmed. Newer reviews/Goals are untouched.
        try {
          const result = this.current(project, id),
            execution = connection.executions().get(result.executionId),
            agent = execution.sessionId ? this.host.peek(project, execution.sessionId) : undefined;
          if (result.verdict === 'return' && execution.reviewResultId === id && agent) {
            const goal = this.sameGoal(agent, execution.nativeSessionId, execution.goalId);
            if (goal) {
              this.goals().disarm(agent);
              const current = this.sameGoal(agent, execution.nativeSessionId, execution.goalId)!;
              if (current.phase === 'active')
                this.goals().pause(agent, { id: current.id, revision: current.revision });
            }
          }
        } catch {
          /* A changed authority or Goal is not ours to control. */
        }
        catalog.progress(id, 'progress', {
          state: 'unknown',
          note: error instanceof Error ? error.message : '结果协调未确认',
          at: at(),
        });
      }
    } finally {
      if (!this.closed) this.publish(project, id);
    }
  }
  private activeAuthor(project: string, id: string, agent: NativeAgent) {
    const result = this.current(project, id),
      execution = this.connection(project).executions().get(result.executionId),
      goal = this.sameGoal(agent, execution.nativeSessionId, execution.goalId)!;
    if (goal.phase !== 'active' || goal.activation !== 'armed')
      throw new ProjectError('REVIEW_RETURN_UNCONFIRMED', '原Goal尚未实际接续，不登记成功');
  }
  private confirmReturn(project: string, id: string, agent: NativeAgent) {
    this.activeAuthor(project, id, agent);
    const catalog = this.connection(project).reviewResults(),
      progress = {
        state: 'confirmed' as const,
        note: '沿原Agent原Goal实际接续且持久接纳；同次返修，未新开尝试',
        at: at(),
      };
    catalog.progress(id, 'authorAction', progress);
    catalog.progress(id, 'progress', progress);
  }
  private publish(project: string, id: string) {
    if (this.closed || this.notices.has(id)) return;
    const job = this.notify(project, id);
    this.notices.set(id, job);
    void job
      .finally(() => {
        if (this.notices.get(id) === job) this.notices.delete(id);
      })
      .catch(() => {});
  }
  private async notify(project: string, id: string) {
    const catalog = this.connection(project).reviewResults();
    for (const notice of catalog.get(id).notifications) {
      if (notice.progress.state === 'confirmed') continue;
      try {
        const saved = await this.communication.sendReviewResult(project, id, notice.messageId);
        catalog.notified(id, notice.targetSessionId, {
          state: saved.receipt.durableAcceptedAt
            ? 'confirmed'
            : saved.receipt.state === 'unknown'
              ? 'unknown'
              : 'prepared',
          note: '正式结果通知持久接纳与业务办理分别记录',
          at: at(),
        });
      } catch (error) {
        catalog.notified(id, notice.targetSessionId, {
          state: 'unknown',
          note: error instanceof Error ? error.message : '结果通知未知',
          at: at(),
        });
      }
    }
  }
  admission(project: string, session: string, agent: NativeAgent): boolean {
    const connection = this.connection(project),
      execution = connection.executions().currentForSession(session);
    if (!execution?.reviewResultId) return true;
    try {
      const result = this.current(project, execution.reviewResultId);
      if (result.authorAction.state === 'confirmed') return true;
      if (result.authorAction.state !== 'prepared') return false;
      this.activeAuthor(project, result.id, agent);
      return true;
    } catch {
      return false;
    }
  }
  query(project: string, id?: string) {
    const connection = this.connection(project),
      catalog = connection.reviewResults();
    if (!id) return catalog.list();
    const result = catalog.get(id),
      execution = connection.executions().get(result.executionId);
    return {
      result,
      review: connection.reviews().get(result.reviewId),
      execution,
      versions: connection.versions().headers(result.executionId),
      nativeLoaded: {
        author: !!execution.sessionId && !!this.host.peek(project, execution.sessionId),
      },
    };
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.runs.values(), ...this.notices.values()]);
  }
}
