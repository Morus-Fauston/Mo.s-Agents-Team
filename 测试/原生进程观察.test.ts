import { expect, test } from 'vitest';
import { NativeProcessRanges } from '../源码/宿主/进程范围观察.ts';
import type { RangeFact } from '../源码/宿主/进程范围观察.ts';
import type { NativeAgent, NativeContext, ToolDefinition } from '../源码/宿主/原生接口.ts';
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
