import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { resolveSkillSources } from '../services/skill-sources.ts';
import type { SkillSources } from '../services/skill-sources.ts';
import type { WorkflowType } from '../contracts/roles.ts';
import type { NativeContext, NativeModules, NativeSkillProvider } from './native.ts';
import { ProjectError } from '../services/errors.ts';
export class SkillAssembly {
  readonly sources: SkillSources;
  private readonly provider: NativeSkillProvider;
  private readonly modules: NativeModules;
  private readonly lifecycle = new AbortController();
  constructor(ctx: NativeContext, modules: NativeModules, root: string, type: WorkflowType) {
    this.modules = modules;
    this.sources = resolveSkillSources(root, type);
    const roots = [...new Set(this.sources.entries.map((e) => dirname(dirname(e.path))))];
    this.provider = new modules.FileSystemSkillProvider(
      ctx,
      { signal: this.lifecycle.signal, invalidate: () => {} },
      {
        includeDefaultRoots: false,
        customSkillDirs: roots,
        watch: false,
        providerName: 'mat-for-mat',
      },
    );
  }
  async catalog(cwd: string, signal?: AbortSignal) {
    const observed = await this.provider.list({ cwd, ...(signal === undefined ? {} : { signal }) });
    if (!Array.isArray(observed) && !observed.complete)
      throw new ProjectError(
        'SKILL_DISCOVERY_INCOMPLETE',
        '原生Skill来源发现不完整，不以缺失当空目录',
      );
    const candidates = Array.isArray(observed) ? observed : observed.candidates;
    return this.sources.entries.map((entry) => {
      const matches = candidates.filter(
        (candidate) => candidate.name === entry.name && realpathSync(candidate.path) === entry.path,
      );
      if (matches.length !== 1)
        throw new ProjectError(
          'SKILL_NOT_DISCOVERED',
          `原生提供者未唯一发现已登记Skill：${entry.name}`,
        );
      return { ...entry, candidate: matches[0]! };
    });
  }
  async summary(cwd: string, signal: AbortSignal) {
    const catalog = await this.catalog(cwd, signal);
    const entries = catalog.map(({ candidate, ...entry }) => ({
      ...entry,
      description: candidate.description,
      invocationPolicy: candidate.invocation,
    }));
    const body =
      'For MAT适用目录（只提供目录，正文按意图加载；显式入口须本次用户以 $名称 指定；交接须明确安排）\n' +
      JSON.stringify(entries);
    return {
      body,
      version: createHash('sha256').update(this.sources.version).update(body).digest('hex'),
      entries,
    };
  }
  async load(
    name: string,
    cwd: string,
    signal: AbortSignal,
    explicit = false,
  ): Promise<{ body: string; path: string; sha256: string }> {
    const entry = (await this.catalog(cwd, signal)).find((e) => e.name === name);
    if (!entry) throw new ProjectError('SKILL_NOT_ALLOWED', 'Skill不属于当前类型的For MAT来源');
    if (
      (entry.invocation === 'explicit' ||
        entry.invocation === 'explicit-arrangement' ||
        !entry.candidate.invocation.modelInvocable) &&
      !explicit
    )
      throw new ProjectError(
        'SKILL_EXPLICIT_REQUIRED',
        '此Skill须用户明确使用；普通模型调用不能解锁手动入口',
      );
    if (
      explicit &&
      !entry.candidate.invocation.userInvocable &&
      !entry.candidate.invocation.modelInvocable
    )
      throw new ProjectError('SKILL_DISABLED', '来源禁用此Skill调用');
    const skill = await this.provider.get(entry.candidate, { cwd, signal });
    if (!skill || skill.name !== name || realpathSync(skill.path) !== entry.path)
      throw new ProjectError('SKILL_CHANGED', 'Skill来源发生变化或无法完整加载');
    if (
      (!explicit && !skill.invocation.modelInvocable) ||
      (explicit && !skill.invocation.userInvocable && !skill.invocation.modelInvocable)
    )
      throw new ProjectError('SKILL_DISABLED', '重新读取的来源已禁用此调用');
    const body = this.modules.renderSkillContent(skill);
    if (body.length > 8192)
      throw new ProjectError(
        'SKILL_BUDGET',
        '完整Skill超过当前宿主工具结果预算，拒绝返回会被静默裁剪的正文',
      );
    return {
      body,
      path: entry.path,
      sha256: createHash('sha256').update(skill.content).digest('hex'),
    };
  }
  async dispose() {
    this.lifecycle.abort();
    await this.provider.dispose();
  }
}
