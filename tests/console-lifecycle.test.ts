import { afterEach, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { ProjectService } from '../src/services/project-service.ts';
import { initializeProject, connectProject } from '../src/services/project.ts';
import { startConsole } from '../src/api/server.ts';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'mat-console-life-'));
  roots.push(base);
  const root = join(base, '项目');
  mkdirSync(root);
  initializeProject({
    root,
    name: '资源回收',
    supervisor: { provider: 'deepseek-official', model: 'deepseek-flash' },
  });
  const state = join(base, '插件');
  const service = new ProjectService(state);
  service.attach(root);
  service.close();
  return { root, state };
}
function assertReleased(root: string) {
  const connection = connectProject(root);
  connection.close();
}
test('同步启动参数失败不留下项目独占连接', async () => {
  const f = fixture();
  await expect(startConsole({ stateDirectory: f.state, port: -1 })).rejects.toThrow();
  assertReleased(f.root);
});
test('异步端口占用失败释放已恢复的项目连接', async () => {
  const f = fixture();
  const occupied = createServer();
  await new Promise<void>((resolve) => occupied.listen(0, '127.0.0.1', resolve));
  try {
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('未取得端口');
    await expect(
      startConsole({ stateDirectory: f.state, port: address.port }),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    assertReleased(f.root);
  } finally {
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
  }
});
test('连接文件写入失败同时关闭HTTP与数据库，正常关闭可重复调用', async () => {
  const f = fixture();
  mkdirSync(join(f.state, '连接.json'));
  await expect(startConsole({ stateDirectory: f.state, port: 0 })).rejects.toThrow();
  assertReleased(f.root);
  rmSync(join(f.state, '连接.json'), { recursive: true });
  const server = await startConsole({ stateDirectory: f.state, port: 0 });
  expect((await fetch(server.url + '/api/projects')).status).toBe(200);
  await server.close();
  await server.close();
  assertReleased(f.root);
});
