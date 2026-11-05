import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { ProjectService } from '../业务/项目服务.ts';
import { ProjectError } from '../业务/项目.ts';
import { initializeSchema } from '../契约/项目.ts';
const attachment = z.object({ root: z.string().min(1) }).strict();
export function createApplication(service: ProjectService, assetsDirectory?: string): Hono {
  const app = new Hono();
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      return c.json({ code: 'INVALID_HOST', message: '请从本机控制台地址访问' }, 403);
    const origin = c.req.header('origin');
    if (origin && origin !== url.origin)
      return c.json({ code: 'FOREIGN_ORIGIN', message: '命令必须来自当前控制台' }, 403);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof ProjectError)
      return c.json({ code: error.code, message: error.message }, 409);
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json({ code: 'INVALID_INPUT', message: '请核对项目根、名称及主管执行配置' }, 400);
    return c.json({ code: 'OPERATION_FAILED', message: error.message }, 400);
  });
  app.get('/api/projects', (c) => c.json(service.list()));
  app.post('/api/projects', async (c) => {
    const data = initializeSchema.parse(await c.req.json());
    const supervisor = {
      provider: data.supervisor.provider,
      model: data.supervisor.model,
      ...(data.supervisor.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: data.supervisor.reasoningEffort }),
    };
    return c.json(service.create({ root: data.root, name: data.name, supervisor }), 201);
  });
  app.post('/api/projects/attach', async (c) =>
    c.json(service.attach(attachment.parse(await c.req.json()).root)),
  );
  app.all('/api/*', (c) => c.json({ code: 'NOT_FOUND', message: '接口不存在' }, 404));
  if (assetsDirectory) {
    app.use('*', serveStatic({ root: assetsDirectory }));
    app.get('*', serveStatic({ path: `${assetsDirectory}/index.html` }));
  }
  return app;
}
