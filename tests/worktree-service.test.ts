import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import type { NativeAgent } from '../src/host/native.ts';
import { localCommitFixture } from './local-commit-fixture.ts';
import { withinPath } from '../src/services/write-scopes.ts';
import { WorktreeService } from '../src/services/worktrees.ts';
function fixture() {
  const f = localCommitFixture();
  f.git('add', '--', 'a.txt');
  f.git('commit', '-m', 'approved source baseline');
  const base = f.git('rev-parse', 'HEAD');
  f.write('a.txt', 'source uncommitted work\n');
  f.git('add', '--', 'keep.txt');
  const wb = f.c.workbench(),
    phase = wb.createPhase(
      { kind: 'user' },
      {
        operationId: randomUUID(),
        name: '工作树服务',
        goal: '官方结果核对',
        basis: '受控原生夹具',
      },
    ),
    category = wb.createCategory(
      { kind: 'user' },
      { operationId: randomUUID(), code: 'TREE', name: '树' },
    ),
    ticket = wb.createTicket(
      { kind: 'user' },
      {
        operationId: randomUUID(),
        phaseId: phase.id,
        categoryId: category.id,
        title: '明确空间',
        goal: '绑定实际基线',
        included: '单独树',
        excluded: '不复制未提交',
        conditions: [{ condition: '准确记录', verification: 'automated' }],
      },
    );
  let cwd = f.root,
    flush = true,
    creates = 0,
    removes = 0,
    removeMode: 'remove' | 'noop' | 'unknown' = 'remove';
  const agent = { id: 'unit-local-manager' } as unknown as NativeAgent,
    host = {
      poolDirectory: '.agents/worktrees',
      peek: () => agent,
      directory: () => cwd,
      setDirectory: async (_a: NativeAgent, path: string) => {
        cwd = path;
        return path;
      },
      flush: async () => flush,
      safe: () => ({ state: 'confirmed' as const, note: '受控夹具，无原生在途' }),
      remove: async (_agent: NativeAgent, source: string, path: string, _signal: AbortSignal) => {
        if (source !== f.root || !withinPath(f.directory, path))
          throw new Error('非本夹具清理范围');
        _signal.throwIfAborted();
        removes++;
        if (removeMode !== 'noop') f.git('worktree', 'remove', '--', path);
        return { exitCode: 0, output: '', rangeGone: removeMode !== 'unknown' };
      },
      create: async (
        _a: NativeAgent,
        input: { name: string; from: string },
        _signal: AbortSignal,
        onPhase: (name: string) => void,
      ) => {
        creates++;
        onPhase('prepare');
        const path = join(f.root, '.agents', 'worktrees', input.name);
        mkdirSync(join(f.root, '.agents', 'worktrees'), { recursive: true });
        writeFileSync(join(f.root, '.agents', 'worktrees', '.gitignore'), '*\n');
        f.git('worktree', 'add', '-b', input.name, '--', path, input.from);
        onPhase('checkout');
        cwd = path;
        return { path, branch: input.name, baseCommit: input.from, repositoryRoot: f.root };
      },
    },
    service = new WorktreeService(f.projects, host);
  return {
    ...f,
    base,
    ticket,
    service,
    actor: { kind: 'session' as const, sessionId: f.manager.id },
    input: (name: string) => ({
      operationId: randomUUID(),
      ticketId: ticket.id,
      repository: f.root,
      from: base,
      name,
      basis: '用户已准独立主执行空间，仅模拟官方调用与实仓回读',
    }),
    creates: () => creates,
    removes: () => removes,
    setRemoveMode: (value: typeof removeMode) => {
      removeMode = value;
    },
    cwd: () => cwd,
    setNativeCwd: (value: string) => {
      cwd = value;
    },
    setOwner: (id: string) => {
      agent.id = id;
    },
    setFlush: (v: boolean) => {
      flush = v;
    },
    async dispose() {
      await service.close();
      f.close();
    },
  };
}
test('主管准备使用官方调用接缝并恢复原cwd；未提交及已暂存源内容不带入新树', async () => {
  const f = fixture();
  try {
    const input = f.input('prepared-tree'),
      v = await f.service.create(f.project.id, f.actor, input);
    expect(v.status).toBe('ready');
    expect(v.source.commit).toBe(f.base);
    expect(v.restore.confirmed).toBe(true);
    expect(f.cwd()).toBe(f.root);
    expect(readFileSync(join(v.path!, 'a.txt'), 'utf8')).toBe('local baseline\n');
    expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('source uncommitted work\n');
    expect(f.git('status', '--porcelain=v1')).toContain('A  keep.txt');
    expect((await f.service.create(f.project.id, f.actor, input)).id).toBe(v.id);
    expect(f.creates()).toBe(1);
  } finally {
    await f.dispose();
  }
}, 30_000);
test('创建后的目录持久确认未知先回读原Git登记，不再次官方create', async () => {
  const f = fixture();
  try {
    f.setFlush(false);
    const input = f.input('unknown-tree'),
      unknown = await f.service.create(f.project.id, f.actor, input);
    expect(unknown.status).toBe('unknown');
    expect(unknown.path).toBeTruthy();
    expect((await f.service.create(f.project.id, f.actor, input)).status).toBe('unknown');
    f.setFlush(true);
    const ready = await f.service.reconcile(f.project.id, f.actor, unknown.id, {
      operationId: randomUUID(),
      expectedRevision: unknown.revision,
      reason: '查询原登记及目录持久接纳，不重做',
    });
    expect(ready.status).toBe('ready');
    expect(f.creates()).toBe(1);
    expect(f.cwd()).toBe(f.root);
  } finally {
    await f.dispose();
  }
}, 30_000);

