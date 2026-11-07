import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { completionFixture } from './completion-fixture.ts';
import { AssistantService } from '../src/services/assistant-service.ts';
import { AssistantControlService } from '../src/services/assistant-controls.ts';
import { CommunicationService } from '../src/services/chat-service.ts';
import type {
  NativeAgent,
  NativeContext,
  NativeJobView,
  NativeMessage,
} from '../src/host/native.ts';
const quiet = {
  agentIdle: true,
  inFlightTools: false,
  filesStable: true,
  fileFingerprint: 'unit',
  processesComplete: true,
  jobObservations: [],
  note: '原生边界替身，不代表外部进程现场',
};
test('软停止只投递并保留真实挂起来源；未知停稳补核原记录，不cancel或kill', async () => {
  const f = completionFixture(),
    agents = new Map<string, NativeAgent>();
  let controller: AssistantControlService | undefined,
    communication: CommunicationService | undefined;
  try {
    const c = f.connection,
      project = c.snapshot().id;
    let cancels = 0,
      kills = 0,
      steers = 0,
      stable = false;
    const creator = new AssistantService(f.projects, {
      async create(_p, input, reserved) {
        const s = c.reserveSession(input);
        reserved(s);
        const bound = c.bindSession(s.id, 'unit-' + s.id);
        const inbox: NativeMessage[] = [];
        agents.set(s.id, {
          id: bound.nativeSessionId!,
          status: 'idle',
          inbox: { nextStep: inbox },
          session: { snapshotEvents: () => [], deriveMessages: () => inbox },
          cancel() {
            cancels++;
          },
          steer(m: NativeMessage) {
            steers++;
            inbox.push(m);
          },
        } as unknown as NativeAgent);
        return bound;
      },
      async reuse(_p, id, claim) {
        const s = c.session(id);
        claim(s);
        return s;
      },
    });
    const a = await creator.create(project, f.session.id, {
      operationId: randomUUID(),
      roleId: f.role.id,
      name: '软停止辅助',
      purpose: '只收尾',
      writeScopes: [],
    });
    communication = new CommunicationService(f.projects, {
      peek: (_p, id) => agents.get(id),
      open: async (_p, id) => agents.get(id)!,
      flush: async () => true,
    });
    controller = new AssistantControlService(
      f.projects,
      communication,
      {
        native: {
          goals: { get: () => undefined },
          sessions: { flush: async () => true },
          jobs: {
            list: () => [],
            kill() {
              kills++;
            },
          },
        } as unknown as NativeContext,
        peek: (_p, id) => agents.get(id),
        inspect: async () => ({ ...quiet, filesStable: stable }),
        freshContext: async () => ({ cwd: a.cwd }),
        changed: () => {},
      },
      'unit',
    );
    const stop = controller.request(
      project,
      { kind: 'user' },
      {
        operationId: randomUUID(),
        collaborationId: a.id,
        action: 'soft-stop',
        reason: '保存当前小块后暂停',
        expectedRevision: 0,
      },
    );
    await expect.poll(() => c.assistantControls().get(stop.id).status).toBe('delivered');
    expect(steers).toBe(1);
    expect(cancels).toBe(0);
    expect(kills).toBe(0);
    expect(c.collaborations().scopeForSession(a.sessionId!)?.shutdownOnly).toBe(true);
    const actor = { kind: 'session' as const, sessionId: a.sessionId! };
    c.workbench().appendLog(actor, f.ticket.id, {
      operationId: randomUUID(),
      title: '已保存恢复位置',
      content: '必要收尾允许',
    });
    expect(() =>
      c
        .collaborationResults()
        .report(a.sessionId!, { operationId: randomUUID(), action: 'complete' }),
    ).toThrow('实际辅助');
    await controller.handoff(
      project,
      a.sessionId!,
      agents.get(a.sessionId!)!,
      stop.id,
      '手上小块已保存，无其他后台，恢复位置明确',
    );
    await expect.poll(() => c.assistantControls().get(stop.id).status).toBe('checking');
    expect(c.session(a.sessionId!).communicationState).toBe('paused');
    stable = true;
    controller.retry(project, { kind: 'user' }, stop.id, {
      operationId: randomUUID(),
      expectedRevision: stop.revision,
      reason: '补核同一范围',
    });
    await expect.poll(() => c.assistantControls().get(stop.id).status).toBe('stopped');
    expect(c.assistantControls().list(a.id)).toHaveLength(1);
    expect(cancels).toBe(0);
    expect(kills).toBe(0);
  } finally {
    await controller?.close();
    await communication?.close();
    f.close();
  }
});

