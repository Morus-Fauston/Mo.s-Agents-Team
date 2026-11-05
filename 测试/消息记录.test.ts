import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeProject, connectProject } from '../源码/业务/项目.ts';
import type { ProjectConnection } from '../源码/业务/项目.ts';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
const fixtures: { root: string; connection: ProjectConnection }[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    fixture.connection.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
function fixture(beforeConnect?: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'mat-message-'));
  initializeProject({ root, name: '消息记录', supervisor: { provider: 'p', model: 'm' } });
  beforeConnect?.(root);
  const connection = connectProject(root);
  fixtures.push({ root, connection });
  const role = connection.roles()[0]!;
  const session = connection.reserveSession({
    roleId: role.id,
    name: '主管会话',
    purpose: '存储策略单元验证',
    cwd: root,
  });
  connection.bindSession(session.id, 'unit-native-' + session.id);
  return { root, connection, session };
}
test('同一消息与投递依据事务保存，重复请求返回原记录，改变正文明确冲突', () => {
  const { connection, session } = fixture();
  const catalog = connection.messages();
  const input = {
    id: randomUUID(),
    target: session.addresses.readable,
    content: '  原样 **Markdown**\n第二行',
  };
  const saved = catalog.save({ kind: 'user' }, input);
  expect(saved.message.content).toBe(input.content);
  expect(saved.receipt.state).toBe('pending');
  expect(saved.receipt.durableAcceptedAt).toBeNull();
  expect(saved.receipt.enteredAt).toBeNull();
  const repeated = catalog.save({ kind: 'user' }, input);
  expect(repeated.message.id).toBe(saved.message.id);
  expect(repeated.message.ordinal).toBe(saved.message.ordinal);
  expect(catalog.history({ kind: 'user' }, saved.message.conversationId).messages).toHaveLength(1);
  expect(catalog.events(0)).toHaveLength(1);
  expect(() => catalog.save({ kind: 'user' }, { ...input, content: '改变正文' })).toThrow(
    '相同消息身份',
  );
  expect(catalog.history({ kind: 'user' }, saved.message.conversationId).messages).toHaveLength(1);
  connection.closeSession(session.id);
  expect(catalog.save({ kind: 'user' }, input).message.id).toBe(saved.message.id);
});

test('投递依据写入失败时消息、对话和界面事件一起回滚', () => {
  const { connection, session } = fixture((root) => {
    const db = new DatabaseSync(join(root, '.TEAM', '运行数据', 'mat.db'));
    db.exec(
      "CREATE TRIGGER fail_delivery BEFORE INSERT ON message_delivery BEGIN SELECT RAISE(ABORT,'forced delivery failure'); END;",
    );
    db.close();
  });
  const catalog = connection.messages();
  const id = randomUUID();
  expect(() =>
    catalog.save(
      { kind: 'user' },
      { id, target: session.addresses.numeric, content: '必须完整回滚' },
    ),
  ).toThrow('forced delivery failure');
  expect(catalog.conversations({ kind: 'user' })).toEqual([]);
  expect(catalog.events(0)).toEqual([]);
  expect(() => catalog.get(id)).toThrow('不存在');
});

test('普通成员只回复用户已开启私聊，非参与者不可读，用户不能插入成员间回复', () => {
  const { connection, session, root } = fixture();
  const role = connection.registerRole({
    code: 'DEV',
    name: '开发',
    type: 'developer',
    configuration: { provider: 'p', model: 'm' },
  });
  const dev = connection.reserveSession({
    roleId: role.id,
    name: '开发会话',
    purpose: '策略验证',
    cwd: root,
  });
  connection.bindSession(dev.id, 'unit-native-' + dev.id);
  const catalog = connection.messages();
  expect(() =>
    catalog.save(
      { kind: 'session', sessionId: dev.id },
      { id: randomUUID(), target: 'user', content: '未开启的用户私聊' },
    ),
  ).toThrow('用户已开启');
  const userMessage = catalog.save(
    { kind: 'user' },
    { id: randomUUID(), target: dev.addresses.readable, content: '用户主动联系' },
  );
  const answer = catalog.save(
    { kind: 'session', sessionId: dev.id },
    { id: randomUUID(), target: 'user', content: '回复用户', replyTo: userMessage.message.id },
  );
  expect(answer.receipt.state).toBe('none');
  expect(() =>
    catalog.history({ kind: 'session', sessionId: session.id }, userMessage.message.conversationId),
  ).toThrow('不属于此私聊');
  const memberMessage = catalog.save(
    { kind: 'session', sessionId: session.id },
    { id: randomUUID(), target: dev.addresses.numeric, content: '主管和开发交流' },
  );
  expect(
    catalog.history({ kind: 'user' }, memberMessage.message.conversationId).messages,
  ).toHaveLength(1);
  expect(() =>
    catalog.save(
      { kind: 'user' },
      {
        id: randomUUID(),
        target: dev.addresses.readable,
        content: '试图插入成员间对话',
        replyTo: memberMessage.message.id,
      },
    ),
  ).toThrow('回复必须属于');
});

