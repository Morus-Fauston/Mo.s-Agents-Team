import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectService } from '../源码/业务/项目服务.ts';
import { ProjectControlService } from '../源码/业务/项目控制.ts';
import type { ExecutionControlService } from '../源码/业务/执行控制.ts';
import type { CommunicationService } from '../源码/业务/私聊服务.ts';
import type { NativeAgent, NativeContext } from '../源码/宿主/原生接口.ts';
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mat-project-control-')),
    root = join(directory, '项目');
  mkdirSync(root);
  const projects = new ProjectService(join(directory, '存储')),
    project = projects.create({
      root,
      name: '项目控制单测',
      supervisor: { provider: 'unit', model: 'unit' },
    }),
    connection = projects.forProject(project.id),
    calls = { created: 0, opened: 0, woken: 0 };
  let agent: NativeAgent | undefined;
  const control = new ProjectControlService(
    projects,
    {
      request() {
        throw new Error('此夹具没有正式执行');
      },
    } as unknown as ExecutionControlService,
    {
      async sendSystem() {
        calls.woken++;
      },
    } as unknown as CommunicationService,
    {
      native: { jobs: { list: () => [] } } as unknown as NativeContext,
      peek: () => agent,
      async openControlled() {
        calls.opened++;
        return agent!;
      },
      async createManager(_project, reserved) {
        calls.created++;
        const session = connection.reserveSession({
          roleId: connection.roles()[0]!.id,
          name: '单测主管',
          purpose: '无真实模型',
          cwd: root,
        });
        reserved(session);
        connection.bindSession(session.id, 'unit-manager');
        agent = { id: 'unit-manager', status: 'idle' } as NativeAgent;
        return connection.session(session.id);
      },
    },
    'unit-epoch',
  );
  return {
    root,
    project,
    connection,
    control,
    calls,
    async close() {
      await control.close();
      projects.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test('查询不启动；明确启动同次重试只创建和唤醒一个主管', async () => {
  const f = fixture();
  try {
    expect(f.control.query(f.project.id).desiredStarted).toBe(false);
    expect(() => f.connection.controls().requireDispatch()).toThrow('未启动');
    expect(f.calls.created).toBe(0);
    f.connection.setSkillSourceRoot(f.root);
    const input = { operationId: randomUUID(), reason: '单测明确启动' };
    f.control.start(f.project.id, input);
    f.control.start(f.project.id, input);
    await expect.poll(() => f.connection.controls().project().state).toBe('running');
    expect(f.calls).toEqual({ created: 1, opened: 0, woken: 1 });
    f.control.start(f.project.id, { operationId: randomUUID(), reason: '已经启动不重复唤醒' });
    await Promise.resolve();
    expect(f.calls.woken).toBe(1);
    expect(f.calls.created).toBe(1);
  } finally {
    await f.close();
  }
});
test('启动缺件不盲建会话；关闭式查询不修改已启动意图，明确停止才关闭门禁', async () => {
  const f = fixture();
  try {
    expect(() =>
      f.control.start(f.project.id, { operationId: randomUUID(), reason: '缺件' }),
    ).toThrow('来源');
    expect(f.connection.snapshot().started).toBe(false);
    f.connection.setSkillSourceRoot(f.root);
    f.control.start(f.project.id, { operationId: randomUUID(), reason: '启动' });
    await expect.poll(() => f.connection.controls().project().state).toBe('running');
    for (let i = 0; i < 5; i++) f.control.query(f.project.id);
    expect(f.connection.snapshot().started).toBe(true);
    const result = f.control.stop(f.project.id, { operationId: randomUUID(), reason: '明确停止' });
    expect(result.desiredStarted).toBe(false);
    expect(result.runtime.state).toBe('stopped');
    expect(f.calls.created).toBe(1);
    expect(() => f.connection.controls().requireDispatch()).toThrow('项目');
  } finally {
    await f.close();
  }
});

test('旧停止操作重试不能覆盖较新的明确启动', async () => {
  const f = fixture();
  try {
    f.connection.setSkillSourceRoot(f.root);
    f.control.start(f.project.id, { operationId: randomUUID(), reason: '先启动' });
    await expect.poll(() => f.connection.controls().project().state).toBe('running');
    const stop = { operationId: randomUUID(), reason: '原停止' };
    f.control.stop(f.project.id, stop);
    f.control.start(f.project.id, { operationId: randomUUID(), reason: '较新的明确启动' });
    await expect.poll(() => f.connection.controls().project().state).toBe('running');
    f.control.stop(f.project.id, stop);
    expect(f.connection.snapshot().started).toBe(true);
    expect(f.connection.controls().project().state).toBe('running');
    expect(
      f.connection.session(f.connection.controls().project().managerSessionId!).communicationState,
    ).toBe('active');
  } finally {
    await f.close();
  }
});
