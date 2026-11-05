import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startConsole } from '../接口/启动.ts';
import { HostSessionRuntime } from './会话装配.ts';
import type { NativeContext } from './原生接口.ts';
interface PluginContext {
  effect(
    callback: () => void | (() => void | Promise<void>) | Promise<() => void | Promise<void>>,
  ): unknown;
  logger?: { info(message: string): void; error?(message: string): void };
}
interface PluginConfiguration {
  stateDirectory?: string;
  port?: number;
}
export const inject = [
  'agents',
  'tools',
  'loader',
  'workingDirectory',
  'agentPresets',
  'sessions',
  'goals',
];
export function apply(ctx: PluginContext & NativeContext, config: PluginConfiguration = {}): void {
  ctx.effect(() => {
    const state =
      config.stateDirectory ??
      join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugins', 'mat');
    // Preset activation waits for the Loader tree to settle; do not make that
    // same tree wait for this asynchronous console boot.
    const opening = startConsole({
      stateDirectory: state,
      port: config.port ?? 0,
      assetsDirectory: fileURLToPath(new URL('../界面/', import.meta.url)),
      onError: (error) => ctx.logger?.error?.(`MAT 控制台错误：${error.message}`),
      ...(ctx.agentPresets
        ? {
            createRuntime: (service: import('../业务/项目服务.ts').ProjectService) =>
              HostSessionRuntime.start(ctx, service),
          }
        : {}),
    });
    void opening.then(
      (server) => ctx.logger?.info(`MAT 控制台：${server.url}`),
      (error) =>
        ctx.logger?.error?.(
          `MAT 启动失败：${error instanceof Error ? error.message : String(error)}`,
        ),
    );
    return async () => {
      const server = await opening.catch(() => undefined);
      await server?.close();
    };
  });
}