test('原主早期换树映射原写域且保留启动基线；新交付以新空间基线比较', async () => {
  const f = fixture();
  try {
    const c = f.c,
      wb = c.workbench();
    wb.openPhase({ kind: 'user' }, f.ticket.phaseId, {
      operationId: randomUUID(),
      reason: '本票开工',
    });
    const e = c.executions().register(
      f.actor,
      {
        operationId: randomUUID(),
        ticket: f.ticket.id,
        sessionId: f.developer.id,
        name: '原主',
        cwd: f.root,
        writeScopes: [join(f.root, 'a.txt')],
      },
      'unit',
    ).record;
    c.executions().sessionPrepared(e.id, f.developer.id);
    wb.allocateCurrentMaterial(f.developer.id);
    const old = c.versions().baseline(e.id);
    c.executions().starting(e.id, 1, { provider: 'unit', model: 'unit' }, '本票原Goal');
    c.executions().goalLinked(e.id, {
      id: 'original-worktree-goal',
      revision: 1,
      objective: '本票原Goal',
      phase: 'active',
      activation: 'armed',
      roundsStarted: 1,
      maxGoalRounds: 5,
    });
    c.executions().goalDurable(e.id);
    f.setOwner('unit-local-developer');
    const actor = { kind: 'session' as const, sessionId: f.developer.id },
      value = await f.service.create(f.project.id, actor, {
        operationId: randomUUID(),
        name: 'main-tree',
        from: f.base,
        basis: '本票原授权内独立源码现场，不复制原未提交内容',
      });
    expect(value.status).toBe('ready');
    const current = c.executions().get(e.id);
    expect(current.cwd).toBe(value.path);
    expect(current.writeScopes).toEqual([join(value.path!, 'a.txt')]);
    expect(current.goalId).toBe('original-worktree-goal');
    expect(c.versions().get(old.id).snapshot.roots[0]!.root).toBe(f.root);
    expect(c.versions().file(old.id, 0, 'a.txt').toString()).toBe('source uncommitted work\n');
    const baselines = c
      .versions()
      .list(e.id)
      .filter((v) => v.kind === 'baseline');
    expect(baselines).toHaveLength(2);
    expect(baselines[1]!.worktreeId).toBe(value.id);
    expect(baselines[1]!.snapshot.roots[0]!.root).toBe(value.path);
    writeFileSync(join(value.path!, 'a.txt'), 'main scoped change\n');
    const delivery = c.versions().delivery(actor, e.id, {
        operationId: randomUUID(),
        summary: '本票新树成果',
        scope: '仅a.txt',
        evidencePaths: [],
      }),
      diff = c.versions().diff(delivery.id, 'ticket');
    expect(diff.from).toBe(baselines[1]!.id);
    expect(diff.changes.filter((v) => v.path === 'a.txt')).toHaveLength(1);
    expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('source uncommitted work\n');
    const from = resolve(value.path!),
      to = resolve(f.directory, 'retained-checkout');
    if (!withinPath(f.directory, from) || !withinPath(f.directory, to))
      throw new Error('拒绝移动非本夹具目录');
    renameSync(from, to);
    expect(() => f.service.assertBusinessDirectory(f.project.id, f.developer.id, f.root)).toThrow(
      '不让原生ensure',
    );
    expect(c.versions().file(delivery.id, 0, 'a.txt').toString()).toBe('main scoped change\n');
  } finally {
    await f.dispose();
  }
}, 30_000);

test('只读核对期间调用会话cwd变化，不能从另一仓库继续官方创建', async () => {
  const f = fixture();
  try {
    const pending = f.service.create(f.project.id, f.actor, f.input('cwd-race'));
    f.setNativeCwd(f.directory);
    await expect(pending).rejects.toThrow(/目录|cwd|变化/);
    expect(f.creates()).toBe(0);
    expect(f.c.worktrees().list({ kind: 'user' })).toHaveLength(0);
  } finally {
    await f.dispose();
  }
}, 30_000);

