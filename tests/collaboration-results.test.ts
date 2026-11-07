import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { completionFixture } from './completion-fixture.ts';
import { AssistantService } from '../src/services/assistant-service.ts';
const quiet = {
  agentIdle: true,
  inFlightTools: false,
  filesStable: true,
  fileFingerprint: 'fixture',
  processesComplete: true,
  jobObservations: [],
  note: '仅为原生边界替身，不冒充实际环境',
};
test('主执行等待保留两个辅助，结果先存后确认，齐备才可接续，重复结果不新增', async () => {
  const f = completionFixture();
  try {
    const c = f.connection,
      catalog = c.collaborations();
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
    const create = () =>
      service.create(c.snapshot().id, f.session.id, {
        operationId: randomUUID(),
        roleId: f.role.id,
        name: '辅助',
        purpose: '测试正式结果',
        writeScopes: [],
      });
    const a = await create(),
      b = await create();
    const results = c.collaborationResults();
    const waiting = results.wait(f.session.id, {
      operationId: randomUUID(),
      reason: '没有其他可做部分，等待两个核对结果',
      dependencies: [a.id, b.id],
    });
    expect(waiting.state).toBe('waiting');
    results.problem(waiting.id, '原Goal暂停的flush暂时未知');
    expect(results.retryWait(waiting.id).id).toBe(waiting.id);
    expect(results.getWait(waiting.id).state).toBe('waiting');
    expect(c.executions().get(f.execution.id).lifecycleState).toBe('waiting');
    expect(catalog.scopeForSession(a.sessionId!)?.allowWrite).toBe(true);
    const input = {
      operationId: randomUUID(),
      action: 'complete',
      content: '核对完毕',
      evidencePaths: [],
    };
    const first = results.report(a.sessionId!, input);
    expect(first.progress).toBe('saved');
    expect(catalog.unsettled(f.execution.id)).toHaveLength(2);
    expect(results.report(a.sessionId!, input)).toEqual(first);
    expect(() => results.report(a.sessionId!, { ...input, content: '替换原文' })).toThrow('冲突');
    results.observe(first.id, quiet);
    expect(results.readiness(waiting.id).outstanding).toEqual([a.id, b.id]);
    const notice = results.prepareNotice(first.id),
      message = c.messages().saveCollaborationResult(first.id, notice.id);
    expect(message.message.sender.sessionId).toBe(a.sessionId);
    expect(c.messages().beginDelivery(message.message.id).receipt.state).toBe('sending');
    c.messages().recordMemoryAccepted(message.message.id);
    c.messages().recordDurableAccepted(message.message.id);
    expect(() =>
      c
        .messages()
        .save(
          { kind: 'session', sessionId: a.sessionId! },
          { id: randomUUID(), target: f.session.id, content: '不能借正式结果扩普通聊天权限' },
        ),
    ).toThrow('控制');
    expect(results.readiness(waiting.id)).toMatchObject({ ready: false, outstanding: [b.id] });
    const second = results.report(b.sessionId!, { ...input, operationId: randomUUID() });
    results.observe(second.id, quiet);
    const secondNotice = results.prepareNotice(second.id);
    c.messages().saveCollaborationResult(second.id, secondNotice.id);
    c.messages().recordMemoryAccepted(secondNotice.id);
    c.messages().recordDurableAccepted(secondNotice.id);
    expect(results.readiness(waiting.id)).toMatchObject({ ready: true, outstanding: [] });
    expect(results.getWait(waiting.id).dependencies).toEqual([a.id, b.id]);
    expect(catalog.unsettled(f.execution.id)).toEqual([]);
    results.signalled(waiting.id);
    expect(c.executions().get(f.execution.id).lifecycleState).toBe('active');
    expect(() =>
      catalog.resumeForMessage(f.session.id, a.sessionId!, () => {
        throw new Error('消息保存失败');
      }),
    ).toThrow('保存失败');
    expect(c.session(a.sessionId!).communicationState).toBe('archived');
    catalog.resumeForMessage(f.session.id, a.sessionId!, () => undefined);
    expect(catalog.scopeForSession(a.sessionId!)?.allowWrite).toBe(true);
    const correction = results.report(a.sessionId!, {
      ...input,
      operationId: randomUUID(),
      content: '关联原协作修正',
    });
    expect(correction.previousResultId).toBe(first.id);
    expect(() => results.observe(first.id, quiet)).toThrow('旧结果');
    results.observe(correction.id, quiet);
    const correctionNotice = results.prepareNotice(correction.id);
    c.messages().saveCollaborationResult(correction.id, correctionNotice.id);
    c.messages().recordMemoryAccepted(correctionNotice.id);
    c.messages().recordDurableAccepted(correctionNotice.id);
    const already = results.wait(f.session.id, {
      operationId: randomUUID(),
      reason: '结果已到，不能再次睡下',
      dependencies: [a.id, b.id],
    });
    expect(already.state).toBe('ready');
    expect(c.executions().get(f.execution.id).lifecycleState).toBe('active');
    const d = await create(),
      e = await create();
    const failedWait = results.wait(f.session.id, {
      operationId: randomUUID(),
      reason: '等待新一组辅助',
      dependencies: [d.id, e.id],
    });
    catalog.problem(d.id, '实际协作失败，主负责人需要处理');
    expect(results.readiness(failedWait.id).ready).toBe(false);
    const faultId = catalog.get(d.id).faultId!;
    c.messages().saveCollaborationFault(faultId);
    c.messages().recordMemoryAccepted(faultId);
    c.messages().recordDurableAccepted(faultId);
    expect(results.readiness(failedWait.id)).toMatchObject({
      ready: true,
      exceptions: [d.id],
      outstanding: [d.id, e.id],
    });
    expect(results.getWait(failedWait.id).dependencies).toEqual([d.id, e.id]);
    c.controls().request(
      { kind: 'user' },
      {
        operationId: randomUUID(),
        executionId: f.execution.id,
        action: 'soft-stop',
        reason: '用户独立暂停',
        expectedRevision: 0,
      },
      'unit',
    );
    expect(results.canWake(failedWait.id)).toBe(false);
    expect(() => results.retryWait(failedWait.id)).toThrow('控制变化');
    expect(() => results.signalled(failedWait.id)).toThrow('不解除暂停');
    expect(catalog.scopeForSession(e.sessionId!)?.allowWrite).toBe(false);
    expect(() => results.report(e.sessionId!, { ...input, operationId: randomUUID() })).toThrow(
      '实际辅助',
    );
    expect(c.workbench().getTicket(f.ticket.id).state).toBe('in-progress');
  } finally {
    f.close();
  }
});
test('辅助短完成可无说明，未知停稳不释放，挂起和文字恢复条件不被猜成完成', async () => {
  const f = completionFixture();
  try {
    const c = f.connection,
      service = new AssistantService(f.projects, {
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
        name: '短辅助',
        purpose: '核对',
        writeScopes: [],
      }),
      r = c.collaborationResults();
    const result = r.report(a.sessionId!, { operationId: randomUUID(), action: 'complete' });
    expect(result.content).toBe('');
    expect(
      r.observe(result.id, { ...quiet, processesComplete: false, filesStable: null }).progress,
    ).toBe('unknown');
    expect(c.collaborations().unsettled(f.execution.id)).toHaveLength(1);
    expect(r.observe(result.id, quiet).observations).toHaveLength(2);
    c.collaborations().resumeForMessage(f.session.id, a.sessionId!, () => undefined);
    expect(() =>
      r.report(a.sessionId!, {
        operationId: randomUUID(),
        action: 'hangup',
        content: '有原因但未指明等待对象或恢复条件',
      }),
    ).toThrow('恢复');
    expect(() =>
      r.report(a.sessionId!, { operationId: randomUUID(), action: 'hangup', content: '' }),
    ).toThrow('挂起原因');
    const held = r.report(a.sessionId!, {
      operationId: randomUUID(),
      action: 'hangup',
      content: '需主负责人澄清输入',
      resumeCondition: '收到输入规则',
    });
    r.observe(held.id, quiet);
    const heldNotice = r.prepareNotice(held.id);
    c.messages().saveCollaborationResult(held.id, heldNotice.id);
    c.messages().recordMemoryAccepted(heldNotice.id);
    c.messages().recordDurableAccepted(heldNotice.id);
    expect(c.collaborations().get(a.id).state).toBe('waiting');
    const arrived = r.wait(f.session.id, {
      operationId: randomUUID(),
      reason: '辅助需要澄清',
      dependencies: [a.id],
    });
    expect(arrived.state).toBe('ready');
    expect(r.readiness(arrived.id).exceptions).toEqual([a.id]);
    const manual = r.wait(f.session.id, {
      operationId: randomUUID(),
      reason: '没有其他可做事项',
      resumeCondition: '用户明确确认样例',
    });
    expect(manual.state).toBe('waiting');
    expect(r.readiness(manual.id).ready).toBe(false);
  } finally {
    f.close();
  }
});
