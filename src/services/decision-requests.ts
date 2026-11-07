import type { WorkbenchActor } from '../contracts/workbench.ts';
import type { DecisionRequest } from '../contracts/decision-requests.ts';
import type { ProjectService } from './project-service.ts';
import type { CommunicationService } from './chat-service.ts';
import type { CollaborationResultsService } from './collaboration-results-service.ts';
import { ProjectError } from './errors.ts';

export class DecisionRequestService {
  private readonly projects: ProjectService;
  private readonly communication: CommunicationService;
  private readonly results: Pick<CollaborationResultsService, 'reconcileExecution'>;
  private readonly runs = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    projects: ProjectService,
    communication: CommunicationService,
    results: Pick<CollaborationResultsService, 'reconcileExecution'>,
  ) {
    this.projects = projects;
    this.communication = communication;
    this.results = results;
  }
  async act(
    project: string,
    actor: WorkbenchActor,
    action: 'create' | 'reply' | 'escalate' | 'supplement' | 'withdraw',
    id: string | undefined,
    input: unknown,
  ): Promise<DecisionRequest> {
    if (this.closed) throw new ProjectError('DECISION_CLOSED', '决定请求服务正在关闭');
    const c = this.projects.forProject(project),
      catalog = c.decisionRequests();
    let r: DecisionRequest;
    if (action === 'create') r = catalog.create(actor, input);
    else {
      if (!id) throw new ProjectError('DECISION_ID_REQUIRED', '动作须绑定原请求ID');
      r = catalog[action](actor, id, input);
    }
    await this.deliver(project, r.id);
    return catalog.get(actor, r.id);
  }
  async retry(project: string, actor: WorkbenchActor, id: string): Promise<DecisionRequest> {
    this.projects.forProject(project).decisionRequests().get(actor, id);
    await this.deliver(project, id);
    return this.projects.forProject(project).decisionRequests().get(actor, id);
  }
  private async deliver(project: string, id: string): Promise<void> {
    if (this.closed) throw new ProjectError('DECISION_CLOSED', '决定请求服务正在关闭');
    const key = project + ':' + id,
      prior = this.runs.get(key) ?? Promise.resolve();
    const run = prior
      .catch(() => {})
      .then(async () => {
        const c = this.projects.forProject(project),
          catalog = c.decisionRequests();
        for (const n of catalog.notices(id)) {
          const current = catalog.record(id);
          // An old prompt is never sent again as if it were a new pending action.
          if (n.revision !== current.revision) continue;
          try {
            const staged = await this.communication.stageDecisionNotice(project, n.id);
            if (n.target.kind === 'user') {
              catalog.noticeDelivery(n.id, 'ui-only', '仅保存用户可见通知，不代表已读或答复');
              continue;
            }
            if (staged.receipt.durableAcceptedAt === null) {
              catalog.noticeDelivery(
                n.id,
                'held',
                staged.receipt.error ?? '原入口尚未确认持久接纳',
              );
              continue;
            }
            catalog.noticeDelivery(n.id, 'durable', null);
            if (catalog.record(id).revision !== n.revision) continue;
            if (n.kind === 'reply' && n.target.sessionId && current.collaborationId)
              c.collaborations().resumeForDecision(current.id);
            await this.results.reconcileExecution(project, current.executionId);
            if (catalog.record(id).revision !== n.revision) continue;
            const target = c.session(n.target.sessionId!),
              main = c.executions().currentForSession(target.id),
              helper = c.collaborations().currentForSession(target.id);
            if (
              target.status === 'bound' &&
              target.communicationState === 'active' &&
              !target.error &&
              (target.roleType === 'supervisor' ||
                (main?.lifecycleState === 'active' &&
                  c.executions().scopeForSession(target.id)?.allowAssist) ||
                (helper && c.collaborations().scopeForSession(target.id)?.allowWrite))
            )
              await this.communication.sendDecisionNotice(project, n.id);
          } catch (error) {
            catalog.noticeDelivery(
              n.id,
              'failed',
              error instanceof Error ? error.message : '原通知投递待核对',
            );
          }
        }
      });
    this.runs.set(key, run);
    try {
      await run;
    } finally {
      if (this.runs.get(key) === run) this.runs.delete(key);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.runs.values()]);
  }
}
