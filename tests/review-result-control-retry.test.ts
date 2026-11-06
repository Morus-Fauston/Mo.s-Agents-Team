import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resultServiceFixture } from './review-result-runtime-fixture.ts';
test('上级停止优先；明确按控制修订接续原结果只解除该次协调限制，不能跳过停稳或恢复别的Goal', async () => {
  const f = resultServiceFixture();
  try {
    f.setReviewerQuiet(false);
    const project = f.connection.snapshot().id,
      result = f.service.submit(project, f.reviewer.id, f.auditAgent, f.input('return'));
    await expect
      .poll(() => f.connection.reviewResults().get(result.id).progress.state)
      .toBe('unknown');
    const controls = f.connection.controls(),
      actor = { kind: 'session' as const, sessionId: f.manager.id },
      stop = controls.request(
        actor,
        {
          operationId: randomUUID(),
          executionId: f.execution.id,
          action: 'hard-stop',
          reason: '上级核对',
          expectedRevision: 0,
        },
        'unit',
      );
    const retry = {
      operationId: randomUUID(),
      reason: '核对后仅办理原正式结果',
      expectedControlRevision: 1,
    };
    expect(() => f.service.retry(project, actor, result.id, retry)).toThrow();
    controls.receipt(stop.id, 'goal', { state: 'confirmed', note: '单元模拟已挂起' });
    controls.receipt(stop.id, 'cancel', { state: 'confirmed', note: '单元模拟已取消' });
    controls.observeStopped(stop.id, {
      agentIdle: true,
      inFlightTools: false,
      filesStable: true,
      fileFingerprint: 'unit',
      processesComplete: true,
      jobObservations: [],
      note: '合成停稳',
    });
    expect(() =>
      f.service.retry(project, actor, result.id, { ...retry, expectedControlRevision: 0 }),
    ).toThrow();
    expect(() =>
      f.service.retry(project, actor, result.id, {
        operationId: randomUUID(),
        reason: '未明确解除旧控制',
      }),
    ).toThrow();
    f.setReviewerQuiet(true);
    f.service.retry(project, actor, result.id, retry);
    await expect
      .poll(() => f.connection.reviewResults().get(result.id).progress.state)
      .toBe('confirmed');
    expect(controls.revision(f.execution.id)).toBe(2);
    expect(controls.activeControl(f.execution.id)?.resumeSnapshot).toMatchObject({
      mode: 'review-result-only',
      resultId: result.id,
    });
    expect(f.connection.session(f.session.id).communicationState).toBe('active');
    expect(f.goals.get(f.author.id)?.id).toBe('unit-main-goal');
    expect(f.connection.executions().list()).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});
