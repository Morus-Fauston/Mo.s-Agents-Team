import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localCommitFixture } from './local-commit-fixture.ts';
import { inspectWorktreeSource } from '../src/services/local-git.ts';
test('工作树记录绑定真实主管与原票；原操作和未知结果沿原身份保存，不重复预留', async () => {
  const f = localCommitFixture();
  try {
    f.git('add', '--', 'a.txt');
    f.git('commit', '-m', 'local baseline');
    const wb = f.c.workbench(),
      phase = wb.createPhase(
        { kind: 'user' },
        { operationId: randomUUID(), name: '树', goal: '明确空间', basis: '单元' },
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
          title: '独立工作',
          goal: '本地基线',
          included: '指定文件',
          excluded: '其他',
          conditions: [{ condition: '自动核对', verification: 'automated' }],
        },
      ),
      catalog = f.c.worktrees(),
      manager = { kind: 'session' as const, sessionId: f.manager.id },
      source = await inspectWorktreeSource(f.root),
      input = {
        operationId: randomUUID(),
        ticketId: ticket.id,
        repository: f.root,
        name: 'unit-tree',
        from: source.commit,
        basis: '主管在本项目已批准的独立执行空间',
      };
    expect(() =>
      catalog.reserve({ kind: 'user' }, input, source, 'unit-local-manager', f.root),
    ).toThrow('主管');
    expect(() =>
      catalog.reserve(
        { kind: 'session', sessionId: f.worker.id },
        input,
        source,
        'unit-local-committer',
        f.root,
      ),
    ).toThrow('主执行');
    const v = catalog.reserve(manager, input, source, 'unit-local-manager', f.root);
    expect(v.ticketId).toBe(ticket.id);
    expect(v.retention).toBe('retain');
    expect(() => catalog.reserve(manager, input, source, 'foreign-native', f.root)).not.toThrow();
    expect(catalog.reserve(manager, input, source, 'unit-local-manager', f.root).id).toBe(v.id);
    expect(() =>
      catalog.reserve(
        manager,
        { ...input, basis: '正文变了' },
        source,
        'unit-local-manager',
        f.root,
      ),
    ).toThrow('身份');
    catalog.problem(v.id, '官方调用结果未知');
    expect(catalog.reserve(manager, input, source, 'unit-local-manager', f.root).status).toBe(
      'unknown',
    );
    expect(() =>
      catalog.reserve(
        manager,
        { ...input, operationId: randomUUID(), name: 'other-tree' },
        source,
        'unit-local-manager',
        f.root,
      ),
    ).toThrow('原共同仓库');
    expect(catalog.history(manager, v.id)).toHaveLength(2);
    expect(wb.getTicket(ticket.id).state).toBe('todo');
    const ready = catalog.ready(v.id, f.root + '/unit-tree', 'unit-tree', source.head, true);
    catalog.reserve(
      manager,
      { ...input, operationId: randomUUID(), name: 'other-tree' },
      source,
      'unit-local-manager',
      f.root,
    );
    expect(() =>
      catalog.cleanupStart(
        manager,
        ready.id,
        {
          operationId: randomUUID(),
          expectedRevision: ready.revision,
          expectedHead: source.head,
          basis: '明确清理',
        },
        'unit-local-manager',
      ),
    ).toThrow('原共同仓库');
    expect(catalog.get(manager, ready.id).cleanup).toBeNull();
  } finally {
    f.close();
  }
}, 30_000);
