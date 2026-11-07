import { expect, test } from 'vitest';
import { NativeProcessRanges } from '../src/host/process-ranges.ts';
import type { RangeFact } from '../src/host/process-ranges.ts';
import type { NativeAgent, NativeContext, ToolDefinition } from '../src/host/native.ts';

test('宿主每次读取返回不同方法代理时仍能安装观察，并只还原自己的方法', () => {
  const original = () => ({}),
    target = { spawn: original };
  const service = new Proxy(target, {
    get(object, key, receiver) {
      const value = Reflect.get(object, key, receiver);
      return typeof value === 'function' ? new Proxy(value, {}) : value;
    },
  });
  const observer = new NativeProcessRanges(
    { subprocess: service } as unknown as NativeContext,
    () => {},
  );
  expect(observer.available).toBe(true);
  observer.close();
  expect(target.spawn).toBe(original);
});
test('只观察实际MAT工具的受管范围，保留原结果，不把直接返回当退出，关闭还原接口', async () => {
  let release!: () => void;
  const done = new Promise<boolean>((resolve) => {
      release = () => resolve(true);
    }),
    original = () => ({ waitForExit: () => done }),
    service = { spawn: original },
    facts: RangeFact[] = [],
    registered: ToolDefinition[] = [],
    owner = { id: 'unit-owner' } as NativeAgent;
  const definition = {
      name: 'pwsh',
      async execute() {
        await Promise.resolve();
        service.spawn();
        return 'original-result';
      },
    },
    ctx = {
      subprocess: service,
      tools: {
        definitions: () => [definition],
        register: (tool: ToolDefinition) => {
          registered.push(tool);
          return () => {};
        },
      },
    } as unknown as NativeContext;
  const observer = new NativeProcessRanges(ctx, (fact) => facts.push(fact));
  service.spawn();
  expect(facts).toEqual([]);
  observer.install(ctx, owner, 'project', 'session', () => {});
  const result = await registered[0]!.execute({}, {
    agent: owner,
    callId: 'actual-call',
    signal: new AbortController().signal,
  } as Parameters<ToolDefinition['execute']>[1]);
  expect(result).toBe('original-result');
  expect(facts[0]?.state).toBe('pending');
  expect(facts[0]?.callId).toBe('actual-call');
  expect(facts[0]?.nativeOwner).toBe(owner.id);
  expect(() =>
    registered[0]!.execute(
      {},
      { agent: { id: 'foreign' } as NativeAgent, signal: new AbortController().signal },
    ),
  ).toThrow('实际MAT');
  release();
  await expect.poll(() => facts.at(-1)?.state).toBe('gone');
  observer.close();
  expect(service.spawn).toBe(original);
});

test.each([false, undefined, null, 0, 1, 'true'])(
  '退出观察返回%j时不能证明受管范围退出',
  async (confirmed) => {
    const facts: RangeFact[] = [],
      registered: ToolDefinition[] = [],
      owner = { id: 'unit-owner' } as NativeAgent;
    const service = { spawn: () => ({ waitForExit: async () => confirmed }) };
    const ctx = {
      subprocess: service,
      tools: {
        definitions: () => [
          {
            name: 'pwsh',
            async execute() {
              service.spawn();
              return 'original';
            },
          },
        ],
        register: (tool: ToolDefinition) => {
          registered.push(tool);
          return () => {};
        },
      },
    } as unknown as NativeContext;
    const observer = new NativeProcessRanges(ctx, (fact) => facts.push(fact));
    try {
      observer.install(ctx, owner, 'project', 'session', () => {});
      await registered[0]!.execute({}, {
        agent: owner,
        callId: 'actual-call',
        signal: new AbortController().signal,
      } as Parameters<ToolDefinition['execute']>[1]);
      await expect.poll(() => facts.at(-1)?.state).toBe('unknown');
      expect(facts.some((fact) => fact.state === 'gone')).toBe(false);
    } finally {
      observer.close();
    }
  },
);
test('提供器退出观察拒绝时保持unknown，不伪造gone', async () => {
  const facts: RangeFact[] = [],
    registered: ToolDefinition[] = [],
    owner = { id: 'unit-owner' } as NativeAgent,
    service = {
      spawn: () => ({
        waitForExit: async () => {
          throw new Error('provider cannot prove range empty');
        },
      }),
    },
    definition = {
      name: 'pwsh',
      async execute() {
        service.spawn();
        return 'original';
      },
    },
    ctx = {
      subprocess: service,
      tools: {
        definitions: () => [definition],
        register: (tool: ToolDefinition) => {
          registered.push(tool);
          return () => {};
        },
      },
    } as unknown as NativeContext;
  const observer = new NativeProcessRanges(ctx, (fact) => facts.push(fact));
  try {
    observer.install(ctx, owner, 'project', 'session', () => {});
    await registered[0]!.execute({}, {
      agent: owner,
      callId: 'actual-call',
      signal: new AbortController().signal,
    } as Parameters<ToolDefinition['execute']>[1]);
    await expect.poll(() => facts.at(-1)?.state).toBe('unknown');
    expect(facts.some((fact) => fact.state === 'gone')).toBe(false);
  } finally {
    observer.close();
  }
});

test('受管包装传递真实工具名，使原记录查询不被业务目录守卫挡住，终端仍受守卫', async () => {
  const owner = { id: 'query-owner' } as NativeAgent;
  const registered: ToolDefinition[] = [];
  const ctx = {
    subprocess: { spawn: () => ({}) },
    tools: {
      definitions: () =>
        ['mat_worktree', 'pwsh'].map((name) => ({ name, execute: async () => name })),
      register: (d: ToolDefinition) => {
        registered.push(d);
        return () => {};
      },
    },
  } as unknown as NativeContext;
  const observer = new NativeProcessRanges(ctx, () => {});
  try {
    for (const definition of ctx.tools.definitions(owner))
      registered.push(
        observer.wrap(definition, owner, 'project', 'session', (_agent, name) => {
          if (name !== 'mat_worktree') throw new Error('业务目录未知');
        }),
      );
    const exec = { agent: owner, callId: 'real-query', signal: new AbortController().signal };
    await expect(registered[0]!.execute({ action: 'query' }, exec)).resolves.toBe('mat_worktree');
    expect(() => registered[1]!.execute({}, exec)).toThrow('业务目录未知');
    expect(() => registered[0]!.execute({}, { ...exec, agent: { ...owner } })).toThrow('实际MAT');
  } finally {
    observer.close();
  }
});
