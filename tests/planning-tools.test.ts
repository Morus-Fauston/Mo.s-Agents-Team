import { test, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ProjectService } from '../src/services/project-service.ts';
import { createApplication } from '../src/api/application.ts';
import { installWorkbenchTools } from '../src/host/workbench-tools.ts';
import type { NativeAgent, NativeContext, NativeModules } from '../src/host/native.ts';

test('主管保存规划，经用户确认一次后正式拆票；未确认规划和普通来源不能扩权', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-plan-'));
  const service = new ProjectService(join(root, 'state'), root);
  try {
    const project = service.create({
      root,
      name: '规划',
      supervisor: { provider: 'p', model: 'm' },
    });
    const connection = service.forProject(project.id),
      wb = connection.workbench();
    const session = connection.reserveSession({
      roleId: project.roles[0]!.id,
      name: '主管',
      purpose: '规划',
      cwd: root,
    });
    connection.bindSession(session.id, 'native-plan');
    const actor = { kind: 'session' as const, sessionId: session.id };
    const phase = wb.createPhase(actor, {
      operationId: randomUUID(),
      name: '首个里程碑',
      goal: '离线工具',
      basis: '目标讨论',
    });
    const category = wb.createCategory(actor, {
      operationId: randomUUID(),
      code: 'ENG',
      name: '开发',
    });
    const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>();
    let sequence = 0;
    let events: unknown[] = [];
    const agent = {
      id: 'native-plan',
      session: { snapshotEvents: () => events },
    } as unknown as NativeAgent;
    installWorkbenchTools(
      {
        tools: { register: (tool: { name: string; execute: never }) => tools.set(tool.name, tool) },
      } as unknown as NativeContext,
      agent,
      { defineTool: (value: unknown) => value } as NativeModules,
      'supervisor',
      () => ({ connection, sessionId: session.id }),
    );
    const invoke = async (name: string, input: unknown, seq = ++sequence) => {
      const callId = 'call-' + seq;
      events = [{ seq, type: 'tool/call', data: { name, callId } }];
      return JSON.parse(
        await tools
          .get(name)!
          .execute(input, { agent, callId, signal: new AbortController().signal }),
      );
    };
    const planned = await invoke('mat_plan', {
      plan: {
        phaseId: phase.id,
        goal: '离线工具',
        included: '整数加法',
        excluded: '联网',
        content: '先拆一个可验收切片',
        basis: '用户目标讨论',
      },
    });
    const ticket = {
      phaseId: phase.id,
      categoryId: category.id,
      planId: planned.id,
      title: '整数加法',
      goal: '两个整数相加',
      included: '整数输入与结果',
      excluded: '联网',
      conditions: [{ condition: '2+3=5', verification: 'automated' }],
    };
    await expect(invoke('mat_create_ticket', ticket)).rejects.toThrow('确认');
    expect(() =>
      wb.confirmPlan(actor, planned.id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        reason: '自报用户同意',
      }),
    ).toThrow('用户入口');
    await expect(
      invoke('mat_create_ticket', { ...ticket, actor: { kind: 'user' } }),
    ).rejects.toThrow();
    const app = createApplication(service);
    const response = await app.request(`/api/projects/${project.id}/plans/${planned.id}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operationId: randomUUID(),
        expectedRevision: 1,
        reason: '确认此目标范围并由主管拆票',
      }),
    });
    expect(response.status).toBe(200);
    const otherPhase = wb.createPhase(actor, {
      operationId: randomUUID(),
      name: '后续期',
      goal: '后续',
      basis: '尚未确认',
    });
    await expect(
      invoke('mat_create_ticket', { ...ticket, phaseId: otherPhase.id }),
    ).rejects.toThrow('期次');
    const created = await invoke('mat_create_ticket', ticket);
    expect(created.code).toBe('P001-ENG-001');
    const retrySequence = sequence;
    expect(await invoke('mat_create_ticket', ticket, retrySequence)).toEqual(created);
    expect(wb.getTicket(created.ticketId)).toMatchObject({
      state: 'todo',
      planId: planned.id,
      author: { sessionId: session.id },
    });
    expect(wb.getPhase(phase.id).state).toBe('unopened');
    expect(wb.listTickets()).toHaveLength(1);
    const plans = await (await app.request(`/api/projects/${project.id}/plans`)).json();
    expect(plans[0]).toMatchObject({
      id: planned.id,
      content: '先拆一个可验收切片',
      confirmation: { author: { kind: 'user' } },
    });
    events = [];
    await expect(
      tools
        .get('mat_create_ticket')!
        .execute(ticket, { agent, callId: 'invented', signal: new AbortController().signal }),
    ).rejects.toThrow('真实工具');
    await expect(
      tools
        .get('mat_create_ticket')!
        .execute(ticket, { agent: {}, callId: 'invented', signal: new AbortController().signal }),
    ).rejects.toThrow('实际调用');
  } finally {
    service.close();
    rmSync(root, { recursive: true, force: true });
  }
});
