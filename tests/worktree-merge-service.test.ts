import { verifyMergeGit } from '../src/services/worktree-merge-git.ts';
import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';
import { captureLocalGit } from '../src/services/local-git.ts';
import { worktreeMergeFixture } from './worktree-merge-fixture.ts';
import { WorktreeMergeService } from '../src/services/worktree-merges.ts';

test('预核须绑定同一已审固定版本与实际源commit，后来改变的源码不能借旧pass合入', async () => {
  const f = await worktreeMergeFixture();
  try {
    const service = new WorktreeMergeService(f.projects, {});
    const input = {
      targetRepository: f.root,
      sourceWorktreeId: f.sourceWorktree.id,
      sourceVersionId: f.sourceVersion.id,
      sourceResultId: f.sourceResult.id,
      sourceCommit: f.sourceCommit,
    };
    const p = await service.preview(f.project.id, f.managerActor, input);
    expect(p.source.versionId).toBe(f.sourceVersion.id);
    expect(p.source.resultId).toBe(f.sourceResult.id);
    expect(p.plan.sourceCommit).toBe(f.sourceCommit);
    expect(p.source.rawFingerprint).toHaveLength(64);
    await expect(service.preview(f.project.id, { kind: 'user' }, input)).rejects.toThrow('主管');
    await expect(
      service.preview(f.project.id, f.managerActor, { ...input, sourceResultId: randomUUID() }),
    ).rejects.toThrow();
    const baseline = f.c.versions().list(f.sourceExecution.id)[0]!;
    await expect(
      service.preview(f.project.id, f.managerActor, { ...input, sourceVersionId: baseline.id }),
    ).rejects.toThrow('版本');
    writeFileSync(join(f.sourcePath, 'a.txt'), 'later source change\n');
    f.git('-C', f.sourcePath, 'add', '--', 'a.txt');
    f.git('-C', f.sourcePath, 'commit', '-m', 'later unreviewed source');
    await expect(
      service.preview(f.project.id, f.managerActor, {
        ...input,
        sourceCommit: f.git('-C', f.sourcePath, 'rev-parse', 'HEAD'),
      }),
    ).rejects.toThrow('受审');
    await service.close();
  } finally {
    f.close();
  }
}, 30_000);

test('真实Git合入只进入等待组合核验，不替组合票勾选；未知停稳不能借blocked回报释放', async () => {
  const f = await worktreeMergeFixture();
  try {
    let quiet = true;
    const host = {
      allowed: () => true,
      inspect: () => ({
        nativeSessionId: 'unit-local-committer',
        epoch: 'unit',
        boundary: 0,
        ranges: [],
        state: quiet ? 'confirmed' : 'unknown',
        note: '仅合成受管观察',
        observedAt: new Date().toISOString(),
      }),
      notify: async (_p: string, _id: string, notice: string) => ({
        receipt: {
          messageId: notice,
          targetSessionId: f.c
            .worktreeMerges()
            .get({ kind: 'user' }, _id)
            .notices.find((n) => n.id === notice)!.targetSessionId,
          transport: 'mat-steer',
          nativeMessageId: notice,
          state: 'accepted',
          memoryAcceptedAt: new Date().toISOString(),
          durableAcceptedAt: new Date().toISOString(),
          enteredAt: null,
          nativeAttemptId: null,
          modelRequestId: null,
          handledRecord: null,
          error: null,
        },
      }),
    };
    const service = new WorktreeMergeService(
        f.projects,
        host as ConstructorParameters<typeof WorktreeMergeService>[1],
      ),
      base = {
        targetRepository: f.root,
        sourceWorktreeId: f.sourceWorktree.id,
        sourceVersionId: f.sourceVersion.id,
        sourceResultId: f.sourceResult.id,
        sourceCommit: f.sourceCommit,
      },
      preview = await service.preview(f.project.id, f.managerActor, base);
    const input = {
        ...base,
        operationId: randomUUID(),
        sessionId: f.worker.id,
        expectedFingerprint: preview.fingerprint,
        combinationTicketId: f.combinationTicket.id,
        basis: '受控原生接缝，真实E Git合入',
      },
      worker = { kind: 'session' as const, sessionId: f.worker.id };
    const value = await service.arrange(f.project.id, f.managerActor, input);
    expect(value.status).toBe('arranged');
    const ready = await service.inspect(f.project.id, worker, value.id, {
      operationId: randomUUID(),
      expectedRevision: value.revision,
    });
    expect(ready.status).toBe('ready');
    quiet = false;
    const uncertain = await service.report(f.project.id, worker, value.id, {
      operationId: randomUUID(),
      expectedRevision: ready.revision,
      state: 'blocked',
      content: '自报未做不能覆盖未知停稳',
    });
    expect(uncertain.status).toBe('unknown');
    expect(f.c.worktreeMerges().busyRepository(preview.plan.target.commonDir)).toBe(true);
    quiet = true;
    f.git('merge', '--no-edit', '--no-overwrite-ignore', '--', f.sourceCommit);
    const result = await service.reconcile(f.project.id, f.managerActor, value.id, {
      operationId: randomUUID(),
      expectedRevision: uncertain.revision,
      reason: '独立回读原id，不执行第二次Git',
    });
    expect(result.status).toBe('awaiting-verification');
    expect(result.lastProof?.state).toBe('verified');
    expect(result.combination).toBeNull();
    expect(f.c.workbench().getTicket(f.combinationTicket.id).checklist[0]!.checked).toBe(false);
    await service.close();
  } finally {
    f.close();
  }
}, 60_000);

