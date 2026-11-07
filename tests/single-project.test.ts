import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectService } from '../src/services/project-service.ts';
import { createApplication } from '../src/api/application.ts';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
});
test('工作台只初始化启动绑定目录，旧登记和跨根请求不改变归属', async () => {
  const base = mkdtempSync(join(tmpdir(), 'mat-bound-'));
  cleanup.push(() => rmSync(base, { recursive: true, force: true }));
  const root = join(base, 'current'),
    other = join(base, 'other'),
    state = join(base, 'state');
  for (const path of [root, other, state]) mkdirSync(path);
  writeFileSync(join(state, '项目目录.json'), 'invalid legacy registry');
  const service = new ProjectService(state, root);
  cleanup.push(() => service.close());
  const app = createApplication(service);
  expect(await (await app.request('/api/workspace')).json()).toEqual({ root, project: null });
  const create = (target: string) =>
    app.request('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        root: target,
        name: '当前项目',
        supervisor: { provider: 'p', model: 'm' },
      }),
    });
  expect((await create(other)).status).toBe(409);
  expect(existsSync(join(other, '.TEAM'))).toBe(false);
  const response = await create(root);
  expect(response.status).toBe(201);
  const project = await response.json();
  expect((await (await app.request('/api/workspace')).json()).project.id).toBe(project.id);
  expect(await (await app.request('/api/projects')).json()).toHaveLength(1);
  expect((await app.request('/api/projects/999999999/roles')).status).toBe(409);
  expect((await app.request('/api/projects/999999999/control')).status).toBe(409);
  const attach = await app.request('/api/projects/attach', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root }),
  });
  expect((await attach.json()).roles).toEqual(project.roles);
  writeFileSync(project.paths.team, '# 用户原有内容\n');
  service.close();
  const resumed = new ProjectService(state, root);
  cleanup.push(() => resumed.close());
  expect(resumed.list()[0]).toMatchObject({ id: project.id, root });
  expect(readFileSync(project.paths.team, 'utf8')).toBe('# 用户原有内容\n');
  expect(readFileSync(join(state, '项目目录.json'), 'utf8')).toBe('invalid legacy registry');
});
