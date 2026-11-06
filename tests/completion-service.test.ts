import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { completionFixture } from './completion-fixture.ts';
import { CompletionService } from '../src/services/completion-service.ts';
import type { CommunicationService } from '../src/services/chat-service.ts';
import type { NativeAgent, NativeContext } from '../src/host/native.ts';
import type { NativeGoalView } from '../src/contracts/execution.ts';

function fixture() {
  const f = completionFixture(),
    agents = new Map<string, NativeAgent>(),
    goals = new Map<string, NativeGoalView>(),
    calls: { name: string; value?: unknown }[] = [];
  const make = (id: string) =>
    ({
      id,
      status: 'idle',
      inbox: { nextStep: [] },
      session: {
        snapshotEvents: () => [],
        deriveMessages: () => [{ content: 'AUTHOR_PRIVATE_HISTORY_DO_NOT_COPY' }],
      },
    }) as unknown as NativeAgent;
  const author = make('unit-executor');
  let reviewFlushUnknown = false,
    hiddenAuthor = false,
    releaseCreate: (() => void) | undefined,
    createBarrier: Promise<void> | undefined;
  let newReviewPhase: NativeGoalView['phase'] | undefined;
  agents.set(f.session.id, author);
  goals.set(author.id, {
    id: 'unit-main-goal',
    revision: 1,
    objective: '原执行',
    phase: 'active',
    activation: 'armed',
    roundsStarted: 1,
    maxGoalRounds: 2,
  });
  const native = {
    goals: {
      get: (agent: NativeAgent) => goals.get(agent.id),
      disarm: (agent: NativeAgent) => {
        calls.push({ name: 'disarm', value: agent.id });
        const goal = goals.get(agent.id)!;
        goal.activation = 'disarmed';
        return goal;
      },
      pause: (agent: NativeAgent) => {
        calls.push({ name: 'pause', value: agent.id });
        const goal = goals.get(agent.id)!;
        goal.phase = 'paused';
        goal.activation = 'disarmed';
        goal.revision++;
        return goal;
      },
      resume: (agent: NativeAgent) => {
        calls.push({ name: 'resume', value: agent.id });
        const goal = goals.get(agent.id)!;
        goal.phase = 'active';
        goal.activation = 'armed';
        goal.revision++;
        return goal;
      },
      create: (agent: NativeAgent, input: { objective: string }) => {
        calls.push({ name: 'goal', value: input.objective });
        const goal: NativeGoalView = {
          id: 'unit-audit-goal',
          revision: 1,
          objective: input.objective,
          phase: 'active',
          activation: 'armed',
          roundsStarted: 0,
          maxGoalRounds: 1,
        };
        goals.set(agent.id, goal);
        return goal;
      },
    },
    sessions: {
      flush: async (session: NativeAgent['session']) => {
        if (session !== author.session && newReviewPhase) {
          const goal = [...goals.values()].find((goal) => goal.id === 'unit-audit-goal')!;
          goal.phase = newReviewPhase;
          goal.activation = 'disarmed';
          newReviewPhase = undefined;
        }
        if (session !== author.session && reviewFlushUnknown) {
          reviewFlushUnknown = false;
          return false;
        }
        return true;
      },
    },
  } as unknown as NativeContext;
  let failCreate = false;
  const service = new CompletionService(
    f.projects,
    {
      sendSystem: async (
        _project: string,
        input: Parameters<CommunicationService['sendSystem']>[1],
      ) => {
        calls.push({ name: 'notify' });
        return f.connection.messages().saveSystem(input);
      },
    } as unknown as CommunicationService,
    {
      native,
      peek: (_project, id) => (hiddenAuthor && id === f.session.id ? undefined : agents.get(id)),
      openControlled: async (_project, id) => {
        calls.push({ name: 'open', value: id });
        if (id === f.session.id) hiddenAuthor = false;
        return agents.get(id)!;
      },
      async create(_project, input, reserved) {
        calls.push({ name: 'create', value: input });
        if (createBarrier) await createBarrier;
        if (failCreate) {
          failCreate = false;
          throw new Error('创建前的确定失败');
        }
        const session = f.connection.reserveSession(input);
        reserved(session);
        const agent = make('unit-review-' + session.id);
        agents.set(session.id, agent);
        f.connection.bindSession(session.id, agent.id);
        return f.connection.session(session.id);
      },
      async setDirectory(_agent, cwd) {
        calls.push({ name: 'cwd', value: cwd });
        return cwd;
      },
      async inspectAuthor() {
        return {
          agentIdle: true,
          inFlightTools: false,
          filesStable: true,
          fileFingerprint: 'unit',
          processesComplete: true,
          jobObservations: [],
          note: '单元合成观察，不冒充Host',
        };
      },
      async inspectReview() {
        return {
          agentIdle: true,
          inFlightTools: false,
          filesStable: true,
          fileFingerprint: 'unit-review',
          processesComplete: true,
          jobObservations: [],
          note: '单元审核停稳观察',
        };
      },
    },
  );
  f.connection
    .reviews()
    .configure(
      { kind: 'session', sessionId: f.manager.id },
      { operationId: randomUUID(), reviewerRoleId: f.reviewer.id },
    );
  return {
    ...f,
    service,
    author,
    goals,
    calls,
    setFailCreate: () => {
      failCreate = true;
    },
    unknownReviewFlush: () => {
      reviewFlushUnknown = true;
    },
    settleNewReviewDuringFlush: (phase: NativeGoalView['phase']) => {
      newReviewPhase = phase;
    },
    unloadAuthor: () => {
      hiddenAuthor = true;
    },
    blockCreate: () => {
      createBarrier = new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      return () => releaseCreate?.();
    },
    async dispose() {
      await service.close();
      f.close();
    },
  };
}

