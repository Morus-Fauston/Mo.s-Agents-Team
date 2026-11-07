import { test, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { completionFixture } from './completion-fixture.ts';
import {
  ModelConfigurationService,
  modelFaultMatches,
} from '../src/services/model-configurations.ts';
import type { NativeAgent, NativeEvent } from '../src/host/native.ts';
import type { ExecutionConfiguration } from '../src/contracts/project.ts';
function fixture(enabled = true, formal = false) {
  const f = completionFixture(),
    c = f.connection;
  const configuration = { provider: 'bad', model: 'primary' },
    fallback = { provider: 'p', model: 'backup' };
  const role = c.registerRole({
      code: 'MODEL',
      type: 'developer',
      name: '模型服务',
      configuration,
      fallback: { enabled, configuration: fallback },
    }),
    s = c.reserveSession({ roleId: role.id, name: '备用目标', purpose: '服务边界', cwd: f.root });
  c.bindSession(s.id, 'native-model');
  let formalExecution: string | undefined;
  if (formal) {
    const ticket = c.workbench().createTicket(
      { kind: 'user' },
      {
        operationId: randomUUID(),
        phaseId: f.ticket.phaseId,
        categoryId: f.ticket.categoryId,
        title: '备用正式执行',
        goal: '原Goal接续',
        included: '材料',
        excluded: '额外动作',
        conditions: [{ condition: '来源可核', verification: 'automated' }],
      },
    );
    const e = c.executions().register(
      { kind: 'session', sessionId: f.manager.id },
      {
        operationId: randomUUID(),
        ticket: ticket.id,
        sessionId: s.id,
        name: '备用正式执行',
        cwd: f.root,
        writeScopes: [],
      },
      'unit',
    ).record;
    formalExecution = e.id;
    c.executions().sessionPrepared(e.id, s.id);
    c.workbench().allocateCurrentMaterial(s.id);
    c.versions().baseline(e.id);
    c.executions().starting(e.id, 10, configuration, '原Goal接续');
    c.executions().goalLinked(e.id, {
      id: 'original-fallback-goal',
      revision: 1,
      objective: '原Goal接续',
      phase: 'active',
      activation: 'armed',
      roundsStarted: 1,
      maxGoalRounds: 2,
    });
    c.executions().goalDurable(e.id);
  }
  let current = configuration,
    allowed = true,
    canSwitch = true,
    flushResult = true;
  const events: NativeEvent[] = [],
    wakes = vi.fn(),
    select = vi.fn((config: ExecutionConfiguration) => {
      current = config;
      events.push({ type: 'model/selection', seq: events.length, data: { ...config } });
    });
  const agent = {
    id: 'native-model',
    status: 'idle',
    whenIdle: async () => {},
    model: { current: () => current, select },
    session: { snapshotEvents: () => events },
    steer: wakes,
  } as unknown as NativeAgent;
  const flush = vi.fn(async () => flushResult),
    fault = vi.fn(),
    host = {
      peek: () => agent,
      flush,
      canContinue: () =>
        allowed &&
        (!formalExecution || c.executions().get(formalExecution).lifecycleState === 'active'),
      canSwitch: () => canSwitch,
      classify: (e: unknown) => (e as { code?: string })?.code ?? null,
      recoverableFault: (_agent: NativeAgent, error: string) => modelFaultMatches(events, error),
      fault,
    };
  const service = new ModelConfigurationService(f.projects, host),
    error = { turn: 1, step: 1, error: { code: 'NO_ADAPTER' } };
  return {
    ...f,
    c,
    s,
    service,
    agent,
    host,
    events,
    wakes,
    select,
    fault,
    error,
    formalExecution,
    setAllowed: (v: boolean) => {
      allowed = v;
    },
    setCanSwitch: (v: boolean) => {
      canSwitch = v;
    },
    setFlush: (v: boolean) => {
      flushResult = v;
    },
    async finish() {
      await service.close();
      f.close();
    },
  };
}
test('用户明确切换仅清除已核对的旧模型故障，新消息可投；未知工具故障不被改配置抹除', async () => {
  const f = fixture(false);
  try {
    f.events.push({
      type: 'turn/end',
      seq: 0,
      data: {
        turn: 1,
        reason: { kind: 'error', error: { code: 'NO_ADAPTER', message: '旧模型故障' } },
      },
    });
    f.c.recordSessionError(f.s.id, '旧模型故障');
    const state = f.c.modelPolicies().state(f.s.id);
    await f.service.explicit(f.c.snapshot().id, f.s.id, {
      operationId: randomUUID(),
      expectedRevision: state.revision,
      configuration: { provider: 'p', model: 'explicit' },
      reason: '用户明确修复模型配置',
    });
    expect(f.c.session(f.s.id).error).toBeNull();
    expect(f.wakes).not.toHaveBeenCalled();
    f.c.recordSessionError(f.s.id, '未知工具故障');
    await f.service.explicit(f.c.snapshot().id, f.s.id, {
      operationId: randomUUID(),
      expectedRevision: f.c.modelPolicies().state(f.s.id).revision,
      configuration: { provider: 'p', model: 'explicit2' },
      reason: '仅换配置不证明未知故障已解',
    });
    expect(f.c.session(f.s.id).error).toBe('未知工具故障');
  } finally {
    await f.finish();
  }
});
test('用户切换持久未知保留旧模型故障，原事件补核后才解除异常门禁且不唤醒', async () => {
  const f = fixture(false);
  try {
    f.events.push({
      type: 'turn/end',
      seq: 0,
      data: {
        turn: 1,
        reason: { kind: 'error', error: { code: 'NO_ADAPTER', message: '旧模型故障' } },
      },
    });
    f.c.recordSessionError(f.s.id, '旧模型故障');
    f.setFlush(false);
    const input = {
      operationId: randomUUID(),
      expectedRevision: f.c.modelPolicies().state(f.s.id).revision,
      configuration: { provider: 'p', model: 'explicit' },
      reason: '明确切换待核',
    };
    await expect(f.service.explicit(f.c.snapshot().id, f.s.id, input)).rejects.toThrow('持久');
    expect(f.c.session(f.s.id).error).toBe('旧模型故障');
    const change = f.c.modelPolicies().history(f.s.id)[0]!;
    f.setFlush(true);
    await f.service.retry(f.c.snapshot().id, f.s.id, change.id);
    expect(f.c.session(f.s.id).error).toBeNull();
    expect(f.select).toHaveBeenCalledTimes(1);
    expect(f.wakes).not.toHaveBeenCalled();
  } finally {
    await f.finish();
  }
});
test('已确认旧切换的重放不能清除之后新发生的模型故障', async () => {
  const f = fixture(false);
  try {
    f.events.push({
      type: 'turn/end',
      seq: 0,
      data: {
        turn: 1,
        reason: { kind: 'error', error: { code: 'NO_ADAPTER', message: '旧模型故障' } },
      },
    });
    f.c.recordSessionError(f.s.id, '旧模型故障');
    const input = {
      operationId: randomUUID(),
      expectedRevision: f.c.modelPolicies().state(f.s.id).revision,
      configuration: { provider: 'p', model: 'explicit' },
      reason: '旧切换',
    };
    const change = await f.service.explicit(f.c.snapshot().id, f.s.id, input);
    expect(f.c.session(f.s.id).error).toBeNull();
    f.events.push({
      type: 'turn/end',
      seq: 2,
      data: {
        turn: 2,
        reason: { kind: 'error', error: { code: 'NO_ADAPTER', message: '新模型故障' } },
      },
    });
    f.c.recordSessionError(f.s.id, '新模型故障');
    await f.service.explicit(f.c.snapshot().id, f.s.id, input);
    expect(f.c.session(f.s.id).error).toBe('新模型故障');
    await f.service.retry(f.c.snapshot().id, f.s.id, change.id);
    expect(f.c.session(f.s.id).error).toBe('新模型故障');
    expect(f.select).toHaveBeenCalledTimes(1);
  } finally {
    await f.finish();
  }
});
test('正式执行原模型turn/end保留失败步骤而不抢先中止备用；其他轮故障不能借原切换忽略', async () => {
  const f = fixture(true, true);
  try {
    let release!: () => void;
    f.agent.whenIdle = () =>
      new Promise<void>((r) => {
        release = r;
      });
    const cat = f.c.executions(),
      id = f.formalExecution!;
    cat.stepStarted(f.s.id, { type: 'step/start', seq: 11, data: { turn: 1, step: 1 } });
    expect(f.service.modelError(f.c.snapshot().id, f.s.id, f.agent, f.error)).toBe(true);
    const changeId = f.service.recoveryForTurn(f.c.snapshot().id, f.s.id, 1, 'NO_ADAPTER');
    expect(changeId).toBeTruthy();
    cat.turnEnded(
      f.s.id,
      {
        type: 'turn/end',
        seq: 13,
        data: { turn: 1, reason: { kind: 'error', error: { code: 'NO_ADAPTER' } } },
      },
      changeId,
    );
    expect(cat.get(id).failure).toBeNull();
    expect(cat.steps(id)[0]!.failed).toBe(true);
    release();
    await vi.waitFor(() => expect(f.wakes).toHaveBeenCalledTimes(1));
    expect(cat.get(id).goalId).toBe('original-fallback-goal');
    expect(f.service.recoveryForTurn(f.c.snapshot().id, f.s.id, 2, 'NO_ADAPTER')).toBeUndefined();
    cat.stepStarted(f.s.id, { type: 'step/start', seq: 19, data: { turn: 1, step: 2 } });
    cat.turnEnded(
      f.s.id,
      {
        type: 'turn/end',
        seq: 20,
        data: { turn: 1, reason: { kind: 'error', error: { code: 'NO_ADAPTER' } } },
      },
      changeId,
    );
    expect(cat.get(id).lifecycleState).toBe('error');
  } finally {
    await f.finish();
  }
});
test('未启用不选备用；启用只在原生持久确认后唤醒原会话，备用失败不遍历', async () => {
  const off = fixture(false);
  try {
    expect(off.service.modelError(off.c.snapshot().id, off.s.id, off.agent, off.error)).toBe(false);
    expect(off.select).not.toHaveBeenCalled();
  } finally {
    await off.finish();
  }
  const f = fixture();
  try {
    expect(f.service.modelError(f.c.snapshot().id, f.s.id, f.agent, f.error)).toBe(true);
    await vi.waitFor(() => expect(f.wakes).toHaveBeenCalledTimes(1));
    expect(f.select).toHaveBeenCalledTimes(1);
    expect(f.host.flush).toHaveBeenCalledTimes(1);
    expect(f.c.modelPolicies().state(f.s.id).current.model).toBe('backup');
    expect(f.service.modelError(f.c.snapshot().id, f.s.id, f.agent, f.error)).toBe(true);
    expect(f.c.modelPolicies().state(f.s.id).fallbackState).toBe('selected');
    expect(f.wakes).toHaveBeenCalledTimes(1);
    expect(
      f.service.modelError(f.c.snapshot().id, f.s.id, f.agent, {
        turn: 2,
        step: 1,
        error: new Error('切换后的宿主准备失败'),
      }),
    ).toBe(false);
    expect(f.c.modelPolicies().state(f.s.id).fallbackState).toBe('failed');
    expect(f.select).toHaveBeenCalledTimes(1);
    expect(f.c.executions().get(f.execution.id).lifecycleState).toBe('active');
  } finally {
    await f.finish();
  }
});
test('备用选择持久未知不唤醒；补核原事件不重复选择、不恢复执行控制', async () => {
  const f = fixture();
  try {
    f.setFlush(false);
    expect(f.service.modelError(f.c.snapshot().id, f.s.id, f.agent, f.error)).toBe(true);
    await vi.waitFor(() => expect(f.fault).toHaveBeenCalledTimes(1));
    const c = f.c.modelPolicies(),
      change = c.history(f.s.id)[0]!;
    expect(change.status).toBe('unknown');
    expect(c.state(f.s.id).current.model).toBe('primary');
    expect(f.wakes).not.toHaveBeenCalled();
    expect(f.service.admission(f.c.snapshot().id, f.s.id)).toBe(false);
    f.setFlush(true);
    await f.service.retry(f.c.snapshot().id, f.s.id, change.id);
    expect(f.select).toHaveBeenCalledTimes(1);
    expect(c.get(change.id).status).toBe('confirmed');
    expect(f.wakes).not.toHaveBeenCalled();
  } finally {
    await f.finish();
  }
});
test('选择备用等待原生空闲期间控制改变，保留停止且不热切；明确用户切换独立核安全边界', async () => {
  const f = fixture();
  try {
    let release!: () => void;
    f.agent.whenIdle = () =>
      new Promise<void>((r) => {
        release = r;
      });
    expect(f.service.modelError(f.c.snapshot().id, f.s.id, f.agent, f.error)).toBe(true);
    f.setAllowed(false);
    release();
    await vi.waitFor(() => expect(f.c.modelPolicies().history(f.s.id)[0]!.status).toBe('unknown'));
    expect(f.select).not.toHaveBeenCalled();
    expect(f.wakes).not.toHaveBeenCalled();
    const state = f.c.modelPolicies().state(f.session.id),
      input = {
        operationId: randomUUID(),
        expectedRevision: state.revision,
        configuration: { provider: 'p', model: 'explicit' },
        reason: '明确安全切换',
      };
    f.setCanSwitch(false);
    await expect(f.service.explicit(f.c.snapshot().id, f.s.id, input)).rejects.toThrow('安全边界');
  } finally {
    await f.finish();
  }
});
