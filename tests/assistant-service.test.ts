import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectService } from '../src/services/project-service.ts';
import { AssistantService } from '../src/services/assistant-service.ts';

test('主执行创建一层辅助只准备会话，真实关联分配材料，Chat另发且重送不重建', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-assistant-'));
  mkdirSync(join(root, 'source'));
  const projects = new ProjectService(join(root, 'state'), root);
  try {
    const project = projects.create({
        root,
        name: '协作服务验证',
        supervisor: { provider: 'unit', model: 'unit' },
      }),
      c = projects.forProject(project.id),
      wb = c.workbench();
    const user = { kind: 'user' as const };
    const phase = wb.createPhase(user, {
      operationId: randomUUID(),
      name: '一期',
      goal: '协作',
      basis: '单测',
    });
    wb.openPhase(user, phase.id, { operationId: randomUUID(), reason: '单测' });
    const category = wb.createCategory(user, {
      operationId: randomUUID(),
      code: 'TEST',
      name: '测试',
    });
    const ticket = wb.createTicket(user, {
      operationId: randomUUID(),
      phaseId: phase.id,
      categoryId: category.id,
      title: '一张票',
      goal: '协作',
      included: '源码',
      excluded: '无',
      conditions: [{ condition: '实际链', verification: 'automated' }],
    });
    const role = c.registerRole({
      code: 'DEV',
      type: 'developer',
      name: '开发',
      configuration: { provider: 'unit', model: 'unit' },
    });
    const reserve = (roleId: string) => {
      const s = c.reserveSession({
        roleId,
        name: '夹具',
        purpose: '只验证边界，不冒充实际DSH',
        cwd: join(root, 'source'),
      });
      return c.bindSession(s.id, 'native-' + s.id);
    };
    const manager = reserve(project.roles[0]!.id),
      main = reserve(role.id);
    const catalog = c.executions(),
      execution = catalog.register(
        { kind: 'session', sessionId: manager.id },
        {
          operationId: randomUUID(),
          ticket: ticket.id,
          sessionId: main.id,
          name: '主执行',
          cwd: main.cwd,
          writeScopes: [main.cwd],
        },
        'unit',
      ).record;
    catalog.sessionReserved(execution.id, main.id);
    catalog.sessionPrepared(execution.id, main.id);
    catalog.starting(execution.id, 0, { provider: 'unit', model: 'unit' }, '当前票');
    catalog.goalLinked(execution.id, {
      id: 'unit-goal',
      revision: 1,
      objective: '当前票',
      phase: 'active',
      activation: 'armed',
      roundsStarted: 0,
      maxGoalRounds: 2,
    });
    catalog.goalDurable(execution.id);
    let creations = 0;
    const service = new AssistantService(projects, {
      async create(_project, input, reserved) {
        creations++;
        const s = c.reserveSession(input);
        reserved(s);
        return c.bindSession(s.id, 'native-' + s.id);
      },
      async reuse(_project, id, claim) {
        const prepared = c.session(id);
        claim(prepared);
        return prepared;
      },
    });
    const input = {
      operationId: randomUUID(),
      roleId: role.id,
      name: '核对辅助',
      purpose: '只读核对',
      writeScopes: [],
    };
    const saved = await service.create(project.id, main.id, input);
    expect(saved.state).toBe('active');
    expect(creations).toBe(1);
    expect((await service.create(project.id, main.id, input)).id).toBe(saved.id);
    expect(creations).toBe(1);
    expect(c.collaborations().scopeForSession(saved.sessionId!)?.kind).toBe('assistant');
    expect(wb.materialDomains(ticket.id).find((d) => d.referenceId === saved.id)?.kind).toBe(
      'assistant',
    );
    expect(c.messages().conversations({ kind: 'session', sessionId: saved.sessionId! })).toEqual(
      [],
    );
    await expect(
      service.create(project.id, saved.sessionId!, { ...input, operationId: randomUUID() }),
    ).rejects.toThrow('主负责人');
    const message = c.messages().save(
      { kind: 'session', sessionId: main.id },
      {
        id: randomUUID(),
        target: c.session(saved.sessionId!).addresses.readable,
        content: '请核对当前票',
      },
    );
    expect(message.message.sender.sessionId).toBe(main.id);
    expect(message.message.recipient.sessionId).toBe(saved.sessionId);
    const second = await service.create(project.id, main.id, {
      ...input,
      operationId: randomUUID(),
    });
    expect(second.sessionId).not.toBe(saved.sessionId);
    const idle = reserve(role.id);
    const reused = await service.create(project.id, main.id, {
      operationId: randomUUID(),
      sessionId: idle.id,
      name: '续用',
      purpose: '同票空闲入口',
      writeScopes: [],
    });
    expect(reused.state).toBe('active');
    expect(reused.sessionId).toBe(idle.id);
    expect(creations).toBe(2);
    await expect(
      service.create(project.id, main.id, {
        operationId: randomUUID(),
        sessionId: idle.id,
        name: '抢占',
        purpose: '拒绝',
      }),
    ).rejects.toMatchObject({ code: 'ASSISTANT_SESSION_BUSY' });
    await expect(
      service.create(project.id, manager.id, { ...input, operationId: randomUUID() }),
    ).rejects.toThrow('主负责人');
    expect(
      c
        .messages()
        .contacts({ kind: 'session', sessionId: main.id })
        .entries.find((v) => v.sessionId === saved.sessionId)?.collaboration?.parentSessionId,
    ).toBe(main.id);
    const failedService = new AssistantService(projects, {
      async create() {
        throw new Error('会话尚未登记前的明确失败');
      },
      async reuse(_project, id) {
        return c.session(id);
      },
    });
    const failed = await failedService.create(project.id, main.id, {
      ...input,
      operationId: randomUUID(),
    });
    expect(failed).toMatchObject({ state: 'error', sessionId: null });
    expect(
      c
        .collaborations()
        .unsettled(execution.id)
        .map((v) => v.id),
    ).not.toContain(failed.id);
    const nativeBusy = reserve(role.id);
    const busyService = new AssistantService(projects, {
      async create() {
        throw new Error('not used');
      },
      async reuse() {
        throw new Error('原生会话有其他Goal');
      },
    });
    const rejected = await busyService.create(project.id, main.id, {
      operationId: randomUUID(),
      sessionId: nativeBusy.id,
      name: '不会抢占',
      purpose: '应拒绝',
    });
    expect(rejected.state).toBe('error');
    expect(c.collaborations().currentForSession(nativeBusy.id)).toBeUndefined();
    await expect(
      service.create(project.id, main.id, {
        ...input,
        operationId: randomUUID(),
        writeScopes: [root],
      }),
    ).rejects.toThrow('超出');
  } finally {
    projects.close();
    rmSync(root, { recursive: true, force: true });
  }
});