test('主硬停止逐辅助取消，仅kill实际owner登记作业，两个目标核清后才释放', async () => {
  const f = completionFixture(),
    agents = new Map<string, NativeAgent>(),
    jobs = new Map<string, NativeJobView>();
  let controller: AssistantControlService | undefined,
    communication: CommunicationService | undefined;
  try {
    const c = f.connection,
      project = c.snapshot().id,
      killed: string[] = [],
      cancelled: string[] = [];
    const creator = new AssistantService(f.projects, {
      async create(_p, input, reserved) {
        const s = c.reserveSession(input);
        reserved(s);
        const bound = c.bindSession(s.id, 'unit-' + s.id),
          jobId = 'job-' + s.id,
          startedAt = Date.now();
        jobs.set(jobId, {
          id: jobId,
          owner: bound.nativeSessionId!,
          kind: 'pwsh',
          label: '受控边界夹具',
          status: 'running',
          startedAt,
        });
        const fake = {
          id: bound.nativeSessionId!,
          status: 'running',
          session: {
            snapshotEvents: () => [
              {
                type: 'job/registered',
                seq: 10,
                data: { owner: bound.nativeSessionId, jobId, startedAt },
              },
            ],
          },
          cancel() {
            cancelled.push(s.id);
            fake.status = 'idle';
          },
        };
        agents.set(s.id, fake as unknown as NativeAgent);
        return bound;
      },
      async reuse(_p, id, claim) {
        const s = c.session(id);
        claim(s);
        return s;
      },
    });
    const create = () =>
      creator.create(project, f.session.id, {
        operationId: randomUUID(),
        roleId: f.role.id,
        name: '有外部作业的辅助',
        purpose: '逐目标核停',
        writeScopes: [],
      });
    const a = await create(),
      b = await create();
    jobs.set('foreign', {
      id: 'foreign',
      owner: '其他会话',
      kind: 'pwsh',
      label: '不能影响',
      status: 'running',
      startedAt: Date.now(),
    });
    communication = new CommunicationService(f.projects, {
      open: async () => {
        throw new Error('硬停止不发工作消息');
      },
      flush: async () => true,
    });
    controller = new AssistantControlService(
      f.projects,
      communication,
      {
        native: {
          goals: { get: () => undefined },
          jobs: {
            get: (id: string) => jobs.get(id),
            kill: (id: string) => {
              jobs.get(id)!.status = 'killed';
              killed.push(id);
            },
            list: () => [...jobs.values()],
          },
        } as unknown as NativeContext,
        peek: (_p, id) => agents.get(id),
        freshContext: async () => ({}),
        changed: () => {},
        inspect: async (_p, assistant) => ({
          ...quiet,
          jobObservations: [...jobs.values()]
            .filter((j) => j.owner === assistant.nativeSessionId)
            .map((j) => ({ jobId: j.id, nativeStatus: j.status, externalStatus: 'gone' as const })),
        }),
      },
      'unit',
    );
    const root = c.controls().request(
      { kind: 'user' },
      {
        operationId: randomUUID(),
        executionId: f.execution.id,
        action: 'hard-stop',
        reason: '停止原主辅',
        expectedRevision: 0,
      },
      'unit',
    );
    c.controls().receipt(root.id, 'goal', { state: 'confirmed', note: '夹具主Goal已暂停' });
    c.controls().receipt(root.id, 'cancel', { state: 'confirmed', note: '夹具主会话已idle' });
    c.controls().observeStopped(root.id, quiet);
    controller.propagate(project, root);
    await expect
      .poll(() =>
        root.assistantTargetIds.every((id) => c.assistantControls().get(id).status === 'stopped'),
      )
      .toBe(true);
    expect(cancelled.sort()).toEqual([a.sessionId!, b.sessionId!].sort());
    expect(killed.sort()).toEqual(['job-' + a.sessionId, 'job-' + b.sessionId].sort());
    expect(jobs.get('foreign')?.status).toBe('running');
    expect(c.executions().get(f.execution.id).writeOccupancy).toBe('released');
  } finally {
    await controller?.close();
    await communication?.close();
    f.close();
  }
});

