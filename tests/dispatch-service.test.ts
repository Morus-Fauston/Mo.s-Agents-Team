import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectService } from '../src/services/project-service.ts';
import { DispatchService } from '../src/services/dispatch-service.ts';
import type { DispatchHost } from '../src/services/dispatch-service.ts';
import type { NativeAgent } from '../src/host/native.ts';
import type { NativeGoalView } from '../src/contracts/execution.ts';
import type { RequestRecord } from '../src/contracts/session-runtime.ts';
import { ExecutionControlService } from '../src/services/execution-controls.ts';
import type { NativeContext } from '../src/host/native.ts';
import type { CommunicationService } from '../src/services/chat-service.ts';
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mat-dispatch-service-')),
    root = join(directory, '项目');
  mkdirSync(root);
  const projects = new ProjectService(join(directory, '存储')),
    project = projects.create({
      root,
      name: '调度接缝单测',
      supervisor: { provider: 'unit', model: 'unit' },
    }),
    connection = projects.forProject(project.id),
    wb = connection.workbench(),
    user = { kind: 'user' as const };
  const phase = wb.createPhase(user, {
    operationId: randomUUID(),
    name: '一期',
    goal: '只验证调度',
    basis: '不冒充实际Host证据',
    checklist: [],
  });
  wb.openPhase(user, phase.id, { operationId: randomUUID(), reason: '单测' });
  const category = wb.createCategory(user, {
      operationId: randomUUID(),
      code: 'TEST',
      name: '验证',
    }),
    ticket = wb.createTicket(user, {
      operationId: randomUUID(),
      phaseId: phase.id,
      categoryId: category.id,
      title: '准备边界',
      goal: '稳定登记与失败',
      included: '单测',
      excluded: '非真实Host',
      dependencies: [],
      conditions: [{ condition: '验证状态事实', verification: 'automated' }],
    }),
    role = connection.registerRole({
      code: 'DEV',
      name: '开发',
      type: 'developer',
      configuration: { provider: 'unit', model: 'unit' },
    }),
    manager = connection.reserveSession({
      roleId: connection.roles()[0]!.id,
      name: '主管夹具',
      purpose: '单测',
      cwd: root,
    });
  connection.bindSession(manager.id, 'unit-manager');
  let goalsCreated = 0,
    opens = 0,
    goal: NativeGoalView | undefined;
  const agents = new Map<string, NativeAgent>();
  const host: DispatchHost = {
    async create(_project, input, reserved) {
      const session = connection.reserveSession(input);
      reserved(session);
      connection.bindSession(session.id, 'unit-' + session.id);
      agents.set(session.id, {
        id: 'unit-' + session.id,
        status: 'idle',
        inbox: { nextStep: [], remove() {} },
        model: { current: () => ({ provider: 'unit', model: 'unit' }), select() {} },
        session: { snapshotEvents: () => [] },
      } as unknown as NativeAgent);
      return connection.session(session.id);
    },
    async open(_project, id) {
      opens++;
      return agents.get(id)!;
    },
    peek: (_project, id) => agents.get(id),
    directory: () => root,
    ensureDirectory: async () => root,
    setDirectory: async (_agent, cwd) => cwd,
    getGoal: () => goal,
    createGoal(_agent, input) {
      goalsCreated++;
      goal = {
        id: 'unit-goal-' + randomUUID(),
        revision: 1,
        objective: input.objective,
        phase: 'active',
        activation: 'armed',
        roundsStarted: 0,
        maxGoalRounds: 1,
      };
      return goal;
    },
    flush: async () => true,
    notify: async (_project, input) => connection.messages().saveSystem(input),
  };
  connection
    .controls()
    .startProject({ kind: 'user' }, { operationId: randomUUID(), reason: '单测明确启动' }, 'unit');
  connection.controls().projectReady('unit', manager.id);
  const service = new DispatchService(projects, host),
    actor = { kind: 'session' as const, sessionId: manager.id },
    input = {
      operationId: randomUUID(),
      ticket: ticket.id,
      roleId: role.id,
      name: '本票',
      cwd: root,
      maxGoalRounds: 1,
    };
  return {
    root,
    projects,
    project,
    connection,
    service,
    host,
    actor,
    input,
    agents,
    counts: () => ({ goalsCreated, opens }),
    async close() {
      await service.close();
      projects.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test('正式派工先固定实际工作区和材料基线，再创建原生Goal', async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.root, '派工前.txt'), '必须进入派工基线');
    const original = f.host.createGoal;
    let beforeLaunch = '';
    f.host.createGoal = (agent, input) => {
      const record = f.connection.executions().list()[0]!,
        baseline = f.connection.versions().list(record.id)[0];
      if (baseline)
        beforeLaunch = f.connection.versions().file(baseline.id, 0, '派工前.txt').toString();
      return original(agent, input);
    };
    const record = f.service.dispatch(f.project.id, f.actor, f.input);
    await expect.poll(() => f.connection.executions().get(record.id).goalDurableAt).not.toBeNull();
    expect(beforeLaunch).toBe('必须进入派工基线');
    expect(f.connection.versions().list(record.id)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test('先返回稳定登记，异步Goal回执未知保留身份与占用，查询不另开会话', async () => {
  const f = await fixture();
  try {
    f.host.flush = async () => false;
    const immediate = f.service.dispatch(f.project.id, f.actor, f.input);
    expect(immediate.startupState).toBe('registered');
    expect(f.counts().goalsCreated).toBe(0);
    await expect.poll(() => f.connection.executions().get(immediate.id).failure).not.toBeNull();
    const actual = f.connection.executions().get(immediate.id);
    expect(actual.goalId).toBeTruthy();
    expect(actual.startupState).toBe('unknown');
    expect(actual.writeOccupancy).toBe('unknown');
    expect(actual.notifications[0]?.state).toBe('saved');
    expect(
      f.connection.messages().get(actual.notifications[0]!.messageId).message.sender.kind,
    ).toBe('system');
    const counts = f.counts();
    f.service.query(f.project.id, actual.id);
    expect(f.counts()).toEqual(counts);
    expect(f.service.dispatch(f.project.id, f.actor, f.input).id).toBe(actual.id);
    expect(f.counts().goalsCreated).toBe(1);
    expect(() => f.service.context(f.project.id, actual.sessionId!, f.root)).toThrow(
      '未在当前宿主确认',
    );
  } finally {
    await f.close();
  }
});
test('已有会话派工的同一操作回读不因当前忙碌而丢失原安排', async () => {
  const f = await fixture();
  try {
    const session = await f.host.create(
        f.project.id,
        { roleId: f.input.roleId, name: '复用夹具', purpose: '单测', cwd: f.root },
        () => {},
      ),
      input = { ...f.input, roleId: undefined, sessionId: session.id };
    const registered = f.service.dispatch(f.project.id, f.actor, input);
    await expect
      .poll(() => f.connection.executions().get(registered.id).goalDurableAt)
      .not.toBeNull();
    f.agents.get(session.id)!.status = 'running';
    expect(f.service.dispatch(f.project.id, f.actor, input).id).toBe(registered.id);
    expect(f.counts().goalsCreated).toBe(1);
  } finally {
    await f.close();
  }
});
async function startedFixture() {
  const f = await fixture(),
    record = f.service.dispatch(f.project.id, f.actor, f.input);
  await expect.poll(() => f.connection.executions().get(record.id).goalDurableAt).not.toBeNull();
  const current = f.connection.executions().get(record.id),
    agent = f.agents.get(current.sessionId!)!;
  let seq = 0;
  const event = (type: string, data: Record<string, unknown>) =>
    f.service.observe(f.project.id, current.sessionId!, agent, { type, seq: ++seq, data });
  const step = (number: number) => {
    event('step/start', { turn: 1, step: number });
    const request: RequestRecord = {
      id: randomUUID(),
      sessionId: current.sessionId!,
      nativeAttemptId: 'unit:' + number,
      turn: 1,
      step: number,
      contextVersion: 'unit',
      sources: [],
      skillManifestVersion: 'unit',
      skillCatalogVersion: 'unit',
      loadedSkills: [],
      requestConfiguration: { provider: 'unit', model: 'unit' },
      reportedModel: 'unit',
      usage: null,
      status: 'completed',
      error: null,
      startedAt: new Date().toISOString(),
      executionId: record.id,
    };
    f.connection.saveRequest(request);
    f.service.requestObserved(f.project.id, current.sessionId!, request.id);
    event('step/end', { turn: 1, step: number });
  };
  return { ...f, record, agent, current, event, step };
}
test('运行服务软停止只disarm并投递平台要求，不调用cancel或kill', async () => {
  const f = await startedFixture();
  let cancelled = 0,
    killed = 0,
    disarmed = 0,
    paused = 0;
  const native = {
    goals: {
      get: () => f.host.getGoal(f.agent),
      disarm: () => {
        disarmed++;
        const goal = f.host.getGoal(f.agent)!;
        goal.activation = 'disarmed';
        return goal;
      },
      pause: () => {
        paused++;
      },
    },
    jobs: {
      kill: () => {
        killed++;
      },
    },
    sessions: { flush: async () => true },
  } as unknown as NativeContext;
  f.agent.cancel = () => {
    cancelled++;
  };
  const communication = {
    sendControl: async (_project: string, id: string, kind: 'request' | 'resume') =>
      f.connection.messages().recordControl(id, kind),
  } as unknown as CommunicationService;
  const control = new ExecutionControlService(f.projects, f.service, communication, {
    native,
    peek: () => f.agent,
    openControlled: async () => f.agent,
    freshContext: async () => ({ unit: true }),
  });
  try {
    const registered = control.request(
      f.project.id,
      { kind: 'user' },
      {
        operationId: randomUUID(),
        executionId: f.record.id,
        action: 'soft-stop',
        reason: '单测安全收尾',
        expectedRevision: 0,
      },
    );
    expect(registered.status).toBe('requested');
    await expect.poll(() => f.connection.controls().get(registered.id).status).toBe('delivered');
    expect(disarmed).toBe(1);
    expect(cancelled).toBe(0);
    expect(killed).toBe(0);
    expect(paused).toBe(0);
    expect(f.connection.executions().get(f.record.id).lifecycleState).toBe('active');
    expect(f.connection.executions().get(f.record.id).writeOccupancy).toBe('pending-release');
    expect(f.connection.messages().get(registered.messageId).message.sender.kind).toBe('system');
  } finally {
    await control.close();
    await f.close();
  }
});
test('第三步结束后的异步hook失败不提前确认启动，故障与通知沿同次身份保存', async () => {
  const f = await startedFixture();
  try {
    for (const step of [1, 2, 3]) f.step(step);
    await Promise.resolve();
    expect(f.connection.executions().get(f.record.id).completedSteps).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 0));
    f.service.hostError(f.project.id, f.current.sessionId!, f.agent, {
      turn: 1,
      step: 3,
      error: { code: 'UNIT_LATE_STOP_HOOK' },
    });
    f.event('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { code: 'UNIT_LATE_STOP_HOOK' } },
    });
    await expect
      .poll(() => f.connection.executions().get(f.record.id).notifications[0]?.state)
      .toBe('saved');
    const value = f.connection.executions().get(f.record.id);
    expect(value.completedSteps).toBe(2);
    expect(value.confirmedAt).toBeNull();
    expect(value.failure?.phase).toBe('startup');
    expect(f.connection.executions().steps(value.id).at(-1)?.failed).toBe(true);
    expect(value.notifications).toHaveLength(1);
  } finally {
    await f.close();
  }
});
test('aborted轮不把最后工具中断步骤计为启动成功，completed轮才确认最后一步', async () => {
  const f = await startedFixture();
  try {
    for (const step of [1, 2, 3]) f.step(step);
    f.event('turn/end', { turn: 1, reason: { kind: 'aborted' } });
    expect(f.connection.executions().get(f.record.id).completedSteps).toBe(2);
    expect(f.connection.executions().get(f.record.id).confirmedAt).toBeNull();
  } finally {
    await f.close();
  }
  const success = await startedFixture();
  try {
    for (const step of [1, 2, 3]) success.step(step);
    success.event('turn/end', { turn: 1, reason: { kind: 'completed' } });
    expect(success.connection.executions().get(success.record.id).completedSteps).toBe(3);
    expect(success.connection.executions().get(success.record.id).startupState).toBe('confirmed');
  } finally {
    await success.close();
  }
});
test('没有新step的独立agent/error仍保存，外来Agent拒绝，重复error不新建通知', async () => {
  const f = await startedFixture();
  try {
    f.service.hostError(
      f.project.id,
      f.current.sessionId!,
      { ...f.agent, id: 'unit-foreign' },
      { error: { code: 'UNIT_START_APPEND' } },
    );
    expect(f.connection.executions().get(f.record.id).failure).toBeNull();
    f.service.hostError(f.project.id, f.current.sessionId!, f.agent, {
      turn: 1,
      step: 0,
      error: { code: 'UNIT_START_APPEND' },
    });
    await expect
      .poll(() => f.connection.executions().get(f.record.id).notifications[0]?.state)
      .toBe('saved');
    const first = f.connection.executions().get(f.record.id);
    f.service.hostError(f.project.id, f.current.sessionId!, f.agent, {
      turn: 1,
      step: 0,
      error: { code: 'UNIT_START_APPEND' },
    });
    f.event('turn/end', { turn: 1, reason: { kind: 'error' } });
    await Promise.resolve();
    const current = f.connection.executions().get(f.record.id);
    expect(current.failure?.id).toBe(first.failure?.id);
    expect(current.notifications).toHaveLength(1);
    expect(current.firstRequestId).toBeNull();
    expect(current.startupState).toBe('error');
    expect(current.writeOccupancy).not.toBe('released');
  } finally {
    await f.close();
  }
});
