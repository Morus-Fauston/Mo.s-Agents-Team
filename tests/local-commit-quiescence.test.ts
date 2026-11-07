import { test, expect } from 'vitest';
import type { NativeAgent, NativeContext, NativeEvent } from '../src/host/native.ts';
import type { LocalCommitRecord } from '../src/contracts/local-commits.ts';
import { observeLocalCommit } from '../src/host/local-commit-quiescence.ts';
test('提交回报只排除自身真实工具；后台终态不能代替受管范围退出', () => {
  const events: NativeEvent[] = [
      { type: 'tool/call', seq: 1, data: { name: 'pwsh', callId: 'git-call' } },
      { type: 'tool/result', seq: 2, data: { callId: 'git-call' } },
      { type: 'tool/call', seq: 3, data: { name: 'mat_local_commit', callId: 'report' } },
    ],
    agent = {
      id: 'native-local',
      status: 'running',
      inbox: { nextStep: [] },
      session: { snapshotEvents: () => events },
    } as unknown as NativeAgent,
    ctx = {
      jobs: { list: () => [{ id: 'j', owner: 'native-local', status: 'completed' }] },
      goals: { get: () => undefined },
    } as unknown as NativeContext,
    value = {
      native: { nativeSessionId: agent.id, epoch: 'old-host', boundary: 0, ranges: [] },
    } as unknown as LocalCommitRecord;
  const sample = (id?: string) =>
    observeLocalCommit(ctx, agent, agent.id, 'new-host', true, value, id);
  expect(sample('report').state).toBe('unknown');
  value.native!.ranges.push({
    id: 'range',
    nativeOwner: agent.id,
    callId: 'git-call',
    state: 'gone',
    at: 'now',
    note: '原生范围明确退出',
  });
  expect(sample('report').state).toBe('confirmed');
  expect(sample('forged-report').state).toBe('unknown');
  events.push({ type: 'tool/call', seq: 4, data: { name: 'write', callId: 'parallel' } });
  expect(sample('report').state).toBe('unknown');
  events.push({ type: 'tool/result', seq: 5, data: { callId: 'parallel' } });
  value.native!.ranges[0]!.state = 'unknown';
  expect(sample('report').state).toBe('unknown');
});
