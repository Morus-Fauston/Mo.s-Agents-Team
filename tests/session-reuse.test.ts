import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { worktreeMergeFixture } from './worktree-merge-fixture.ts';

const inputs = (f: Awaited<ReturnType<typeof worktreeMergeFixture>>) => {
  const session = f.c.session(f.sourceSession.id);
  return {
    dispatch: {
      operationId: randomUUID(),
      ticket: f.combinationTicket.id,
      sessionId: session.id,
      name: '同会话顺序承接新票',
      cwd: f.sourcePath,
      worktreeId: f.sourceWorktree.id,
      writeScopes: [],
    },
    reuse: {
      nativeSessionId: session.nativeSessionId!,
      epoch: 'unit',
      boundary: 10,
      ranges: [],
      state: 'confirmed' as const,
      note: '仅合成原生观察，不作为真实SDK',
      observedAt: new Date().toISOString(),
    },
  };
};

test('审阅收尾的暂停需明确原执行及可信停稳才可同会话承接新票，不恢复旧Goal', async () => {
  const f = await worktreeMergeFixture();
  try {
    const { dispatch, reuse } = inputs(f),
      catalog = f.c.executions(),
      old = f.sourceExecution;
    f.c.workbench().updateTicket(f.managerActor, f.combinationTicket.id, {
      operationId: randomUUID(),
      expectedRevision: f.combinationTicket.revision,
      reason: '本票消费已经正式通过的固定版本',
      dependencies: [f.sourceTicket.id],
    });
    expect(f.c.session(f.sourceSession.id).communicationState).toBe('paused');
    expect(() => catalog.register(f.managerActor, dispatch, 'unit')).toThrow(/受控制/);
    const approved = { ...dispatch, reuseClosedExecutionId: old.id };
    expect(() => catalog.register(f.managerActor, approved, 'unit')).toThrow(/原生/);
    const value = catalog.register(f.managerActor, approved, 'unit', undefined, () => reuse).record;
    expect(value.id).not.toBe(old.id);
    expect(value.sessionId).toBe(old.sessionId);
    expect(value.sessionReuse?.previousExecutionId).toBe(old.id);
    expect(value.sessionReuse?.previousResultId).toBe(f.sourceResult.id);
    expect(value.dependencyEvidence).toEqual([
      {
        ticketId: f.sourceTicket.id,
        reviewId: f.sourceResult.id,
        deliveryId: f.sourceResult.versionId,
        scope: f.sourceResult.scope,
      },
    ]);
    expect(value.goalId).toBeNull();
    expect(catalog.get(old.id).lifecycleState).toBe('closed');
    expect(f.c.session(f.sourceSession.id).communicationState).toBe('active');
    expect(catalog.register(f.managerActor, approved, 'unit').record.id).toBe(value.id);
  } finally {
    f.close();
  }
}, 60000);

test('后续独立暂停覆盖收尾来源，即使原Goal已清除且原生安静也不能借新派工解除', async () => {
  const f = await worktreeMergeFixture();
  try {
    const { dispatch, reuse } = inputs(f),
      catalog = f.c.executions();
    f.c.setCommunicationState(f.sourceSession.id, 'paused');
    expect(() =>
      catalog.register(
        f.managerActor,
        { ...dispatch, reuseClosedExecutionId: f.sourceExecution.id },
        'unit',
        undefined,
        () => reuse,
      ),
    ).toThrow(/暂停来源/);
    expect(catalog.currentForSession(f.sourceSession.id)).toBeUndefined();
    expect(f.c.session(f.sourceSession.id).communicationState).toBe('paused');
  } finally {
    f.close();
  }
}, 60000);
