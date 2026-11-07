import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { worktreeMergeFixture } from './worktree-merge-fixture.ts';
import { WorktreeMergeService } from '../src/services/worktree-merges.ts';

test('撤销须原合入独立核定未发生且原提交者安静，同操作重放只返回原记录', async () => {
  const f = await worktreeMergeFixture();
  try {
    let quiet = true;
    const service = new WorktreeMergeService(f.projects, {
      allowed: () => true,
      inspect: () => ({
        nativeSessionId: 'unit-local-committer',
        epoch: 'unit',
        boundary: 0,
        ranges: [],
        state: quiet ? 'confirmed' : 'unknown',
        note: '仅合成原生观察',
        observedAt: new Date().toISOString(),
      }),
    });
    const base = {
      targetRepository: f.root,
      sourceWorktreeId: f.sourceWorktree.id,
      sourceVersionId: f.sourceVersion.id,
      sourceResultId: f.sourceResult.id,
      sourceCommit: f.sourceCommit,
    };
    const p = await service.preview(f.project.id, f.managerActor, base);
    const arranged = await service.arrange(f.project.id, f.managerActor, {
      ...base,
      operationId: randomUUID(),
      sessionId: f.worker.id,
      expectedFingerprint: p.fingerprint,
      combinationTicketId: f.combinationTicket.id,
      basis: '撤销夹具',
    });
    const input = {
      operationId: randomUUID(),
      expectedRevision: arranged.revision,
      reason: '原Git未发生，明确撤销不做清理',
    };
    quiet = false;
    await expect(service.cancel(f.project.id, f.managerActor, arranged.id, input)).rejects.toThrow(
      /安静/,
    );
    expect(f.c.worktreeMerges().get(f.managerActor, arranged.id).status).toBe('arranged');
    quiet = true;
    const cancelled = await service.cancel(f.project.id, f.managerActor, arranged.id, input);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.integrated).toBeNull();
    expect(f.c.worktreeMerges().busyRepository(p.plan.target.commonDir)).toBe(false);
    expect(f.c.workbench().getTask(cancelled.taskId).state).not.toBe('checked');
    expect(f.git('rev-parse', 'HEAD')).toBe(p.plan.target.head);
    expect((await service.cancel(f.project.id, f.managerActor, arranged.id, input)).revision).toBe(
      cancelled.revision,
    );
    await expect(
      service.cancel(f.project.id, f.managerActor, arranged.id, { ...input, reason: '不同正文' }),
    ).rejects.toThrow(/操作身份/);
    await service.close();
  } finally {
    f.close();
  }
}, 60000);
