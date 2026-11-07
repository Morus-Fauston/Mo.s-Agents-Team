import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startConsole } from '../api/server.ts';
import { HostSessionRuntime } from './session-runtime.ts';
import type { NativeContext } from './native.ts';
interface PluginContext {
  effect(
    callback: () => void | (() => void | Promise<void>) | Promise<() => void | Promise<void>>,
  ): unknown;
  logger?: { info(message: string): void; error?(message: string): void };
}
interface PluginConfiguration {
  projectRoot?: string;
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
  'jobs',
  'subprocess',
];
export function apply(ctx: PluginContext & NativeContext, config: PluginConfiguration = {}): void {
  if (!config.projectRoot) throw new Error('MAT 必须显式配置 projectRoot 为宿主项目绝对目录');
  const projectRoot = config.projectRoot;
  ctx.effect(() => {
    const state =
      config.stateDirectory ??
      join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'plugins', 'mat');
    // Preset activation waits for the Loader tree to settle; do not make that
    // same tree wait for this asynchronous console boot.
    const opening = startConsole({
      projectRoot,
      stateDirectory: state,
      port: config.port ?? 0,
      assetsDirectory: fileURLToPath(new URL('../web/', import.meta.url)),
      onError: (error) => ctx.logger?.error?.(`MAT 控制台错误：${error.message}`),
      ...(ctx.agentPresets
        ? {
            createRuntime: (service: import('../services/project-service.ts').ProjectService) =>
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
