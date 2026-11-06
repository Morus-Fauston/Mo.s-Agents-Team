import type { ProjectService } from './project-service.ts';
import type { CommunicationService } from './chat-service.ts';
import type { DispatchService } from './dispatch-service.ts';
import type { WorkbenchActor } from '../contracts/workbench.ts';
import { ProjectError } from './errors.ts';
export class AcceptanceService {
  private readonly projects: ProjectService;
  private readonly communication: CommunicationService;
  private readonly dispatch: DispatchService;
  private readonly jobs = new Map<string, Promise<void>>();
  private closed = false;
  constructor(
    projects: ProjectService,
    communication: CommunicationService,
    dispatch: DispatchService,
  ) {
    this.projects = projects;
    this.communication = communication;
    this.dispatch = dispatch;
  }
  query(project: string, ticketId: string) {
    const c = this.projects.forProject(project),
      catalog = c.acceptance(),
      ticket = c.workbench().getTicket(ticketId);
    return {
      ticketId: ticket.id,
      state: ticket.state,
      assignments: catalog
        .assignments(ticket.id)
        .map((assignment) => ({ assignment, result: catalog.recordFor(assignment.id) ?? null })),
      accepted: catalog.accepted(ticket.id),
      supplements: catalog.supplements(ticket.id),
      escalations: catalog.escalations(ticket.id),
      notices: catalog.notices(ticket.id),
    };
  }
  act(
    project: string,
    actor: WorkbenchActor,
    kind: 'assign' | 'record' | 'complete' | 'supplement' | 'escalate',
    input: unknown,
  ) {
    if (this.closed) throw new ProjectError('ACCEPTANCE_CLOSED', '验收服务正在关闭');
    const catalog = this.projects.forProject(project).acceptance();
    const result =
      kind === 'supplement'
        ? this.dispatch.supplement(project, actor, input)
        : kind === 'escalate'
          ? catalog.escalate(actor, input)
          : kind === 'assign'
            ? catalog.assign(actor, input)
            : kind === 'record'
              ? catalog.record(actor, input)
              : catalog.complete(actor, input);
    this.publish(project);
    return result;
  }
  publish(project: string) {
    if (this.closed) return;
    const catalog = this.projects.forProject(project).acceptance();
    for (const notice of catalog.notices().filter((item) => item.state !== 'saved')) {
      if (this.jobs.has(notice.id)) continue;
      const run = Promise.resolve().then(async () => {
        try {
          await this.communication.sendAcceptanceNotice(project, notice.id);
          catalog.notified(notice.id, 'saved', null);
        } catch (error) {
          catalog.notified(
            notice.id,
            'unavailable',
            error instanceof Error ? error.message : '通知未确认',
          );
        }
      });
      this.jobs.set(notice.id, run);
      void run.finally(() => this.jobs.delete(notice.id)).catch(() => {});
    }
  }
  async close() {
    this.closed = true;
    await Promise.allSettled([...this.jobs.values()]);
  }
}
