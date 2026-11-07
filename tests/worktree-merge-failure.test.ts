import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { worktreeMergeFixture } from './worktree-merge-fixture.ts';
import { finishMergeExecution } from './merge-execution-fixture.ts';
import { WorktreeMergeService } from '../src/services/worktree-merges.ts';

test('组合指定退回意见保存失败固定版本及恢复条件，保留原合入与原执行，不代填通过', async () => {
  const f = await worktreeMergeFixture();
  try {
    const service = new WorktreeMergeService(f.projects, {
      allowed: () => true,
      inspect: () => ({
        nativeSessionId: 'unit-local-committer',
        epoch: 'unit',
        boundary: 0,
        ranges: [],
        state: 'confirmed',
        note: '仅合成原生回执',
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
    let v = await service.arrange(f.project.id, f.managerActor, {
      ...base,
      operationId: randomUUID(),
      sessionId: f.worker.id,
      expectedFingerprint: p.fingerprint,
      combinationTicketId: f.combinationTicket.id,
      basis: '组合失败夹具',
    });
    f.git('merge', '--no-edit', '--no-overwrite-ignore', '--', f.sourceCommit);
    v = await service.reconcile(f.project.id, f.managerActor, v.id, {
      operationId: randomUUID(),
      expectedRevision: v.revision,
      reason: '核定原合入',
    });
    const e = f.c.executions().register(
      f.managerActor,
      {
        operationId: randomUUID(),
        ticket: f.combinationTicket.id,
        roleId: f.developer.roleId,
        name: '组合检查',
        cwd: f.root,
        mergeId: v.id,
        writeScopes: [f.root],
      },
      'unit',
    ).record;
    const failed = finishMergeExecution(f, e, 'return');
    const input = {
      operationId: randomUUID(),
      expectedRevision: v.revision,
      versionId: failed.version.id,
      resultId: failed.result.id,
      basis: '退回的固定版本保留；按意见继续原执行，修正后重新验证/送审',
    };
    v = await service.recordCombinationFailure(f.project.id, f.managerActor, v.id, input);
    expect(v.status).toBe('awaiting-verification');
    expect(v.combination).toBeNull();
    expect(v.combinationAttempts.at(-1)?.state).toBe('returned');
    expect(v.combinationAttempts.at(-1)?.issues).toEqual(failed.result.issues);
    expect(v.integrated?.head).toBe(f.sourceCommit);
    expect(f.c.executions().get(e.id).writeOccupancy).not.toBe('released');
    expect(f.c.workbench().getTask(v.taskId).state).toBe('held');
    expect(
      (await service.recordCombinationFailure(f.project.id, f.managerActor, v.id, input)).revision,
    ).toBe(v.revision);
    await service.close();
  } finally {
    f.close();
  }
}, 60000);
