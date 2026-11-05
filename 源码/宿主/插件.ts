import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startConsole } from '../接口/启动.ts';
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
export function apply(ctx: PluginContext, config: PluginConfiguration = {}): void {
  ctx.effect(async () => {
    const state =
      config.stateDirectory ??
      join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugins', 'mat');
    const server = await startConsole({
      stateDirectory: state,
      port: config.port ?? 0,
      assetsDirectory: fileURLToPath(new URL('../界面/', import.meta.url)),
      onError: (error) => ctx.logger?.error?.(`MAT 控制台错误：${error.message}`),
    });
    ctx.logger?.info(`MAT 控制台：${server.url}`);
    return () => server.close();
  });
}
