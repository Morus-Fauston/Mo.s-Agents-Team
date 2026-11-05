import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import type { WorkflowType } from '../契约/角色.ts';
import { ProjectError } from './错误.ts';
const entrySchema = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  source: z.string(),
  path: z.string().optional(),
  types: z.array(z.enum(['主管', '开发', '调查', '审阅', '提交'])),
  invocation: z.enum(['task', 'explicit', 'explicit-arrangement', 'conditional']),
});
const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  profile: z.literal('for-mat'),
  entries: z.array(entrySchema),
});
export interface SkillSource {
  name: string;
  path: string;
  invocation: z.infer<typeof entrySchema>['invocation'];
  source: string;
}
export interface SkillSources {
  root: string;
  manifest: string;
  version: string;
  entries: SkillSource[];
}
const typeNames = {
  supervisor: '主管',
  developer: '开发',
  investigator: '调查',
  reviewer: '审阅',
  committer: '提交',
} as const;
const upstream: Record<string, string> = {
  'https://github.com/tw93/Waza': 'waza',
  'https://github.com/mattpocock/skills': 'mattpocock-skills',
  'https://github.com/anthropics/skills': 'anthropic-skills',
};
function within(root: string, path: string): string {
  const canonical = realpathSync(path);
  const rest = relative(root, canonical);
  if (rest === '..' || rest.startsWith('../') || rest.startsWith('..\\') || isAbsolute(rest))
    throw new ProjectError('SKILL_SOURCE_ESCAPE', `Skill来源越出已选目录：${path}`);
  return canonical;
}
function upstreamDirectory(root: string, name: string): string {
  const matches: string[] = [];
  const visit = (directory: string, depth: number) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const child = join(directory, entry.name);
      if (entry.name === name && readdirSync(child).includes('SKILL.md')) matches.push(child);
      if (depth < 4) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  if (matches.length !== 1)
    throw new Error(`Skill来源缺失或存在歧义：${name}，匹配${matches.length}项`);
  return matches[0]!;
}
export function resolveSkillSources(sourceRoot: string, type: WorkflowType): SkillSources {
  try {
    if (!isAbsolute(sourceRoot)) throw new Error('来源目录必须是绝对路径');
    const root = realpathSync(sourceRoot);
    const manifest = within(root, join(root, 'manifests', 'for-mat.json'));
    const bytes = readFileSync(manifest);
    const parsed = manifestSchema.parse(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    );
    const seen = new Set<string>();
    const entries: SkillSource[] = [];
    for (const entry of parsed.entries) {
      if (seen.has(entry.name)) throw new Error(`重复Skill名称：${entry.name}`);
      seen.add(entry.name);
      if (!entry.types.includes(typeNames[type])) continue;
      const directory = entry.path
        ? join(root, entry.path)
        : entry.source in upstream
          ? upstreamDirectory(
              join(root, '.skills', 'upstream', upstream[entry.source]!, 'skills'),
              entry.name,
            )
          : undefined;
      if (!directory) throw new Error(`未识别Skill来源：${entry.name}`);
      if (entry.path && isAbsolute(entry.path))
        throw new Error(`清单路径必须相对来源目录：${entry.name}`);
      const path = within(root, join(directory, 'SKILL.md'));
      if (!lstatSync(path).isFile()) throw new Error(`Skill正文不是文件：${entry.name}`);
      entries.push({ name: entry.name, path, invocation: entry.invocation, source: entry.source });
    }
    return { root, manifest, version: createHash('sha256').update(bytes).digest('hex'), entries };
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    throw new ProjectError(
      'SKILL_SOURCE_UNAVAILABLE',
      `For MAT来源不完整或无效：${error instanceof Error ? error.message : '未知错误'}`,
    );
  }
}
