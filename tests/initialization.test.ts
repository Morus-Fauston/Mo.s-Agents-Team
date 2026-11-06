import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeProject, readProject, connectProject } from '../src/services/project.js';
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
test('初始化后能回读软件生成的项目和主管身份，重复初始化保留相同身份', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mat-init-'));
  roots.push(root);
  const input = {
    root,
    name: '真实项目',
    supervisor: { provider: 'deepseek-official', model: 'deepseek-flash' },
  };
  const created = await initializeProject(input);
  expect(created.name).toBe('真实项目');
  expect(created.roles[0]?.type).toBe('supervisor');
  expect(created.id).toMatch(/^\d+$/);
  expect(created.roles[0]?.id).toMatch(/^\d+$/);
  expect(await readFile(created.paths.team, 'utf8')).toContain('真实项目');
  expect((await initializeProject(input)).id).toBe(created.id);
  expect((await readProject(root)).roles).toEqual(created.roles);
});
test('已登记资料缺失时明确拒绝初始化，不用模板补写用户资料', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mat-missing-'));
  roots.push(root);
  const input = {
    root,
    name: '缺件项目',
    supervisor: { provider: 'deepseek-official', model: 'deepseek-flash' },
  };
  const created = initializeProject(input);
  await rm(created.roles[0]!.paths.soul);
  expect(() => initializeProject(input)).toThrow(/缺少规范/);
});
test('资料准备失败后不产生正式登记，同一数据库可在修复输入后重试', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mat-rollback-'));
  roots.push(root);
  await mkdir(join(root, '.TEAM'));
  await mkdir(join(root, '.TEAM', 'TEAM.md'));
  const input = {
    root,
    name: '事务失败重试',
    supervisor: { provider: 'deepseek-official', model: 'deepseek-flash' },
  };
  expect(() => initializeProject(input)).toThrow();
  expect(() => readProject(root)).toThrow();
  await rm(join(root, '.TEAM', 'TEAM.md'), { recursive: true });
  await writeFile(join(root, '.TEAM', 'TEAM.md'), '原有共用规范');
  const created = initializeProject(input);
  expect(await readFile(created.paths.team, 'utf8')).toBe('原有共用规范');
  expect(readProject(root).id).toBe(created.id);
});
test('插件独占写入连接，连接关闭后可重载，接入事实仍禁止CLI初始化', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mat-writer-'));
  roots.push(root);
  const input = {
    root,
    name: '单写入者',
    supervisor: { provider: 'deepseek-official', model: 'deepseek-flash' },
  };
  const created = initializeProject(input);
  let connection = connectProject(root);
  try {
    expect(connection.snapshot().started).toBe(false);
    expect(() => connectProject(root)).toThrow();
    expect(() => initializeProject(input)).toThrow();
  } finally {
    connection.close();
  }
  expect(() => initializeProject(input)).toThrow(/已接入/);
  connection = connectProject(root);
  try {
    expect(connection.snapshot().id).toBe(created.id);
  } finally {
    connection.close();
  }
});
