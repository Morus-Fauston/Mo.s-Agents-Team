import { z } from 'zod';
import { dispatchBodySchema } from '../契约/执行.ts';
import type { DispatchService } from '../业务/派工服务.ts';
import type { ProjectConnection } from '../业务/项目.ts';
import { ProjectError } from '../业务/错误.ts';
import { messageIdentity } from '../业务/消息呈递.ts';
import type { WorkflowType } from '../契约/角色.ts';
import type { NativeAgent, NativeContext, NativeModules } from './原生接口.ts';
import { nativeToolParameters } from './工具参数.ts';
export function installExecutionTools(
  ctx: NativeContext,
  owner: NativeAgent,
  modules: NativeModules,
  role: WorkflowType,
  resolve: (agent: NativeAgent) => { connection: ProjectConnection; sessionId: string },
  service: DispatchService,
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
}