test('同角色多会话必须用明确地址，可读与数字地址重试归同一消息', () => {
  const { connection, session, root } = fixture();
  const another = connection.reserveSession({
    roleId: session.roleId,
    name: '第二上下文',
    purpose: '寻址验证',
    cwd: root,
  });
  connection.bindSession(another.id, 'unit-native-' + another.id);
  const catalog = connection.messages();
  expect(() =>
    catalog.save({ kind: 'user' }, { id: randomUUID(), target: 'SUP', content: '不能猜目标' }),
  ).toThrow('多个会话');
  const input = { id: randomUUID(), target: another.addresses.readable, content: '明确目标' };
  const first = catalog.save({ kind: 'user' }, input);
  const repeated = catalog.save({ kind: 'user' }, { ...input, target: another.addresses.numeric });
  expect(repeated.message.id).toBe(first.message.id);
  expect(repeated.receipt.targetSessionId).toBe(another.id);
});

test('暂停只保存不投递，终止和封存拒绝新消息；旧消息身份仍可回查', () => {
  const { connection, session } = fixture();
  const catalog = connection.messages();
  connection.setCommunicationState(session.id, 'paused');
  const input = { id: randomUUID(), target: session.addresses.readable, content: '暂停期间的消息' };
  const held = catalog.save({ kind: 'user' }, input);
  expect(held.receipt.state).toBe('held');
  expect(held.receipt.memoryAcceptedAt).toBeNull();
  connection.setCommunicationState(session.id, 'terminated');
  expect(() => catalog.save({ kind: 'user' }, { ...input, id: randomUUID() })).toThrow(
    '终止或封存',
  );
  expect(catalog.save({ kind: 'user' }, input).message.id).toBe(input.id);
  connection.setCommunicationState(session.id, 'archived');
  expect(() => catalog.save({ kind: 'user' }, { ...input, id: randomUUID() })).toThrow(
    '终止或封存',
  );
});

test('内存接纳、持久接纳和进入请求分别留痕，回执失败不擦除已知事实', () => {
  const { connection, session } = fixture();
  const catalog = connection.messages();
  const saved = catalog.save(
    { kind: 'user' },
    { id: randomUUID(), target: session.addresses.readable, content: '分别核对' },
  );
  catalog.beginDelivery(saved.message.id);
  catalog.recordMemoryAccepted(saved.message.id);
  let current = catalog.get(saved.message.id);
  expect(current.receipt.memoryAcceptedAt).not.toBeNull();
  expect(current.receipt.durableAcceptedAt).toBeNull();
  expect(current.receipt.enteredAt).toBeNull();
  catalog.recordEntered(saved.message.id, 'native-attempt-1');
  catalog.recordFailure(saved.message.id, '持久回执未知');
  current = catalog.get(saved.message.id);
  expect(current.receipt.state).toBe('unknown');
  expect(current.receipt.enteredAt).not.toBeNull();
  expect(current.receipt.durableAcceptedAt).toBeNull();
  expect(current.receipt.handledRecord).toBeNull();
  catalog.recordEntered(saved.message.id, 'native-attempt-2');
  expect(catalog.get(saved.message.id).receipt.state).toBe('unknown');
  expect(catalog.get(saved.message.id).receipt.nativeAttemptId).toBe('native-attempt-1');
  catalog.recordDurableAccepted(saved.message.id);
  expect(catalog.get(saved.message.id).receipt.durableAcceptedAt).not.toBeNull();
  expect(catalog.pending(session.id)).toEqual([]);
});