test('原合入未办时阻止目标写入派工，提交者不能另接不同仓库的本地Git事项', async () => {
  const f = await worktreeMergeFixture();
  try {
    const other = join(f.root, 'other-repo');
    mkdirSync(other);
    f.git('init', '--initial-branch=main', other);
    writeFileSync(join(other, 'b.txt'), 'other approved local file\n');
    f.write('.git/info/exclude', '.TEAM/\n.agents/\nother-repo/\n');
    const host = {
      allowed: () => true,
      inspect: () => ({
        nativeSessionId: 'unit-local-committer',
        epoch: 'unit',
        boundary: 0,
        ranges: [],
        state: 'confirmed' as const,
        note: '仅合成停稳',
        observedAt: new Date().toISOString(),
      }),
    };
    const service = new WorktreeMergeService(f.projects, host),
      base = {
        targetRepository: f.root,
        sourceWorktreeId: f.sourceWorktree.id,
        sourceVersionId: f.sourceVersion.id,
        sourceResultId: f.sourceResult.id,
        sourceCommit: f.sourceCommit,
      },
      p = await service.preview(f.project.id, f.managerActor, base);
    await service.arrange(f.project.id, f.managerActor, {
      ...base,
      operationId: randomUUID(),
      sessionId: f.worker.id,
      expectedFingerprint: p.fingerprint,
      combinationTicketId: f.combinationTicket.id,
      basis: '仅单元范围冻结',
    });
    expect(() =>
      f.c.executions().register(
        f.managerActor,
        {
          operationId: randomUUID(),
          ticket: f.combinationTicket.id,
          roleId: f.developer.roleId,
          name: '冲突写入',
          cwd: f.root,
          writeScopes: [join(f.root, 'a.txt')],
        },
        'unit',
      ),
    ).toThrow('合入');
    const plan = await captureLocalGit(other, ['b.txt'], 'baseline');
    expect(() =>
      f.c.localCommits().arrange(
        f.managerActor,
        {
          operationId: randomUUID(),
          sessionId: f.worker.id,
          repository: other,
          kind: 'baseline',
          files: ['b.txt'],
          expectedFingerprint: plan.fingerprint,
          basis: '不能挤掉原合入',
          commitMessage: 'other',
          ticketIds: [],
          versionIds: [],
        },
        plan,
        { nativeSessionId: 'unit-local-committer', epoch: 'unit', boundary: 0, ranges: [] },
      ),
    ).toThrow('提交者');
    await service.close();
  } finally {
    f.close();
  }
}, 60_000);

