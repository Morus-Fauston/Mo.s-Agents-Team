import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { completionFixture } from './completion-fixture.ts';

test('作者停稳必须包含全部真实作业及明确原生终态，不能仅依赖processesComplete', () => {
  const f = completionFixture();
  try {
    const catalog = f.connection.reviews(),
      saved = catalog.complete(f.session.id, {
        operationId: randomUUID(),
        summary: '停稳严格核对',
        scope: '成果.txt',
      });
    f.connection.controls().recordJob(f.session.id, {
      type: 'job/registered',
      seq: 100,
      data: {
        jobId: 'author-job',
        owner: 'unit-executor',
        kind: 'unit',
        label: '仅单元夹具',
        startedAt: 1,
      },
    });
    const observation = {
      agentIdle: true,
      inFlightTools: false,
      filesStable: true,
      fileFingerprint: 'unit',
      processesComplete: true,
      jobObservations: [],
      note: '合成观察',
    };
    for (const jobs of [
      [],
      [{ jobId: 'author-job', nativeStatus: 'unknown', externalStatus: 'gone' as const }],
      [{ jobId: 'author-job', nativeStatus: 'invented-terminal', externalStatus: 'gone' as const }],
    ]) {
      expect(
        catalog.authorPaused(saved.reviewId, 'unit-main-goal', 'unit-executor', true, {
          ...observation,
          jobObservations: jobs,
        }).authorPause.state,
      ).toBe('unknown');
    }
    expect(
      catalog.authorPaused(saved.reviewId, 'unit-main-goal', 'unit-executor', true, {
        ...observation,
        jobObservations: [
          { jobId: 'author-job', nativeStatus: 'completed', externalStatus: 'gone' },
        ],
      }).authorPause.state,
    ).toBe('confirmed');
  } finally {
    f.close();
  }
});
test('完成一次原子保存固定交付、唯一审核、主管待处理和原执行等待，重试不重复', () => {
  const f = completionFixture();
  try {
    const reviews = f.connection.reviews(),
      actor = { kind: 'session' as const, sessionId: f.manager.id };
    reviews.configure(actor, { operationId: randomUUID(), reviewerRoleId: f.reviewer.id });
    const input = {
        operationId: randomUUID(),
        summary: '本次执行简报',
        scope: '成果.txt',
        evidencePaths: [],
        checklistItemIds: [f.ticket.checklist[0]!.id],
      },
      completed = reviews.complete(f.session.id, input);
    expect(completed.executionId).toBe(f.execution.id);
    expect(completed.reviewId).toBeTruthy();
    expect(reviews.get(completed.reviewId).reviewerRole?.id).toBe(f.reviewer.id);
    expect(f.connection.versions().get(completed.versionId).summary).toBe('本次执行简报');
    expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe('awaiting-review');
    expect(f.connection.workbench().getTask(completed.taskId).ticketIds).toEqual([f.ticket.id]);
    expect(f.connection.executions().get(f.execution.id).lifecycleState).toBe('waiting');
    expect(reviews.complete(f.session.id, input).id).toBe(completed.id);
    expect(f.connection.versions().list(f.execution.id)).toHaveLength(2);
    expect(reviews.list(f.execution.id)).toHaveLength(1);
    expect(() => reviews.complete(f.session.id, { ...input, summary: '更改原操作正文' })).toThrow(
      '操作身份',
    );
    expect(() => reviews.complete(f.session.id, { ...input, operationId: randomUUID() })).toThrow(
      '等待',
    );
  } finally {
    f.close();
  }
});

test('缺独审人选保持待审阅和主管待处理，不由作者代选或自审', () => {
  const f = completionFixture();
  try {
    const reviews = f.connection.reviews(),
      source = { kind: 'session' as const, sessionId: f.session.id },
      manager = { kind: 'session' as const, sessionId: f.manager.id };
    expect(() =>
      reviews.configure(source, { operationId: randomUUID(), reviewerRoleId: f.reviewer.id }),
    ).toThrow('仅用户或实际主管');
    expect(() =>
      reviews.configure(manager, { operationId: randomUUID(), reviewerRoleId: f.session.roleId }),
    ).toThrow('审阅类型');
    const saved = reviews.complete(f.session.id, {
        operationId: randomUUID(),
        summary: '缺独审人也保存交付',
        scope: '成果.txt',
      }),
      review = reviews.get(saved.reviewId);
    expect(review.status).toBe('missing-reviewer');
    expect(review.reviewerRole).toBeNull();
    expect(review.sessionId).toBeNull();
    expect(review.start.state).toBe('pending');
    expect(f.connection.workbench().getTask(saved.taskId).state).toBe('unchecked');
    expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe('awaiting-review');
    expect(() =>
      f.connection.workbench().appendLog(source, f.ticket.id, {
        operationId: randomUUID(),
        title: '等待不能改资料',
        type: 'progress',
        importance: 'normal',
        content: '不应写入',
        references: [],
      }),
    ).toThrow('实际执行责任');
  } finally {
    f.close();
  }
});

