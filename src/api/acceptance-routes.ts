import { Hono } from 'hono';
import type { ProjectService } from '../services/project-service.ts';
import type { SessionRuntime } from '../host/session-runtime.ts';
import { acceptanceRecordInputSchema } from '../contracts/acceptance.ts';
import { reviewResultRetrySchema } from '../contracts/review-results.ts';
import { ProjectError } from '../services/errors.ts';
export function createAcceptanceRoutes(service: ProjectService, runtime?: SessionRuntime) {
  const app = new Hono();
  app.get('/:project/review-results', (c) =>
    c.json(
      service.forProject(c.req.param('project')).reviewResults().list(c.req.query('executionId')),
    ),
  );
  app.get('/:project/review-results/:result', (c) => {
    const project = c.req.param('project'),
      id = c.req.param('result');
    return c.json(
      runtime?.reviewResults
        ? runtime.reviewResults.query(project, id)
        : { result: service.forProject(project).reviewResults().get(id) },
    );
  });
  app.post('/:project/review-results/:result/retry', async (c) => {
    if (!runtime?.reviewResults)
      throw new ProjectError('HOST_UNAVAILABLE', '宿主未连接正式结果服务');
    return c.json(
      runtime.reviewResults.retry(
        c.req.param('project'),
        { kind: 'user' },
        c.req.param('result'),
        reviewResultRetrySchema.parse(await c.req.json()),
      ),
      202,
    );
  });
  app.get('/:project/tickets/:ticket/acceptance', (c) => {
    const project = c.req.param('project'),
      id = c.req.param('ticket');
    if (runtime?.acceptance) return c.json(runtime.acceptance.query(project, id));
    const connection = service.forProject(project),
      catalog = connection.acceptance(),
      ticket = connection.workbench().getTicket(id);
    return c.json({
      ticketId: ticket.id,
      state: ticket.state,
      assignments: catalog
        .assignments(ticket.id)
        .map((assignment) => ({ assignment, result: catalog.recordFor(assignment.id) ?? null })),
      accepted: catalog.accepted(ticket.id),
      supplements: catalog.supplements(ticket.id),
      escalations: catalog.escalations(ticket.id),
      notices: catalog.notices(ticket.id),
    });
  });
  app.post('/:project/acceptance-results', async (c) => {
    if (!runtime?.acceptance) throw new ProjectError('HOST_UNAVAILABLE', '宿主未连接验收办理服务');
    return c.json(
      runtime.acceptance.act(
        c.req.param('project'),
        { kind: 'user' },
        'record',
        acceptanceRecordInputSchema.parse(await c.req.json()),
      ),
      201,
    );
  });
  return app;
}
