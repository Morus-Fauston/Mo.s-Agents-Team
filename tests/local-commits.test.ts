import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localCommitFixture } from './local-commit-fixture.ts';
import { captureLocalGit, verifyLocalCommit } from '../src/services/local-git.ts';
test('真实主管明确预览差异安排提交类型；普通成员不能安排或冒充回报，同操作不重复建事项', async () => {
  const f = localCommitFixture();
  try {
    const plan = await captureLocalGit(f.root, ['a.txt'], 'baseline'),
      input = {
        operationId: randomUUID(),
        sessionId: f.worker.id,
        repository: f.root,
        kind: 'baseline',
        files: ['a.txt'],
        expectedFingerprint: plan.fingerprint,
        basis: '用户明确授权隔离仓库初始基线，仅a.txt，不发布',
        commitMessage: 'isolated local baseline',
      };
    const catalog = f.c.localCommits();
    expect(() => catalog.arrange({ kind: 'user' }, input, plan)).toThrow('真实主管');
    expect(() =>
      catalog.arrange({ kind: 'session', sessionId: f.developer.id }, input, plan),
    ).toThrow('真实主管');
    const value = catalog.arrange({ kind: 'session', sessionId: f.manager.id }, input, plan);
    expect(value).toMatchObject({
      status: 'arranged',
      managerSessionId: f.manager.id,
      committerSessionId: f.worker.id,
    });
    expect(catalog.arrange({ kind: 'session', sessionId: f.manager.id }, input, plan).id).toBe(
      value.id,
    );
    expect(() =>
      catalog.arrange(
        { kind: 'session', sessionId: f.manager.id },
        { ...input, basis: '不同安排' },
        plan,
      ),
    ).toThrow('操作');
    expect(f.c.workbench().getTask(value.taskId).business).toEqual({
      kind: 'local-commit',
      id: value.id,
    });
    expect(
      catalog.get({ kind: 'session', sessionId: f.worker.id }, value.id).plan.fingerprint,
    ).toBe(plan.fingerprint);
    expect(() => catalog.get({ kind: 'session', sessionId: f.developer.id }, value.id)).toThrow(
      '关联',
    );
    const proof = await verifyLocalCommit(plan);
    expect(() =>
      catalog.report(
        { kind: 'session', sessionId: f.developer.id },
        value.id,
        {
          operationId: randomUUID(),
          expectedRevision: 1,
          state: 'committed',
          content: '自称已提交',
        },
        proof,
      ),
    ).toThrow('关联');
    expect(() =>
      catalog.report(
        { kind: 'session', sessionId: f.manager.id },
        value.id,
        {
          operationId: randomUUID(),
          expectedRevision: 1,
          state: 'committed',
          content: '主管不能冒充提交者',
        },
        proof,
      ),
    ).toThrow('原提交');
  } finally {
    f.close();
  }
}, 30_000);
test('自报提交不等于Git事实；unknown沿原记录回读，不重建commit或改原票验收', async () => {
  const f = localCommitFixture();
  try {
    const wb = f.c.workbench(),
      phase = wb.createPhase(
        { kind: 'user' },
        { operationId: randomUUID(), name: '本地提交', goal: '独立办理', basis: '单元测试' },
      ),
      category = wb.createCategory(
        { kind: 'user' },
        { operationId: randomUUID(), code: 'LOC', name: '本地' },
      ),
      ticket = wb.createTicket(
        { kind: 'user' },
        {
          operationId: randomUUID(),
          phaseId: phase.id,
          categoryId: category.id,
          title: '仍待开发的业务票',
          goal: '独立验收',
          included: '材料',
          excluded: '不以commit结票',
          conditions: [{ condition: '人工接受', verification: 'manual' }],
        },
      );
    const plan = await captureLocalGit(f.root, ['a.txt'], 'baseline'),
      catalog = f.c.localCommits(),
      manager = { kind: 'session' as const, sessionId: f.manager.id },
      worker = { kind: 'session' as const, sessionId: f.worker.id },
      input = {
        operationId: randomUUID(),
        sessionId: f.worker.id,
        repository: f.root,
        kind: 'baseline',
        files: ['a.txt'],
        expectedFingerprint: plan.fingerprint,
        basis: '用户已准本地基线，不代人工',
        commitMessage: 'authorized local baseline',
        ticketIds: [ticket.id],
      };
    const value = catalog.arrange(manager, input, plan),
      report = {
        operationId: randomUUID(),
        expectedRevision: 1,
        state: 'committed',
        content: '自报已完成，但需要软件核对',
      };
    const unknown = catalog.report(worker, value.id, report, await verifyLocalCommit(plan));
    expect(unknown.status).toBe('unknown');
    expect(unknown.lastProof.state).toBe('not-observed');
    expect(catalog.report(worker, value.id, report, await verifyLocalCommit(plan)).revision).toBe(
      unknown.revision,
    );
    const second = f.c.reserveSession({
      roleId: f.role.id,
      name: '另一提交入口',
      purpose: '不得重复接同仓安排',
      cwd: f.root,
    });
    f.c.bindSession(second.id, 'unit-local-second');
    expect(() =>
      catalog.arrange(manager, { ...input, operationId: randomUUID(), sessionId: second.id }, plan),
    ).toThrow('原安排');
    f.git('add', '--', 'a.txt');
    f.git('commit', '-m', input.commitMessage);
    const proof = await verifyLocalCommit(plan);
    expect(proof.state).toBe('verified');
    const done = catalog.reconcile(
      manager,
      value.id,
      {
        operationId: randomUUID(),
        expectedRevision: unknown.revision,
        reason: '沿原事项核对实际HEAD，不重做Git',
      },
      proof,
      {
        state: 'confirmed',
        note: '受控单元夹具无原生后台或并行工具',
        observedAt: new Date().toISOString(),
      },
    );
    expect(done.status).toBe('completed');
    expect(done.lastProof.commit).toBe(f.git('rev-parse', 'HEAD'));
    expect(wb.getTask(value.taskId).state).toBe('checked');
    expect(wb.getTicket(ticket.id).state).toBe('todo');
    expect(wb.getTicket(ticket.id).checklist[0]!.checked).toBe(false);
    expect(catalog.arrange(manager, input, plan).id).toBe(value.id);
    expect(f.git('rev-list', '--count', 'HEAD')).toBe('1');
    expect(
      catalog
        .history(manager, value.id)
        .some((e) => e.kind === 'report' && e.data.proof.state === 'not-observed'),
    ).toBe(true);
  } finally {
    f.close();
  }
}, 30_000);
