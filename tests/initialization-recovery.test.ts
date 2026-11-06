import { afterEach, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, renameSync, symlinkSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { initializeProject, connectProject } from '../src/services/project.ts';
import type { ProjectConnection } from '../src/services/project.ts';
const fault = vi.hoisted(() => ({ failSoul: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      if (fault.failSoul && String(args[0]).endsWith('SOUL.md')) {
        fault.failSoul = false;
        throw new Error('injected soul write failure');
      }
      return actual.writeFileSync(...args);
    },
  };
});
const roots: string[] = [];
afterEach(() => {
  fault.failSoul = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test('TEAM已写而后续规范写入失败后，重试沿用同一角色身份', () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-recovery-'));
  roots.push(root);
  const input = {
    root,
    name: '故障恢复',
    supervisor: { provider: 'deepseek-official', model: 'deepseek-flash' },
  };
  fault.failSoul = true;
  expect(() => initializeProject(input)).toThrow('injected soul write failure');
  const before = readFileSync(join(root, '.TEAM', 'TEAM.md'), 'utf8');
  const retried = initializeProject(input);
  expect(before).toContain(retried.roles[0]!.id);
  expect(readFileSync(retried.paths.team, 'utf8')).toBe(before);
});
test.each(['角色', '角色ID'])('接入拒绝%s祖先junction，不读取根外规范', (kind) => {
  const base = mkdtempSync(join(tmpdir(), 'mat-junction-'));
  roots.push(base);
  const root = join(base, '项目');
  mkdirSync(root);
  const created = initializeProject({
    root,
    name: '目录边界',
    supervisor: { provider: 'deepseek-official', model: 'deepseek-flash' },
  });
  const source =
    kind === '角色'
      ? join(root, '.TEAM', '角色')
      : join(root, '.TEAM', '角色', created.roles[0]!.id);
  const outside = join(base, '根外规范');
  assert.ok(resolve(source).startsWith(resolve(base) + sep));
  assert.ok(resolve(outside).startsWith(resolve(base) + sep));
  renameSync(source, outside);
  symlinkSync(outside, source, 'junction');
  let unexpected: ProjectConnection | undefined;
  try {
    expect(() => {
      unexpected = connectProject(root);
    }).toThrow(/普通目录|符号链接/);
  } finally {
    unexpected?.close();
  }
});
