import { Hono } from 'hono';
import { z } from 'zod';
import type { ProjectService } from '../services/project-service.ts';
import { ticketStateSchema } from '../contracts/workbench.ts';
import {
  listMaterials,
  readMaterial,
  materialFile,
  expectedMaterialRoot,
} from '../services/ticket-materials.ts';
import { createReadStream, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { ProjectError } from '../services/errors.ts';
import {
  deliveryOpinionEvidence,
  ticketDeliveries,
  ticketRelationships,
} from '../services/ticket-deliveries.ts';
import { historyTargets } from '../services/history-navigation.ts';
import { previewImage, previewText } from '../services/material-preview.ts';
import { resolve } from 'node:path';
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
        kind: ticket.kind,
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
      plans: wb.plans(),
    });
  });
  app.get('/:project/worktrees', (c) =>
    c.json(service.forProject(c.req.param('project')).worktrees().list(user)),
  );
  app.get('/:project/worktrees/:worktree', (c) => {
    const catalog = service.forProject(c.req.param('project')).worktrees(),
      id = c.req.param('worktree');
    return c.json({ record: catalog.get(user, id), history: catalog.history(user, id) });
  });
  app.get('/:project/local-commits/:arrangement', (c) => {
    const catalog = service.forProject(c.req.param('project')).localCommits(),
      id = c.req.param('arrangement');
    return c.json({ arrangement: catalog.get(user, id), history: catalog.history(user, id) });
  });
  app.get('/:project/worktree-merges/:merge', (c) => {
    const catalog = service.forProject(c.req.param('project')).worktreeMerges(),
      id = c.req.param('merge');
    return c.json({ arrangement: catalog.get(user, id), history: catalog.history(user, id) });
  });
  app.get('/:project/plans', (c) => c.json(catalog(c.req.param('project')).plans()));
  app.post('/:project/plans/:plan/confirm', async (c) =>
    c.json(
      catalog(c.req.param('project')).confirmPlan(user, c.req.param('plan'), await c.req.json()),
    ),
  );
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
  app.get('/:project/tickets/:ticket/research', (c) =>
    c.json(
      catalog(c.req.param('project')).research(c.req.param('ticket'), c.req.query('questionId')),
    ),
  );
  app.get('/:project/tickets/:ticket/research/:question/history', (c) => {
    const wb = catalog(c.req.param('project')),
      ticket = c.req.param('ticket'),
      q = c.req.param('question');
    return c.json({
      definitions: wb.researchQuestionHistory(ticket, q),
      answers: wb.researchAnswerHistory(ticket, q),
    });
  });
  app.post('/:project/tickets/:ticket/research', async (c) =>
    c.json(
      catalog(c.req.param('project')).addResearchQuestion(
        user,
        c.req.param('ticket'),
        await c.req.json(),
      ),
      201,
    ),
  );
  app.patch('/:project/tickets/:ticket/research/:question', async (c) =>
    c.json(
      catalog(c.req.param('project')).updateResearchQuestion(
        user,
        c.req.param('ticket'),
        c.req.param('question'),
        await c.req.json(),
      ),
    ),
  );
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
    const expected = expectedMaterialRoot(connection.snapshot().root, ticket.code);
    if (resolve(ticket.materialRoot) !== expected)
      throw new ProjectError('MATERIAL_RANGE', '票据材料入口与项目内分配位置不符');
    return expected;
  };
  app.get('/:project/tickets/:ticket/deliveries', (c) =>
    c.json(ticketDeliveries(service.forProject(c.req.param('project')), c.req.param('ticket'))),
  );
  app.get('/:project/tickets/:ticket/deliveries/opinion/:result', (c) =>
    c.json(
      deliveryOpinionEvidence(
        service.forProject(c.req.param('project')),
        c.req.param('ticket'),
        z.uuid().parse(c.req.param('result')),
      ),
    ),
  );
  app.get('/:project/tickets/:ticket/relationships', (c) =>
    c.json(ticketRelationships(service.forProject(c.req.param('project')), c.req.param('ticket'))),
  );
  app.get('/:project/tickets/:ticket/materials', (c) => {
    const connection = service.forProject(c.req.param('project')),
      ticket = connection.workbench().getTicket(c.req.param('ticket')),
      root = materials(c.req.param('project'), ticket.id),
      path = c.req.query('path') ?? '';
    let entries: ReturnType<typeof listMaterials> = [],
      materialError: string | null = null;
    try {
      entries = listMaterials(root, path);
    } catch (error) {
      if (
        !(error instanceof ProjectError) ||
        !['MATERIAL_UNAVAILABLE', 'MATERIAL_NOT_DIRECTORY', 'MATERIAL_LINK'].includes(error.code)
      )
        throw error;
      materialError = error.message;
    }
    return c.json({
      root,
      entries,
      materialError,
      executionDomains: connection.workbench().materialDomains(ticket.id),
      currentDelivery: ticketDeliveries(connection, ticket.id, false).currentDelivery,
      note: '执行及独审域由实际业务分配；目录中的文件不自动成为有效交付',
    });
  });
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
    const format = z.enum(['text', 'image']).default('text').parse(c.req.query('preview'));
    if (statSync(file).size > (format === 'image' ? 8 * 1024 * 1024 : 1048576))
      throw new ProjectError(
        'MATERIAL_PREVIEW_BUDGET',
        '材料超过预览预算，请下载完整文件；未静默裁剪',
      );
    const content = readMaterial(root, path);
    if (format === 'image') {
      const image = previewImage(content);
      return c.body(image.bytes, 200, image.headers);
    }
    return c.json({ path, content: previewText(content) });
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
  app.get('/:project/history/:entry/targets', (c) =>
    c.json(historyTargets(service.forProject(c.req.param('project')), c.req.param('entry'))),
  );
  app.post('/:project/history', async (c) =>
    c.json(catalog(c.req.param('project')).addHistory(user, await c.req.json()), 201),
  );
  app.get('/:project/feedback', (c) => c.json(catalog(c.req.param('project')).feedback()));
  return app;
}
