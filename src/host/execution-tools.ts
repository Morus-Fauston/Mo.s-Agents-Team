import { z } from 'zod';
import { dispatchBodySchema } from '../contracts/execution.ts';
import type { DispatchService } from '../services/dispatch-service.ts';
import type { ProjectConnection } from '../services/project.ts';
import { ProjectError } from '../services/errors.ts';
import { messageIdentity } from '../services/message-presentation.ts';
import type { WorkflowType } from '../contracts/roles.ts';
import type { NativeAgent, NativeContext, NativeModules } from './native.ts';
import { nativeToolParameters } from './tool-parameters.ts';
import { controlBodySchema } from '../contracts/controls.ts';
import type { ExecutionControlService } from '../services/execution-controls.ts';
export function installExecutionTools(
  ctx: NativeContext,
  owner: NativeAgent,
  modules: NativeModules,
  role: WorkflowType,
  resolve: (agent: NativeAgent) => { connection: ProjectConnection; sessionId: string },
  service: DispatchService,
  controls?: ExecutionControlService,
): void {
  type Exec = { agent: NativeAgent; callId: string };
  const register = <S extends z.ZodType>(
    name: string,
    description: string,
    schema: S,
    run: (input: z.output<S>, exec: Exec) => unknown,
  ) =>
    ctx.tools.register(
      modules.defineTool({
        name,
        description,
        parameters: nativeToolParameters(schema),
        output: {
          schema: { type: 'string' },
          render: (_args: unknown, result: string) => [{ type: 'text', text: result }],
        },
        execute: (raw: unknown, exec: Exec) => {
          if (exec.agent !== owner)
            throw new ProjectError('TOOL_CALLER_MISMATCH', '执行工具不属于真实调用会话');
          resolve(exec.agent);
          return JSON.stringify(run(schema.parse(raw), exec));
        },
      }),
    );
  register(
    'mat_execution',
    '只读查询当前项目的正式执行、启动阶段、实际步骤、请求配置、Goal和写入占用。不会打开会话、调用模型或恢复Goal。有nextOffset时继续读同一JSON文档。',
    z
      .object({
        executionId: z.uuid().optional(),
        offset: z.number().int().nonnegative().default(0),
      })
      .strict(),
    (input) => {
      const binding = resolve(owner),
        document = Array.from(
          JSON.stringify(service.query(binding.connection.snapshot().id, input.executionId)),
        ),
        end = Math.min(document.length, input.offset + 2000);
      return {
        content: document.slice(input.offset, end).join(''),
        offset: input.offset,
        nextOffset: end < document.length ? end : null,
        totalCharacters: document.length,
      };
    },
  );
  if (role === 'supervisor')
    register(
      'mat_dispatch',
      '仅主管可正式派工一张已开启阶段内的待办票据。选择一个新开角色或一个明确已有会话。返回登记不代表启动通过；用mat_execution核对至少三个实际Agent步骤。不要重复调用来重试未知结果。',
      dispatchBodySchema,
      (input, exec) => {
        const binding = resolve(owner),
          event = owner.session
            .snapshotEvents()
            .findLast(
              (event) =>
                event.type === 'tool/call' &&
                event.data.name === 'mat_dispatch' &&
                event.data.callId === exec.callId,
            );
        if (!event) throw new ProjectError('TOOL_CALL_ID_REQUIRED', '派工缺少真实工具调用记录');
        return service.dispatch(
          binding.connection.snapshot().id,
          { kind: 'session', sessionId: binding.sessionId },
          {
            ...input,
            operationId: messageIdentity(
              'mat_dispatch:' + owner.id + ':' + event.seq + ':' + exec.callId,
            ),
          },
        );
      },
    );
  register(
    'mat_version',
    '只读取得当前项目执行的固定版本、整票/返修差异、旧原件或审前工作区匹配。不会形成交付、启动模型或修改版本。按nextOffset完整续读JSON。',
    z
      .object({
        action: z.enum(['list', 'detail', 'diff', 'check', 'file']),
        executionId: z.uuid().optional(),
        versionId: z.uuid().optional(),
        mode: z.enum(['ticket', 'repair']).default('ticket'),
        rootIndex: z.number().int().nonnegative().default(0),
        path: z.string().min(1).optional(),
        offset: z.number().int().nonnegative().default(0),
      })
      .strict(),
    (input) => {
      const binding = resolve(owner),
        versions = binding.connection.versions();
      let value: unknown;
      if (input.action === 'list') {
        const executionId =
          input.executionId ??
          binding.connection.executions().currentForSession(binding.sessionId)?.id ??
          binding.connection.reviews().forSession(binding.sessionId)?.executionId;
        if (!executionId)
          throw new ProjectError('VERSION_EXECUTION_REQUIRED', '请选择明确执行，未猜测他人版本');
        value = versions.headers(executionId);
      } else {
        if (!input.versionId) throw new ProjectError('VERSION_REQUIRED', '请选择固定版本ID');
        const record = versions.get(input.versionId);
        if (input.executionId && record.executionId !== input.executionId)
          throw new ProjectError('VERSION_EXECUTION_MISMATCH', '固定版本不属于所选执行');
        if (input.action === 'detail') value = record;
        else if (input.action === 'check') value = versions.check(record.id);
        else if (input.action === 'diff') value = versions.diff(record.id, input.mode);
        else {
          if (!input.path)
            throw new ProjectError('VERSION_PATH_REQUIRED', '请选择版本内相对文件路径');
          const bytes = versions.file(record.id, input.rootIndex, input.path);
          let content: string, encoding: string;
          try {
            content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            encoding = 'utf8';
          } catch {
            content = bytes.toString('base64');
            encoding = 'base64';
          }
          value = {
            versionId: record.id,
            path: input.path,
            rootIndex: input.rootIndex,
            byteLength: bytes.length,
            encoding,
            content,
          };
        }
      }
      const text = Array.from(JSON.stringify(value)),
        end = Math.min(text.length, input.offset + 2000);
      return {
        content: text.slice(input.offset, end).join(''),
        offset: input.offset,
        nextOffset: end < text.length ? end : null,
        totalCharacters: text.length,
      };
    },
  );
  if (controls)
    register(
      'mat_control',
      '明确控制一个执行。主管可控制本项目，普通执行只能停止自己；恢复先核对最新现场和修订。返回请求不等于工具或写入已停稳。',
      controlBodySchema,
      (input, exec) => {
        const binding = resolve(owner),
          event = owner.session
            .snapshotEvents()
            .findLast(
              (event) =>
                event.type === 'tool/call' &&
                event.data.name === 'mat_control' &&
                event.data.callId === exec.callId,
            );
        if (!event) throw new ProjectError('TOOL_CALL_ID_REQUIRED', '没有真实控制工具调用');
        return controls.request(
          binding.connection.snapshot().id,
          { kind: 'session', sessionId: binding.sessionId },
          {
            ...input,
            operationId: messageIdentity(
              'mat_control:' + owner.id + ':' + event.seq + ':' + exec.callId,
            ),
          },
        );
      },
    );
}
