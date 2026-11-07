import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { worktreeMergeFixture } from './worktree-merge-fixture.ts';
import { WorktreeMergeService } from '../src/services/worktree-merges.ts';
import { captureLocalGit, verifyLocalCommit } from '../src/services/local-git.ts';

test('审后提交须有同版本已核定本地回执链，只有Git commit或自报不能借用旧pass', async () => {
  const f = await worktreeMergeFixture(false);
  try {
    const service = new WorktreeMergeService(f.projects, {}),
      catalog = f.c.localCommits();
    const plan = await captureLocalGit(f.sourcePath, ['a.txt'], 'commit');
    const receipt = catalog.arrange(
      f.managerActor,
      {
        operationId: randomUUID(),
        sessionId: f.worker.id,
        repository: f.sourcePath,
        kind: 'commit',
        files: ['a.txt'],
        expectedFingerprint: plan.fingerprint,
        basis: '本例已审源码提交',
        commitMessage: 'approved source after review',
        versionIds: [f.sourceVersion.id],
        ticketIds: [f.sourceTicket.id],
      },
      plan,
      { nativeSessionId: 'unit-local-committer', epoch: 'unit', boundary: 0, ranges: [] },
    );
    f.git('-C', f.sourcePath, 'add', '--', 'a.txt');
    f.git('-C', f.sourcePath, 'commit', '-m', 'approved source after review');
    const commit = f.git('-C', f.sourcePath, 'rev-parse', 'HEAD');
    const base = {
      targetRepository: f.root,
      sourceWorktreeId: f.sourceWorktree.id,
      sourceVersionId: f.sourceVersion.id,
      sourceResultId: f.sourceResult.id,
      sourceCommit: commit,
    };
    await expect(service.preview(f.project.id, f.managerActor, base)).rejects.toThrow(/提交链/);
    const done = catalog.reconcile(
      f.managerActor,
      receipt.id,
      {
        operationId: randomUUID(),
        expectedRevision: receipt.revision,
        reason: '实际Git对象及范围回读，原生仅合成观察',
      },
      await verifyLocalCommit(plan),
      { state: 'confirmed', note: '仅合成原生回执', observedAt: new Date().toISOString() },
    );
    expect(done.status).toBe('completed');
    const preview = await service.preview(f.project.id, f.managerActor, base);
    expect(preview.source.receiptIds).toEqual([receipt.id]);
    expect(preview.plan.sourceCommit).toBe(commit);
    await service.close();
  } finally {
    f.close();
  }
}, 60000);
