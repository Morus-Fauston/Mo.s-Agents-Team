import { test, expect } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { localCommitFixture } from './local-commit-fixture.ts';
import { captureMergeGit } from '../src/services/worktree-merge-git.ts';

test('合入安排仅由实际主管创建，绑定原提交者；原操作不因重试改变输入或另占共同Git', async () => {
  const f = localCommitFixture();
  try {
    f.write('.git/info/exclude', '.TEAM/\n.agents/\n');
    f.git('add', '--', 'a.txt', 'keep.txt');
    f.git('commit', '-m', 'shared baseline');
    const source = join(f.root, '.agents/worktrees/source');
    f.git('worktree', 'add', '-b', 'source', source, 'HEAD');
    writeFileSync(join(source, 'a.txt'), 'source reviewed fixture\n');
    f.git('-C', source, 'add', '--', 'a.txt');
    f.git('-C', source, 'commit', '-m', 'source fixture');
    const plan = await captureMergeGit(
        f.root,
        source,
        f.git('-C', source, 'rev-parse', 'HEAD'),
        join(f.root, '.TEAM/运行数据/merge-preview', randomUUID(), 'objects'),
      ),
      wb = f.c.workbench(),
      user = { kind: 'user' as const },
      manager = { kind: 'session' as const, sessionId: f.manager.id };
    const phase = wb.createPhase(user, {
        operationId: randomUUID(),
        name: '合入',
        goal: '权限与幂等',
        basis: 'catalog夹具',
      }),
      category = wb.createCategory(user, { operationId: randomUUID(), code: 'MER', name: '合入' });
    const ticket = (title: string) =>
      wb.createTicket(user, {
        operationId: randomUUID(),
        phaseId: phase.id,
        categoryId: category.id,
        title,
        goal: '受控catalog输入，不冒充正式pass',
        included: '本操作',
        excluded: '不运行模型',
        conditions: [{ condition: '核对原记录', verification: 'automated' }],
      });
    const sourceTicket = ticket('源'),
      combination = ticket('组合'),
      sourceWorktreeId = randomUUID(),
      sourceVersionId = randomUUID(),
      sourceResultId = randomUUID();
    const preview = {
      plan,
      sourceWorktreeId,
      source: {
        ticketId: sourceTicket.id,
        executionId: randomUUID(),
        versionId: sourceVersionId,
        resultId: sourceResultId,
        versionFingerprint: 'controlled-source-fixture',
        rootIndex: 0,
        receiptId: null,
        rawFingerprint: 'controlled-raw-fixture',
      },
      fingerprint: 'f'.repeat(64),
    };
    const input = {
      operationId: randomUUID(),
      targetRepository: f.root,
      sourceWorktreeId,
      sourceVersionId,
      sourceResultId,
      sourceCommit: plan.sourceCommit,
      sessionId: f.worker.id,
      expectedFingerprint: preview.fingerprint,
      combinationTicketId: combination.id,
      basis: '仅测catalog身份与幂等；source/pass为受控服务输入夹具，不是实际通过',
    };
    const native = {
        nativeSessionId: 'unit-local-committer',
        epoch: 'unit',
        boundary: 0,
        ranges: [],
      },
      catalog = f.c.worktreeMerges();
    expect(() => catalog.arrange(user, input, preview, native)).toThrow('主管');
    expect(() =>
      catalog.arrange({ kind: 'session', sessionId: f.developer.id }, input, preview, native),
    ).toThrow('主管');
    expect(() =>
      catalog.arrange(manager, input, preview, { ...native, nativeSessionId: 'foreign' }),
    ).toThrow('实际');
    expect(() =>
      catalog.arrange(manager, { ...input, expectedFingerprint: 'a'.repeat(64) }, preview, native),
    ).toThrow('指纹');
    const value = catalog.arrange(manager, input, preview, native);
    expect(value.status).toBe('arranged');
    expect(value.committerSessionId).toBe(f.worker.id);
    expect(value.preview.source.versionId).toBe(sourceVersionId);
    expect(catalog.busyRepository(plan.target.commonDir)).toBe(true);
    expect(catalog.arrange(manager, input, preview, native).id).toBe(value.id);
    expect(() => catalog.arrange(manager, { ...input, basis: 'changed' }, preview, native)).toThrow(
      '身份',
    );
    expect(() =>
      catalog.arrange(manager, { ...input, operationId: randomUUID() }, preview, native),
    ).toThrow('共同');
    expect(wb.getTicket(sourceTicket.id).state).toBe('todo');
    expect(wb.getTicket(combination.id).state).toBe('todo');
    expect(catalog.get(user, value.id).id).toBe(value.id);
  } finally {
    f.close();
  }
}, 30_000);
