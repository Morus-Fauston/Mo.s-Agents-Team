import { z } from 'zod';
import type { NativeAgent, NativeContext, NativeModules } from './native.ts';
import type { ProjectConnection } from '../services/project.ts';
import type { AssistantService } from '../services/assistant-service.ts';
import { assistantBodySchema } from '../contracts/collaboration.ts';
import { nativeToolParameters } from './tool-parameters.ts';
import { messageIdentity } from '../services/message-presentation.ts';
import { ProjectError } from '../services/errors.ts';
export function installAssistantTools(
  ctx: NativeContext,
  owner: NativeAgent,
  modules: NativeModules,
  resolve: (agent: NativeAgent) => { connection: ProjectConnection; sessionId: string },
  service: AssistantService,
): void {
  const schema = assistantBodySchema;
  const execute = async (args: unknown, exec: { agent?: NativeAgent; callId: string }) => {
    if (exec.agent !== owner)
      throw new ProjectError('TOOL_CALLER_MISMATCH', '辅助创建工具只属于实际调用会话');
    const { connection, sessionId } = resolve(exec.agent);
    const call = owner.session
      .snapshotEvents()
      .findLast(
        (e) =>
          e.type === 'tool/call' &&
          e.data.name === 'mat_create_session' &&
          e.data.callId === exec.callId,
      );
    if (!call)
      throw new ProjectError('TOOL_CALL_ID_REQUIRED', '缺少实际工具调用记录，不能猜测创建身份');
    const saved = await service.create(connection.snapshot().id, sessionId, {
      ...schema.parse(args),
      operationId: messageIdentity(
        'mat-assistant:' + owner.id + ':' + call.seq + ':' + exec.callId,
      ),
    });
    const session = saved.sessionId ? connection.session(saved.sessionId) : null;
    return JSON.stringify({
      collaborationId: saved.id,
      ticketId: saved.ticketId,
      executionId: saved.executionId,
      parentSessionId: saved.parentSessionId,
      sessionId: saved.sessionId,
      addresses: session?.addresses ?? null,
      state: saved.state,
      error: saved.error,
      materials: connection
        .workbench()
        .materialDomains(saved.ticketId)
        .filter((d) => d.referenceId === saved.id)
        .map((d) => ({ id: d.id, path: d.path, available: d.available })),
      note: '只准备一层辅助；首条工作通过mat_chat发送。writeScopes为声明范围，不是OS隔离。',
    });
  };
  ctx.tools.register(
    modules.defineTool({
      name: 'mat_create_session',
      description:
        '当前开发或调查主负责人引用已有开发/调查/审阅角色创建或续用一层辅助。默认同树，writeScopes只在主票内；空列表只读源码，可写独立材料域。创建不发消息、不启动Goal；返回地址后通过Chat交代当前票工作。辅助不能再创建下一层，不调主管或提交角色。',
      parameters: nativeToolParameters(schema),
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
      },
      execute,
    }),
  );
  const query = z.object({ offset: z.number().int().nonnegative().default(0) }).strict();
  ctx.tools.register(
    modules.defineTool({
      name: 'mat_collaborations',
      description:
        '读取当前主票或自身一层协作关联，含材料与源码写入范围，全文按nextOffset读取；不启动工作、不解除控制。',
      parameters: nativeToolParameters(query),
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
      },
      execute: async (args: unknown, exec: { agent?: NativeAgent }) => {
        if (exec.agent !== owner)
          throw new ProjectError('TOOL_CALLER_MISMATCH', '协作查询不属于实际调用会话');
        const { connection, sessionId } = resolve(exec.agent),
          catalog = connection.collaborations();
        const own = catalog.currentForSession(sessionId),
          main = connection.executions().currentForSession(sessionId);
        const entries = own ? [own] : main ? catalog.list(main.id) : [];
        const data = {
          collaborations: entries.map((a) => ({
            ...a,
            results: connection.collaborationResults().results(a.id),
          })),
          waits: main ? connection.collaborationResults().waits(main.id) : [],
        };
        const { offset } = query.parse(args),
          points = Array.from(JSON.stringify(data));
        const end = Math.min(points.length, offset + 2000);
        return JSON.stringify({
          content: points.slice(offset, end).join(''),
          offset,
          nextOffset: end < points.length ? end : null,
          totalCharacters: points.length,
        });
      },
    }),
  );
}
