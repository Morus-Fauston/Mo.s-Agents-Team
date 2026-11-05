import { afterEach, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectProject } from '../源码/业务/项目.ts';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test('独立CLI初始化不加载宿主，已有插件连接时明确拒绝第二写入者', () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-cli-'));
  roots.push(root);
  const home = join(root, '未使用的宿主根');
  const args = [
    '--experimental-strip-types',
    resolve('源码/命令/入口.ts'),
    'init',
    root,
    '--name',
    'CLI真实项目',
    '--provider',
    'deepseek-official',
    '--model',
    'deepseek-flash',
  ];
  const run = () =>
    spawnSync(process.execPath, args, {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, DSH_HOME: home },
    });
  const first = run();
  expect(first.status).toBe(0);
  const created = JSON.parse(first.stdout);
  expect(created.name).toBe('CLI真实项目');
  expect(existsSync(home)).toBe(false);
  const connection = connectProject(root);
  try {
    const second = run();
    expect(second.status).toBe(1);
    expect(JSON.parse(second.stderr).code).toBe('PROJECT_BUSY');
  } finally {
    connection.close();
  }
});