test('逐票审阅配置可覆盖默认或明确继承，旧配置操作重放不覆盖新安排', () => {
  const f = completionFixture();
  try {
    const reviews = f.connection.reviews(),
      actor = { kind: 'session' as const, sessionId: f.manager.id },
      first = { operationId: randomUUID(), reviewerRoleId: f.reviewer.id };
    reviews.configure(actor, first);
    reviews.configure(actor, {
      operationId: randomUUID(),
      ticketId: f.ticket.id,
      reviewerRoleId: null,
    });
    expect(reviews.configuration(f.ticket.id)).toMatchObject({
      inherit: false,
      reviewerRoleId: null,
    });
    reviews.configure(actor, {
      operationId: randomUUID(),
      ticketId: f.ticket.id,
      reviewerRoleId: null,
      inherit: true,
    });
    expect(reviews.configuration(f.ticket.id)).toMatchObject({
      inherit: true,
      reviewerRoleId: f.reviewer.id,
    });
    reviews.configure(actor, { operationId: randomUUID(), reviewerRoleId: null });
    reviews.configure(actor, first);
    expect(reviews.configuration().reviewerRoleId).toBeNull();
    expect(() => reviews.configure(actor, { ...first, reviewerRoleId: null })).toThrow('操作身份');
  } finally {
    f.close();
  }
});

test('版本已保存后责任接缝失败，外层回滚交付、审核和票据等待，不留半份有效交付', () => {
  const f = completionFixture();
  try {
    const reviews = f.connection.reviews();
    f.connection.workbench().bindExecutionAccess(() => undefined);
    expect(() =>
      reviews.complete(f.session.id, {
        operationId: randomUUID(),
        summary: '缺失实际责任映射',
        scope: '成果.txt',
      }),
    ).toThrow('实际执行责任');
    expect(f.connection.versions().list(f.execution.id)).toHaveLength(1);
    expect(reviews.list(f.execution.id)).toHaveLength(0);
    expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe('in-progress');
    expect(f.connection.executions().get(f.execution.id).lifecycleState).toBe('active');
  } finally {
    f.close();
  }
});

test('原Goal挂起后预留唯一非作者会话，独立材料绑定审核版本，先到的结果不会被再次等待覆盖', () => {
  const f = completionFixture();
  try {
    const reviews = f.connection.reviews();
    reviews.configure(
      { kind: 'session', sessionId: f.manager.id },
      { operationId: randomUUID(), reviewerRoleId: f.reviewer.id },
    );
    const saved = reviews.complete(f.session.id, {
      operationId: randomUUID(),
      summary: '独立审核准备',
      scope: '成果.txt',
    });
    const session = f.connection.reserveSession({
      roleId: f.reviewer.id,
      name: '空上下文审核',
      purpose: '仅单元夹具',
      cwd: f.ticket.materialRoot,
    });
    expect(() => reviews.sessionReserved(saved.reviewId, session.id)).toThrow('挂起');
    reviews.authorPaused(saved.reviewId, 'unit-main-goal', 'unit-executor', true, {
      agentIdle: true,
      inFlightTools: false,
      filesStable: true,
      fileFingerprint: 'fixture',
      processesComplete: true,
      jobObservations: [],
      note: '合成停稳证据，不是真实Host',
    });
    const old = f.connection.reserveSession({
      roleId: f.reviewer.id,
      name: '旧审核聊天',
      purpose: '拒绝作为空上下文',
      cwd: f.root,
    });
    f.connection.bindSession(old.id, 'unit-old-reviewer');
    expect(() => reviews.sessionReserved(saved.reviewId, old.id)).toThrow('空上下文');
    reviews.sessionReserved(saved.reviewId, session.id);
    f.connection.bindSession(session.id, 'unit-reviewer');
    reviews.sessionPrepared(saved.reviewId, session.id, 'unit-reviewer');
    const material = f.connection.workbench().allocateCurrentMaterial(session.id);
    expect(material.kind).toBe('review');
    expect(material.referenceId).toBe(saved.reviewId);
    expect(material.path).not.toBe(f.material.path);
    reviews.materialPrepared(saved.reviewId);
    reviews.goalLinked(
      saved.reviewId,
      {
        id: 'unit-review-goal',
        revision: 1,
        objective: '固定版本审核',
        phase: 'active',
        activation: 'armed',
        roundsStarted: 0,
        maxGoalRounds: 1,
      },
      0,
    );
    reviews.startDurable(saved.reviewId, true, { matches: true, error: null });
    expect(reviews.get(saved.reviewId).status).toBe('active');
    expect(reviews.scopeForSession(session.id)?.kind).toBe('review');
    const resultId = randomUUID();
    reviews.signalWait(saved.reviewId, session.id, saved.versionId, resultId);
    reviews.armWait(saved.reviewId);
    expect(reviews.get(saved.reviewId).wait).toMatchObject({ state: 'signalled', resultId });
    expect(() =>
      reviews.signalWait(saved.reviewId, f.session.id, saved.versionId, randomUUID()),
    ).toThrow('指定');
    expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe('awaiting-review');
  } finally {
    f.close();
  }
});
