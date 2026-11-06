import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resultServiceFixture } from './review-result-runtime-fixture.ts';
test('主管退回已收尾成果原子建立关联新尝试，不能普通唤醒旧Goal；失败登记完整回滚', async () => {
  const f = resultServiceFixture();
  try {
    const r = f.service.submit(
      f.connection.snapshot().id,
      f.reviewer.id,
      f.auditAgent,
      f.input('pass'),
    );
    await expect
      .poll(() => f.connection.reviewResults().get(r.id).progress.state)
      .toBe('confirmed');
    const actor = { kind: 'session' as const, sessionId: f.manager.id },
      catalog = f.connection.acceptance();
    const body = {
      operationId: randomUUID(),
      ticketId: f.ticket.id,
      versionId: r.versionId,
      resultId: r.id,
      reason: '补做原范围缺项',
      dispatch: { roleId: f.role.id, name: '补做', cwd: f.root, requirements: '原范围补做' },
    };
    const register = (raw: unknown) =>
      f.connection.executions().register(actor, raw, 'unit').record;
    expect(() =>
      catalog.supplement(actor, body, () => {
        throw new Error('模拟登记失败');
      }),
    ).toThrow('登记失败');
    expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe('review-passed');
    expect(f.connection.executions().list()).toHaveLength(1);
    const saved = catalog.supplement(actor, body, register);
    expect(saved.previousExecutionId).toBe(f.execution.id);
    expect(saved.executionId).not.toBe(f.execution.id);
    expect(
      catalog.supplement(actor, body, () => {
        throw new Error('不能重复派工');
      }).id,
    ).toBe(saved.id);
    expect(f.connection.workbench().getTicket(f.ticket.id).currentExecution).toBe(
      saved.executionId,
    );
    expect(f.connection.executions().get(f.execution.id).lifecycleState).toBe('closed');
    expect(f.goals.get(f.author.id)).toBeUndefined();
    expect(f.connection.reviewResults().get(r.id).progress.state).toBe('confirmed');
    expect(() =>
      catalog.complete(actor, {
        operationId: randomUUID(),
        ticketId: f.ticket.id,
        versionId: r.versionId,
        resultId: r.id,
        basis: '旧版本不能结新尝试',
      }),
    ).toThrow();
  } finally {
    await f.dispose();
  }
});
test('正常退回不广播；原作者只有显式争议才建立关联主管待处理，重复不新增', async () => {
  const f = resultServiceFixture();
  try {
    const r = f.service.submit(
      f.connection.snapshot().id,
      f.reviewer.id,
      f.auditAgent,
      f.input('return'),
    );
    await expect
      .poll(() => f.connection.reviewResults().get(r.id).progress.state)
      .toBe('confirmed');
    const catalog = f.connection.acceptance(),
      input = {
        operationId: randomUUID(),
        resultId: r.id,
        kind: 'scope',
        basis: '要求超出本次允许范围',
        evidencePaths: [],
      };
    const before = f.connection.workbench().tasks(true).length;
    expect(() => catalog.escalate({ kind: 'session', sessionId: f.reviewer.id }, input)).toThrow();
    const saved = catalog.escalate({ kind: 'session', sessionId: f.session.id }, input);
    expect(catalog.escalate({ kind: 'session', sessionId: f.session.id }, input).id).toBe(saved.id);
    expect(f.connection.workbench().tasks(true)).toHaveLength(before + 1);
    expect(saved.resultId).toBe(r.id);
    expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe('in-progress');
  } finally {
    await f.dispose();
  }
});