test('提交者已有另一仓库本地事项时也不能反向接入新合入', async () => {
  const f = await worktreeMergeFixture();
  try {
    const other = join(f.root, 'other-repo');
    mkdirSync(other);
    f.git('init', '--initial-branch=main', other);
    writeFileSync(join(other, 'b.txt'), 'other local file\n');
    f.write('.git/info/exclude', '.TEAM/\n.agents/\nother-repo/\n');
    const local = await captureLocalGit(other, ['b.txt'], 'baseline');
    f.c.localCommits().arrange(
      f.managerActor,
      {
        operationId: randomUUID(),
        sessionId: f.worker.id,
        repository: other,
        kind: 'baseline',
        files: ['b.txt'],
        expectedFingerprint: local.fingerprint,
        basis: '原本地事项',
        commitMessage: 'other',
        ticketIds: [],
        versionIds: [],
      },
      local,
      { nativeSessionId: 'unit-local-committer', epoch: 'unit', boundary: 0, ranges: [] },
    );
    const service = new WorktreeMergeService(f.projects, {
        allowed: () => true,
        inspect: () => ({
          nativeSessionId: 'unit-local-committer',
          epoch: 'unit',
          boundary: 0,
          ranges: [],
          state: 'confirmed',
          note: '仅合成',
          observedAt: new Date().toISOString(),
        }),
      }),
      base = {
        targetRepository: f.root,
        sourceWorktreeId: f.sourceWorktree.id,
        sourceVersionId: f.sourceVersion.id,
        sourceResultId: f.sourceResult.id,
        sourceCommit: f.sourceCommit,
      },
      p = await service.preview(f.project.id, f.managerActor, base);
    await expect(
      service.arrange(f.project.id, f.managerActor, {
        ...base,
        operationId: randomUUID(),
        sessionId: f.worker.id,
        expectedFingerprint: p.fingerprint,
        combinationTicketId: f.combinationTicket.id,
        basis: '不能挤掉原本地事项',
      }),
    ).rejects.toThrow('提交者');
    await service.close();
  } finally {
    f.close();
  }
}, 60_000);

test('合入通知只投原提交者和原主管；普通平台通知权限不扩，旧安排提示被持有', async () => {
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
          note: '仅合成',
          observedAt: new Date().toISOString(),
        }),
      }),
      base = {
        targetRepository: f.root,
        sourceWorktreeId: f.sourceWorktree.id,
        sourceVersionId: f.sourceVersion.id,
        sourceResultId: f.sourceResult.id,
        sourceCommit: f.sourceCommit,
      },
      p = await service.preview(f.project.id, f.managerActor, base),
      value = await service.arrange(f.project.id, f.managerActor, {
        ...base,
        operationId: randomUUID(),
        sessionId: f.worker.id,
        expectedFingerprint: p.fingerprint,
        combinationTicketId: f.combinationTicket.id,
        basis: '单元原事项通知',
      }),
      messages = f.c.messages();
    expect(() =>
      messages.saveSystem({
        id: randomUUID(),
        target: f.worker.id,
        content: 'generic platform must not bypass',
      }),
    ).toThrow('主管');
    const notice = value.notices[0]!,
      saved = messages.saveMergeNotice(value.id, notice.id);
    expect(saved.message.recipient.sessionId).toBe(f.worker.id);
    expect(saved.message.sender.kind).toBe('system');
    f.git('merge', '--no-edit', '--no-overwrite-ignore', '--', f.sourceCommit);
    const proof = await verifyMergeGit(value.preview.plan),
      next = f.c.worktreeMerges().reconciled(
        f.managerActor,
        value.id,
        {
          operationId: randomUUID(),
          expectedRevision: value.revision,
          reason: '真实Git回读，合成原生停稳',
        },
        proof,
        { state: 'confirmed', note: '仅合成', observedAt: new Date().toISOString() },
      );
    const resultNotice = next.notices.find((n) => n.kind === 'result')!;
    expect(resultNotice.targetSessionId).toBe(f.manager.id);
    expect(messages.saveMergeNotice(value.id, resultNotice.id).message.recipient.sessionId).toBe(
      f.manager.id,
    );
    expect(messages.beginDelivery(notice.id).receipt.state).toBe('held');
    await service.close();
  } finally {
    f.close();
  }
}, 60_000);
