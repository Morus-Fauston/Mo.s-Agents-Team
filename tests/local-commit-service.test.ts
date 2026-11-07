import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { localCommitFixture } from './local-commit-fixture.ts';
import { LocalCommitService } from '../src/services/local-commits.ts';
import { captureLocalGit, verifyLocalCommit } from '../src/services/local-git.ts';
function fixture() {
  const f = localCommitFixture();
  let quiet = true,
    allowed = true;
  const manager = { kind: 'session' as const, sessionId: f.manager.id },
    worker = { kind: 'session' as const, sessionId: f.worker.id };
  const service = new LocalCommitService(f.projects, {
    inspect: (_p: string, s: string) => ({
      nativeSessionId: f.c.session(s).nativeSessionId!,
      epoch: 'unit',
      boundary: -1,
      ranges: [],
      state: quiet ? ('confirmed' as const) : ('unknown' as const),
      note: '受控原生夹具',
      observedAt: new Date().toISOString(),
    }),
    allowed: () => allowed,
    notify: async (p, id, notice) =>
      f.projects.forProject(p).messages().saveLocalCommitNotice(id, notice),
  });
  return {
    ...f,
    managerActor: manager,
    workerActor: worker,
    service,
    setQuiet: (v: boolean) => {
      quiet = v;
    },
    setAllowed: (v: boolean) => {
      allowed = v;
    },
    async arrange() {
      const plan = await service.preview(f.project.id, manager, {
        repository: f.root,
        files: ['a.txt'],
        kind: 'baseline',
      });
      return service.arrange(f.project.id, manager, {
        operationId: randomUUID(),
        sessionId: f.worker.id,
        repository: f.root,
        files: ['a.txt'],
        kind: 'baseline',
        expectedFingerprint: plan.fingerprint,
        basis: '获准的隔离基线',
        commitMessage: 'isolated baseline',
      });
    },
    async dispose() {
      await service.close();
      f.close();
    },
  };
}
test('真实Git事实与原生在途分别核定；重复原操作只查询原结果', async () => {
  const f = fixture();
  try {
    const value = await f.arrange();
    expect(value.native?.nativeSessionId).toBe('unit-local-committer');
    expect(value.notices[0]?.receipt?.targetSessionId).toBe(f.worker.id);
    expect(value.notices[0]?.error).toBeNull();
    f.setQuiet(false);
    const blocked = await f.service.inspect(
      f.project.id,
      f.workerActor,
      value.id,
      { operationId: randomUUID(), expectedRevision: value.revision },
      'current-call',
    );
    expect(blocked.status).toBe('blocked');
    f.setQuiet(true);
    const ready = await f.service.inspect(
      f.project.id,
      f.workerActor,
      value.id,
      { operationId: randomUUID(), expectedRevision: blocked.revision },
      'next-call',
    );
    expect(ready.status).toBe('ready');
    f.git('add', '--', 'a.txt');
    f.git('commit', '-m', value.commitMessage);
    f.setQuiet(false);
    const raw = {
      operationId: randomUUID(),
      expectedRevision: ready.revision,
      state: 'blocked',
      content: '自报blocked，但提交对象已存在且仍有在途观察',
    };
    const unknown = await f.service.report(
      f.project.id,
      f.workerActor,
      value.id,
      raw,
      'report-call',
    );
    expect(unknown.lastProof?.state).toBe('verified');
    expect(unknown.status).toBe('unknown');
    f.setQuiet(true);
    await expect(
      f.service.inspect(
        f.project.id,
        f.workerActor,
        value.id,
        { operationId: randomUUID(), expectedRevision: unknown.revision },
        'another-inspect',
      ),
    ).rejects.toThrow('先reconcile');
    expect(
      (await f.service.report(f.project.id, f.workerActor, value.id, raw, 'retry-call')).revision,
    ).toBe(unknown.revision);
    const done = await f.service.reconcile(f.project.id, f.managerActor, value.id, {
      operationId: randomUUID(),
      expectedRevision: unknown.revision,
      reason: '原记录回读',
    });
    expect(done.status).toBe('completed');
    expect(f.git('rev-list', '--count', 'HEAD')).toBe('1');
    expect(f.c.messages().currentDecisionNotice(value.notices[0]!.id)).toBe(false);
  } finally {
    await f.dispose();
  }
}, 30_000);
test('安排核验异步返回后控制已变化，不创建事项或通知', async () => {
  const f = fixture();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>((r) => {
      release = r;
    }),
    entered = new Promise<void>((r) => {
      started = r;
    });
  const plan = await captureLocalGit(f.root, ['a.txt'], 'baseline');
  const racing = new LocalCommitService(
    f.projects,
    {
      inspect: () => ({
        nativeSessionId: 'unit-local-committer',
        epoch: 'unit',
        boundary: -1,
        ranges: [],
        state: 'confirmed',
        note: '原生夹具',
        observedAt: new Date().toISOString(),
      }),
      allowed: () => true,
      notify: async (p, id, notice) =>
        f.projects.forProject(p).messages().saveLocalCommitNotice(id, notice),
    },
    {
      capture: async () => {
        started();
        await gate;
        return plan;
      },
      verify: verifyLocalCommit,
      ready: async () => {},
    },
  );
  try {
    const pending = racing.arrange(f.project.id, f.managerActor, {
      operationId: randomUUID(),
      sessionId: f.worker.id,
      repository: f.root,
      files: ['a.txt'],
      kind: 'baseline',
      expectedFingerprint: plan.fingerprint,
      basis: '控制竞争',
      commitMessage: 'isolated baseline',
    });
    await entered;
    f.c
      .controls()
      .stopProject({ kind: 'user' }, { operationId: randomUUID(), reason: '核验中停止' }, 'unit');
    release();
    await expect(pending).rejects.toThrow(/启动|停止/);
    expect(f.c.localCommits().list({ kind: 'user' })).toHaveLength(0);
  } finally {
    release();
    await racing.close();
    await f.dispose();
  }
}, 30_000);

test('已变更的未提交安排可核对后撤销；Git存在或在途未定不能以撤销释放范围', async () => {
  const f = fixture();
  try {
    const value = await f.arrange();
    f.write('a.txt', 'new unapproved content\n');
    f.setQuiet(false);
    await expect(
      f.service.cancel(f.project.id, f.managerActor, value.id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        reason: '差异需要重新明确',
      }),
    ).rejects.toThrow(/在途|核定|安静/);
    f.setQuiet(true);
    const cancelled = await f.service.cancel(f.project.id, f.managerActor, value.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      reason: '差异需要重新明确',
    });
    expect(cancelled.status).toBe('cancelled');
    expect(f.c.workbench().getTask(value.taskId).state).not.toBe('checked');
    const replacement = await f.arrange();
    expect(replacement.id).not.toBe(value.id);
    f.git('add', '--', 'a.txt');
    f.git('commit', '-m', replacement.commitMessage);
    await expect(
      f.service.cancel(f.project.id, f.managerActor, replacement.id, {
        operationId: randomUUID(),
        expectedRevision: replacement.revision,
        reason: '不能代替核定',
      }),
    ).rejects.toThrow(/Git|对象/);
    expect(f.git('rev-list', '--count', 'HEAD')).toBe('1');
  } finally {
    await f.dispose();
  }
}, 30_000);
