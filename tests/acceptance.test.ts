import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { historyTargets } from '../src/services/history-navigation.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resultServiceFixture } from './review-result-runtime-fixture.ts';
async function fixture(verification: 'automated' | 'manual' = 'automated', prechecked = false) {
  const f = resultServiceFixture(verification, prechecked),
    result = f.service.submit(
      f.connection.snapshot().id,
      f.reviewer.id,
      f.auditAgent,
      f.input('pass'),
    );
  await expect
    .poll(() => f.connection.reviewResults().get(result.id).progress.state)
    .toBe('confirmed');
  return { ...f, result, managerActor: { kind: 'session' as const, sessionId: f.manager.id } };
}
test('冻结已勾选不能绕过本版本必需验收退回，重安排不得降为可选', async () => {
  const f = await fixture('automated', true);
  try {
    const catalog = f.connection.acceptance(),
      body = {
        operationId: randomUUID(),
        ticketId: f.ticket.id,
        versionId: f.result.versionId,
        resultId: f.result.id,
        conditionId: f.ticket.checklist[0]!.id,
        owner: { kind: 'session', sessionId: f.manager.id },
        required: true,
        reason: '追加必要核对',
      };
    const assignment = catalog.assign(f.managerActor, body);
    catalog.record(f.managerActor, {
      operationId: randomUUID(),
      assignmentId: assignment.id,
      decision: 'return',
      basis: '必要核对未接受；保留原勾选以验证门槛',
      checkCondition: false,
    });
    expect(f.connection.workbench().getTicket(f.ticket.id).checklist[0]!.checked).toBe(true);
    expect(() =>
      catalog.assign(f.managerActor, {
        ...body,
        operationId: randomUUID(),
        required: false,
        reason: '不能降为可选绕过退回',
      }),
    ).toThrow('必需');
    expect(catalog.assignment(assignment.id).active).toBe(true);
    expect(() =>
      catalog.complete(f.managerActor, {
        operationId: randomUUID(),
        ticketId: f.ticket.id,
        versionId: f.result.versionId,
        resultId: f.result.id,
        basis: '冻结勾选不能忽略必要退回',
      }),
    ).toThrow('验收');
  } finally {
    await f.dispose();
  }
});
test('实际主管安排验收，指定责任方记录并显式关联Log/Checklist，主管核对后才能结票', async () => {
  const f = await fixture();
  try {
    const catalog = f.connection.acceptance(),
      versionId = f.result.versionId;
    expect(() =>
      catalog.complete(f.managerActor, {
        operationId: randomUUID(),
        ticketId: f.ticket.id,
        versionId,
        resultId: f.result.id,
        basis: '不能略过未勾条件',
      }),
    ).toThrow();
    const assignment = catalog.assign(f.managerActor, {
      operationId: randomUUID(),
      ticketId: f.ticket.id,
      versionId,
      resultId: f.result.id,
      conditionId: f.ticket.checklist[0]!.id,
      owner: { kind: 'session', sessionId: f.manager.id },
      required: true,
      reason: '主管承担自动化证据核对',
    });
    expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe('awaiting-acceptance');
    const input = {
      operationId: randomUUID(),
      assignmentId: assignment.id,
      decision: 'accept',
      basis: '单元夹具中的合成验收依据，不冒充真实工具',
      evidencePaths: ['成果.txt'],
      checkCondition: true,
    };
    f.connection.setCommunicationState(f.manager.id, 'paused');
    expect(() => catalog.record(f.managerActor, input)).toThrow('暂停');
    expect(catalog.recordFor(assignment.id)).toBeUndefined();
    expect(f.connection.workbench().getTicket(f.ticket.id).checklist[0]!.checked).toBe(false);
    f.connection.setCommunicationState(f.manager.id, 'active');
    const saved = catalog.record(f.managerActor, input);
    expect(saved.author.sessionId).toBe(f.manager.id);
    expect(saved.versionId).toBe(versionId);
    expect(catalog.record(f.managerActor, input).id).toBe(saved.id);
    const ticket = f.connection.workbench().getTicket(f.ticket.id);
    expect(ticket.state).toBe('awaiting-acceptance');
    expect(ticket.checklist[0]!.checked).toBe(true);
    expect(ticket.checklist[0]!.logId).toBeTruthy();
    expect(() =>
      catalog.complete(
        { kind: 'user' },
        {
          operationId: randomUUID(),
          ticketId: f.ticket.id,
          versionId,
          resultId: f.result.id,
          basis: '用户接受不能代主管结票',
        },
      ),
    ).toThrow('主管');
    const complete = {
      operationId: randomUUID(),
      ticketId: f.ticket.id,
      versionId,
      resultId: f.result.id,
      basis: '对应版本独审、验收、Checklist和收尾均核清',
    };
    const accepted = catalog.complete(f.managerActor, complete);
    expect(accepted.versionId).toBe(versionId);
    expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe('completed');
    expect(catalog.complete(f.managerActor, complete).id).toBe(accepted.id);
    const history = f.connection.workbench().projectHistory();
    const phaseEvent = history.find(
      (entry) => entry.kind === 'phase-opened' && entry.objectId === f.ticket.phaseId,
    )!;
    expect(historyTargets(f.connection, phaseEvent.id)).toContainEqual(
      expect.objectContaining({ kind: 'phase', recordId: f.ticket.phaseId }),
    );
    const recordEvent = history.find(
      (entry) => entry.kind === 'acceptance-recorded' && entry.references.includes(saved.id),
    )!;
    expect(historyTargets(f.connection, recordEvent.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'acceptance',
          ticketId: f.ticket.id,
          recordId: assignment.id,
        }),
        expect.objectContaining({ kind: 'acceptance', ticketId: f.ticket.id, recordId: saved.id }),
      ]),
    );
    const acceptedEvent = history.find(
      (entry) => entry.kind === 'ticket-accepted' && entry.references.includes(accepted.id),
    )!;
    expect(historyTargets(f.connection, acceptedEvent.id)).toContainEqual(
      expect.objectContaining({ kind: 'acceptance', ticketId: f.ticket.id, recordId: accepted.id }),
    );
  } finally {
    await f.dispose();
  }
});
test('必需人工项不可代填、不可绕过版本绑定，人工接受不自动结票', async () => {
  const f = await fixture('manual');
  try {
    const catalog = f.connection.acceptance(),
      body = {
        operationId: randomUUID(),
        ticketId: f.ticket.id,
        versionId: f.result.versionId,
        resultId: f.result.id,
        conditionId: f.ticket.checklist[0]!.id,
        required: true,
        reason: '必需用户事项',
      };
    expect(() =>
      catalog.assign(f.managerActor, {
        ...body,
        owner: { kind: 'session', sessionId: f.manager.id },
      }),
    ).toThrow('人工');
    const assignment = catalog.assign(f.managerActor, { ...body, owner: { kind: 'user' } });
    const accept = {
      operationId: randomUUID(),
      assignmentId: assignment.id,
      decision: 'accept',
      basis: '仅单元模拟用户操作，不登记真实人工通过',
      checkCondition: true,
      evidencePaths: [],
    };
    expect(() => catalog.record(f.managerActor, accept)).toThrow();
    expect(() =>
      catalog.complete(f.managerActor, {
        operationId: randomUUID(),
        ticketId: f.ticket.id,
        versionId: f.result.versionId,
        resultId: f.result.id,
        basis: '缺人工',
      }),
    ).toThrow();
    catalog.record({ kind: 'user' }, accept);
    expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe('awaiting-acceptance');
    expect(f.connection.workbench().getTicket(f.ticket.id).checklist[0]!.author?.kind).toBe('user');
    writeFileSync(join(f.root, '成果.txt'), '审后变更，不得拿旧通过背书');
    expect(() =>
      catalog.complete(f.managerActor, {
        operationId: randomUUID(),
        ticketId: f.ticket.id,
        versionId: f.result.versionId,
        resultId: f.result.id,
        basis: '旧版本不对应',
      }),
    ).toThrow('版本');
  } finally {
    await f.dispose();
  }
});
test('验收方退回只保留意见，旧安排和其他责任方不能覆盖当前记录', async () => {
  const f = await fixture('manual');
  try {
    const catalog = f.connection.acceptance(),
      assignment = catalog.assign(f.managerActor, {
        operationId: randomUUID(),
        ticketId: f.ticket.id,
        versionId: f.result.versionId,
        resultId: f.result.id,
        conditionId: f.ticket.checklist[0]!.id,
        owner: { kind: 'user' },
        required: true,
        reason: '用户体验',
      });
    const returned = catalog.record(
      { kind: 'user' },
      {
        operationId: randomUUID(),
        assignmentId: assignment.id,
        decision: 'return',
        basis: '仅单元模拟的体验退回',
        evidencePaths: [],
        checkCondition: true,
      },
    );
    expect(returned.decision).toBe('return');
    expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe('awaiting-acceptance');
    expect(f.connection.workbench().getTicket(f.ticket.id).checklist[0]!.checked).toBe(false);
    expect(() =>
      catalog.record(
        { kind: 'user' },
        {
          operationId: randomUUID(),
          assignmentId: assignment.id,
          decision: 'accept',
          basis: '不能覆盖旧退回',
          checkCondition: true,
        },
      ),
    ).toThrow();
    expect(() =>
      catalog.complete(f.managerActor, {
        operationId: randomUUID(),
        ticketId: f.ticket.id,
        versionId: f.result.versionId,
        resultId: f.result.id,
        basis: '未接受',
      }),
    ).toThrow();
  } finally {
    await f.dispose();
  }
});
