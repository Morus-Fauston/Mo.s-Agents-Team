import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { ProjectService } from '../业务/项目服务.ts';
import { ProjectError } from '../业务/项目.ts';
import { initializeSchema } from '../契约/项目.ts';
import { roleInputSchema, roleUpdateSchema } from '../契约/角色.ts';
import { sessionInputSchema } from '../契约/会话.ts';
import { resolveSkillSources } from '../业务/Skill来源.ts';
import type { SessionRuntime } from '../宿主/会话装配.ts';
const attachment = z.object({ root: z.string().min(1) }).strict();
export function createApplication(
  service: ProjectService,
  assetsDirectory?: string,
  runtime?: SessionRuntime,
): Hono {
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
  app.get('/api/runtime', (c) =>
    c.json({
      available: !!runtime,
      message: runtime
        ? 'DSH会话装配已连接'
        : '当前控制台未连接原生预设及会话服务，可维护登记，不能创建工作会话',
    }),
  );
  app.get('/api/projects/:project/roles', (c) =>
    c.json(service.forProject(c.req.param('project')).roles()),
  );
  app.post('/api/projects/:project/roles', async (c) =>
    c.json(
      service
        .forProject(c.req.param('project'))
        .registerRole(roleInputSchema.parse(await c.req.json())),
      201,
    ),
  );
  app.patch('/api/projects/:project/roles/:role', async (c) =>
    c.json(
      service
        .forProject(c.req.param('project'))
        .updateRole(c.req.param('role'), roleUpdateSchema.parse(await c.req.json())),
    ),
  );
  app.get('/api/projects/:project/settings', (c) =>
    c.json({ skillSourceRoot: service.forProject(c.req.param('project')).skillSourceRoot() }),
  );
  app.put('/api/projects/:project/settings', async (c) => {
    const input = z
      .object({ skillSourceRoot: z.string().min(1) })
      .strict()
      .parse(await c.req.json());
    for (const type of [
      'supervisor',
      'developer',
      'investigator',
      'reviewer',
      'committer',
    ] as const)
      resolveSkillSources(input.skillSourceRoot, type);
    const connection = service.forProject(c.req.param('project'));
    connection.setSkillSourceRoot(input.skillSourceRoot);
    return c.json({
      skillSourceRoot: connection.skillSourceRoot(),
      effect: '供新建会话使用；不热改已有会话来源目录',
    });
  });
  app.get('/api/projects/:project/sessions', (c) =>
    c.json(service.forProject(c.req.param('project')).sessions()),
  );
  app.post('/api/projects/:project/sessions', async (c) => {
    if (!runtime)
      throw new ProjectError('HOST_UNAVAILABLE', '当前宿主未连接会话装配服务，不创建替代执行器');
    return c.json(
      await runtime.create(c.req.param('project'), sessionInputSchema.parse(await c.req.json())),
      201,
    );
  });
  app.get('/api/projects/:project/sessions/:session/configuration', (c) => {
    const project = c.req.param('project'),
      session = c.req.param('session');
    if (runtime) return c.json(runtime.configuration(project, session));
    const connection = service.forProject(project);
    const record = connection.session(session);
    return c.json({
      session: record,
      defaultConfiguration: connection.roles().find((r) => r.id === record.roleId)!.configuration,
      requestedConfiguration: record.configuration,
      nativeLoaded: false,
      actualPreset: null,
      registeredTools: null,
      requests: connection.requests(session),
      message: '仅查询持久记录；未运行的实际配置不推定已生效',
    });
  });
  app.all('/api/*', (c) => c.json({ code: 'NOT_FOUND', message: '接口不存在' }, 404));
  if (assetsDirectory) {
    app.use('*', serveStatic({ root: assetsDirectory }));
    app.get('*', serveStatic({ path: `${assetsDirectory}/index.html` }));
  }
  return app;
}
