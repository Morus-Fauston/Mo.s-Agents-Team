import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { completionFixture } from './completion-fixture.ts';
import { AssistantService } from '../src/services/assistant-service.ts';
import { CommunicationService } from '../src/services/chat-service.ts';
import type { NativeAgent, NativeMessage } from '../src/host/native.ts';
import { AssistantLogNotices } from '../src/host/assistant-log-notices.ts';

test('辅助Log真实归属，Chat指定项替换撤回且旧消息重送不恢复授权', async () => {
  const f = completionFixture();
  let communication: CommunicationService | undefined;
  try {
    const c = f.connection,
      wb = c.workbench(),
      project = c.snapshot().id;
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
    const a = await creator.create(project, f.session.id, {
      operationId: randomUUID(),
      roleId: f.role.id,
      name: '验证辅助',
      purpose: '写Log并按指定项核对',
      writeScopes: [],
    });
    const actor = { kind: 'session' as const, sessionId: a.sessionId! },
      parent = { kind: 'session' as const, sessionId: f.session.id };
    const entry = {
      title: '独立验证',
      content: '仅记录实测',
      type: 'verification',
      importance: 'normal',
      references: [],
    };
    const log = wb.appendLog(actor, f.ticket.id, { operationId: randomUUID(), ...entry });
    expect(log.author.sessionId).toBe(a.sessionId);
    expect(log.collaborationId).toBe(a.id);
    const update = () => ({
      operationId: randomUUID(),
      logId: log.id,
      updates: [{ id: 'C001', expectedRevision: 1, checked: true, result: '实测成立' }],
    });
    expect(() => wb.updateChecklist(actor, f.ticket.id, update())).toThrow('最新系统授权');
    const inbox: NativeMessage[] = [];
    const helper = {
      id: a.nativeSessionId!,
      status: 'idle',
      inbox: { nextStep: inbox },
      session: { deriveMessages: () => [] },
      steer(m: NativeMessage) {
        inbox.push(m);
      },
    } as unknown as NativeAgent;
    communication = new CommunicationService(f.projects, {
      open: async () => helper,
      flush: async () => true,
    });
    const grant = {
      id: randomUUID(),
      target: a.sessionId!,
      content: '允许核对C001',
      allowedChecklistIds: ['C001'],
    };
    await communication.send(project, parent, grant);
    expect(wb.updateChecklist(actor, f.ticket.id, update()).checklist[0]?.author.sessionId).toBe(
      a.sessionId,
    );
    wb.addCondition({ kind: 'user' }, f.ticket.id, {
      operationId: randomUUID(),
      condition: '另一个可验证项',
      verification: 'automated',
      reason: '测试指定项替换',
    });
    wb.addCondition({ kind: 'user' }, f.ticket.id, {
      operationId: randomUUID(),
      condition: '用户实际体验',
      verification: 'manual',
      reason: '测试不能代填人工',
    });
    await communication.send(project, parent, {
      id: randomUUID(),
      target: a.sessionId!,
      content: '只允许第二项',
      allowedChecklistIds: ['C002'],
    });
    expect(() => wb.updateChecklist(actor, f.ticket.id, update())).toThrow('最新系统授权');
    await expect(
      communication.send(project, parent, {
        id: randomUUID(),
        target: a.sessionId!,
        content: '无效范围',
        allowedChecklistIds: ['C001', 'C999'],
      }),
    ).rejects.toThrow('授权项');
    expect(c.collaborations().scopeForSession(a.sessionId!)?.checklistIds).toEqual(['C002']);
    await expect(
      communication.send(project, parent, {
        id: randomUUID(),
        target: a.sessionId!,
        content: '保存失败须回滚授权',
        replyTo: randomUUID(),
        allowedChecklistIds: ['C001'],
      }),
    ).rejects.toThrow();
    expect(c.collaborations().scopeForSession(a.sessionId!)?.checklistIds).toEqual(['C002']);
    wb.updateChecklist(actor, f.ticket.id, {
      operationId: randomUUID(),
      newLog: { ...entry, title: '同次依据' },
      updates: [{ id: 'C002', expectedRevision: 1, checked: true, result: '同次Log有据' }],
    });
    const linked = wb.getTicket(f.ticket.id).checklist[1]!;
    expect(wb.getLog(f.ticket.id, linked.logId!).collaborationId).toBe(a.id);
    await expect(
      communication.send(project, parent, {
        id: randomUUID(),
        target: a.sessionId!,
        content: '人工项不能授予',
        allowedChecklistIds: ['C003'],
      }),
    ).rejects.toThrow('人工');
    await communication.send(project, parent, {
      id: randomUUID(),
      target: a.sessionId!,
      content: '恢复指定自动项',
      allowedChecklistIds: ['C001'],
    });
    await communication.send(project, parent, {
      id: randomUUID(),
      target: a.sessionId!,
      content: '普通补充',
    });
    expect(c.collaborations().scopeForSession(a.sessionId!)?.checklistIds).toEqual(['C001']);
    await communication.send(project, parent, {
      id: randomUUID(),
      target: a.sessionId!,
      content: '撤回结果更新权',
      allowedChecklistIds: [],
    });
    await communication.send(project, parent, grant);
    expect(() => wb.updateChecklist(actor, f.ticket.id, update())).toThrow('最新系统授权');
    expect(wb.getTicket(f.ticket.id).checklist[0]?.checked).toBe(true);
    expect(wb.getLog(f.ticket.id, log.id).content).toBe('仅记录实测');
    wb.updateCondition({ kind: 'user' }, f.ticket.id, 'C001', {
      operationId: randomUUID(),
      expectedRevision: 1,
      condition: '条件已更新',
      verification: 'automated',
      reason: '不沿用旧条件结果',
    });
    expect(() => wb.updateChecklist(actor, f.ticket.id, update())).toThrow('条件版本');

    await expect(
      communication.send(
        project,
        { kind: 'user' },
        {
          id: randomUUID(),
          target: a.sessionId!,
          content: '伪造主负责人字段',
          allowedChecklistIds: ['C001'],
        },
      ),
    ).rejects.toThrow();
  } finally {
    await communication?.close();
    f.close();
  }
});

