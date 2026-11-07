import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SkillAssembly } from '../src/host/skills.ts';
import type { NativeContext, NativeModules } from '../src/host/native.ts';
test('原生提供者规范化Windows路径大小写后仍加载同一已登记Skill', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-skill-case-'));
  mkdirSync(join(root, 'manifests'));
  mkdirSync(join(root, 'skills', 'write'), { recursive: true });
  const path = join(root, 'skills', 'write', 'SKILL.md');
  writeFileSync(path, '---\nname: write\ndescription: fixture\n---\n完整方法');
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
      ],
    }),
  );
  const nativePath =
    process.platform === 'win32' ? path.replace('mat-skill-case-', 'MAT-SKILL-CASE-') : path;
  const candidate = {
    name: 'write',
    path: nativePath,
    description: 'fixture',
    invocation: { modelInvocable: true, userInvocable: true },
  };
  const modules = {
    FileSystemSkillProvider: class {
      async list() {
        return [candidate];
      }
      async get() {
        return { ...candidate, content: '完整方法', provider: 'fixture' };
      }
      async dispose() {}
    },
    renderSkillContent: (s: { content: string }) => s.content,
  } as unknown as NativeModules;
  const assembly = new SkillAssembly({} as NativeContext, modules, root, 'developer');
  try {
    expect((await assembly.catalog(root))[0]!.name).toBe('write');
    expect((await assembly.load('write', root, new AbortController().signal)).body).toBe(
      '完整方法',
    );
  } finally {
    await assembly.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