test.each(['missing', 'unexpected'] as const)(
  'Goal为%s时保留未知，仍取消已确认原辅助及其登记作业，不触碰其他Goal',
  async (mode) => {
    const f = completionFixture();
    let controller: AssistantControlService | undefined,
      communication: CommunicationService | undefined;
    try {
      const c = f.connection;
      let cancelled = 0,
        killed = 0;
      const creator = new AssistantService(f.projects, {
        async create(_p, input, reserved) {
          const s = c.reserveSession(input);
          reserved(s);
          return c.bindSession(s.id, 'unit-' + s.id);
        },
        async reuse(_p, id, claim) {
          const s = c.session(id);
          claim(s);
          return s;
        },
      });
      const a = await creator.create(c.snapshot().id, f.session.id, {
        operationId: randomUUID(),
        roleId: f.role.id,
        name: 'Goal无法核清的原辅助',
        purpose: '只控制确定归属的目标',
        writeScopes: [],
      });
      const startedAt = Date.now(),
        owner = a.nativeSessionId!,
        job = { id: 'owned', owner, kind: 'pwsh', label: '登记作业', startedAt, status: 'running' };
      const agent = {
        id: owner,
        status: 'idle',
        cancel() {
          cancelled++;
        },
        session: {
          snapshotEvents: () => [
            { type: 'job/registered', seq: 10, data: { jobId: job.id, owner, startedAt } },
          ],
        },
      } as unknown as NativeAgent;
      const foreignGoal = { id: 'unrelated-goal' };
      communication = new CommunicationService(f.projects, {
        open: async () => agent,
        flush: async () => true,
      });
      controller = new AssistantControlService(
        f.projects,
        communication,
        {
          native: {
            ...(mode === 'unexpected'
              ? {
                  goals: {
                    get: () => foreignGoal,
                    clear() {
                      throw new Error('不能clear其他Goal');
                    },
                    disarm() {
                      throw new Error('不能disarm其他Goal');
                    },
                  },
                }
              : {}),
            jobs: {
              get: () => job,
              kill() {
                killed++;
                job.status = 'killed';
              },
              list: () => [job],
            },
          } as unknown as NativeContext,
          peek: () => agent,
          inspect: async () => quiet,
          freshContext: async () => ({}),
          changed: () => {},
        },
        'unit',
      );
      const stop = controller.request(
        c.snapshot().id,
        { kind: 'user' },
        {
          operationId: randomUUID(),
          collaborationId: a.id,
          action: 'hard-stop',
          reason: '只执行可确认归属的硬停止',
          expectedRevision: 0,
        },
      );
      await expect.poll(() => c.assistantControls().get(stop.id).status).toBe('unknown');
      expect(cancelled).toBe(1);
      expect(killed).toBe(1);
      expect(c.assistantControls().get(stop.id).goal?.state).toBe('unknown');
      expect(foreignGoal.id).toBe('unrelated-goal');
    } finally {
      await controller?.close();
      await communication?.close();
      f.close();
    }
  },
);
