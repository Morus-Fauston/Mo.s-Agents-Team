import { z } from 'zod';
import type { NativeAgent, NativeContext, NativeModules } from './native.ts';
import type { ProjectConnection } from '../services/project.ts';
import type { AssistantControlService } from '../services/assistant-controls.ts';
import { assistantControlInputSchema } from '../contracts/assistant-controls.ts';
import { nativeToolParameters } from './tool-parameters.ts';
import { messageIdentity } from '../services/message-presentation.ts';
import { ProjectError } from '../services/errors.ts';
export function installAssistantControlTools(
  ctx: NativeContext,
  owner: NativeAgent,
  modules: NativeModules,
  resolve: (agent: NativeAgent) => { connection: ProjectConnection; sessionId: string },
  service: AssistantControlService,
): void {
  const fields = z
    .object({
      collaborationId: z.uuid().optional(),
      action: z.enum(['soft-stop', 'hard-stop', 'terminate', 'resume']).optional(),
      expectedRevision: z.number().int().nonnegative().optional(),
      reason: z.string().trim().min(1).optional(),
      content: z.string().optional(),
      stopMode: z.enum(['soft', 'hard']).optional(),
      retryControlId: z.uuid().optional(),
      offset: z.number().int().nonnegative().default(0),
    })
    .strict();
  ctx.tools.register(
    modules.defineTool({
      name: 'mat_assistant_control',
      description:
        '读取或明确控制本票一层辅助。只填collaborationId可读控制历史，按nextOffset读全。主负责人只能在自身已恢复后显式resume继承父控制的必要原辅助，不能解除独立暂停。主管可按权限控制。动作需action、collaborationId、expectedRevision及reason；不是普通Chat，不创建Goal或替代会话。补核原控制只填retryControlId、expectedRevision和reason。返回请求不代表已停稳或实际运行。',
      parameters: nativeToolParameters(fields),
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
      },
      execute: async (args: unknown, exec: { agent?: NativeAgent; callId: string }) => {
        if (exec.agent !== owner)
          throw new ProjectError('TOOL_CALLER_MISMATCH', '辅助控制工具不属于实际调用会话');
        const source = resolve(owner),
          c = source.connection,
          project = c.snapshot().id,
          input = fields.parse(args);
        const actor = { kind: 'session' as const, sessionId: source.sessionId };
        if (input.action || input.retryControlId) {
          const event = owner.session
            .snapshotEvents()
            .findLast(
              (e) =>
                e.type === 'tool/call' &&
                e.data.name === 'mat_assistant_control' &&
                e.data.callId === exec.callId,
            );
          if (!event)
            throw new ProjectError('TOOL_CALL_ID_REQUIRED', '辅助控制缺少实际工具调用事件');
          const operationId = messageIdentity(
            'mat-assistant-control:' + owner.id + ':' + event.seq + ':' + exec.callId,
          );
          let saved;
          if (input.retryControlId) {
            const v = z
              .object({
                retryControlId: z.uuid(),
                expectedRevision: z.number().int().positive(),
                reason: z.string().trim().min(1),
                offset: z.literal(0),
              })
              .strict()
              .parse(input);
            saved = service.retry(project, actor, v.retryControlId, {
              operationId,
              expectedRevision: v.expectedRevision,
              reason: v.reason,
            });
          } else {
            const { offset, ...body } = input;
            if (offset !== 0)
              throw new ProjectError('ASSISTANT_CONTROL_INPUT', '动作不能同时分页读取');
            saved = service.request(
              project,
              actor,
              assistantControlInputSchema.parse({ ...body, operationId }),
            );
          }
          return JSON.stringify({
            controlId: saved.id,
            collaborationId: saved.collaborationId,
            revision: saved.revision,
            status: saved.status,
            hasError: saved.error !== null,
            note: '请求与逐目标停稳分别核对；完整详情用collaborationId读取',
          });
        }
        const q = z
            .object({ collaborationId: z.uuid(), offset: z.number().int().nonnegative() })
            .strict()
            .parse(input),
          a = c.collaborations().get(q.collaborationId);
        if (
          c.session(source.sessionId).roleType !== 'supervisor' &&
          a.parentSessionId !== source.sessionId &&
          a.sessionId !== source.sessionId &&
          c.reviews().scopeForSession(source.sessionId)?.ticketId !== a.ticketId
        )
          throw new ProjectError('ASSISTANT_CONTROL_QUERY', '不是本次辅助关系的可见入口');
        const points = Array.from(JSON.stringify(service.query(project, a.id)));
        let end = q.offset,
          part = '';
        while (end < points.length && end - q.offset < 2000) {
          const next = part + points[end]!;
          if (JSON.stringify(next).length > 5700) break;
          part = next;
          end++;
        }
        return JSON.stringify({
          content: part,
          offset: q.offset,
          nextOffset: end < points.length ? end : null,
          totalCharacters: points.length,
        });
      },
    }),
  );
}
