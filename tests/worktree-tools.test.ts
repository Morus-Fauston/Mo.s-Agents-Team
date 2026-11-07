import { NativeProcessRanges } from '../src/host/process-ranges.ts';
import type { ToolDefinition } from '../src/host/native.ts';
import { test, expect, vi } from 'vitest';
import { installWorktreeTools } from '../src/host/worktree-tools.ts';
import type { NativeAgent, NativeContext, NativeModules } from '../src/host/native.ts';
import type { WorktreeService } from '../src/services/worktrees.ts';

test('工作树工具装配不提前索取尚未持久绑定的调用身份，执行时仍拒绝伪造来源', async () => {
  const owner = { id: 'native-before-bind' } as NativeAgent;
  const definitions: Record<string, unknown>[] = [];
  const ctx = {
    tools: { register: (d: Record<string, unknown>) => definitions.push(d) },
  } as unknown as NativeContext;
  const modules = { defineTool: (d: unknown) => d } as unknown as NativeModules;
  const resolve = vi.fn(() => {
    throw new Error('持久绑定尚未完成');
  });
  installWorktreeTools(ctx, owner, modules, 'supervisor', resolve, {
    available: true,
  } as WorktreeService);
  expect(resolve).not.toHaveBeenCalled();
  expect(definitions.map((d) => d.name)).toEqual(['mat_worktree', 'create_worktree']);
  const execute = definitions[0]!.execute as (input: unknown, exec: unknown) => Promise<string>;
  await expect(execute({ action: 'query' }, { agent: { ...owner } })).rejects.toThrow('实际调用者');
  await expect(execute({ action: 'query' }, { agent: owner })).rejects.toThrow('持久绑定尚未完成');
  expect(resolve).toHaveBeenCalledTimes(1);
});

test('MAT工作树与受管范围在同一宿主工具层仅注册一次，不重复覆盖自己的工具', () => {
  const owner = { id: 'same-scope-owner' } as NativeAgent;
  const tools = new Map<string, ToolDefinition>();
  const ctx = {
    subprocess: { spawn: () => ({}) },
    tools: {
      definitions: () => [...tools.values()],
      register: (definition: ToolDefinition) => {
        if (tools.has(definition.name)) throw new Error('already registered in this scope');
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
  } as unknown as NativeContext;
  const modules = { defineTool: (d: unknown) => d } as unknown as NativeModules;
  const observer = new NativeProcessRanges(ctx, () => {});
  try {
    installWorktreeTools(
      ctx,
      owner,
      modules,
      'supervisor',
      () => {
        throw new Error('not executing');
      },
      { available: true } as WorktreeService,
      (definition) => observer.wrap(definition, owner, 'project', 'session', () => {}),
    );
    expect(() => observer.install(ctx, owner, 'project', 'session', () => {})).not.toThrow();
    expect([...tools.keys()]).toEqual(['mat_worktree', 'create_worktree']);
  } finally {
    observer.close();
  }
});

test('工作树别名按每步真实协作身份激活，辅助不可见且复用回主执行后恢复', () => {
  let helper = true,
    available = true;
  const registered: { definition: Record<string, unknown>; options?: { when?: () => boolean } }[] =
    [];
  const ctx = {
    tools: {
      register: (definition: Record<string, unknown>, options?: { when?: () => boolean }) =>
        registered.push({ definition, options }),
    },
  } as unknown as NativeContext;
  const owner = {} as NativeAgent,
    modules = { defineTool: (d: unknown) => d } as unknown as NativeModules;
  const resolve = vi.fn(() => ({
    sessionId: 'actual-session',
    connection: {
      collaborations: () => ({
        currentForSession: () => (helper ? { id: 'actual-collaboration' } : undefined),
      }),
    },
  }));
  installWorktreeTools(
    ctx,
    owner,
    modules,
    'developer',
    resolve as Parameters<typeof installWorktreeTools>[4],
    {
      get available() {
        return available;
      },
    } as WorktreeService,
  );
  expect(resolve).not.toHaveBeenCalled();
  const gate = registered.find((r) => r.definition.name === 'create_worktree')!.options?.when;
  expect(gate).toBeTypeOf('function');
  expect(gate!()).toBe(false);
  helper = false;
  expect(gate!()).toBe(true);
  available = false;
  expect(gate!()).toBe(false);
  available = true;
  expect(gate!()).toBe(true);
});
