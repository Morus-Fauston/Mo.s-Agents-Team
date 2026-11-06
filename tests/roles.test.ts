import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProject, connectProject } from '../src/services/project.ts';
import type { ProjectConnection } from '../src/services/project.ts';
const fixtures: { root: string; connection: ProjectConnection }[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.connection.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('按用户配置登记开发角色，数字身份与空规范路径稳定，重复登记不覆盖正文', () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-role-'));
  initializeProject({
    root,
    name: '角色项目',
    supervisor: { provider: 'deepseek-official', model: 'deepseek-flash' },
  });
  const connection = connectProject(root);
  fixtures.push({ root, connection });
  const input = {
    code: 'DEV',
    name: '功能开发',
    type: 'developer' as const,
    configuration: { provider: 'deepseek-official', model: 'deepseek-flash' },
  };
  const created = connection.registerRole(input);
  expect(created.id).toMatch(/^\d+$/);
  expect(created.type).toBe('developer');
  expect(created.allowChildAgents).toBe(false);
  expect(readFileSync(created.paths.soul, 'utf8')).toBe('');
  writeFileSync(created.paths.soul, '用户保存的长期身份');
  expect(connection.registerRole(input).id).toBe(created.id);
  expect(readFileSync(created.paths.soul, 'utf8')).toBe('用户保存的长期身份');
  expect(connection.roles().map((r) => r.code)).toEqual(expect.arrayContaining(['SUP', 'DEV']));
  expect(() =>
    connection.registerRole({ ...input, code: 'NATIVE', allowChildAgents: true }),
  ).toThrow('首版不支持');
  expect(() => connection.registerRole({ ...input, code: 'SUP2', type: 'supervisor' })).toThrow(
    '主管已经登记',
  );
  const committer = { ...input, code: 'GIT', type: 'committer' as const };
  connection.registerRole(committer);
  expect(() => connection.registerRole({ ...committer, code: 'GIT2' })).toThrow('必须唯一');
});
