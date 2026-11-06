import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initializeProject, connectProject } from '../src/services/project.ts';
import type { RequestRecord } from '../src/contracts/session-runtime.ts';
function fixture(opened = true) {
  const root = mkdtempSync(join(tmpdir(), 'mat-dispatch-'));
  initializeProject({
    root,
    name: '派工SQLite单测',
    supervisor: { provider: 'unit', model: 'unit' },
  });
  const connection = connectProject(root),
    wb = connection.workbench(),
    user = { kind: 'user' as const };
  const phase = wb.createPhase(user, {
    operationId: randomUUID(),
    name: '第一期',
    goal: '单票执行',
    basis: '单测不冒充Host证明',
    checklist: [],
  });
  if (opened) wb.openPhase(user, phase.id, { operationId: randomUUID(), reason: '夹具明确开放' });
  const category = wb.createCategory(user, {
    operationId: randomUUID(),
    code: 'TEST',
    name: '验证',
  });
  const ticketInput = {
    phaseId: phase.id,
    categoryId: category.id,
    title: '执行切片',
    goal: '核对真实启动',
    included: '明确本次范围',
    excluded: '不做后续',
    dependencies: [],
    conditions: [{ condition: '取得实际依据', verification: 'automated' }],
  };
  const ticket = wb.createTicket(user, { ...ticketInput, operationId: randomUUID() });
  const role = connection.registerRole({
      code: 'DEV',
      name: '开发',
      type: 'developer',
      configuration: { provider: 'unit', model: 'unit' },
    }),
    manager = connection.reserveSession({
      roleId: connection.roles()[0]!.id,
      name: '主管来源夹具',
      purpose: '只核对持久业务，不代表实际宿主',
      cwd: root,
    });
  connection.bindSession(manager.id, 'unit-manager');
  const actor = { kind: 'session' as const, sessionId: manager.id };
  const catalog = connection.executions();
  const input = {
    operationId: randomUUID(),
    ticket: ticket.code,
    roleId: role.id,
    name: '本票主执行',
    cwd: root,
    writeScopes: [root],
    requirements: '不扩大授权',
  };
  return {
    root,
    connection,
    wb,
    catalog,
    actor,
    role,
    ticket,
    ticketInput,
    input,
    close() {
      connection.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
function prepare(f: ReturnType<typeof fixture>) {
  const { record } = f.catalog.register(f.actor, f.input, 'unit-owner');
  const session = f.connection.reserveSession({
    roleId: f.role.id,
    name: '准备夹具',
    purpose: '非真实Host执行',
    cwd: f.root,
  });
  f.catalog.sessionReserved(record.id, session.id);
  f.connection.bindSession(session.id, 'unit-executor-' + session.id);
  f.catalog.sessionPrepared(record.id, session.id);
  f.catalog.starting(record.id, 0, { provider: 'unit', model: 'unit' }, '本次完整Goal');
  f.catalog.goalLinked(record.id, {
    id: 'goal-unit-' + randomUUID(),
    revision: 1,
    objective: '本次完整Goal',
    phase: 'active',
    activation: 'armed',
    roundsStarted: 0,
    maxGoalRounds: 2,
  });
  f.catalog.goalDurable(record.id);
  return { record, session };
}
function request(
  f: ReturnType<typeof fixture>,
  sessionId: string,
  step: number,
  status: RequestRecord['status'] = 'completed',
) {
  const value: RequestRecord = {
    id: randomUUID(),
    sessionId,
    nativeAttemptId: 'unit:' + step,
    turn: 1,
    step,
    contextVersion: 'unit',
    sources: [],
    skillManifestVersion: 'unit',
    skillCatalogVersion: 'unit',
    loadedSkills: [],
    requestConfiguration: { provider: 'unit', model: 'unit' },
    reportedModel: status === 'completed' ? 'unit' : null,
    usage: null,
    status,
    error: status === 'failed' ? '单测失败' : null,
    startedAt: new Date().toISOString(),
  };
  f.connection.saveRequest(value);
  f.catalog.requestObserved(sessionId, value.id);
  return value;
}
test('派工来源必须是真实主管，期次未开放或无依赖依据时不建立执行', () => {
  const closed = fixture(false);
  try {
    expect(() => closed.catalog.register(closed.actor, closed.input, 'unit-owner')).toThrow(
      '未开放',
    );
    expect(closed.catalog.list()).toEqual([]);
  } finally {
    closed.close();
  }
  const f = fixture();
  try {
    const fake = f.connection.reserveSession({
      roleId: f.role.id,
      name: '非主管',
      purpose: '错误身份',
      cwd: f.root,
    });
    f.connection.bindSession(fake.id, 'unit-not-manager');
    expect(() =>
      f.catalog.register({ kind: 'session', sessionId: fake.id }, f.input, 'unit-owner'),
    ).toThrow('主管');
    const dependent = f.wb.createTicket(
      { kind: 'user' },
      {
        ...f.ticketInput,
        operationId: randomUUID(),
        title: '缺依赖依据',
        dependencies: [f.ticket.id],
      },
    );
    expect(() =>
      f.catalog.register(
        f.actor,
        { ...f.input, operationId: randomUUID(), ticket: dependent.code },
        'unit-owner',
      ),
    ).toThrow('依赖');
    expect(f.catalog.list()).toHaveLength(0);
  } finally {
    f.close();
  }
});
test('稳定安排先登记不冒充启动，同请求回读原ID，换正文和重复主执行拒绝', () => {
  const f = fixture();
  try {
    const first = f.catalog.register(f.actor, f.input, 'unit-owner'),
      retry = f.catalog.register(f.actor, f.input, 'unit-owner');
    expect(first.isNew).toBe(true);
    expect(retry.isNew).toBe(false);
    expect(retry.record.id).toBe(first.record.id);
    expect(retry.record.dispatchId).toBe(first.record.dispatchId);
    expect(first.record.startupState).toBe('registered');
    expect(f.wb.getTicket(f.ticket.id).state).toBe('todo');
    expect(() => f.catalog.register(f.actor, { ...f.input, name: '换正文' }, 'unit-owner')).toThrow(
      '操作身份',
    );
    expect(() =>
      f.catalog.register(f.actor, { ...f.input, operationId: randomUUID() }, 'unit-owner'),
    ).toThrow('主执行');
    expect(f.catalog.list()).toHaveLength(1);
  } finally {
    f.close();
  }
});
test('三个实际Agent步骤才确认持续启动，重试请求或工具数量不能凑步骤', () => {
  const f = fixture();
  try {
    const { record, session } = prepare(f);
    expect(f.wb.getTicket(f.ticket.id).state).toBe('todo');
    f.catalog.stepStarted(session.id, { type: 'step/start', seq: 10, data: { turn: 1, step: 1 } });
    request(f, session.id, 1, 'failed');
    request(f, session.id, 1);
    request(f, session.id, 1);
    expect(f.wb.getTicket(f.ticket.id).state).toBe('in-progress');
    f.catalog.stepEnded(session.id, { type: 'step/end', seq: 20, data: { turn: 1, step: 1 } });
    f.catalog.settleStep(record.id, 1, 1);
    expect(f.catalog.get(record.id).completedSteps).toBe(1);
    expect(f.catalog.get(record.id).startupState).toBe('starting');
    for (const step of [2, 3]) {
      f.catalog.stepStarted(session.id, {
        type: 'step/start',
        seq: step * 100,
        data: { turn: 1, step },
      });
      request(f, session.id, step);
      f.catalog.stepEnded(session.id, {
        type: 'step/end',
        seq: step * 100 + 20,
        data: { turn: 1, step },
      });
      f.catalog.settleStep(record.id, 1, step);
    }
    expect(f.catalog.get(record.id).startupState).toBe('confirmed');
    expect(f.catalog.get(record.id).completedSteps).toBe(3);
    expect(f.wb.getTicket(f.ticket.id).state).not.toBe('completed');
  } finally {
    f.close();
  }
});
test('首次真实请求后失败保留已发生事实，未知不释放冲突写域也不新开替代', () => {
  const f = fixture();
  try {
    const { record, session } = prepare(f);
    f.catalog.stepStarted(session.id, { type: 'step/start', seq: 1, data: { turn: 1, step: 1 } });
    const actual = request(f, session.id, 1, 'failed');
    f.catalog.fail(record.id, {
      code: 'UNIT_UNKNOWN_ACK',
      message: '单测注入：接纳结果未知',
      unknown: true,
    });
    const current = f.catalog.get(record.id);
    expect(current.firstRequestId).toBe(actual.id);
    expect(current.startupState).toBe('unknown');
    expect(current.writeOccupancy).toBe('unknown');
    expect(f.catalog.register(f.actor, f.input, 'unit-owner').record.id).toBe(record.id);
    const another = f.wb.createTicket(
      { kind: 'user' },
      { ...f.ticketInput, operationId: randomUUID(), title: '冲突范围' },
    );
    expect(() =>
      f.catalog.register(
        f.actor,
        { ...f.input, operationId: randomUUID(), ticket: another.id },
        'unit-owner',
      ),
    ).toThrow('写入范围');
    expect(f.catalog.list()).toHaveLength(1);
  } finally {
    f.close();
  }
});
test('第三步真实异常不算启动三步通过，工具失败而Agent继续不自动error', () => {
  const f = fixture();
  try {
    const { record, session } = prepare(f);
    for (const step of [1, 2, 3]) {
      f.catalog.stepStarted(session.id, {
        type: 'step/start',
        seq: step * 10,
        data: { turn: 1, step },
      });
      request(f, session.id, step);
      f.catalog.stepEnded(session.id, {
        type: 'step/end',
        seq: step * 10 + 2,
        data: { turn: 1, step },
      });
      if (step < 3) f.catalog.settleStep(record.id, 1, step);
    }
    f.catalog.turnEnded(session.id, {
      type: 'turn/end',
      seq: 99,
      data: { turn: 1, reason: { kind: 'error', error: { code: 'UNIT_TERMINAL' } } },
    });
    f.catalog.settleStep(record.id, 1, 3);
    const current = f.catalog.get(record.id);
    expect(current.completedSteps).toBe(2);
    expect(current.startupState).toBe('error');
    expect(current.failure?.phase).toBe('startup');
    expect(current.writeOccupancy).not.toBe('released');
  } finally {
    f.close();
  }
});
test('明确不冲突的写域可安排不同票，同一会话仍不能并行承接两票', () => {
  const f = fixture();
  try {
    const a = join(f.root, '源码A'),
      b = join(f.root, '源码B');
    mkdirSync(a);
    mkdirSync(b);
    const first = f.catalog.register(
      f.actor,
      { ...f.input, writeScopes: [a] },
      'unit-owner',
    ).record;
    const another = f.wb.createTicket(
      { kind: 'user' },
      { ...f.ticketInput, operationId: randomUUID(), title: '独立切片' },
    );
    const second = f.catalog.register(
      f.actor,
      { ...f.input, operationId: randomUUID(), ticket: another.id, writeScopes: [b] },
      'unit-owner',
    ).record;
    const session = f.connection.reserveSession({
      roleId: f.role.id,
      name: '只承接一票',
      purpose: '单测',
      cwd: f.root,
    });
    f.catalog.sessionReserved(first.id, session.id);
    expect(() => f.catalog.sessionReserved(second.id, session.id)).toThrow('会话');
  } finally {
    f.close();
  }
});
