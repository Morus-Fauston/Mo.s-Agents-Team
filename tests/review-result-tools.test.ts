import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { reviewResultFixture } from './review-result-fixture.ts';
import { installReviewResultTools } from '../src/host/review-result-tools.ts';
import type { NativeAgent, NativeContext, NativeModules } from '../src/host/native.ts';
import type { ReviewResultService } from '../src/services/review-result-service.ts';
test('正式意见原生参数可见，实际调用派生操作身份；其他角色不取得意见写口', () => {
  const f = reviewResultFixture();
  try {
    type Tool = {
      name: string;
      parameters: Record<string, unknown>;
      execute(raw: unknown, exec: { agent: NativeAgent; callId: string }): string;
    };
    const tools = new Map<string, Tool>(),
      calls: unknown[] = [],
      owner = {
        id: 'unit-result-reviewer',
        session: {
          snapshotEvents: () => [
            {
              seq: 2,
              type: 'tool/call',
              data: { name: 'mat_review_opinion', callId: 'unit-call' },
            },
          ],
        },
      } as unknown as NativeAgent;
    const ctx = {
        tools: { register: (tool: Tool) => tools.set(tool.name, tool) },
      } as unknown as NativeContext,
      modules = { defineTool: (value: unknown) => value } as NativeModules;
    const service = {
      submit: (_project: string, _session: string, _agent: NativeAgent, input: unknown) => {
        calls.push(input);
        return {
          id: randomUUID(),
          reviewId: f.review.id,
          versionId: f.review.versionId,
          verdict: 'pass',
          progress: { state: 'pending' },
        };
      },
      query: () => ({ body: '审计全文😀'.repeat(1500) }),
    } as unknown as ReviewResultService;
    installReviewResultTools(
      ctx,
      owner,
      modules,
      'reviewer',
      () => ({ connection: f.connection, sessionId: f.reviewer.id }),
      service,
    );
    const opinion = tools.get('mat_review_opinion')!;
    expect(opinion.parameters).toHaveProperty('versionId');
    expect(opinion.parameters).toHaveProperty('reviewId');
    expect(opinion.parameters).toHaveProperty('verdict');
    expect(opinion.parameters).not.toHaveProperty('operationId');
    const input = {
        reviewId: f.review.id,
        versionId: f.review.versionId,
        verdict: 'pass',
        scope: '整票',
        basis: '原件及必要验证',
        issues: [],
        evidencePaths: [],
      },
      exec = { agent: owner, callId: 'unit-call' };
    opinion.execute(input, exec);
    opinion.execute(input, exec);
    expect(calls[0]).toEqual(calls[1]);
    expect(calls[0]).toHaveProperty('operationId');
    expect(() => opinion.execute(input, { ...exec, agent: {} as NativeAgent })).toThrow('实际');
    expect(() => opinion.execute({ ...input, operationId: randomUUID() }, exec)).toThrow();
    const read = tools.get('mat_review_result')!,
      parts: string[] = [];
    let offset = 0;
    for (;;) {
      const page = JSON.parse(read.execute({ resultId: randomUUID(), offset }, exec));
      parts.push(page.content);
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
    expect(JSON.parse(parts.join('')).body).toBe('审计全文😀'.repeat(1500));
    tools.clear();
    installReviewResultTools(
      ctx,
      owner,
      modules,
      'developer',
      () => ({ connection: f.connection, sessionId: f.session.id }),
      service,
    );
    expect(tools.has('mat_review_opinion')).toBe(false);
    expect(tools.has('mat_review_result_retry')).toBe(false);
  } finally {
    f.close();
  }
});