test('完成Chat服务挂起原Goal，异步仅一次启动新的审核会话并保存通知，不复制作者聊天', async () => {
  const f = fixture();
  try {
    const input = {
        operationId: randomUUID(),
        summary: '完成真实业务后的单元简报',
        scope: '成果.txt',
      },
      saved = f.service.complete(f.connection.snapshot().id, f.session.id, f.author, input);
    expect(f.goals.get(f.author.id)?.phase).toBe('paused');
    await expect.poll(() => f.connection.reviews().get(saved.reviewId).status).toBe('active');
    const review = f.connection.reviews().get(saved.reviewId);
    expect(review.wait.state).toBe('armed');
    expect(review.authorPause.state).toBe('confirmed');
    expect(review.create.state).toBe('confirmed');
    expect(review.start.state).toBe('confirmed');
    expect(f.calls.filter((call) => call.name === 'create')).toHaveLength(1);
    expect(f.calls.filter((call) => call.name === 'goal')).toHaveLength(1);
    const objective = String(f.calls.find((call) => call.name === 'goal')?.value);
    expect(objective).toContain(saved.versionId);
    expect(objective).toContain(f.ticket.goal);
    expect(JSON.parse(objective.split('\n\n')[1]!)).toMatchObject({
      materialWriteDomain: review.materialPath,
    });
    expect(objective).not.toContain('AUTHOR_PRIVATE_HISTORY_DO_NOT_COPY');
    expect(f.service.complete(f.connection.snapshot().id, f.session.id, f.author, input).id).toBe(
      saved.id,
    );
    await Promise.resolve();
    expect(f.calls.filter((call) => call.name === 'create')).toHaveLength(1);
    const notice = f.connection.messages().get(review.notifications[0]!.messageId);
    expect(notice.message.sender.kind).toBe('system');
    expect(notice.message.content).toContain(saved.reviewId);
  } finally {
    await f.dispose();
  }
});

test.each(['complete', 'paused', 'blocked', 'active'] as const)(
  '新审核Goal在首次flush期间变为%s/disarmed时不登记active',
  async (phase) => {
    const f = fixture();
    try {
      f.settleNewReviewDuringFlush(phase);
      const project = f.connection.snapshot().id,
        saved = f.service.complete(project, f.session.id, f.author, {
          operationId: randomUUID(),
          summary: '新建审核状态变化',
          scope: '成果.txt',
        });
      await expect.poll(() => f.connection.reviews().get(saved.reviewId).status).toBe('unknown');
      expect(f.connection.reviews().get(saved.reviewId).start.state).not.toBe('confirmed');
      expect(f.calls.filter((call) => call.name === 'goal')).toHaveLength(1);
      expect(f.calls.filter((call) => call.name === 'resume')).toHaveLength(0);
    } finally {
      await f.dispose();
    }
  },
);

