import { Hono } from 'hono';
import type { ProjectService } from '../services/project-service.ts';
import type { SessionRuntime } from '../host/session-runtime.ts';
import { reviewConfigurationSchema, reviewRetrySchema } from '../contracts/completion.ts';
import { ProjectError } from '../services/errors.ts';
export function createReviewRoutes(service: ProjectService, runtime?: SessionRuntime): Hono {
  const app = new Hono();
  app.get('/:project/review-settings', (c) =>
    c.json(
      service.forProject(c.req.param('project')).reviews().configuration(c.req.query('ticketId')),
    ),
  );
  app.put('/:project/review-settings', async (c) =>
    c.json(
      service
        .forProject(c.req.param('project'))
        .reviews()
        .configure({ kind: 'user' }, reviewConfigurationSchema.parse(await c.req.json())),
    ),
  );
  app.get('/:project/reviews', (c) =>
    c.json(service.forProject(c.req.param('project')).reviews().list(c.req.query('executionId'))),
  );
  app.get('/:project/reviews/:review', (c) => {
    const project = c.req.param('project'),
      id = c.req.param('review'),
      connection = service.forProject(project);
    if (runtime?.completions) return c.json(runtime.completions.query(project, id));
    const review = connection.reviews().get(id),
      completion = connection.reviews().completion(review.completionId);
    return c.json({
      review,
      completion,
      task: connection.workbench().getTask(completion.taskId),
      versions: connection.versions().headers(review.executionId),
      requests: review.sessionId ? connection.requests(review.sessionId) : [],
      native: { loaded: false, status: null, goal: null, goalError: null },
    });
  });
  app.post('/:project/reviews/:review/retry', async (c) => {
    if (!runtime?.completions) throw new ProjectError('HOST_UNAVAILABLE', '宿主未连接交回服务');
    return c.json(
      runtime.completions.retry(
        c.req.param('project'),
        { kind: 'user' },
        c.req.param('review'),
        reviewRetrySchema.parse(await c.req.json()),
      ),
      202,
    );
  });
  return app;
}