test('多个辅助Log仅形成未读来源索引，请求接纳才消耗；元数据及纠正不覆盖旧文', async () => {
  const f = completionFixture();
  try {
    const c = f.connection,
      wb = c.workbench();
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
      roleId: f.reviewer.id,
      name: '写Log辅助',
      purpose: '测试合并提示',
      writeScopes: [],
    });
    const actor = { kind: 'session' as const, sessionId: a.sessionId! },
      parent = { kind: 'session' as const, sessionId: f.session.id };
    const append = (title: string, corrects?: string) =>
      wb.appendLog(actor, f.ticket.id, {
        operationId: randomUUID(),
        title,
        content: '旧正文保留',
        type: 'verification',
        importance: 'normal',
        ...(corrects ? { corrects } : {}),
      });
    const l1 = append('第一次核对'),
      l2 = append('追加纠正', l1.id);
    const main = wb.appendLog(parent, f.ticket.id, {
      operationId: randomUUID(),
      title: '主负责人记录',
      content: '不能由辅助整理',
    });
    expect(() =>
      wb.updateLog(actor, f.ticket.id, main.id, {
        operationId: randomUUID(),
        reason: '越权整理',
        archived: true,
      }),
    ).toThrow('自己的Log');
    wb.updateLog(actor, f.ticket.id, l1.id, {
      operationId: randomUUID(),
      reason: '修正分类',
      type: 'discovery',
      archived: true,
    });
    expect(wb.getLog(f.ticket.id, l1.id).content).toBe('旧正文保留');
    expect(wb.getLog(f.ticket.id, l2.id).corrects).toBe(l1.id);
    const pending = wb.pendingAssistantLogs(f.session.id);
    expect(pending.map((n) => n.logId)).toEqual([l1.id, l2.id]);
    expect(pending.every((n) => n.author.sessionId === a.sessionId && !('content' in n))).toBe(
      true,
    );
    const notices = new AssistantLogNotices(),
      history: NativeMessage[] = [];
    const native = {
      id: c.session(f.session.id).nativeSessionId!,
      session: { deriveMessages: () => history },
      steer() {
        throw new Error('轻提示不唤醒');
      },
      inject() {
        throw new Error('只在既有请求边界附带');
      },
    } as unknown as NativeAgent;
    c.setCommunicationState(f.session.id, 'paused');
    expect(notices.prepare(c, f.session.id, native)).toBeUndefined();
    c.setCommunicationState(f.session.id, 'active');
    c.executions().waitForCollaborations(f.execution.id);
    expect(notices.prepare(c, f.session.id, native)).toBeUndefined();
    c.executions().returnFromCollaborationWait(f.execution.id);
    const message = notices.prepare(c, f.session.id, native)!;
    expect(message.content[0]?.text).toContain('第一次核对');
    expect(message.content[0]?.text).not.toContain('旧正文保留');
    expect(wb.pendingAssistantLogs(f.session.id)).toHaveLength(2);
    expect(() => wb.acceptAssistantLogNotices(f.session.id, pending, 'no-request')).toThrow(
      '实际请求',
    );
    const request = {
      ...c.requests(f.session.id)[0]!,
      id: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    c.saveRequest(request);
    notices.entered(c, f.session.id, native, request.id);
    expect(wb.pendingAssistantLogs(f.session.id)).toHaveLength(2);
    history.push(message);
    notices.entered(c, f.session.id, native, request.id);
    expect(wb.pendingAssistantLogs(f.session.id)).toEqual([]);
    wb.acceptAssistantLogNotices(f.session.id, pending, request.id);
    const l3 = append('后来新记录');
    expect(wb.pendingAssistantLogs(f.session.id).map((n) => n.logId)).toEqual([l3.id]);
  } finally {
    f.close();
  }
});
