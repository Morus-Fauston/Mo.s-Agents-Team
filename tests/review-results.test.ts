import { test, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { reviewResultFixture } from './review-result-fixture.ts';

test.each(['return', 'pass'] as const)(
  '指定实际独审提交%s，原子保留审计、等待结果和业务转态，不冒充原生收尾',
  (verdict) => {
    const f = reviewResultFixture();
    try {
      const results = f.connection.reviewResults(),
        actor = { kind: 'session' as const, sessionId: f.reviewer.id },
        input = {
          operationId: randomUUID(),
          reviewId: f.review.id,
          versionId: f.review.versionId,
          verdict,
          scope: '本票完整固定版本',
          basis: '逐项核对原件与条件',
          issues: verdict === 'return' ? ['缺少错误输入的必要验证，请在原范围修正'] : [],
          evidencePaths: [],
        };
      const result = results.submit(actor, input);
      expect(result.reviewId).toBe(f.review.id);
      expect(result.versionId).toBe(f.review.versionId);
      expect(result.author.sessionId).toBe(f.reviewer.id);
      expect(result.author.roleType).toBe('reviewer');
      expect(result.verdict).toBe(verdict);
      expect(results.get(result.id)).toEqual(result);
      expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe(
        verdict === 'return' ? 'in-progress' : 'review-passed',
      );
      expect(f.connection.reviews().get(f.review.id).wait).toMatchObject({
        state: 'signalled',
        resultId: result.id,
      });
      expect(f.connection.reviews().get(f.review.id).status).toBe('decided');
      expect(f.connection.executions().get(f.execution.id).lifecycleState).toBe('waiting');
      expect(result.progress.state).toBe('pending');
      expect(results.submit(actor, input).id).toBe(result.id);
      expect(results.list(f.execution.id)).toHaveLength(1);
      expect(() => results.submit(actor, { ...input, basis: '同操作改正文' })).toThrow('冲突');
      expect(() => results.submit(actor, { ...input, operationId: randomUUID() })).toThrow();
      expect(f.connection.versions().list(f.execution.id)).toHaveLength(2);
      const targets = result.notifications.map((notice) => notice.targetSessionId);
      expect(targets).toEqual(verdict === 'return' ? [f.session.id] : [f.manager.id]);
    } finally {
      f.close();
    }
  },
);

test('作者、用户和同角色另一会话不能代替指定独审；旧版本不能形成当前意见', () => {
  const f = reviewResultFixture();
  try {
    const results = f.connection.reviewResults(),
      input = {
        operationId: randomUUID(),
        reviewId: f.review.id,
        versionId: f.review.versionId,
        verdict: 'pass',
        scope: '本票',
        basis: '不得代填',
        issues: [],
        evidencePaths: [],
      };
    const other = f.connection.reserveSession({
      roleId: f.reviewer.roleId,
      name: '非指定独审',
      purpose: '不能代为通过',
      cwd: f.root,
    });
    f.connection.bindSession(other.id, 'unit-another-reviewer');
    for (const actor of [
      { kind: 'user' as const },
      ...[f.session.id, f.manager.id, other.id].map((sessionId) => ({
        kind: 'session' as const,
        sessionId,
      })),
    ]) {
      expect(() => results.submit(actor, input)).toThrow();
    }
    expect(() =>
      results.submit(
        { kind: 'session', sessionId: f.reviewer.id },
        { ...input, versionId: f.connection.versions().list(f.execution.id)[0]!.id },
      ),
    ).toThrow('版本');
    expect(results.list(f.execution.id)).toHaveLength(0);
    expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe('awaiting-review');
    expect(f.connection.reviews().get(f.review.id).wait.state).toBe('armed');
  } finally {
    f.close();
  }
});

test('正式转态失败回滚审计记录及已到等待信号，沿原操作可重新提交', () => {
  const f = reviewResultFixture();
  try {
    const results = f.connection.reviewResults(),
      input = {
        operationId: randomUUID(),
        reviewId: f.review.id,
        versionId: f.review.versionId,
        verdict: 'return',
        scope: '本票完整成果',
        basis: '核对事务边界',
        issues: ['补全必要验证'],
        evidencePaths: [],
      },
      actor = { kind: 'session' as const, sessionId: f.reviewer.id };
    const seam = vi.spyOn(f.connection.workbench(), 'reviewDecided').mockImplementationOnce(() => {
      throw new Error('同事务转态前失败');
    });
    expect(() => results.submit(actor, input)).toThrow('同事务');
    expect(results.list(f.execution.id)).toHaveLength(0);
    expect(f.connection.reviews().get(f.review.id).wait).toMatchObject({
      state: 'armed',
      resultId: null,
    });
    expect(f.connection.reviews().get(f.review.id).status).toBe('active');
    expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe('awaiting-review');
    seam.mockRestore();
    expect(results.submit(actor, input).verdict).toBe('return');
    expect(results.list(f.execution.id)).toHaveLength(1);
  } finally {
    f.close();
  }
});
test('正式退回通知只沿已保存的业务目标投给原作者，不扩大普通平台通知权限', () => {
  const f = reviewResultFixture();
  try {
    const result = f.connection.reviewResults().submit(
      { kind: 'session', sessionId: f.reviewer.id },
      {
        operationId: randomUUID(),
        reviewId: f.review.id,
        versionId: f.review.versionId,
        verdict: 'return',
        scope: '整票',
        basis: '原件',
        issues: ['补充验证'],
      },
    );
    const notice = result.notifications[0]!,
      messages = f.connection.messages();
    expect(() =>
      messages.saveSystem({
        id: notice.messageId,
        target: notice.targetSessionId,
        content: notice.content,
      }),
    ).toThrow('主管');
    const saved = messages.saveReviewResult(result.id, notice.messageId);
    expect(saved.message.sender.kind).toBe('system');
    expect(saved.receipt.targetSessionId).toBe(f.session.id);
    expect(saved.message.content).toBe(notice.content);
    expect(messages.saveReviewResult(result.id, notice.messageId).message.id).toBe(
      saved.message.id,
    );
    expect(() => messages.saveReviewResult(result.id, randomUUID())).toThrow();
  } finally {
    f.close();
  }
});
