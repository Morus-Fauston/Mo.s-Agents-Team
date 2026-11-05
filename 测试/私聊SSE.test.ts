import { expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeProject, connectProject } from '../源码/业务/项目.ts';
import { startConsole } from '../源码/接口/启动.ts';
test('真实HTTP按事件游标重连，带活跃SSE流关闭控制台也会释放数据库', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-sse-'));
  const project = join(root, '项目'),
    state = join(root, '插件');
  mkdirSync(project);
  mkdirSync(state);
  initializeProject({
    root: project,
    name: 'SSE网线层验证',
    supervisor: { provider: 'unit-provider', model: 'unit-model' },
  });
  const connection = connectProject(project);
  const session = connection.reserveSession({
    roleId: connection.roles()[0]!.id,
    name: '登记夹具',
    purpose: '只验证HTTP与SQLite，不作为真实Host证据',
    cwd: project,
  });
  connection.bindSession(session.id, 'unit-native');
  const saved = connection
    .messages()
    .save(
      { kind: 'user' },
      { id: randomUUID(), target: session.addresses.readable, content: '事件1' },
    );
  const projectId = connection.snapshot().id;
  connection.close();
  writeFileSync(join(state, '项目目录.json'), JSON.stringify([project]));
  const console = await startConsole({ stateDirectory: state, port: 0 });
  try {
    const response = await fetch(console.url + `/api/projects/${projectId}/events?after=0`, {
      signal: AbortSignal.timeout(3000),
    });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    let text = '';
    while (!text.includes('id: 1')) {
      const part = await reader.read();
      if (part.done) break;
      text += new TextDecoder().decode(part.value);
    }
    expect(text).toContain('message-saved');
    expect(text).toContain(saved.message.id);
    await reader.cancel();
    const resumed = await fetch(console.url + `/api/projects/${projectId}/events?after=0`, {
      headers: { 'last-event-id': '1' },
      signal: AbortSignal.timeout(3000),
    });
    const resumedReader = resumed.body!.getReader();
    const ready = await resumedReader.read();
    expect(new TextDecoder().decode(ready.value)).toContain('"cursor":1');
    await console.close();
    let done = false;
    while (!done) {
      done = (await resumedReader.read()).done;
    }
    const reopened = connectProject(project);
    reopened.close();
  } finally {
    await console.close();
    rmSync(root, { recursive: true, force: true });
  }
});
