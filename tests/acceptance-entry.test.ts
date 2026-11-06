import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { resultServiceFixture } from './review-result-runtime-fixture.ts';
import { AcceptanceService } from '../src/services/acceptance-service.ts';
import { createApplication } from '../src/api/application.ts';
import { installAcceptanceTools } from '../src/host/acceptance-tools.ts';
import type { CommunicationService } from '../src/services/chat-service.ts';
import type { DispatchService } from '../src/services/dispatch-service.ts';
import type { SessionRuntime } from '../src/host/session-runtime.ts';
import type { NativeAgent, NativeContext, NativeModules } from '../src/host/native.ts';
test('同源用户入口只办理本人指定验收，不能传主管身份或调用主管结票；保存通知不代办理', async () => {
  const f = resultServiceFixture('manual');
  let service: AcceptanceService | undefined;
  try {
    const r = f.service.submit(
      f.connection.snapshot().id,
      f.reviewer.id,
      f.auditAgent,
      f.input('pass'),
    );
    await expect
      .poll(() => f.connection.reviewResults().get(r.id).progress.state)
      .toBe('confirmed');
    const project = f.connection.snapshot().id,
      catalog = f.connection.acceptance(),
      assigned = catalog.assign(
        { kind: 'session', sessionId: f.manager.id },
        {
          operationId: randomUUID(),
          ticketId: f.ticket.id,
          versionId: r.versionId,
          resultId: r.id,
          conditionId: f.ticket.checklist[0]!.id,
          owner: { kind: 'user' },
          reason: '仅单元模拟用户事项',
        },
      );
    service = new AcceptanceService(
      f.projects,
      {
        sendAcceptanceNotice: async (_p: string, id: string) =>
          f.connection.messages().saveAcceptanceNotice(id),
      } as unknown as CommunicationService,
      {} as DispatchService,
    );
    const app = createApplication(f.projects, undefined, { acceptance: service } as SessionRuntime),
      path = `http://localhost/api/projects/${project}`,
      body = {
        operationId: randomUUID(),
        assignmentId: assigned.id,
        decision: 'accept',
        basis: '单元合成用户结果',
        checkCondition: true,
      };
    const post = (suffix: string, input: unknown) =>
      app.request(path + suffix, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(input),
      });
    expect(
      (
        await post('/acceptance-results', {
          ...body,
          actor: { kind: 'session', sessionId: f.manager.id },
        })
      ).status,
    ).toBe(400);
    expect((await post('/acceptance-results', body)).status).toBe(201);
    expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe('awaiting-acceptance');
    expect((await post('/tickets/' + f.ticket.id + '/complete', body)).status).toBe(404);
    const view = await (await app.request(path + '/tickets/' + f.ticket.id + '/acceptance')).json();
    expect(view.assignments[0].result.author.kind).toBe('user');
    await expect.poll(() => catalog.notices().filter((n) => n.state === 'saved').length).toBe(1);
    const notice = catalog.notices()[0]!;
    expect(f.connection.messages().get(notice.id).message.sender.kind).toBe('system');
    expect(() => f.connection.messages().saveAcceptanceNotice(randomUUID())).toThrow();
  } finally {
    await service?.close();
    await f.dispose();
  }
});
test('主管原生办理参数投影与实际工具身份派生，普通成员没有结票、安排或补做写口', () => {
  const f = resultServiceFixture();
  try {
    type Tool = {
      name: string;
      parameters: Record<string, unknown>;
      execute(raw: unknown, exec: { agent: NativeAgent; callId: string }): string;
    };
    const registered = new Map<string, Tool>(),
      calls: unknown[] = [],
      owner = {
        id: 'unit-manager',
        session: {
          snapshotEvents: () => [
            {
              seq: 7,
              type: 'tool/call',
              data: { name: 'mat_ticket_accept', callId: 'actual-call' },
            },
          ],
        },
      } as unknown as NativeAgent;
    const ctx = {
        tools: { register: (tool: Tool) => registered.set(tool.name, tool) },
      } as unknown as NativeContext,
      modules = { defineTool: (tool: unknown) => tool } as NativeModules;
    const service = {
      act: (project: string, actor: unknown, kind: string, input: unknown) => {
        calls.push({ project, actor, kind, input });
        return {};
      },
    } as unknown as AcceptanceService;
    const install = (role: 'supervisor' | 'developer') =>
      installAcceptanceTools(
        ctx,
        owner,
        modules,
        role,
        () => ({ connection: f.connection, sessionId: f.manager.id }),
        service,
      );
    install('supervisor');
    const tool = registered.get('mat_ticket_accept')!;
    expect(tool.parameters).toHaveProperty('versionId');
    expect(tool.parameters).not.toHaveProperty('operationId');
    expect(registered.get('mat_delivery_supplement')!.parameters).toHaveProperty('dispatch');
    const input = {
        ticketId: f.ticket.id,
        versionId: f.review.versionId,
        resultId: randomUUID(),
        basis: '仅单元验证身份',
      },
      exec = { agent: owner, callId: 'actual-call' };
    tool.execute(input, exec);
    tool.execute(input, exec);
    expect(calls[0]).toEqual(calls[1]);
    expect(() => tool.execute(input, { ...exec, agent: {} as NativeAgent })).toThrow('实际');
    expect(() => tool.execute({ ...input, operationId: randomUUID() }, exec)).toThrow();
    registered.clear();
    install('developer');
    expect(registered.has('mat_ticket_accept')).toBe(false);
    expect(registered.has('mat_acceptance_assign')).toBe(false);
    expect(registered.has('mat_delivery_supplement')).toBe(false);
    expect(registered.has('mat_review_escalate')).toBe(true);
  } finally {
    f.close();
  }
});
