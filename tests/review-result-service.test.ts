import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resultServiceFixture as fixture } from './review-result-runtime-fixture.ts';
test('正式退回等审核停稳后刷新原输入，恢复原Agent原Goal，不另开尝试', async () => {
  const f = fixture();
  try {
    const project = f.connection.snapshot().id,
      result = f.service.submit(project, f.reviewer.id, f.auditAgent, f.input('return'));
    await expect
      .poll(() => f.connection.reviewResults().get(result.id).progress.state)
      .toBe('confirmed');
    const execution = f.connection.executions().get(f.execution.id);
    expect(execution.lifecycleState).toBe('active');
    expect(execution.waitingReviewId).toBeNull();
    expect(execution.reviewResultId).toBe(result.id);
    expect(f.goals.get(f.author.id)).toMatchObject({
      id: 'unit-main-goal',
      phase: 'active',
      activation: 'armed',
      objective: '最新要求及正式退回意见',
    });
    expect(f.calls.indexOf('scope-guard')).toBeLessThan(f.calls.indexOf('resume:unit-executor'));
    expect(f.connection.reviews().get(f.review.id).closure?.state).toBe('confirmed');
    expect(f.connection.executions().list()).toHaveLength(1);
    expect(f.connection.sessions()).toHaveLength(3);
    const notice = f.connection.reviewResults().get(result.id).notifications[0]!;
    expect(f.connection.messages().get(notice.messageId).receipt.targetSessionId).toBe(
      f.session.id,
    );
  } finally {
    await f.dispose();
  }
});
test('正式通过独立核原执行后清原Goal并释放本次占用，只到审阅通过', async () => {
  const f = fixture();
  try {
    const result = f.service.submit(
      f.connection.snapshot().id,
      f.reviewer.id,
      f.auditAgent,
      f.input('pass'),
    );
    await expect
      .poll(() => f.connection.reviewResults().get(result.id).progress.state)
      .toBe('confirmed');
    expect(f.goals.get(f.author.id)).toBeUndefined();
    expect(f.connection.executions().get(f.execution.id)).toMatchObject({
      lifecycleState: 'closed',
      writeOccupancy: 'released',
    });
    expect(f.connection.executions().currentForSession(f.session.id)).toBeUndefined();
    expect(f.connection.session(f.session.id).communicationState).toBe('paused');
    expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe('review-passed');
    expect(f.calls).toContain('observe-after-clear');
    expect(f.calls.filter((call) => call.startsWith('resume:'))).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});
test('审核范围未知不接续或控制尚未接纳返修的作者', async () => {
  const f = fixture();
  try {
    f.setReviewerQuiet(false);
    const result = f.service.submit(
      f.connection.snapshot().id,
      f.reviewer.id,
      f.auditAgent,
      f.input('return'),
    );
    await expect
      .poll(() => f.connection.reviewResults().get(result.id).progress.state)
      .toBe('unknown');
    expect(f.goals.get(f.author.id)?.phase).toBe('paused');
    expect(f.calls.some((call) => call.includes('unit-executor'))).toBe(false);
    expect(f.connection.executions().get(f.execution.id).lifecycleState).toBe('waiting');
    f.setReviewerQuiet(true);
    f.service.retry(f.connection.snapshot().id, { kind: 'user' }, result.id, {
      operationId: randomUUID(),
      reason: '核实原审核范围已停稳',
    });
    await expect
      .poll(() => f.connection.reviewResults().get(result.id).progress.state)
      .toBe('confirmed');
    expect(f.connection.reviewResults().list()).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});
test('原作者已装入其他Goal时不修改、恢复或清理其他工作', async () => {
  const f = fixture();
  try {
    const goal = f.goals.get(f.author.id)!;
    goal.id = 'foreign-goal';
    goal.phase = 'active';
    goal.activation = 'armed';
    const result = f.service.submit(
      f.connection.snapshot().id,
      f.reviewer.id,
      f.auditAgent,
      f.input('return'),
    );
    await expect
      .poll(() => f.connection.reviewResults().get(result.id).progress.state)
      .toBe('unknown');
    expect(goal).toMatchObject({
      id: 'foreign-goal',
      phase: 'active',
      activation: 'armed',
      objective: '旧输入',
    });
    expect(f.calls.some((call) => call.includes('unit-executor'))).toBe(false);
  } finally {
    await f.dispose();
  }
});
