import { serve } from '@hono/node-server';
import { writeFileSync, renameSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, isAbsolute } from 'node:path';
import { ProjectService } from '../业务/项目服务.ts';
import { createApplication } from './应用.ts';
import type { SessionRuntime } from '../宿主/会话装配.ts';
export interface ConsoleConfiguration {
  stateDirectory: string;
  port: number;
  assetsDirectory?: string;
  onError?: (error: Error) => void;
  createRuntime?: (service: ProjectService) => Promise<SessionRuntime>;
}
export interface ConsoleHandle {
  url: string;
  close(): Promise<void>;
}
async function closeHTTP(server: ReturnType<typeof serve>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const wasListening = server.listening;
    server.close((error) => {
      if (error && wasListening) reject(error);
      else resolve();
    });
  });
}
export async function startConsole(config: ConsoleConfiguration): Promise<ConsoleHandle> {
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535)
    throw new RangeError('控制台端口必须在0到65535之间');
  if (!isAbsolute(config.stateDirectory)) throw new Error('插件存储必须是绝对目录');
  const service = new ProjectService(config.stateDirectory);
  let server: ReturnType<typeof serve> | undefined;
  let runtime: SessionRuntime | undefined;
  try {
    runtime = await config.createRuntime?.(service);
    const app = createApplication(service, config.assetsDirectory, runtime);
    server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: config.port });
    const activeServer = server;
    await new Promise<void>((resolve, reject) => {
      activeServer.once('error', reject);
      activeServer.once('listening', () => {
        activeServer.removeListener('error', reject);
        resolve();
      });
    });
    activeServer.on('error', (error) => config.onError?.(error));
    const address = activeServer.address();
    if (!address || typeof address === 'string') throw new Error('未取得控制台监听地址');
    const url = `http://127.0.0.1:${address.port}`;
    const connection = join(config.stateDirectory, '连接.json');
    const temporary = `${connection}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify({ url, pid: process.pid }, null, 2), { flag: 'wx' });
    renameSync(temporary, connection);
    let closing: Promise<void> | undefined;
    return {
      url,
      close() {
        closing ??= closeHTTP(activeServer).finally(async () => {
          try {
            await runtime?.close();
          } finally {
            service.close();
          }
        });
        return closing;
      },
    };
  } catch (error) {
    try {
      if (server) await closeHTTP(server);
    } finally {
      try {
        await runtime?.close();
      } finally {
        service.close();
      }
    }
    throw error;
  }
}
