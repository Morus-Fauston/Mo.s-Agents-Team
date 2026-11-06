import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ProjectService } from '../src/services/project-service.ts';
import { CommunicationService } from '../src/services/chat-service.ts';
import { createApplication } from '../src/api/application.ts';
import { presentMessage } from '../src/services/message-presentation.ts';
import { ExplicitSkillGrants } from '../src/host/explicit-skills.ts';
import type { NativeAgent, NativeMessage } from '../src/host/native.ts';

test('持久回执丢失后按原消息核对，文件变化不重建已保存引用，已进入请求绝不重投', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-retry-'));
  const projectRoot = join(root, '项目');
  mkdirSync(projectRoot);
  const projects = new ProjectService(join(root, '状态'));
  const project = projects.create({
    root: projectRoot,
    name: '重试适配器单测',
    supervisor: { provider: 'unit', model: 'unit' },
  });
  const connection = projects.forProject(project.id);
  const reserved = connection.reserveSession({
    roleId: project.roles[0]!.id,
    name: '来源',
    purpose: '不代表真实Host证明',
    cwd: projectRoot,
  });
  connection.bindSession(reserved.id, 'unit-native');
  const history: NativeMessage[] = [];
  let steerCount = 0,
    failFlush = true;
  const agent = {
    id: 'unit-native',
    status: 'idle',
    inbox: { nextStep: [] },
    session: { deriveMessages: () => history },
    steer(message: NativeMessage) {
      steerCount++;
      history.push(message);
    },
  } as unknown as NativeAgent;
  const communication = new CommunicationService(projects, {
    open: async () => agent,
    flush: async () => {
      if (failFlush) throw new Error('单测注入：持久回执丢失');
      return true;
    },
  });
  try {
    const path = join(projectRoot, '引用.txt');
    writeFileSync(path, '保存时内容');
    const saved = await communication.send(
      project.id,
      { kind: 'user' },
      {
        id: randomUUID(),
        target: reserved.id,
        content: '原消息',
        references: [{ kind: 'file', path, startLine: 1, endLine: 1, snippet: '保存时内容' }],
      },
    );
    expect(saved.receipt.state).toBe('unknown');
    connection.messages().recordEntered(saved.message.id, 'unit-attempt');
    writeFileSync(path, '文件后来变化');
    const preview = await createApplication(projects).request(
      `http://127.0.0.1/api/projects/${project.id}/messages/${saved.message.id}/references/0`,
    );
    expect(preview.status).toBe(200);
    expect(await preview.json()).toMatchObject({ source: 'saved-snippet', content: '保存时内容' });
    failFlush = false;
    const other = connection
      .messages()
      .save(
        { kind: 'user' },
        { id: randomUUID(), target: reserved.id, content: '另存的未发送消息' },
      );
    const retried = await communication.retry(project.id, { kind: 'user' }, saved.message.id);
    expect(retried.message).toEqual(saved.message);
    expect(retried.receipt.durableAcceptedAt).not.toBeNull();
    expect(retried.receipt.nativeAttemptId).toBe('unit-attempt');
    expect(steerCount).toBe(1);
    expect(connection.messages().get(other.message.id).receipt.memoryAcceptedAt).toBeNull();
    expect(
      connection.messages().history({ kind: 'user' }, saved.message.conversationId).messages,
    ).toHaveLength(2);
  } finally {
    await communication.close();
    projects.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('MAT用户消息只有原始正文授予显式Skill，引用路径和片段不授予', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-chat-grants-'));
  const projectRoot = join(root, '项目');
  mkdirSync(projectRoot);
  const projects = new ProjectService(join(root, '状态'));
  const project = projects.create({
    root: projectRoot,
    name: '私聊许可边界',
    supervisor: { provider: 'unit', model: 'unit' },
  });
  const connection = projects.forProject(project.id);
  const reserved = connection.reserveSession({
    roleId: project.roles[0]!.id,
    name: '接纳单测',
    purpose: '只核对MAT适配器，不代替Host证明',
    cwd: projectRoot,
  });
  connection.bindSession(reserved.id, 'unit-native');
  const agent = { id: 'unit-native' } as NativeAgent;
  const communication = new CommunicationService(projects, {
    open: async () => agent,
    flush: async () => true,
  });
  try {
    const referenced = connection.messages().save(
      { kind: 'user' },
      {
        id: randomUUID(),
        target: reserved.id,
        content: '请检查所选片段',
        references: [
          {
            kind: 'file',
            path: join(projectRoot, '$path-skill.txt'),
            startLine: 1,
            endLine: 1,
            snippet: '$manual',
          },
        ],
      },
    );
    const grants = new ExplicitSkillGrants();
    const admitted = await communication.admit(project.id, reserved.id, agent, 1, [
      presentMessage(referenced),
    ]);
    grants.accept(1, admitted.grants);
    expect(grants.has('manual')).toBe(false);
    expect(grants.has('path-skill')).toBe(false);
    expect(admitted.messages[0]!.content[0]!.text).toContain('$manual');
    const explicit = connection
      .messages()
      .save({ kind: 'user' }, { id: randomUUID(), target: reserved.id, content: '请使用 $manual' });
    grants.accept(
      2,
      (await communication.admit(project.id, reserved.id, agent, 2, [presentMessage(explicit)]))
        .grants,
    );
    expect(grants.has('manual')).toBe(true);
  } finally {
    await communication.close();
    projects.close();
    rmSync(root, { recursive: true, force: true });
  }
});
