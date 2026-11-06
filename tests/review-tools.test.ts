import { test, expect } from 'vitest';
import { completionFixture } from './completion-fixture.ts';
import { installReviewTools } from '../src/host/review-tools.ts';
import type { NativeAgent, NativeContext, NativeModules } from '../src/host/native.ts';
import type { CompletionService } from '../src/services/completion-service.ts';
test('审阅工具向DSH提供可见参数，查询分页保留全文，写入校验实际Agent及主管身份', () => {
  const f = completionFixture();
  try {
    let tool:
      | {
          parameters: Record<string, unknown>;
          execute(raw: unknown, exec: { agent: NativeAgent; callId: string }): string;
        }
      | undefined;
    const agent = {
      id: 'unit-executor',
      session: {
        snapshotEvents: () => [
          { seq: 1, type: 'tool/call', data: { name: 'mat_review', callId: 'actual-call' } },
        ],
      },
    } as unknown as NativeAgent;
    const document = { text: '完整审核记录😀'.repeat(1200) },
      parts: string[] = [];
    installReviewTools(
      {
        tools: {
          register: (value: typeof tool) => {
            tool = value;
          },
        },
      } as unknown as NativeContext,
      agent,
      { defineTool: (value: unknown) => value } as NativeModules,
      () => ({ connection: f.connection, sessionId: f.session.id }),
      { query: () => document } as unknown as CompletionService,
    );
    expect(tool!.parameters).toHaveProperty('action');
    expect(tool!.parameters).toHaveProperty('reviewId');
    expect(tool!.parameters).toHaveProperty('reviewerRoleId');
    const exec = { agent, callId: 'actual-call' };
    let offset = 0;
    for (;;) {
      const page = JSON.parse(tool!.execute({ action: 'query', offset }, exec));
      parts.push(page.content);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(JSON.parse(parts.join(''))).toEqual(document);
    expect(() =>
      tool!.execute({ action: 'configure', reviewerRoleId: f.reviewer.id }, exec),
    ).toThrow('主管');
    expect(() => tool!.execute({ action: 'query' }, { ...exec, agent: {} as NativeAgent })).toThrow(
      '实际',
    );
    expect(() => tool!.execute({ action: 'query', arbitrary: true }, exec)).toThrow();
  } finally {
    f.close();
  }
});
