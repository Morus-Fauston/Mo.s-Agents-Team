import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { completionFixture } from './completion-fixture.ts';
import { AssistantService } from '../src/services/assistant-service.ts';
const quiet = {
  agentIdle: true,
  inFlightTools: false,
  filesStable: true,
  fileFingerprint: 'unit',
  processesComplete: true,
  jobObservations: [],
  note: '仅持久化控制夹具，不是真实停稳证据',
};
test('主控制只捕获本次未结束辅助，逐目标核停前不释放，先主后辅且独立暂停不解除', async () => {
  const f = completionFixture();
  try {
    const c = f.connection,
      catalog = c.assistantControls(),
      user = { kind: 'user' as const };
    const creators = new AssistantService(f.projects, {
      async create(_p, input, reserved) {
        const s = c.reserveSession(input);
        reserved(s);
        return c.bindSession(s.id, 'unit-' + s.id);
      },
      async reuse(_p, id, claim) {
        const s = c.session(id);
        claim(s);
        return s;
      },
    });
    const create = () =>
      creators.create(c.snapshot().id, f.session.id, {
        operationId: randomUUID(),
        roleId: f.role.id,
        name: '受控辅助',
        purpose: '停稳来源',
        writeScopes: [],
      });
    const a = await create(),
      ended = await create(),
      independent = await create();
    const result = c
      .collaborationResults()
      .report(ended.sessionId!, { operationId: randomUUID(), action: 'complete' });
    c.collaborationResults().observe(result.id, quiet);
    const originalWait = c.collaborationResults().wait(f.session.id, {
      operationId: randomUUID(),
      reason: '原主执行等待两个辅助',
      dependencies: [a.id, independent.id],
    });
    const own = catalog.request(
      user,
      {
        operationId: randomUUID(),
        collaborationId: independent.id,
        action: 'hard-stop',
        reason: '独立暂停',
        expectedRevision: 0,
      },
      'unit',
    );
    const root = c.controls().request(
      user,
      {
        operationId: randomUUID(),
        executionId: f.execution.id,
        action: 'hard-stop',
        reason: '主辅全部暂停',
        expectedRevision: 0,
      },
      'unit',
    );
    const targets = root.assistantTargetIds.map((id) => catalog.get(id));
    expect(c.collaborationResults().getWait(originalWait.id).state).toBe('controlled');
    expect(c.collaborationResults().getWait(originalWait.id).supersededByControlId).toBe(root.id);
    c.collaborationResults().problem(originalWait.id, '迟到的原Goal flush错误');
    expect(c.collaborationResults().getWait(originalWait.id).state).toBe('controlled');
    expect(targets.map((t) => t.collaborationId).sort()).toEqual([a.id, independent.id].sort());
    expect(targets.find((t) => t.collaborationId === independent.id)?.blockedBy).toContain(own.id);
    c.controls().receipt(root.id, 'goal', { state: 'confirmed', note: '夹具原Goal已撤销续轮' });
    c.controls().receipt(root.id, 'cancel', { state: 'confirmed', note: '夹具主会话idle' });
    c.controls().observeStopped(root.id, quiet);
    expect(c.executions().get(f.execution.id).writeOccupancy).not.toBe('released');
    for (const t of targets) {
      catalog.receipt(t.id, 'goal', { state: 'unnecessary', note: '本辅助没有Goal' });
      catalog.receipt(t.id, 'cancel', { state: 'confirmed', note: '夹具实际辅助已idle' });
      catalog.observe(t.id, quiet);
    }
    c.controls().observeStopped(root.id, quiet);
    expect(c.executions().get(f.execution.id).writeOccupancy).toBe('released');
    const parent = { kind: 'session' as const, sessionId: f.session.id };
    const resume = (id: string) => ({
      operationId: randomUUID(),
      collaborationId: id,
      action: 'resume',
      reason: '需要继续原工作',
      expectedRevision: catalog.revision(id),
    });
    expect(() => catalog.request(parent, resume(a.id), 'unit')).toThrow();
    const mainResume = c.controls().request(
      user,
      {
        operationId: randomUUID(),
        executionId: f.execution.id,
        action: 'resume',
        reason: '先主负责人核现场',
        expectedRevision: 1,
      },
      'unit',
    );
    c.controls().resumeAdmitted(mainResume.id, {}, 'unit', () => {});
    c.controls().setStatus(mainResume.id, 'resumed');
    expect(c.session(a.sessionId!).communicationState).toBe('paused');
    expect(() => catalog.request(parent, resume(independent.id), 'unit')).toThrow('独立');
    const resumed = catalog.request(parent, resume(a.id), 'unit');
    catalog.resumed(resumed.id, {});
    expect(c.session(a.sessionId!).communicationState).toBe('active');
    const nextWait = c.collaborationResults().wait(f.session.id, {
      operationId: randomUUID(),
      reason: '恢复主执行后明确等待必要原辅助',
      dependencies: [a.id],
    });
    expect(nextWait.id).not.toBe(originalWait.id);
    expect(nextWait.state).toBe('waiting');
    catalog.observe(targets.find((t) => t.collaborationId === a.id)!.id, quiet);
    expect(c.session(a.sessionId!).communicationState).toBe('active');
  } finally {
    f.close();
  }
});

test('原主执行自主软停止沿实际主控制传播，不获得直接暂停其他入口的权限', async () => {
  const f = completionFixture();
  try {
    const c = f.connection;
    const service = new AssistantService(f.projects, {
      async create(_p, input, reserved) {
        const s = c.reserveSession(input);
        reserved(s);
        return c.bindSession(s.id, 'unit-' + s.id);
      },
      async reuse(_p, id, claim) {
        const s = c.session(id);
        claim(s);
        return s;
      },
    });
    const a = await service.create(c.snapshot().id, f.session.id, {
      operationId: randomUUID(),
      roleId: f.role.id,
      name: '原辅助',
      purpose: '随主执行停止',
      writeScopes: [],
    });
    const actor = { kind: 'session' as const, sessionId: f.session.id };
    expect(() =>
      c.assistantControls().request(
        actor,
        {
          operationId: randomUUID(),
          collaborationId: a.id,
          action: 'soft-stop',
          reason: '普通成员不能直接任意控制',
          expectedRevision: 0,
        },
        'unit',
      ),
    ).toThrow('普通会话');
    const root = c.controls().request(
      actor,
      {
        operationId: randomUUID(),
        executionId: f.execution.id,
        action: 'soft-stop',
        reason: '停止自己的当前执行',
        expectedRevision: 0,
      },
      'unit',
    );
    expect(root.assistantTargetIds).toHaveLength(1);
  } finally {
    f.close();
  }
});
