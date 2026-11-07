import { test, expect, vi } from 'vitest';
import { createWorktreeHost } from '../src/host/worktree-host.ts';
import type { NativeAgent, NativeContext } from '../src/host/native.ts';
import type { ProjectService } from '../src/services/project-service.ts';
import type { NativeProcessRanges } from '../src/host/process-ranges.ts';

test('官方worktrees从当前Cordis可选服务读取，未注入属性不直取，服务消失不使用旧实例', async () => {
  const create = vi.fn(async () => ({ path: 'checked' }));
  let active: unknown = { config: { directory: '.agents/worktrees' }, create };
  const ctx = new Proxy(
    { reflect: { get: (name: string) => (name === 'worktrees' ? active : undefined) } },
    {
      get(target, prop) {
        if (prop === 'worktrees') throw new Error('cannot get property worktrees without inject');
        return Reflect.get(target, prop);
      },
    },
  ) as unknown as NativeContext;
  const host = createWorktreeHost(
    ctx,
    {} as ProjectService,
    () => undefined,
    {} as NativeProcessRanges,
    'epoch',
  );
  expect(host.poolDirectory).toBe('.agents/worktrees');
  const agent = {} as NativeAgent,
    input = { name: 'checked', from: 'a'.repeat(40) },
    signal = new AbortController().signal;
  await expect(host.create(agent, input, signal, () => {})).resolves.toEqual({ path: 'checked' });
  expect(create).toHaveBeenCalledTimes(1);
  active = undefined;
  expect(host.poolDirectory).toBeUndefined();
  await expect(host.create(agent, input, signal, () => {})).rejects.toThrow('没有官方');
  expect(create).toHaveBeenCalledTimes(1);
});
