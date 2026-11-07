import { Hono } from 'hono';
import { z } from 'zod';
import type { ProjectService } from '../services/project-service.ts';
import type { SessionRuntime } from '../host/session-runtime.ts';
import { decisionReplySchema } from '../contracts/decision-requests.ts';
import { ProjectError } from '../services/errors.ts';
export function createDecisionRequestRoutes(projects: ProjectService, runtime?: SessionRuntime) {
  const app = new Hono(),
    user = { kind: 'user' as const };
  app.get('/:project/decision-requests', (c) => {
    const catalog = projects.forProject(c.req.param('project')).decisionRequests(),
      scope = z.enum(['mine', 'related']).parse(c.req.query('scope') ?? 'mine');
    return c.json(scope === 'mine' ? catalog.pending(user) : catalog.list(user));
  });
  app.get('/:project/decision-requests/:request', (c) => {
    const catalog = projects.forProject(c.req.param('project')).decisionRequests(),
      id = z.uuid().parse(c.req.param('request'));
    return c.json({ request: catalog.get(user, id), notices: catalog.notices(id) });
  });
  app.post('/:project/decision-requests/:request/reply', async (c) => {
    if (!runtime?.decisionRequests)
      throw new ProjectError('HOST_UNAVAILABLE', '宿主未连接请求办理服务');
    return c.json(
      await runtime.decisionRequests.act(
        c.req.param('project'),
        user,
        'reply',
        z.uuid().parse(c.req.param('request')),
        decisionReplySchema.parse(await c.req.json()),
      ),
      201,
    );
  });
  app.post('/:project/decision-requests/:request/retry-notices', async (c) => {
    if (!runtime?.decisionRequests)
      throw new ProjectError('HOST_UNAVAILABLE', '宿主未连接请求办理服务');
    z.object({ operationId: z.uuid() })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await runtime.decisionRequests.retry(
        c.req.param('project'),
        user,
        z.uuid().parse(c.req.param('request')),
      ),
      202,
    );
  });
  return app;
}
