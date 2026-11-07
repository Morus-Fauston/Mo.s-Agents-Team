import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync, readFileSync } from 'node:fs';
import { inspectWorktreeSource } from '../src/services/local-git.ts';
import { worktreeMergeFixture } from './worktree-merge-fixture.ts';
import { WorktreeMergeService } from '../src/services/worktree-merges.ts';
import { finishMergeExecution } from './merge-execution-fixture.ts';

test('实际冲突交接仅授权明确修正票、开发角色及范围，普通或伪造关联不能绕过占用', async () => {
  const initial = await worktreeMergeFixture();
  let f = initial;
  try {
    const target = join(initial.root, '.agents/worktrees/target'),
      originalHead = initial.git('rev-parse', 'HEAD'),
      originalIndex = readFileSync(join(initial.root, '.git/index'));
    const targetTree = initial.c.worktrees().reserve(
      initial.managerActor,
      {
        operationId: randomUUID(),
        ticketId: initial.combinationTicket.id,
        repository: initial.root,
        name: 'target',
        basis: '已知目标独立工作树启动检查',
      },
      await inspectWorktreeSource(initial.root),
      'unit-local-manager',
      initial.root,
      target,
    );
    initial.git('worktree', 'add', '-b', 'target', target, originalHead);
    initial.c.worktrees().ready(targetTree.id, target, 'target', originalHead, true);
    f = {
      ...initial,
      root: target,
      git: (...args: string[]) => initial.git('-C', target, ...args),
      write: (path: string, value: string) => writeFileSync(join(target, path), value),
    };
    f.write('a.txt', 'divergent target\n');
    f.git('add', '--', 'a.txt');
    f.git('commit', '-m', 'target');
    const service = new WorktreeMergeService(f.projects, {
      allowed: () => true,
      inspect: () => ({
        nativeSessionId: 'unit-local-committer',
        epoch: 'unit',
        boundary: 0,
        ranges: [],
        state: 'confirmed',
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
      basis: '实际E Git冲突夹具',
    });
    expect(() =>
      f.git('merge', '--no-edit', '--no-overwrite-ignore', '--', f.sourceCommit),
    ).toThrow();
    const conflict = await service.reconcile(f.project.id, f.managerActor, arranged.id, {
      operationId: randomUUID(),
      expectedRevision: arranged.revision,
      reason: '固定实际冲突现场',
    });
    expect(conflict.status).toBe('conflict');
    expect(conflict.conflictSnapshot?.roots[0]?.indexState?.mergeHeads).toEqual([f.sourceCommit]);
    const ticket = f.c.workbench().createTicket(
      { kind: 'user' },
      {
        operationId: randomUUID(),
        phaseId: f.sourceTicket.phaseId,
        categoryId: f.sourceTicket.categoryId,
        title: '明确修正',
        goal: '解决a冲突',
        included: 'a',
        excluded: '其他文件',
        conditions: [{ condition: '修正', verification: 'automated' }],
      },
    );
    const prepared = await service.prepareRepair(f.project.id, f.managerActor, arranged.id, {
      operationId: randomUUID(),
      expectedRevision: conflict.revision,
      ticketId: ticket.id,
      writeScopes: [join(f.root, 'a.txt')],
      basis: '只交业务修正',
    });
    expect(prepared.status).toBe('repairing');
    const dispatch = {
      operationId: randomUUID(),
      ticket: ticket.id,
      roleId: f.developer.roleId,
      name: '修正',
      cwd: f.root,
      writeScopes: [join(f.root, 'a.txt')],
    };
    expect(() => f.c.executions().register(f.managerActor, dispatch, 'unit')).toThrow(/合入/);
    expect(() =>
      f.c.executions().register(f.managerActor, { ...dispatch, mergeId: randomUUID() }, 'unit'),
    ).toThrow();
    expect(() =>
      f.c
        .executions()
        .register(
          f.managerActor,
          { ...dispatch, mergeId: arranged.id, writeScopes: [f.root] },
          'unit',
        ),
    ).toThrow(/范围/);
    const e = f.c
      .executions()
      .register(f.managerActor, { ...dispatch, mergeId: arranged.id }, 'unit').record;
    expect(e.mergeId).toBe(arranged.id);
    expect(f.c.worktreeMerges().get(f.managerActor, arranged.id).repair?.executionId).toBe(e.id);
    expect(() => f.c.executions().resolveWorkingDirectory(e.id, f.root)).not.toThrow();
    expect(await service.admitExecution(f.project.id, e.id, f.root)).toBe(true);
    expect(f.c.executions().get(e.id).worktreeId).toBe(targetTree.id);
    f.write('a.txt', 'reviewed business resolution\n');
    const reviewed = finishMergeExecution(f, e);
    expect(() =>
      service.confirmStartupBaseline(f.project.id, e.id, f.c.versions().list(e.id)[0]!.id),
    ).not.toThrow();
    let v = f.c.worktreeMerges().get(f.managerActor, arranged.id);
    v = await service.confirmRepair(f.project.id, f.managerActor, v.id, {
      operationId: randomUUID(),
      expectedRevision: v.revision,
      versionId: reviewed.version.id,
      resultId: reviewed.result.id,
      basis: '修正新固定版本和指定pass',
    });
    const worker = { kind: 'session' as const, sessionId: f.worker.id };
    v = await service.inspect(f.project.id, worker, v.id, {
      operationId: randomUUID(),
      expectedRevision: v.revision,
    });
    expect(v.lastInspection?.mode).toBe('continue-stage');
    expect(v.lastInspection?.ready).toBe(true);
    f.git('add', '-A', '--', ...v.repair!.paths);
    v = await service.inspect(f.project.id, worker, v.id, {
      operationId: randomUUID(),
      expectedRevision: v.revision,
    });
    expect(v.lastInspection?.mode).toBe('continue-commit');
    expect(v.repair?.expectedTree).toBeTruthy();
    expect(f.c.versions().check(reviewed.version.id).matches).toBeNull();
    f.git('commit', '--no-edit');
    v = await service.report(f.project.id, worker, v.id, {
      operationId: randomUUID(),
      expectedRevision: v.revision,
      state: 'merged',
      content: '仅合入结果，不代组合',
    });
    expect(v.status).toBe('awaiting-verification');
    await expect(
      service.confirmCombination(f.project.id, f.managerActor, v.id, {
        operationId: randomUUID(),
        expectedRevision: v.revision,
        versionId: f.sourceVersion.id,
        resultId: f.sourceResult.id,
        basis: '旧源pass不能用于组合',
      }),
    ).rejects.toThrow();
    const combo = f.c.executions().register(
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
    expect(await service.admitExecution(f.project.id, combo.id, f.root)).toBe(true);
    const combination = finishMergeExecution(f, combo);
    v = await service.confirmCombination(f.project.id, f.managerActor, v.id, {
      operationId: randomUUID(),
      expectedRevision: v.revision,
      versionId: combination.version.id,
      resultId: combination.result.id,
      basis: '新组合固定版本与新指定意见',
    });
    expect(v.status).toBe('completed');
    expect(v.combination?.executionId).toBe(combo.id);
    expect(f.c.worktreeMerges().busyRepository(v.preview.plan.target.commonDir)).toBe(false);
    expect(f.c.workbench().getTicket(f.combinationTicket.id).state).toBe('review-passed');
    expect(
      f.c
        .worktrees()
        .get(f.managerActor, targetTree.id)
        .associations.map((a) => a.executionId),
    ).toEqual([e.id, combo.id]);
    expect(initial.git('rev-parse', 'HEAD')).toBe(originalHead);
    expect(readFileSync(join(initial.root, '.git/index'))).toEqual(originalIndex);
    await service.close();
  } finally {
    f.close();
  }
}, 180000);
