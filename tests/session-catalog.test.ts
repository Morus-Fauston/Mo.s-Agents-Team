import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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
test('会话创建记录绑定正式角色，角色默认模型修改只影响后续会话', () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-session-'));
  initializeProject({
    root,
    name: '会话项目',
    supervisor: { provider: 'deepseek-official', model: 'deepseek-flash' },
  });
  const connection = connectProject(root);
  fixtures.push({ root, connection });
  const role = connection.registerRole({
    code: 'DEV',
    name: '开发',
    type: 'developer',
    configuration: { provider: 'deepseek-official', model: 'deepseek-flash' },
  });
  const first = connection.reserveSession({
    roleId: role.id,
    name: '第一次工作',
    purpose: '配置回读',
    cwd: root,
  });
  expect(first.roleId).toBe(role.id);
  expect(first.nativeSessionId).toBeNull();
  expect(first.status).toBe('creating');
  expect(first.addresses.numeric).toBe(`${role.id}#${first.ordinal}`);
  connection.updateRole(role.id, {
    name: '开发',
    configuration: { provider: 'deepseek-official', model: 'configured-other-model' },
  });
  const second = connection.reserveSession({
    roleId: role.id,
    name: '第二次工作',
    purpose: '配置回读',
    cwd: root,
  });
  expect(connection.sessions()[0]!.configuration.model).toBe('deepseek-flash');
  expect(second.configuration.model).toBe('configured-other-model');
  expect(second.ordinal).toBeGreaterThan(first.ordinal);
  const explicit = connection.reserveSession({
    roleId: role.id,
    name: '显式会话配置',
    purpose: '本次参数不继承创建者',
    cwd: root,
    configuration: { provider: 'explicit-provider', model: 'explicit-model' },
  });
  expect(explicit.configuration).toEqual({
    provider: 'explicit-provider',
    model: 'explicit-model',
  });
  expect(connection.roles().find((r) => r.id === role.id)!.configuration.model).toBe(
    'configured-other-model',
  );
  expect(() =>
    connection.reserveSession({
      roleId: '99999999',
      name: '其他项目角色',
      purpose: '拒绝',
      cwd: root,
    }),
  ).toThrow('未在当前项目登记');
});