test('独审创建未返回也不阻塞主管通知，沿同一稳定消息记录查询', async () => {
  const f = fixture(),
    release = f.blockCreate();
  try {
    const project = f.connection.snapshot().id,
      saved = f.service.complete(project, f.session.id, f.author, {
        operationId: randomUUID(),
        summary: '通知独立',
        scope: '成果.txt',
      });
    await expect.poll(() => f.calls.filter((call) => call.name === 'create').length).toBe(1);
    await expect.poll(() => f.calls.filter((call) => call.name === 'notify').length).toBe(1);
    const notice = f.connection.reviews().get(saved.reviewId).notifications[0]!;
    expect(f.connection.messages().get(notice.messageId).message.sender.kind).toBe('system');
    expect(f.connection.reviews().get(saved.reviewId).sessionId).toBeNull();
  } finally {
    release();
    await f.dispose();
  }
});

test('审核Goal持久化未知后显式重试恢复同一Goal，清除旧控制回执并实际允许步骤', async () => {
  const f = fixture();
  try {
    f.unknownReviewFlush();
    const project = f.connection.snapshot().id,
      saved = f.service.complete(project, f.session.id, f.author, {
        operationId: randomUUID(),
        summary: '持久化未知',
        scope: '成果.txt',
      });
    await expect.poll(() => f.connection.reviews().get(saved.reviewId).status).toBe('unknown');
    await f.service.reconcileControls();
    const before = f.connection.reviews().get(saved.reviewId),
      goal = f.goals.get(before.nativeSessionId!)!;
    expect(goal.phase).toBe('paused');
    f.service.retry(project, { kind: 'session', sessionId: f.manager.id }, before.id, {
      operationId: randomUUID(),
      reason: '明确重试原审核',
    });
    await expect.poll(() => f.connection.reviews().get(saved.reviewId).status).toBe('active');
    expect(f.connection.reviews().get(saved.reviewId).control).toBeNull();
    expect(goal.id).toBe(before.goalId);
    expect(goal.phase).toBe('active');
    expect(goal.activation).toBe('armed');
    expect(f.calls.filter((call) => call.name === 'create')).toHaveLength(1);
    expect(f.calls.filter((call) => call.name === 'goal')).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});

test('实际Agent装有其他Goal时不保存新交付也不控制其他工作', async () => {
  const f = fixture();
  try {
    f.goals.get(f.author.id)!.id = 'foreign-goal';
    expect(() =>
      f.service.complete(f.connection.snapshot().id, f.session.id, f.author, {
        operationId: randomUUID(),
        summary: '不可代交',
        scope: '成果.txt',
      }),
    ).toThrow('Goal');
    expect(f.calls).toEqual([]);
    expect(f.connection.versions().list(f.execution.id)).toHaveLength(1);
    expect(f.connection.reviews().list()).toHaveLength(0);
  } finally {
    await f.dispose();
  }
});

test('创建前失败保留原交付，主管显式重试只接续同一审核，重复操作不再次启动', async () => {
  const f = fixture();
  try {
    f.setFailCreate();
    const project = f.connection.snapshot().id;
    const saved = f.service.complete(project, f.session.id, f.author, {
      operationId: randomUUID(),
      summary: '完成交回',
      scope: '成果.txt',
    });
    await expect.poll(() => f.connection.reviews().get(saved.reviewId).status).toBe('failed');
    const retry = { operationId: randomUUID(), reason: '核实创建尚未发生后接续' };
    expect(() =>
      f.service.retry(project, { kind: 'session', sessionId: f.session.id }, saved.reviewId, retry),
    ).toThrow('主管');
    f.unloadAuthor();
    f.service.retry(project, { kind: 'session', sessionId: f.manager.id }, saved.reviewId, retry);
    await expect.poll(() => f.connection.reviews().get(saved.reviewId).status).toBe('active');
    f.service.retry(project, { kind: 'session', sessionId: f.manager.id }, saved.reviewId, retry);
    await Promise.resolve();
    expect(f.connection.reviews().list()).toHaveLength(1);
    expect(f.connection.versions().list(f.execution.id)).toHaveLength(2);
    expect(f.calls.filter((call) => call.name === 'create')).toHaveLength(2);
    expect(f.calls.filter((call) => call.name === 'goal')).toHaveLength(1);
  } finally {
    await f.dispose();
  }
});

test('项目停止同步封住审核新步骤，异步挂起原审核Goal并独立核对自己的材料域', async () => {
  const f = fixture();
  try {
    const project = f.connection.snapshot().id,
      saved = f.service.complete(project, f.session.id, f.author, {
        operationId: randomUUID(),
        summary: '停止场景',
        scope: '成果.txt',
      });
    await expect.poll(() => f.connection.reviews().get(saved.reviewId).status).toBe('active');
    const review = f.connection.reviews().get(saved.reviewId);
    expect(f.service.reviewsQuiet(project)).toBe(false);
    f.connection
      .controls()
      .stopProject({ kind: 'user' }, { operationId: randomUUID(), reason: '停止本项目' }, 'unit');
    await f.service.reconcileControls();
    expect(f.goals.get(review.nativeSessionId!)?.phase).toBe('paused');
    expect(f.goals.get(review.nativeSessionId!)?.activation).toBe('disarmed');
    expect(f.connection.reviews().get(review.id).control?.state).toBe('confirmed');
    expect(f.service.reviewsQuiet(project)).toBe(true);
    expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe('awaiting-review');
    expect(() =>
      f.connection.controls().request(
        { kind: 'user' },
        {
          operationId: randomUUID(),
          executionId: f.execution.id,
          action: 'resume',
          expectedRevision: 0,
          reason: '不得跨过审核等待',
        },
        'unit',
      ),
    ).toThrow();
  } finally {
    await f.dispose();
  }
});

test('审阅作业按真实owner关联，未知或未登记来源不能被已停稳回执覆盖', async () => {
  const f = fixture();
  try {
    const project = f.connection.snapshot().id,
      catalog = f.connection.reviews(),
      saved = f.service.complete(project, f.session.id, f.author, {
        operationId: randomUUID(),
        summary: '审阅作业',
        scope: '成果.txt',
      });
    await expect.poll(() => catalog.get(saved.reviewId).status).toBe('active');
    const review = catalog.get(saved.reviewId),
      event = {
        type: 'job/registered',
        seq: 1,
        time: 1,
        data: {
          jobId: 'owned-review-job',
          owner: review.nativeSessionId,
          startedAt: 1,
          kind: 'pwsh',
          label: 'audit',
          toolCall: { callId: 'audit-call' },
        },
      };
    expect(() =>
      catalog.recordJob(review.sessionId!, {
        ...event,
        data: { ...event.data, owner: 'foreign-owner' },
      }),
    ).toThrow('owner');
    catalog.recordJob(review.sessionId!, event);
    catalog.saveManagedRange(review.sessionId!, 'audit-call', {
      id: 'range',
      state: 'unknown',
      note: '提供器未明确true',
      at: new Date().toISOString(),
    });
    expect(catalog.get(review.id).jobs).toHaveLength(1);
    expect(f.connection.controls().jobs(f.execution.id)).toHaveLength(0);
    f.connection
      .controls()
      .stopProject({ kind: 'user' }, { operationId: randomUUID(), reason: '核对未完作业' }, 'unit');
    await f.service.reconcileControls();
    expect(catalog.get(review.id).control?.state).toBe('unknown');
    expect(f.service.reviewsQuiet(project)).toBe(false);
    const goal = f.goals.get(review.nativeSessionId!)!;
    goal.id = 'foreign-review-goal';
    goal.phase = 'active';
    goal.activation = 'armed';
    const before = f.calls.length;
    await f.service.reconcileControls();
    expect(f.calls.slice(before)).toEqual([]);
    expect(goal.phase).toBe('active');
    expect(f.service.reviewsQuiet(project)).toBe(false);
  } finally {
    await f.dispose();
  }
});
