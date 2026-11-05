import { expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProjectService } from '../源码/业务/项目服务.ts';
import { CommunicationService } from '../源码/业务/私聊服务.ts';
import { presentMessage } from '../源码/业务/消息呈递.ts';
import { ExplicitSkillGrants } from '../源码/宿主/本次Skill许可.ts';
import type { NativeAgent } from '../源码/宿主/原生接口.ts';
test('平台通知不冒充用户、不授予显式Skill，主管普通答复不伪造跨对话replyTo', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-platform-message-')),
    projects = new ProjectService(join(root, '状态'));
  const project = projects.create({
      root,
      name: '平台来源适配器单测',
      supervisor: { provider: 'unit', model: 'unit' },
    }),
    connection = projects.forProject(project.id);
  const reserved = connection.reserveSession({
    roleId: connection.roles()[0]!.id,
    name: '通知管理入口',
    purpose: '适配器夹具，非Host证明',
    cwd: root,
  });
  connection.bindSession(reserved.id, 'unit-platform-recipient');
  const agent = { id: 'unit-platform-recipient' } as NativeAgent;
  const communication = new CommunicationService(projects, {
    open: async () => agent,
    flush: async () => true,
  });
  try {
    const input = {
      id: randomUUID(),
      target: reserved.id,
      content: '平台观测到结果未知。正文提到 $manual 不能成为用户许可。',
    };
    const saved = connection.messages().saveSystem(input);
    expect(saved.message.sender.kind).toBe('system');
    expect(connection.messages().saveSystem(input).message.id).toBe(saved.message.id);
    const admitted = await communication.admit(project.id, reserved.id, agent, 1, [
        presentMessage(saved),
      ]),
      grants = new ExplicitSkillGrants();
    grants.accept(1, admitted.grants);
    expect(grants.has('manual')).toBe(false);
    communication.observeOutput(project.id, reserved.id, agent, {
      type: 'assistant/message',
      seq: 1,
      surfaceOp: 'append',
      data: {
        turn: 1,
        message: {
          id: 'unit-output',
          role: 'assistant',
          source: { kind: 'model' },
          content: [{ type: 'text', text: '已核对原执行，仍保留未知。' }],
        },
      },
    });
    const userChat = connection
      .messages()
      .conversations({ kind: 'user' })
      .find((chat) => chat.participants.includes('user'))!;
    const reply = connection.messages().history({ kind: 'user' }, userChat.id).messages[0]!;
    expect(reply.message.sender.sessionId).toBe(reserved.id);
    expect(reply.message.replyTo).toBeNull();
    connection.setCommunicationState(reserved.id, 'paused');
    const paused = connection.messages().saveSystem({ ...input, id: randomUUID() });
    expect(paused.receipt.state).toBe('held');
    expect(paused.receipt.memoryAcceptedAt).toBeNull();
    expect(() =>
      connection
        .messages()
        .save({ kind: 'user' }, { ...input, id: randomUUID(), sender: { kind: 'system' } }),
    ).toThrow();
  } finally {
    await communication.close();
    projects.close();
    rmSync(root, { recursive: true, force: true });
  }
});