test('主管明确续用记录后绑定本次实际HEAD与执行，材料仍在固定宿主根', async () => {
  const f = fixture();
  try {
    const v = await f.service.create(f.project.id, f.actor, f.input('reuse-tree')),
      cwd = f.service.prepareDispatch(f.project.id, f.actor, v.id);
    expect(cwd).toBe(v.path);
    f.c.workbench().openPhase({ kind: 'user' }, f.ticket.phaseId, {
      operationId: randomUUID(),
      reason: '明确复用树开工',
    });
    const e = f.c.executions().register(
      f.actor,
      {
        operationId: randomUUID(),
        ticket: f.ticket.id,
        sessionId: f.developer.id,
        name: '明确续用',
        cwd,
        worktreeId: v.id,
        writeScopes: [],
      },
      'unit',
    ).record;
    await f.service.admitExecution(f.project.id, e.id, cwd);
    expect(f.c.worktrees().get(f.actor, v.id).associations).toEqual([
      expect.objectContaining({ executionId: e.id, ticketId: f.ticket.id, head: f.base }),
    ]);
    const material = f.c.workbench().allocateCurrentMaterial(f.developer.id);
    expect(withinPath(join(f.root, '.TEAM'), material.path)).toBe(true);
    expect(withinPath(v.path!, material.path)).toBe(false);
    expect(f.c.executions().get(e.id).goalId).toBeNull();
  } finally {
    await f.dispose();
  }
}, 30_000);

test('默认保留；主管明确清理且核足后只移除检出，不删分支、材料或业务记录', async () => {
  const f = fixture();
  try {
    const v = await f.service.create(f.project.id, f.actor, f.input('cleanable-tree'));
    expect(f.removes()).toBe(0);
    const args = {
      operationId: randomUUID(),
      expectedRevision: v.revision,
      expectedHead: f.base,
      basis: '模拟用户明确仅清理已合入且无在途的测试检出，保留分支和全部记录',
    };
    const removed = await f.service.cleanup(f.project.id, f.actor, v.id, args);
    expect(removed.status).toBe('removed');
    expect(f.removes()).toBe(1);
    expect((await f.service.cleanup(f.project.id, f.actor, v.id, args)).status).toBe('removed');
    expect(f.removes()).toBe(1);
    expect(f.c.workbench().getTicket(f.ticket.id).state).toBe('todo');
    expect(f.git('show-ref', '--verify', '--hash', 'refs/heads/cleanable-tree')).toBe(f.base);
    expect(f.git('diff', '--cached', '--name-only')).toBe('keep.txt');
    expect(f.c.worktrees().get(f.actor, v.id).cleanup?.actor.sessionId).toBe(f.manager.id);
    expect(() => f.service.prepareDispatch(f.project.id, f.actor, v.id)).toThrow('未核定');
  } finally {
    await f.dispose();
  }
}, 30_000);

test('命令零退出但现场未移除只记保留；原清理未知没有范围退出证据不能办结或再remove', async () => {
  const f = fixture();
  try {
    const first = await f.service.create(f.project.id, f.actor, f.input('noop-tree'));
    f.setRemoveMode('noop');
    const args = {
      operationId: randomUUID(),
      expectedRevision: first.revision,
      expectedHead: f.base,
      basis: '模拟用户明确清理本夹具',
    };
    const retained = await f.service.cleanup(f.project.id, f.actor, first.id, args, 'noop-call');
    expect(retained.status).toBe('retained');
    expect(retained.cleanup?.state).toBe('failed');
    expect(f.removes()).toBe(1);
    const second = await f.service.create(f.project.id, f.actor, f.input('unknown-remove-tree'));
    f.setRemoveMode('unknown');
    const input = {
      operationId: randomUUID(),
      expectedRevision: second.revision,
      expectedHead: f.base,
      basis: '模拟用户清理，范围退出由独立受管事实核定',
    };
    let unknown = await f.service.cleanup(
      f.project.id,
      f.actor,
      second.id,
      input,
      'unknown-remove-call',
    );
    expect(unknown.status).toBe('unknown');
    expect(unknown.cleanup?.proof?.removed).toBe(true);
    expect(
      (await f.service.cleanup(f.project.id, f.actor, second.id, input, 'retry-call')).status,
    ).toBe('unknown');
    expect(f.removes()).toBe(2);
    unknown = await f.service.reconcile(f.project.id, f.actor, unknown.id, {
      operationId: randomUUID(),
      expectedRevision: unknown.revision,
      reason: '原Git结果已存在但缺少退出证明',
    });
    expect(unknown.status).toBe('unknown');
    f.c.worktrees().saveManagedRange(f.manager.id, {
      id: 'controlled-cleanup-range',
      callId: 'unknown-remove-call',
      nativeOwner: 'unit-local-manager',
      state: 'gone',
      at: new Date().toISOString(),
      note: '单元夹具独立注入的受管退出，不冒充真实SDK',
    });
    const done = await f.service.reconcile(f.project.id, f.actor, unknown.id, {
      operationId: randomUUID(),
      expectedRevision: unknown.revision,
      reason: '原结果和原范围均已核足',
    });
    expect(done.status).toBe('removed');
    expect(f.removes()).toBe(2);
  } finally {
    await f.dispose();
  }
}, 30_000);
