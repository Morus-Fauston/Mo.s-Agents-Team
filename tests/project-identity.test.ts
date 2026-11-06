import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, cpSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectService } from '../src/services/project-service.ts';
import { initializeProject } from '../src/services/project.ts';
const fixtures: { root: string; service: ProjectService }[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.service.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('同一项目身份不因复制资料而同时绑定两个宿主根', () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-project-id-'));
  const first = join(root, '原项目');
  const copied = join(root, '复制目录');
  mkdirSync(first);
  mkdirSync(copied);
  const project = initializeProject({
    root: first,
    name: '固定项目身份',
    supervisor: { provider: 'deepseek-official', model: 'deepseek-flash' },
  });
  cpSync(join(first, '.TEAM'), join(copied, '.TEAM'), { recursive: true });
  const service = new ProjectService(join(root, '插件'));
  fixtures.push({ root, service });
  service.attach(first);
  expect(() => service.attach(copied)).toThrow(/同一项目身份/);
  expect(service.forProject(project.id).snapshot().root).toBe(project.root);
});
