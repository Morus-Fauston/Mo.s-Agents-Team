import { expect, test } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { initializeProject, connectProject } from '../src/services/project.ts';
import { ExecutionControlService } from '../src/services/execution-controls.ts';
import type { ProjectService } from '../src/services/project-service.ts';
import type { DispatchService } from '../src/services/dispatch-service.ts';
import type { CommunicationService } from '../src/services/chat-service.ts';
import type { NativeAgent, NativeContext } from '../src/host/native.ts';
import type { NativeGoalView } from '../src/contracts/execution.ts';
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mat-control-'));
  initializeProject({
    root,
    name: '控制事务单测',
    supervisor: { provider: 'unit', model: 'unit' },
  });
  const connection = connectProject(root),
    wb = connection.workbench(),
    controls = connection.controls(),
    user = { kind: 'user' as const },
    epoch = 'unit-control-owner';
  const manager = connection.reserveSession({
    roleId: connection.roles()[0]!.id,
    name: '主管夹具',
    purpose: '仅验证事务，不冒充Host',
    cwd: root,
  });
  connection.bindSession(manager.id, 'unit-manager');
  controls.startProject(user, { operationId: randomUUID(), reason: '单测明确启动' }, epoch);
  controls.projectReady(epoch, manager.id);
  const phase = wb.createPhase(user, {
    operationId: randomUUID(),
    name: '一期',
    goal: '验证停止',
    basis: '单测',
    checklist: [],
  });
  wb.openPhase(user, phase.id, { operationId: randomUUID(), reason: '单测' });
  const category = wb.createCategory(user, {
      operationId: randomUUID(),
      code: 'CTL',
      name: '控制',
    }),
    ticket = wb.createTicket(user, {
      operationId: randomUUID(),
      phaseId: phase.id,
      categoryId: category.id,
      title: '控制中的票',
      goal: '不假填停止',
      included: '临时单测',
      excluded: '非真实Host',
      dependencies: [],
      conditions: [{ condition: '有证据', verification: 'automated' }],
    }),
    role = connection.registerRole({
      code: 'DEV',
      name: '开发',
      type: 'developer',
      configuration: { provider: 'unit', model: 'unit' },
    }),
    execution = connection.executions().register(
      { kind: 'session', sessionId: manager.id },
      {
        operationId: randomUUID(),
        ticket: ticket.id,
        roleId: role.id,
        name: '控制夹具',
        cwd: root,
      },
      epoch,
    ).record,
    session = connection.reserveSession({
      roleId: role.id,
      name: '本票执行',
      purpose: '单测',
      cwd: root,
    });
  connection.executions().sessionReserved(execution.id, session.id);
  connection.bindSession(session.id, 'unit-executor');
  connection.executions().sessionPrepared(execution.id, session.id);
  connection
    .executions()
    .starting(execution.id, 10, { provider: 'unit', model: 'unit' }, '控制夹具目标');
  connection.executions().goalLinked(execution.id, {
    id: 'unit-goal',
    revision: 1,
    objective: '控制夹具目标',
    phase: 'active',
    activation: 'armed',
    roundsStarted: 1,
    maxGoalRounds: 2,
  });
  return {
    root,
    connection,
    controls,
    user,
    epoch,
    session,
    manager,
    ticket,
    execution,
    close() {
      connection.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test('只读核对不暂停活跃或审阅等待；已有停止只补原控制证据，不绕过回报', () => {
  const f = fixture();
  const quiet = {
    agentIdle: true,
    inFlightTools: false,
    filesStable: true,
    fileFingerprint: 'unit',
    processesComplete: true,
    jobObservations: [],
    note: '原生边界合成证明',
  };
  try {
    const c = f.controls,
      request = (action: 'reconcile' | 'hard-stop') =>
        c.request(
          f.user,
          {
            operationId: randomUUID(),
            executionId: f.execution.id,
            action,
            expectedRevision: c.revision(f.execution.id),
            reason: '核对',
          },
          f.epoch,
        );
    for (const waiting of [false, true]) {
      if (waiting) f.connection.executions().waitForReview(f.execution.id, randomUUID());
      const before = f.connection.executions().get(f.execution.id),
        session = f.connection.session(f.session.id);
      const read = request('reconcile');
      c.receipt(read.id, 'goal', { state: 'confirmed', note: '只读观察' });
      c.receipt(read.id, 'cancel', { state: 'unnecessary', note: '未取消' });
      c.observeStopped(read.id, quiet);
      expect(f.connection.executions().get(f.execution.id)).toEqual(before);
      expect(f.connection.session(f.session.id)).toEqual(session);
    }
    const stale = request('reconcile');
    c.receipt(stale.id, 'goal', { state: 'confirmed', note: '停止前的旧采样' });
    c.receipt(stale.id, 'cancel', { state: 'unnecessary', note: '未取消' });
    const stop = request('hard-stop');
    c.receipt(stop.id, 'goal', { state: 'confirmed', note: '原Goal已暂停' });
    c.receipt(stop.id, 'cancel', { state: 'confirmed', note: '原cancel已调用' });
    c.observeStopped(stop.id, { ...quiet, filesStable: null });
    expect(c.get(stop.id).status).toBe('unknown');
    const beforeLate = f.connection.executions().get(f.execution.id);
    c.observeStopped(stale.id, quiet);
    expect(c.get(stop.id).status).toBe('unknown');
    expect(f.connection.executions().get(f.execution.id)).toEqual(beforeLate);
    const read = request('reconcile');
    c.receipt(read.id, 'goal', { state: 'confirmed', note: '观察' });
    c.receipt(read.id, 'cancel', { state: 'unnecessary', note: '未再取消' });
    c.observeStopped(read.id, quiet);
    expect(c.get(stop.id).status).toBe('stopped');
    expect(f.connection.executions().get(f.execution.id).writeOccupancy).toBe('released');
  } finally {
    f.close();
  }
});

test('停稳交接保留原件；新票占用接走的路径，原执行收窄后只有原主管核对确切差异才能恢复原Goal', async () => {
  const f = fixture(),
    c = f.connection,
    project = c.snapshot().id;
  const manager = { kind: 'session' as const, sessionId: f.manager.id };
  const kept = join(f.root, 'kept'),
    handed = join(f.root, 'handed'),
    file = join(kept, 'source.txt');
  mkdirSync(kept);
  mkdirSync(handed);
  writeFileSync(file, 'old original bytes');
  writeFileSync(join(handed, 'source.txt'), 'handoff origin');
  const goal: NativeGoalView = {
    id: 'unit-goal',
    revision: 2,
    objective: '原目标',
    phase: 'paused',
    activation: 'disarmed',
    roundsStarted: 1,
    maxGoalRounds: 2,
  };
  let resumed = 0,
    prepared = 0;
  const agent = {
    id: 'unit-executor',
    status: 'idle',
    session: { snapshotEvents: () => [], deriveMessages: () => [] },
    steer: () => {},
  } as unknown as NativeAgent;
  const native = {
    workingDirectory: { get: () => f.root },
    jobs: { list: () => [] },
    sessions: { flush: async () => true },
    goals: {
      get: () => goal,
      edit: (_agent: NativeAgent, _expected: unknown, value: { objective: string }) =>
        Object.assign(goal, value),
      resume: () => {
        resumed++;
      },
      disarm: () => {},
    },
  } as unknown as NativeContext;
  const service = new ExecutionControlService(
    { forProject: () => c, list: () => [{ id: project }] } as unknown as ProjectService,
    {
      epoch: f.epoch,
      context: () => ({ message: { content: [{ text: '复核后的目标' }] } }),
    } as unknown as DispatchService,
    {
      prepareResume: async () => {
        prepared++;
      },
    } as unknown as CommunicationService,
    {
      native,
      peek: () => agent,
      openControlled: async () => agent,
      freshContext: async () => ({ cwd: f.root }),
    },
  );
  try {
    const wb = c.workbench();
    const newTicket = wb.createTicket(f.user, {
      operationId: randomUUID(),
      title: '接走独立范围',
      phaseId: f.ticket.phaseId,
      categoryId: f.ticket.categoryId,
      goal: '正式接走一段',
      included: '独立路径',
      excluded: '其他路径',
      conditions: [{ condition: '范围独立', verification: 'automated' }],
    });
    const dispatch = {
      operationId: randomUUID(),
      ticket: newTicket.id,
      roleId: f.execution.roleId,
      name: '接走范围',
      cwd: f.root,
      writeScopes: [handed],
    };
    expect(() => c.executions().register(manager, dispatch, f.epoch)).toThrow(/冲突/);
    const stop = f.controls.request(
      f.user,
      {
        operationId: randomUUID(),
        executionId: f.execution.id,
        action: 'hard-stop',
        reason: '单测交接',
        expectedRevision: 0,
      },
      f.epoch,
    );
    const change = {
      executionId: f.execution.id,
      operationId: randomUUID(),
      expectedControlRevision: 1,
      expectedScopeRevision: 0,
      writeScopes: [kept],
      reason: '原主管明确留下独立范围',
    };
    expect(() => service.adjustScope(project, manager, change)).toThrow(/停稳/);
    f.controls.receipt(stop.id, 'goal', { state: 'confirmed', note: '合成原Goal已停' });
    f.controls.receipt(stop.id, 'cancel', { state: 'confirmed', note: '合成取消已确认' });
    // Invoke the real file/norm sampling code with a synthetic native handle.
    const sampled = await service.inspectExecution(
      project,
      f.execution.id,
      agent,
      undefined,
      false,
      true,
    );
    expect(sampled.checkpoint).toBeDefined();
    f.controls.observeStopped(stop.id, sampled);
    expect(f.controls.get(stop.id).status).toBe('stopped');
    expect(service.recoveryPreview(project, f.execution.id).hasChanges).toBe(false);
    const owner = c.executions().register(manager, dispatch, f.epoch).record;
    expect(owner.writeOccupancy).toBe('held');
    const rejected = service.request(project, f.user, {
      operationId: randomUUID(),
      executionId: f.execution.id,
      expectedRevision: 1,
      action: 'resume',
      reason: '原范围仍会撞上新票',
    });
    await expect.poll(() => f.controls.get(rejected.id).status).toBe('failed');
    expect(c.executions().get(f.execution.id).writeOccupancy).toBe('released');
    const adjustment = service.adjustScope(project, manager, {
      ...change,
      expectedControlRevision: 2,
    });
    expect(adjustment.before).toEqual([f.root]);
    expect(adjustment.after).toEqual([kept]);
    expect(adjustment.stoppedControlId).toBe(stop.id);
    const before = sampled.checkpoint?.files.find((item) => item.path === file)?.sha256;
    expect(readFileSync(join(c.versions().storage, 'sha256', before!), 'utf8')).toBe(
      'old original bytes',
    );
    writeFileSync(file, 'after handoff');
    writeFileSync(join(handed, 'source.txt'), 'new owner changes this');
    const current = service.recoveryPreview(project, f.execution.id);
    expect(current.scopeChanged).toBe(true);
    expect(current.files.map((item) => item.path)).toEqual([file]);
    const denied = service.request(project, f.user, {
      operationId: randomUUID(),
      executionId: f.execution.id,
      expectedRevision: 2,
      action: 'resume',
      reason: '非原主管不能代替核定变化',
      reviewedRecoveryFingerprint: current.fingerprint,
    });
    await expect.poll(() => f.controls.get(denied.id).status).toBe('failed');
    expect(prepared).toBe(0);
    expect(resumed).toBe(0);
    const approved = service.recoveryPreview(project, f.execution.id);
    const accepted = service.request(project, manager, {
      operationId: randomUUID(),
      executionId: f.execution.id,
      expectedRevision: 3,
      action: 'resume',
      reason: '原主管明确认可差异且仅恢复收窄范围',
      reviewedRecoveryFingerprint: approved.fingerprint,
    });
    await expect.poll(() => f.controls.get(accepted.id).goal?.state).toBe('confirmed');
    expect(resumed).toBe(1);
    expect(c.executions().get(f.execution.id)).toMatchObject({
      goalId: 'unit-goal',
      writeScopes: [kept],
      writeOccupancy: 'held',
    });
    expect(c.executions().get(owner.id).writeOccupancy).toBe('held');
    expect(readFileSync(join(c.versions().storage, 'sha256', before!), 'utf8')).toBe(
      'old original bytes',
    );
  } finally {
    await service.close();
    f.close();
  }
}, 20000);

test('扩围只消费本次主执行的精确结构化决定，文字答复与同一批准的变体不能扩权', () => {
  const f = fixture(),
    c = f.connection,
    e = f.execution,
    manager = { kind: 'session' as const, sessionId: f.manager.id },
    worker = { kind: 'session' as const, sessionId: f.session.id },
    kept = join(f.root, 'kept'),
    extra = join(f.root, 'extra');
  try {
    const requestStop = (revision: number) => {
      const stop = f.controls.request(
        f.user,
        {
          executionId: e.id,
          operationId: randomUUID(),
          expectedRevision: revision,
          action: 'hard-stop',
          reason: '合成控制',
        },
        f.epoch,
      );
      f.controls.receipt(stop.id, 'goal', { state: 'confirmed', note: '合成停Goal' });
      f.controls.receipt(stop.id, 'cancel', { state: 'confirmed', note: '合成取消' });
      f.controls.observeStopped(stop.id, {
        agentIdle: true,
        inFlightTools: false,
        filesStable: true,
        fileFingerprint: 'unit',
        processesComplete: true,
        jobObservations: [],
        note: '仅事务夹具',
      });
      return stop;
    };
    requestStop(0);
    const scope = {
      executionId: e.id,
      reason: '写域协调',
      expectedControlRevision: 1,
      expectedScopeRevision: 0,
      operationId: randomUUID(),
      writeScopes: [kept],
    };
    f.controls.adjustScope(manager, scope, () => {});
    const resume = f.controls.request(
      f.user,
      {
        executionId: e.id,
        operationId: randomUUID(),
        expectedRevision: 1,
        action: 'resume',
        reason: '事务夹具恢复',
      },
      f.epoch,
    );
    f.controls.resumeAdmitted(resume.id, {}, f.epoch, () => {});
    const proposal = c.decisionRequests().create(worker, {
      operationId: randomUUID(),
      subject: '有界扩围',
      question: '扩到额外目录',
      impact: '扩大写域',
      reason: 'scope-change',
      requestedWriteScopes: [kept, extra],
    });
    const reply = {
      operationId: randomUUID(),
      expectedRevision: proposal.revision,
      choice: 'accept',
      answer: '同意明确目录',
      restrictions: '',
    };
    expect(() =>
      c
        .decisionRequests()
        .reply(manager, proposal.id, { ...reply, restrictions: '只写另一个目录' }),
    ).toThrow(/准确的新范围/);
    c.decisionRequests().reply(manager, proposal.id, reply);
    const stop = requestStop(2);
    const change = {
      ...scope,
      operationId: randomUUID(),
      expectedScopeRevision: 1,
      expectedControlRevision: 3,
      writeScopes: [kept, extra],
    };
    expect(() => f.controls.adjustScope(manager, change, () => {})).toThrow(/正式决定/);
    expect(() =>
      f.controls.adjustScope(
        manager,
        { ...change, writeScopes: [f.root], decisionRequestId: proposal.id },
        () => {},
      ),
    ).toThrow(/完全一致/);
    const accepted = f.controls.adjustScope(
      manager,
      { ...change, decisionRequestId: proposal.id },
      () => {},
    );
    expect(accepted).toMatchObject({
      stoppedControlId: stop.id,
      revision: 2,
      decisionRequestId: proposal.id,
    });
    expect(
      f.controls.adjustScope(manager, { ...change, decisionRequestId: proposal.id }, () => {
        throw new Error('重放不再调整');
      }),
    ).toEqual(accepted);
    expect(c.executions().get(e.id).writeOccupancy).toBe('released');
  } finally {
    f.close();
  }
});

test.each(
  (['soft-stop', 'hard-stop', 'terminate', 'reconcile'] as const).flatMap((action) =>
    [false, true].map((missing) => ({ action, missing })),
  ),
)('同一Agent的原Goal缺失=$missing 时 $action 不产生原生控制副作用', async ({ action, missing }) => {
  const f = fixture(),
    calls: string[] = [],
    agent = {
      id: 'unit-executor',
      status: 'idle',
      cancel: () => {
        calls.push('cancel');
      },
    } as unknown as NativeAgent;
  const service = new ExecutionControlService(
    { forProject: () => f.connection, list: () => [] } as unknown as ProjectService,
    { epoch: f.epoch } as DispatchService,
    {
      sendControl: async () => {
        calls.push('message');
      },
    } as unknown as CommunicationService,
    {
      native: {
        goals: {
          get: () =>
            missing ? undefined : { id: 'foreign-goal', phase: 'active', activation: 'armed' },
          disarm: () => {
            calls.push('disarm');
          },
          pause: () => {
            calls.push('pause');
          },
          clear: () => {
            calls.push('clear');
          },
        },
        jobs: {
          kill: () => {
            calls.push('kill');
          },
        },
      } as unknown as NativeContext,
      peek: () => agent,
      openControlled: async () => agent,
      freshContext: async () => ({}),
    },
  );
  try {
    const record = service.request('unit-project', f.user, {
      operationId: randomUUID(),
      executionId: f.execution.id,
      action,
      reason: '原Goal不匹配',
      expectedRevision: 0,
    });
    await expect.poll(() => f.controls.get(record.id).status).toBe('unknown');
    expect(calls).toEqual([]);
    expect(f.controls.get(record.id).goal?.state).toBe('unknown');
    expect(f.connection.executions().get(f.execution.id).writeOccupancy).toBe('unknown');
    expect(f.connection.executions().get(f.execution.id).lifecycleState).not.toBe('terminated');
    if (action === 'soft-stop')
      await expect(
        service.handoff('unit-project', f.session.id, record.id, '不应保存或投递的挂起报告'),
      ).rejects.toThrow('Goal');
    expect(() => service.assertModelGoal('unit-project', f.session.id, agent)).toThrow('Goal');
    expect(calls).toEqual([]);
  } finally {
    await service.close();
    f.close();
  }
});
test.each(
  (['hard', 'soft'] as const).flatMap((stopMode) =>
    (['observe', 'flush', 'none'] as const).map((fault) => ({ stopMode, fault })),
  ),
)(
  '终止 $stopMode 在 $fault 阶段的Goal变化不能被收尾覆盖',
  async ({ stopMode, fault }) => {
    const f = fixture(),
      calls: string[] = [];
    let goal: NativeGoalView | undefined = {
      id: 'unit-goal',
      revision: 1,
      objective: '控制夹具目标',
      phase: 'active',
      activation: 'armed',
      roundsStarted: 1,
      maxGoalRounds: 2,
    };
    const agent = {
      id: 'unit-executor',
      status: 'idle',
      cancel: () => calls.push('cancel'),
      session: { snapshotEvents: () => [] },
    } as unknown as NativeAgent;
    const service = new ExecutionControlService(
      { forProject: () => f.connection, list: () => [] } as unknown as ProjectService,
      { epoch: f.epoch } as DispatchService,
      {
        sendControl: async () => {},
        sendControlledResult: async () => {},
      } as unknown as CommunicationService,
      {
        native: {
          goals: {
            get: () => goal,
            disarm: () => {
              goal!.activation = 'disarmed';
              return goal;
            },
            pause: () => {
              goal!.phase = 'paused';
              if (fault === 'observe')
                setTimeout(() => {
                  goal = undefined;
                }, 10);
              return goal;
            },
            clear: () => {
              calls.push('clear');
              goal = undefined;
            },
          },
          jobs: { list: () => [] },
          sessions: {
            flush: async () => {
              calls.push('flush');
              if (fault === 'flush')
                goal = {
                  id: 'foreign-goal',
                  revision: 1,
                  objective: '其他工作',
                  phase: 'active',
                  activation: 'armed',
                  roundsStarted: 1,
                  maxGoalRounds: 1,
                };
              await Promise.resolve();
              return true;
            },
          },
        } as unknown as NativeContext,
        peek: () => agent,
        openControlled: async () => agent,
        freshContext: async () => ({}),
      },
    );
    try {
      const record = service.request('unit-project', f.user, {
        operationId: randomUUID(),
        executionId: f.execution.id,
        action: 'terminate',
        stopMode,
        reason: '异步原身份核对',
        expectedRevision: 0,
      });
      if (stopMode === 'soft') {
        await expect.poll(() => f.controls.get(record.id).status).toBe('delivered');
        await service.handoff('unit-project', f.session.id, record.id, '本次挂起已保存');
      }
      await expect
        .poll(() => f.controls.get(record.id).status, { timeout: 10000 })
        .toBe(fault === 'none' ? 'terminated' : 'unknown');
      expect(f.controls.get(record.id).goal?.state).toBe(
        fault === 'none' ? 'confirmed' : 'unknown',
      );
      expect(calls.filter((call) => call === 'clear')).toHaveLength(fault === 'observe' ? 0 : 1);
      expect(calls.filter((call) => call === 'flush')).toHaveLength(fault === 'observe' ? 0 : 1);
      if (fault === 'flush') expect(goal?.id).toBe('foreign-goal');
      if (fault !== 'none')
        expect(f.connection.executions().get(f.execution.id).writeOccupancy).not.toBe('released');
    } finally {
      await service.close();
      f.close();
    }
  },
  15000,
);

test('控制先保存、同操作回读，正文冲突与旧修订拒绝；软停不冒充已暂停', () => {
  const f = fixture();
  try {
    const input = {
        operationId: randomUUID(),
        executionId: f.execution.id,
        action: 'soft-stop',
        reason: '请到安全点收尾',
        expectedRevision: 0,
      },
      first = f.controls.request(f.user, input, f.epoch);
    expect(first.status).toBe('requested');
    expect(first.cancel).toBeNull();
    expect(f.controls.request(f.user, input, f.epoch).id).toBe(first.id);
    expect(() => f.controls.request(f.user, { ...input, reason: '换正文' }, f.epoch)).toThrow(
      '操作身份',
    );
    expect(() =>
      f.controls.request(f.user, { ...input, operationId: randomUUID() }, f.epoch),
    ).toThrow('修订');
    expect(f.connection.executions().get(f.execution.id).lifecycleState).toBe('active');
    expect(f.connection.executions().get(f.execution.id).writeOccupancy).toBe('pending-release');
  } finally {
    f.close();
  }
});
test('普通会话只能停止自己，不能控制他人或解除上级暂停', () => {
  const f = fixture();
  try {
    const other = f.connection.reserveSession({
      roleId: f.session.roleId,
      name: '无关会话',
      purpose: '单测',
      cwd: f.root,
    });
    f.connection.bindSession(other.id, 'unit-other');
    const input = {
      operationId: randomUUID(),
      executionId: f.execution.id,
      action: 'hard-stop',
      reason: '明确暂停',
      expectedRevision: 0,
    };
    expect(() =>
      f.controls.request({ kind: 'session', sessionId: other.id }, input, f.epoch),
    ).toThrow('无权');
    f.controls.request(f.user, input, f.epoch);
    expect(() =>
      f.controls.request(
        { kind: 'session', sessionId: f.session.id },
        { ...input, operationId: randomUUID(), action: 'resume', expectedRevision: 1 },
        f.epoch,
      ),
    ).toThrow('恢复');
    expect(f.connection.session(f.session.id).communicationState).toBe('paused');
  } finally {
    f.close();
  }
});
test('作业按真实owner与执行保存；未知job和没有外部证据时保留占用', () => {
  const f = fixture();
  try {
    const event = {
      type: 'job/registered',
      seq: 20,
      data: {
        jobId: 'unit-job',
        owner: 'unit-executor',
        kind: 'unit',
        label: '单测作业',
        startedAt: Date.now(),
      },
    };
    f.controls.recordJob(f.session.id, event);
    f.controls.recordJob(f.session.id, event);
    expect(f.controls.jobs(f.execution.id)).toHaveLength(1);
    expect(() =>
      f.controls.recordJob(f.session.id, {
        ...event,
        seq: 21,
        data: { ...event.data, jobId: 'foreign', owner: 'unit-other' },
      }),
    ).toThrow('owner');
    const control = f.controls.request(
      f.user,
      {
        operationId: randomUUID(),
        executionId: f.execution.id,
        action: 'hard-stop',
        reason: '单测停止',
        expectedRevision: 0,
      },
      f.epoch,
    );
    f.controls.observeStopped(control.id, {
      agentIdle: true,
      inFlightTools: false,
      filesStable: true,
      fileFingerprint: 'unit',
      processesComplete: false,
      jobObservations: [{ jobId: 'unit-job', nativeStatus: 'unknown', externalStatus: 'unknown' }],
      note: '合成单测，不代表真实外部观察',
    });
    expect(f.controls.get(control.id).status).toBe('unknown');
    expect(f.connection.executions().get(f.execution.id).writeOccupancy).toBe('unknown');
  } finally {
    f.close();
  }
});
test('作业结束也要独立停稳观察；通过后才能释放声明范围', () => {
  const f = fixture();
  try {
    f.controls.recordJob(f.session.id, {
      type: 'job/registered',
      seq: 20,
      data: {
        jobId: 'unit-job',
        owner: 'unit-executor',
        kind: 'unit',
        label: '单测',
        startedAt: Date.now(),
      },
    });
    f.controls.recordJob(f.session.id, {
      type: 'job/settled',
      seq: 21,
      data: {
        jobId: 'unit-job',
        owner: 'unit-executor',
        kind: 'unit',
        label: '单测',
        startedAt: Date.now(),
        finishedAt: Date.now(),
        status: 'killed',
        cause: 'kill',
        producerReported: true,
      },
    });
    const control = f.controls.request(
      f.user,
      {
        operationId: randomUUID(),
        executionId: f.execution.id,
        action: 'hard-stop',
        reason: '核对',
        expectedRevision: 0,
      },
      f.epoch,
    );
    expect(f.connection.executions().get(f.execution.id).writeOccupancy).not.toBe('released');
    f.controls.receipt(control.id, 'goal', { state: 'confirmed', note: '单测Goal已disarmed' });
    f.controls.receipt(control.id, 'cancel', {
      state: 'confirmed',
      note: '单测cancel回执，idle另验',
    });
    for (const nativeStatus of ['unknown', 'invented-terminal']) {
      f.controls.observeStopped(control.id, {
        agentIdle: true,
        inFlightTools: false,
        filesStable: true,
        fileFingerprint: 'unit',
        processesComplete: true,
        jobObservations: [{ jobId: 'unit-job', nativeStatus, externalStatus: 'gone' }],
        note: '原生终态未明确，不释放',
      });
      expect(f.controls.get(control.id).status).not.toBe('stopped');
      expect(f.connection.executions().get(f.execution.id).writeOccupancy).not.toBe('released');
    }
    f.controls.observeStopped(control.id, {
      agentIdle: true,
      inFlightTools: false,
      filesStable: true,
      fileFingerprint: 'unit',
      processesComplete: true,
      jobObservations: [{ jobId: 'unit-job', nativeStatus: 'killed', externalStatus: 'gone' }],
      note: '单测模拟可信观察；实际Host另验',
    });
    expect(f.controls.get(control.id).status).toBe('stopped');
    expect(f.connection.executions().get(f.execution.id).writeOccupancy).toBe('released');
  } finally {
    f.close();
  }
});
test('终止保留原尝试与未知占用，票回待办，原执行不能恢复', () => {
  const f = fixture();
  try {
    const control = f.controls.request(
      f.user,
      {
        operationId: randomUUID(),
        executionId: f.execution.id,
        action: 'terminate',
        reason: '终止该次而不结票',
        expectedRevision: 0,
      },
      f.epoch,
    );
    f.controls.terminateRecorded(control.id, {
      state: 'confirmed',
      goalId: 'unit-goal',
      note: '单测clear回执',
    });
    expect(f.connection.executions().get(f.execution.id).lifecycleState).toBe('terminated');
    expect(f.connection.executions().get(f.execution.id).writeOccupancy).not.toBe('released');
    expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe('todo');
    expect(f.connection.workbench().getTicket(f.ticket.id).currentExecution).toBeNull();
    expect(() =>
      f.controls.request(
        f.user,
        {
          operationId: randomUUID(),
          executionId: f.execution.id,
          action: 'resume',
          reason: '不允许复活',
          expectedRevision: 1,
        },
        f.epoch,
      ),
    ).toThrow('终止');
    expect(f.controls.get(control.id).executionId).toBe(f.execution.id);
  } finally {
    f.close();
  }
});
test('停止项目只记本项目意图，立即拒绝新派工，未把控制台关闭当停止', () => {
  const f = fixture();
  try {
    expect(f.controls.project().state).toBe('running');
    const result = f.controls.stopProject(
      f.user,
      { operationId: randomUUID(), reason: '明确停止本项目' },
      f.epoch,
    );
    expect(result.executionIds).toContain(f.execution.id);
    expect(f.connection.snapshot().started).toBe(false);
    expect(f.controls.project().state).toBe('stopping');
    expect(() => f.controls.requireDispatch()).toThrow('项目');
    expect(f.connection.session(f.manager.id).nativeSessionId).toBe('unit-manager');
  } finally {
    f.close();
  }
});
test('软停止没有实际挂起回报不能仅凭idle与文件稳定释放范围', () => {
  const f = fixture();
  try {
    const control = f.controls.request(
      f.user,
      {
        operationId: randomUUID(),
        executionId: f.execution.id,
        action: 'soft-stop',
        reason: '需要收尾回报',
        expectedRevision: 0,
      },
      f.epoch,
    );
    f.controls.receipt(control.id, 'goal', { state: 'confirmed', note: '仅单测disarm回执' });
    f.controls.observeStopped(control.id, {
      agentIdle: true,
      inFlightTools: false,
      filesStable: true,
      fileFingerprint: 'unit',
      processesComplete: true,
      jobObservations: [],
      note: '单测：不能替代会话交棒',
    });
    expect(f.connection.executions().get(f.execution.id).writeOccupancy).not.toBe('released');
    expect(f.controls.get(control.id).status).not.toBe('stopped');
  } finally {
    f.close();
  }
});
test('终止后的停稳核对只能释放占用，不能复活旧生命周期或会话', () => {
  const f = fixture();
  try {
    const control = f.controls.request(
      f.user,
      {
        operationId: randomUUID(),
        executionId: f.execution.id,
        action: 'terminate',
        reason: '原尝试终止',
        expectedRevision: 0,
      },
      f.epoch,
    );
    f.controls.receipt(control.id, 'cancel', { state: 'confirmed', note: '单测取消' });
    f.controls.terminateRecorded(control.id, {
      state: 'confirmed',
      goalId: 'unit-goal',
      note: '单测clear',
    });
    f.controls.observeStopped(control.id, {
      agentIdle: true,
      inFlightTools: false,
      filesStable: true,
      fileFingerprint: 'unit',
      processesComplete: true,
      jobObservations: [],
      note: '单测实际观察夹具',
    });
    expect(f.connection.executions().get(f.execution.id).writeOccupancy).toBe('released');
    expect(f.connection.executions().get(f.execution.id).lifecycleState).toBe('terminated');
    expect(f.connection.session(f.session.id).communicationState).toBe('terminated');
    expect(() =>
      f.controls.request(
        f.user,
        {
          operationId: randomUUID(),
          executionId: f.execution.id,
          action: 'resume',
          reason: '不能复活',
          expectedRevision: 1,
        },
        f.epoch,
      ),
    ).toThrow('终止');
  } finally {
    f.close();
  }
});
test('终止后迟到的原作业settled仍归原执行保存，不因退出current而丢失', () => {
  const f = fixture();
  try {
    const startedAt = Date.now(),
      data = {
        jobId: 'unit-late',
        owner: 'unit-executor',
        kind: 'unit',
        label: '终止后的作业',
        startedAt,
      };
    f.controls.recordJob(f.session.id, { type: 'job/registered', seq: 20, data });
    const control = f.controls.request(
      f.user,
      {
        operationId: randomUUID(),
        executionId: f.execution.id,
        action: 'terminate',
        reason: '先保存终止',
        expectedRevision: 0,
      },
      f.epoch,
    );
    f.controls.terminateRecorded(control.id, { state: 'confirmed', note: '单测clear' });
    f.controls.recordJob(f.session.id, {
      type: 'job/settled',
      seq: 30,
      data: {
        ...data,
        status: 'killed',
        finishedAt: Date.now(),
        cause: 'kill',
        producerReported: true,
      },
    });
    expect(f.controls.jobs(f.execution.id)[0]?.settledSeq).toBe(30);
    expect(f.controls.jobs(f.execution.id)[0]?.status).toBe('killed');
  } finally {
    f.close();
  }
});
test('控制要求保持平台来源；受控来源只投递已保存的准确挂起结果', () => {
  const f = fixture();
  try {
    const control = f.controls.request(
        f.user,
        {
          operationId: randomUUID(),
          executionId: f.execution.id,
          action: 'soft-stop',
          reason: '测试 $manual 不能伪装用户授权',
          expectedRevision: 0,
        },
        f.epoch,
      ),
      messages = f.connection.messages(),
      request = messages.recordControl(control.id, 'request');
    expect(request.message.sender.kind).toBe('system');
    expect(request.receipt.targetSessionId).toBe(f.session.id);
    const ordinary = messages.save(
        { kind: 'session', sessionId: f.session.id },
        { id: randomUUID(), target: f.manager.id, content: '旧普通消息不取得回传例外' },
      ),
      resultId = randomUUID();
    expect(() => f.controls.handoff(f.manager.id, control.id, '冒充执行者', [resultId])).toThrow(
      '不属于',
    );
    f.controls.handoff(f.session.id, control.id, '已保存单测记录，恢复从原位置继续', [resultId]);
    f.controls.handoffPaused(control.id);
    const saved = messages.recordControlledResult(resultId, f.session.id);
    expect(saved.message.sender.sessionId).toBe(f.session.id);
    expect(saved.message.content).toBe('已保存单测记录，恢复从原位置继续');
    expect(messages.beginDelivery(saved.message.id).receipt.state).toBe('sending');
    expect(messages.beginDelivery(ordinary.message.id).receipt.state).toBe('held');
    expect(() => messages.recordControlledResult(randomUUID(), f.session.id)).toThrow('正式挂起');
    expect(f.connection.session(f.session.id).communicationState).toBe('paused');
  } finally {
    f.close();
  }
});
test('明确恢复先检查已释放范围与冲突，失败回滚，接纳不换执行身份', () => {
  const f = fixture();
  try {
    const stop = f.controls.request(
      f.user,
      {
        operationId: randomUUID(),
        executionId: f.execution.id,
        action: 'hard-stop',
        reason: '单测停止',
        expectedRevision: 0,
      },
      f.epoch,
    );
    f.controls.receipt(stop.id, 'goal', { state: 'confirmed', note: '单测Goal disarm' });
    f.controls.receipt(stop.id, 'cancel', { state: 'confirmed', note: '单测取消' });
    const resume = f.controls.request(
      f.user,
      {
        operationId: randomUUID(),
        executionId: f.execution.id,
        action: 'resume',
        reason: '明确恢复原尝试',
        expectedRevision: 1,
      },
      f.epoch,
    );
    expect(() => f.controls.resumeAdmitted(resume.id, { unit: true }, f.epoch, () => {})).toThrow(
      '停稳',
    );
    f.controls.observeStopped(stop.id, {
      agentIdle: true,
      inFlightTools: false,
      filesStable: true,
      fileFingerprint: 'unit',
      processesComplete: true,
      jobObservations: [],
      note: '单测可信观察',
    });
    expect(() =>
      f.controls.resumeAdmitted(resume.id, { unit: true }, f.epoch, () => {
        throw new Error('单测冲突');
      }),
    ).toThrow('冲突');
    expect(f.connection.executions().get(f.execution.id).writeOccupancy).toBe('released');
    expect(f.connection.session(f.session.id).communicationState).toBe('paused');
    const result = f.controls.resumeAdmitted(resume.id, { unit: true }, f.epoch, () => {});
    expect(result.id).toBe(f.execution.id);
    expect(result.goalId).toBe('unit-goal');
    expect(result.writeOccupancy).toBe('held');
    expect(f.connection.session(f.session.id).communicationState).toBe('active');
    f.controls.observeStopped(stop.id, {
      agentIdle: true,
      inFlightTools: false,
      filesStable: true,
      fileFingerprint: 'stale-unit',
      processesComplete: true,
      jobObservations: [],
      note: '迟到的旧停止观察',
    });
    expect(f.connection.executions().get(f.execution.id).lifecycleState).toBe('active');
    expect(f.connection.executions().get(f.execution.id).writeOccupancy).toBe('held');
    expect(f.connection.session(f.session.id).communicationState).toBe('active');
  } finally {
    f.close();
  }
});
