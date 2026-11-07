import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { worktreeMergeFixture } from './worktree-merge-fixture.ts';
import { finishMergeExecution } from './merge-execution-fixture.ts';
import { WorktreeMergeService } from '../src/services/worktree-merges.ts';
import { captureLocalGit, verifyLocalCommit } from '../src/services/local-git.ts';

test('组合发现实质修正时复用已审必要提交，旧组合意见不能代新commit核验，原合入历史保留', async () => {
  const f = await worktreeMergeFixture();
  try {
    const host = {
      allowed: () => true,
      inspect: () => ({
        nativeSessionId: 'unit-local-committer',
        epoch: 'unit',
        boundary: 0,
        ranges: [],
        state: 'confirmed' as const,
        note: '仅合成原生回执',
        observedAt: new Date().toISOString(),
      }),
    };
    const service = new WorktreeMergeService(f.projects, host);
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
      basis: '组合修正夹具',
    });
    f.git('merge', '--no-edit', '--no-overwrite-ignore', '--', f.sourceCommit);
    v = await service.reconcile(f.project.id, f.managerActor, v.id, {
      operationId: randomUUID(),
      expectedRevision: v.revision,
      reason: '初次普通合入核定',
    });
    const original = v.lastProof!.resultHead;
    expect(v.integrated?.head).toBe(original);
    const dispatch = {
      roleId: f.developer.roleId,
      name: '组合验证',
      cwd: f.root,
      mergeId: v.id,
      writeScopes: [f.root],
    };
    const e = f.c
      .executions()
      .register(
        f.managerActor,
        { ...dispatch, operationId: randomUUID(), ticket: f.combinationTicket.id },
        'unit',
      ).record;
    f.write('a.txt', 'reviewed combination correction\n');
    const fixed = finishMergeExecution(f, e);
    v = await service.confirmCombination(f.project.id, f.managerActor, v.id, {
      operationId: randomUUID(),
      expectedRevision: v.revision,
      versionId: fixed.version.id,
      resultId: fixed.result.id,
      basis: '组合修正已审，但真实Git仍有差异，保留恢复条件',
    });
    expect(v.status).toBe('awaiting-verification');
    expect(v.combinationAttempts.at(-1)?.state).toBe('needs-correction');
    expect(v.combination).toBeNull();
    const input = {
      operationId: randomUUID(),
      sessionId: f.worker.id,
      repository: f.root,
      kind: 'commit' as const,
      files: ['a.txt'],
      expectedFingerprint: '',
      basis: '同组合票新交付已审必要修正',
      commitMessage: 'approved combination correction',
      versionIds: [fixed.version.id],
      ticketIds: [f.combinationTicket.id],
    };
    const plan = await captureLocalGit(f.root, input.files, 'commit');
    input.expectedFingerprint = plan.fingerprint;
    expect(() => f.c.localCommits().arrange(f.managerActor, input, plan)).toThrow(/合入/);
    const receipt = f.c.localCommits().arrange(f.managerActor, { ...input, mergeId: v.id }, plan, {
      nativeSessionId: 'unit-local-committer',
      epoch: 'unit',
      boundary: 0,
      ranges: [],
    });
    f.git('add', '--', 'a.txt');
    f.git('commit', '-m', input.commitMessage);
    const proof = await verifyLocalCommit(plan);
    expect(proof.tree).toBe(f.git('rev-parse', 'HEAD^{tree}'));
    const done = f.c.localCommits().reconcile(
      f.managerActor,
      receipt.id,
      {
        operationId: randomUUID(),
        expectedRevision: receipt.revision,
        reason: '真实必要提交回读',
      },
      proof,
      { state: 'confirmed', note: '仅合成原生观察', observedAt: new Date().toISOString() },
    );
    expect(done.status).toBe('completed');
    v = await service.reconcile(f.project.id, f.managerActor, v.id, {
      operationId: randomUUID(),
      expectedRevision: v.revision,
      reason: '沿原id纳入已审必要提交回执链',
    });
    expect(v.status).toBe('awaiting-verification');
    expect(v.correctionReceiptIds).toEqual([receipt.id]);
    expect(v.integrated?.head).toBe(original);
    expect(v.lastProof?.parents).toEqual([original]);
    await expect(
      service.confirmCombination(f.project.id, f.managerActor, v.id, {
        operationId: randomUUID(),
        expectedRevision: v.revision,
        versionId: fixed.version.id,
        resultId: fixed.result.id,
        basis: '提交前旧组合版本不能为新HEAD核验',
      }),
    ).rejects.toThrow();
    const supplement = f.c.acceptance().supplement(
      f.managerActor,
      {
        operationId: randomUUID(),
        ticketId: f.combinationTicket.id,
        versionId: fixed.version.id,
        resultId: fixed.result.id,
        reason: '已审修正必要提交后在新HEAD重新组合验证',
        dispatch,
      },
      (raw) => f.c.executions().register(f.managerActor, raw, 'unit').record,
    );
    const final = finishMergeExecution(f, f.c.executions().get(supplement.executionId));
    expect(() =>
      service.confirmStartupBaseline(
        f.project.id,
        supplement.executionId,
        f.c.versions().list(supplement.executionId)[0]!.id,
      ),
    ).not.toThrow();
    v = await service.confirmCombination(f.project.id, f.managerActor, v.id, {
      operationId: randomUUID(),
      expectedRevision: v.revision,
      versionId: final.version.id,
      resultId: final.result.id,
      basis: '新HEAD真实组合执行及新指定pass',
    });
    expect(v.status).toBe('completed');
    expect(v.integrated?.head).toBe(original);
    expect(f.git('merge-base', '--is-ancestor', original, 'HEAD')).toBe('');
    await service.close();
  } finally {
    f.close();
  }
}, 180000);
