import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { z } from 'zod';
import { ProjectService } from '../services/project-service.ts';
import { ProjectError } from '../services/project.ts';
import { initializeSchema } from '../contracts/project.ts';
import { roleInputSchema, roleUpdateSchema } from '../contracts/roles.ts';
import { sessionInputSchema } from '../contracts/sessions.ts';
import { resolveSkillSources } from '../services/skill-sources.ts';
import type { SessionRuntime } from '../host/session-runtime.ts';
import { streamSSE } from 'hono/streaming';
import { chatInputSchema } from '../contracts/chat.ts';
import { checkReferences, readReferenceText } from '../services/file-references.ts';
import { createWorkbenchRoutes } from './workbench-routes.ts';
import { controlInputSchema } from '../contracts/controls.ts';
import { createVersionRoutes } from './version-routes.ts';
import { createReviewRoutes } from './review-routes.ts';
const attachment = z.object({ root: z.string().min(1) }).strict();
export function createApplication(
  service: ProjectService,
  assetsDirectory?: string,
  runtime?: SessionRuntime,
  shutdown?: AbortSignal,
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
      return c.json(
        { code: 'INVALID_INPUT', message: '输入不合法，请核对当前表单或消息参数' },
        400,
      );
    return c.json({ code: 'OPERATION_FAILED', message: error.message }, 400);
  });
  app.route('/api/projects', createWorkbenchRoutes(service));
  app.route('/api/projects', createVersionRoutes(service));
  app.route('/api/projects', createReviewRoutes(service, runtime));
  app.get('/api/projects/:project/control', (c) => {
    const id = c.req.param('project');
    return c.json(
      runtime?.projectControl
        ? runtime.projectControl.query(id)
        : {
            runtime: service.forProject(id).controls().project(),
            desiredStarted: service.forProject(id).snapshot().started,
            available: false,
          },
    );
  });
  app.post('/api/projects/:project/control', async (c) => {
    if (!runtime?.projectControl) throw new ProjectError('HOST_UNAVAILABLE', '宿主未连接项目控制');
    const input = z
      .object({
        operationId: z.uuid(),
        action: z.enum(['start', 'stop', 'force-stop']),
        reason: z.string().trim().min(1),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      input.action === 'start'
        ? runtime.projectControl.start(c.req.param('project'), input)
        : runtime.projectControl.stop(c.req.param('project'), input, input.action === 'force-stop'),
      202,
    );
  });
  app.get('/api/projects/:project/executions/:execution/control', (c) => {
    const id = c.req.param('project'),
      execution = z.uuid().parse(c.req.param('execution')),
      catalog = service.forProject(id).controls();
    return c.json(
      runtime?.controls
        ? runtime.controls.query(id, execution)
        : {
            revision: catalog.revision(execution),
            controls: catalog.list(execution),
            jobs: catalog.jobs(execution),
            available: false,
          },
    );
  });
  app.post('/api/projects/:project/executions/:execution/control', async (c) => {
    if (!runtime?.controls) throw new ProjectError('HOST_UNAVAILABLE', '宿主未连接执行控制');
    const input = controlInputSchema.omit({ executionId: true }).parse(await c.req.json());
    return c.json(
      runtime.controls.request(
        c.req.param('project'),
        { kind: 'user' },
        { ...input, executionId: z.uuid().parse(c.req.param('execution')) },
      ),
      202,
    );
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
  app.post('/api/projects/attach', async (c) => {
    const project = service.attach(attachment.parse(await c.req.json()).root);
    runtime?.projectControl?.attached(project.id);
    return c.json(project);
  });
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
  app.get('/api/projects/:project/executions', (c) => {
    const project = c.req.param('project');
    return c.json(
      runtime?.dispatch
        ? runtime.dispatch.query(project)
        : service.forProject(project).executions().list(),
    );
  });
  app.get('/api/projects/:project/executions/:execution', (c) => {
    const project = c.req.param('project'),
      id = z.uuid().parse(c.req.param('execution'));
    if (runtime?.dispatch) return c.json(runtime.dispatch.query(project, id));
    const connection = service.forProject(project),
      catalog = connection.executions(),
      record = catalog.get(id);
    return c.json({
      record,
      steps: catalog.steps(id),
      events: catalog.events(id),
      session: record.sessionId ? connection.session(record.sessionId) : null,
      native: {
        loaded: false,
        status: null,
        cwd: null,
        selection: null,
        goal: null,
        lastGoalSnapshot: record.goalSnapshot,
        goalError: null,
      },
      requests: record.sessionId
        ? connection.requests(record.sessionId).filter((request) => request.executionId === id)
        : [],
      materials: connection
        .workbench()
        .materialDomains(record.ticketId)
        .filter((domain) => domain.referenceId === id),
      unavailableActions: ['当前宿主未连接；只显示持久快照，不打开原会话'],
      coordinationBasis: '持久记录不是外部作业停稳证明',
    });
  });
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
  app.get('/api/projects/:project/contacts', (c) =>
    c.json(
      service
        .forProject(c.req.param('project'))
        .messages()
        .contacts({ kind: 'user' }, c.req.query('role')),
    ),
  );
  app.get('/api/projects/:project/conversations', (c) =>
    c.json(service.forProject(c.req.param('project')).messages().conversations({ kind: 'user' })),
  );
  app.get('/api/projects/:project/conversations/:conversation', (c) =>
    c.json(
      service
        .forProject(c.req.param('project'))
        .messages()
        .history({ kind: 'user' }, z.uuid().parse(c.req.param('conversation'))),
    ),
  );
  app.post('/api/projects/:project/messages', async (c) => {
    const input = chatInputSchema.parse(await c.req.json());
    if (!runtime)
      throw new ProjectError('HOST_UNAVAILABLE', '当前宿主未连接通信投递服务，消息未保存');
    return c.json(
      await runtime.communication.send(c.req.param('project'), { kind: 'user' }, input),
      201,
    );
  });
  app.post('/api/projects/:project/messages/:message/retry', async (c) => {
    if (!runtime) throw new ProjectError('HOST_UNAVAILABLE', '当前宿主未连接，不能重试投递');
    return c.json(
      await runtime.communication.retry(
        c.req.param('project'),
        { kind: 'user' },
        z.uuid().parse(c.req.param('message')),
      ),
    );
  });
  app.get('/api/projects/:project/messages/:message/references/:index', (c) => {
    const connection = service.forProject(c.req.param('project'));
    const saved = connection.messages().get(z.uuid().parse(c.req.param('message')));
    connection.messages().history({ kind: 'user' }, saved.message.conversationId);
    const index = z.coerce.number().int().nonnegative().parse(c.req.param('index'));
    const reference = saved.message.references[index];
    if (!reference) throw new ProjectError('REFERENCE_NOT_FOUND', '此消息没有指定的引用');
    if (reference.snippet !== undefined)
      return c.json({
        path: reference.path,
        startLine: reference.startLine ?? null,
        endLine: reference.endLine ?? null,
        source: 'saved-snippet',
        content: reference.snippet,
      });
    const actor =
      saved.message.sender.kind === 'user'
        ? { kind: 'user' as const }
        : { kind: 'session' as const, sessionId: saved.message.sender.sessionId! };
    const checked = checkReferences(connection, actor, saved.receipt.targetSessionId ?? 'user', [
      reference,
    ])[0]!;
    return c.json({
      path: checked.path,
      startLine: checked.startLine ?? null,
      endLine: checked.endLine ?? null,
      source: checked.snippet === undefined ? 'current-file' : 'saved-snippet',
      content: checked.snippet ?? readReferenceText(checked),
    });
  });
  app.get('/api/projects/:project/events/cursor', (c) =>
    c.json({ cursor: service.forProject(c.req.param('project')).messages().latestEventSeq() }),
  );
  app.get('/api/projects/:project/events', (c) => {
    const catalog = service.forProject(c.req.param('project')).messages();
    let cursor = z.coerce
      .number()
      .int()
      .nonnegative()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(c.req.header('last-event-id') ?? c.req.query('after') ?? 0);
    return streamSSE(
      c,
      async (stream) => {
        await stream.writeSSE({ event: 'ready', data: JSON.stringify({ cursor }), retry: 1500 });
        let heartbeat = Date.now();
        while (!stream.aborted && !shutdown?.aborted) {
          for (const event of catalog.events(cursor)) {
            await stream.writeSSE({
              id: String(event.seq),
              event: 'change',
              data: JSON.stringify(event),
            });
            cursor = event.seq;
          }
          if (Date.now() - heartbeat > 15000) {
            await stream.writeSSE({ event: 'heartbeat', data: '{}' });
            heartbeat = Date.now();
          }
          await stream.sleep(250);
        }
      },
      async (error, stream) => {
        if (!stream.aborted && !shutdown?.aborted)
          await stream
            .writeSSE({ event: 'unavailable', data: JSON.stringify({ message: error.message }) })
            .catch(() => {});
      },
    );
  });
  app.all('/api/*', (c) => c.json({ code: 'NOT_FOUND', message: '接口不存在' }, 404));
  if (assetsDirectory) {
    app.use('*', serveStatic({ root: assetsDirectory }));
    app.get('*', serveStatic({ path: `${assetsDirectory}/index.html` }));
  }
  return app;
}
