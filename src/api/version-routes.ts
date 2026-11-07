import { Hono } from 'hono';
import { z } from 'zod';
import type { ProjectService } from '../services/project-service.ts';
import { ProjectError } from '../services/errors.ts';
import { previewImage, previewText } from '../services/material-preview.ts';
export function createVersionRoutes(service: ProjectService) {
  const app = new Hono(),
    base = '/:project/executions/:execution/versions';
  const catalog = (project: string | undefined, execution: string | undefined) => {
    const connection = service.forProject(z.string().min(1).parse(project));
    connection.executions().get(z.uuid().parse(execution));
    return connection.versions();
  };
  const scoped = (
    project: string | undefined,
    execution: string | undefined,
    id: string | undefined,
  ) => {
    const versions = catalog(project, execution);
    if (versions.get(z.uuid().parse(id)).executionId !== execution)
      throw new ProjectError('VERSION_EXECUTION_MISMATCH', '固定版本不属于当前执行');
    return versions;
  };
  app.get(base, (c) =>
    c.json(
      catalog(c.req.param('project'), c.req.param('execution')).headers(
        z.uuid().parse(c.req.param('execution')),
      ),
    ),
  );
  app.get(base + '/:version', (c) =>
    c.json(
      scoped(c.req.param('project'), c.req.param('execution'), c.req.param('version')).get(
        z.uuid().parse(c.req.param('version')),
      ),
    ),
  );
  app.get(base + '/:version/check', (c) =>
    c.json(
      scoped(c.req.param('project'), c.req.param('execution'), c.req.param('version')).check(
        z.uuid().parse(c.req.param('version')),
      ),
    ),
  );
  app.get(base + '/:version/diff', (c) =>
    c.json(
      scoped(c.req.param('project'), c.req.param('execution'), c.req.param('version')).diff(
        z.uuid().parse(c.req.param('version')),
        z.enum(['ticket', 'repair']).parse(c.req.query('mode') ?? 'ticket'),
      ),
    ),
  );
  app.get(base + '/:version/file', (c) => {
    const versions = scoped(
        c.req.param('project'),
        c.req.param('execution'),
        c.req.param('version'),
      ),
      root = z.coerce.number().int().nonnegative().parse(c.req.query('root')),
      path = z.string().min(1).parse(c.req.query('path')),
      format = z.enum(['text', 'image']).optional().parse(c.req.query('preview')),
      bytes = versions.file(z.uuid().parse(c.req.param('version')), root, path);
    if (format === 'text') return c.json({ path, content: previewText(bytes) });
    if (format === 'image') {
      const image = previewImage(bytes);
      return c.body(image.bytes, 200, image.headers);
    }
    return c.body(new Uint8Array(bytes), 200, {
      'content-type': 'application/octet-stream',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(path.split(/[\\/]/).at(-1)!)}`,
    });
  });
  return app;
}
