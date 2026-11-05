import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveSkillSources } from '../源码/业务/Skill来源.ts';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test('For MAT严格按类型与源路径解析，不继承个人目录，缺来源明确失败', () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-skill-source-'));
  roots.push(root);
  mkdirSync(join(root, 'manifests'));
  mkdirSync(join(root, 'skills', 'write'), { recursive: true });
  writeFileSync(
    join(root, 'skills', 'write', 'SKILL.md'),
    '---\nname: write\ndescription: 小型写作方法\n---\n原始正文',
  );
  writeFileSync(
    join(root, 'manifests', 'for-mat.json'),
    JSON.stringify({
      schemaVersion: 1,
      profile: 'for-mat',
      entries: [
        {
          name: 'write',
          source: 'local',
          path: 'skills/write',
          types: ['开发'],
          invocation: 'task',
        },
        {
          name: 'missing-private',
          source: 'local',
          path: 'skills/missing-private',
          types: ['主管'],
          invocation: 'explicit',
        },
      ],
    }),
  );
  const resolved = resolveSkillSources(root, 'developer');
  expect(resolved.entries.map((e) => e.name)).toEqual(['write']);
  expect(resolved.entries[0]!.path).toBe(join(root, 'skills', 'write', 'SKILL.md'));
  expect(() => resolveSkillSources(root, 'supervisor')).toThrow('来源');
});
