import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectService } from '../源码/业务/项目服务.ts';
import { createApplication } from '../源码/接口/应用.ts';
const fixtures: { root: string; service: ProjectService }[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('控制台创建与接入回读同一正式登记，接入不自动启动', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-http-'));
  const project = join(root, '项目');
  mkdirSync(project);
  const service = new ProjectService(join(root, '插件'));
  fixtures.push({ root, service });
  const app = createApplication(service);
  const response = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      root: project,
      name: '真实登记',
      supervisor: { provider: 'deepseek-official', model: 'deepseek-flash' },
    }),
  });
  expect(response.status).toBe(201);
  const created = await response.json();
  expect(created.started).toBe(false);
  const attached = await app.request('/api/projects/attach', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ root: project }),
  });
  expect((await attached.json()).id).toBe(created.id);
  const listed = await (await app.request('/api/projects')).json();
  expect(listed).toHaveLength(1);
  expect(listed[0].roles[0].type).toBe('supervisor');
});
test('非法输入和跨来源命令被拒绝，不产生项目登记', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-http-errors-'));
  const service = new ProjectService(join(root, '插件'));
  fixtures.push({ root, service });
  const app = createApplication(service);
  const invalid = await app.request('/api/projects', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  expect(invalid.status).toBe(400);
  const foreign = await app.request('/api/projects/attach', {
    method: 'POST',
    headers: { origin: 'https://example.org', 'content-type': 'application/json' },
    body: '{}',
  });
  expect(foreign.status).toBe(403);
  expect(service.list()).toEqual([]);
});
