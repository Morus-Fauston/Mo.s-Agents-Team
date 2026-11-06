import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, unlinkSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProject, connectProject } from '../src/services/project.ts';
import type { ProjectConnection } from '../src/services/project.ts';
import { assembleContext } from '../src/services/context.ts';
const fixtures: { root: string; connection: ProjectConnection }[] = [];
afterEach(() => {
  for (const f of fixtures.splice(0)) {
    f.connection.close();
    rmSync(f.root, { recursive: true, force: true });
  }
});
test('开发上下文不读取主管私密正文，切工作目录不改变项目角色，空规范合法', () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-context-'));
  initializeProject({
    root,
    name: '上下文项目',
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
  writeFileSync(join(root, '.TEAM', 'USER.md'), 'PRIVATE_USER_SENTINEL');
  const cwd = join(root, '另一个工作目录');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'AGENTS.md'), 'WORKSPACE_RULE_SENTINEL');
  const session = connection.reserveSession({
    roleId: role.id,
    name: '验证会话',
    purpose: '真实规范核对',
    cwd,
  });
  const context = assembleContext(connection.snapshot(), role, session, cwd);
  expect(context.projectId).toBe(connection.snapshot().id);
  expect(context.roleId).toBe(role.id);
  expect(context.body).toContain('WORKSPACE_RULE_SENTINEL');
  expect(context.body).not.toContain('PRIVATE_USER_SENTINEL');
  expect(context.sources.some((s) => s.path.endsWith('USER.md'))).toBe(false);
  expect(context.sources.filter((s) => s.kind === 'role').every((s) => s.bytes === 0)).toBe(true);
  const supervisor = connection.roles().find((r) => r.type === 'supervisor')!;
  const management = connection.reserveSession({
    roleId: supervisor.id,
    name: '主管默认',
    purpose: '配置维护',
    cwd: root,
  });
  expect(assembleContext(connection.snapshot(), supervisor, management, root).body).toContain(
    'PRIVATE_USER_SENTINEL',
  );
});

test('必需缺件与超预算明确失败，正文原样提供且版本由内容决定', () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-context-fail-'));
  initializeProject({ root, name: '拒绝路径', supervisor: { provider: 'p', model: 'm' } });
  const connection = connectProject(root);
  fixtures.push({ root, connection });
  const role = connection.roles()[0]!;
  const session = connection.reserveSession({
    roleId: role.id,
    name: '规范检查',
    purpose: '测试',
    cwd: root,
  });
  writeFileSync(role.paths.soul, '原样 ${projectId}');
  const first = assembleContext(connection.snapshot(), role, session, root);
  expect(first.body).toContain('原样 ${projectId}');
  utimesSync(role.paths.soul, new Date(), new Date(Date.now() + 2000));
  expect(assembleContext(connection.snapshot(), role, session, root).version).toBe(first.version);
  writeFileSync(role.paths.soul, '修改正文');
  expect(assembleContext(connection.snapshot(), role, session, root).version).not.toBe(
    first.version,
  );
  expect(() =>
    assembleContext(connection.snapshot(), role, session, root, { totalBytes: 32 }),
  ).toThrow('预算');
  unlinkSync(role.paths.agent);
  expect(() => assembleContext(connection.snapshot(), role, session, root)).toThrow('缺少必需规范');
});

test('只加载最近仓库根到cwd的规则，不读取更高祖先的个人指令', () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-context-scope-'));
  initializeProject({ root, name: '作用域', supervisor: { provider: 'p', model: 'm' } });
  const connection = connectProject(root);
  fixtures.push({ root, connection });
  writeFileSync(join(root, 'AGENTS.md'), 'OUTSIDE_REPOSITORY_SENTINEL');
  const repo = join(root, '仓库');
  mkdirSync(repo);
  mkdirSync(join(repo, '.git'));
  writeFileSync(join(repo, 'AGENTS.md'), 'REPO_RULE');
  const cwd = join(repo, '子目录');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'CLAUDE.local.md'), 'LOCAL_RULE');
  const role = connection.roles()[0]!;
  const session = connection.reserveSession({
    roleId: role.id,
    name: '作用域',
    purpose: '测试',
    cwd,
  });
  const context = assembleContext(connection.snapshot(), role, session, cwd);
  expect(context.body).toContain('REPO_RULE');
  expect(context.body).toContain('LOCAL_RULE');
  expect(context.body).not.toContain('OUTSIDE_REPOSITORY_SENTINEL');
});
