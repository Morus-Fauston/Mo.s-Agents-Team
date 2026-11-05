import { Hono } from 'hono';
import { z } from 'zod';
import type { ProjectService } from '../业务/项目服务.ts';
import { ticketStateSchema } from '../契约/票据.ts';
import { ensureMaterialRoot, listMaterials, readMaterial, materialFile } from '../业务/票据材料.ts';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { ProjectError } from '../业务/错误.ts';
const user = { kind: 'user' as const };
export function createWorkbenchRoutes(service: ProjectService): Hono {
  const app = new Hono(),
    catalog = (id: string) => service.forProject(id).workbench();
  app.get('/:project/workbench', (c) => {
    const wb = catalog(c.req.param('project'));
    return c.json({
      phases: wb.phases(),
      categories: wb.categories(),
      tickets: wb.listTickets().map((ticket) => ({
        id: ticket.id,
        code: ticket.code,
        title: ticket.title,
        goal: ticket.goal,
        state: ticket.state,
        phaseId: ticket.phaseId,
        categoryId: ticket.categoryId,
        dependencies: ticket.dependencies,
        currentExecution: ticket.currentExecution,
      })),
      tasks: wb.tasks(true),
      feedback: wb.feedback(),
      history: wb.projectHistory(),
    });
  });
  app.get('/:project/tickets', (c) => {
    const filter = z
      .object({
        phaseId: z.uuid().optional(),
        categoryId: z.uuid().optional(),
        state: ticketStateSchema.optional(),
      })
      .parse(c.req.query());
    return c.json(catalog(c.req.param('project')).listTickets(filter));
  });
  app.post('/:project/phases', async (c) =>
    c.json(catalog(c.req.param('project')).createPhase(user, await c.req.json()), 201),
  );
  app.patch('/:project/phases/:phase', async (c) =>
    c.json(
      catalog(c.req.param('project')).updatePhase(user, c.req.param('phase'), await c.req.json()),
    ),
  );
  app.post('/:project/phases/:phase/open', async (c) =>
    c.json(
      catalog(c.req.param('project')).openPhase(user, c.req.param('phase'), await c.req.json()),
    ),
  );
  app.post('/:project/phases/:phase/checklist', async (c) =>
    c.json(
      catalog(c.req.param('project')).maintainPhaseChecklist(
        user,
        c.req.param('phase'),
        await c.req.json(),
      ),
    ),
  );
  app.post('/:project/categories', async (c) =>
    c.json(catalog(c.req.param('project')).createCategory(user, await c.req.json()), 201),
  );
  app.post('/:project/tickets', async (c) =>
    c.json(catalog(c.req.param('project')).createTicket(user, await c.req.json()), 201),
  );
  app.get('/:project/tickets/:ticket', (c) =>
    c.json(catalog(c.req.param('project')).getTicket(c.req.param('ticket'))),
  );
  app.patch('/:project/tickets/:ticket', async (c) =>
    c.json(
      catalog(c.req.param('project')).updateTicket(user, c.req.param('ticket'), await c.req.json()),
    ),
  );
  app.get('/:project/tickets/:ticket/revisions', (c) =>
    c.json(catalog(c.req.param('project')).ticketHistory(c.req.param('ticket'))),
  );
  app.post('/:project/tickets/:ticket/conditions', async (c) =>
    c.json(
      catalog(c.req.param('project')).addCondition(user, c.req.param('ticket'), await c.req.json()),
      201,
    ),
  );
  app.patch('/:project/tickets/:ticket/conditions/:item', async (c) =>
    c.json(
      catalog(c.req.param('project')).updateCondition(
        user,
        c.req.param('ticket'),
        c.req.param('item'),
        await c.req.json(),
      ),
    ),
  );
  app.post('/:project/tickets/:ticket/checklist', async (c) =>
    c.json(
      catalog(c.req.param('project')).updateChecklist(
        user,
        c.req.param('ticket'),
        await c.req.json(),
      ),
    ),
  );
  app.get('/:project/tickets/:ticket/checklist/revisions', (c) =>
    c.json(catalog(c.req.param('project')).checklistHistory(c.req.param('ticket'))),
  );
  app.get('/:project/tickets/:ticket/logs', (c) => {
    const mode = z.enum(['active', 'archived', 'all']).parse(c.req.query('mode') ?? 'active');
    return c.json(catalog(c.req.param('project')).logs(c.req.param('ticket'), mode));
  });
  app.post('/:project/tickets/:ticket/logs', async (c) =>
    c.json(
      catalog(c.req.param('project')).appendLog(user, c.req.param('ticket'), await c.req.json()),
      201,
    ),
  );
  app.get('/:project/tickets/:ticket/logs/:log', (c) =>
    c.json(catalog(c.req.param('project')).getLog(c.req.param('ticket'), c.req.param('log'))),
  );
  app.patch('/:project/tickets/:ticket/logs/:log', async (c) =>
    c.json(
      catalog(c.req.param('project')).updateLog(
        user,
        c.req.param('ticket'),
        c.req.param('log'),
        await c.req.json(),
      ),
    ),
  );
  app.get('/:project/tickets/:ticket/logs/:log/revisions', (c) =>
    c.json(catalog(c.req.param('project')).logHistory(c.req.param('ticket'), c.req.param('log'))),
  );
  const materials = (project: string, ticketId: string) => {
    const connection = service.forProject(project),
      ticket = connection.workbench().getTicket(ticketId);
    return ensureMaterialRoot(connection.snapshot().root, ticket.code);
  };
  app.get('/:project/tickets/:ticket/materials', (c) =>
    c.json({
      root: materials(c.req.param('project'), c.req.param('ticket')),
      entries: listMaterials(
        materials(c.req.param('project'), c.req.param('ticket')),
        c.req.query('path') ?? '',
      ),
      executionDomains: catalog(c.req.param('project')).materialDomains(c.req.param('ticket')),
      currentDelivery: null,
      note: '执行及独审域由实际业务分配；目录中的文件不自动成为有效交付',
    }),
  );
  app.get('/:project/tickets/:ticket/material', (c) => {
    const path = z.string().min(1).parse(c.req.query('path')),
      root = materials(c.req.param('project'), c.req.param('ticket')),
      file = materialFile(root, path);
    if (c.req.query('download') === '1')
      return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>, {
        headers: {
          'content-type': 'application/octet-stream',
          'content-disposition':
            "attachment; filename*=UTF-8''" + encodeURIComponent(path.split(/[\\/]/).at(-1)!),
          'x-content-type-options': 'nosniff',
        },
      });
    if (statSync(file).size > 1048576)
      throw new ProjectError(
        'MATERIAL_PREVIEW_BUDGET',
        '材料超过1MiB预览预算，请下载完整文件；未静默裁剪',
      );
    const content = readMaterial(root, path);
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      throw new ProjectError('MATERIAL_NOT_UTF8', '此材料不是UTF-8文本，请下载原文件');
    }
    return c.json({ path, content: text });
  });
  app.get('/:project/supervisor-tasks', (c) =>
    c.json(catalog(c.req.param('project')).tasks(c.req.query('completed') === '1')),
  );
  app.post('/:project/supervisor-tasks', async (c) =>
    c.json(catalog(c.req.param('project')).createTask(user, await c.req.json()), 201),
  );
  app.patch('/:project/supervisor-tasks/:task', async (c) =>
    c.json(
      catalog(c.req.param('project')).updateTask(user, c.req.param('task'), await c.req.json()),
    ),
  );
  app.get('/:project/supervisor-tasks/:task/revisions', (c) =>
    c.json(catalog(c.req.param('project')).taskHistory(c.req.param('task'))),
  );
  app.get('/:project/history', (c) => c.json(catalog(c.req.param('project')).projectHistory()));
  app.post('/:project/history', async (c) =>
    c.json(catalog(c.req.param('project')).addHistory(user, await c.req.json()), 201),
  );
  app.get('/:project/feedback', (c) => c.json(catalog(c.req.param('project')).feedback()));
  return app;
}
