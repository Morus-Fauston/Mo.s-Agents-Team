import { z } from 'zod';
import type { NativeAgent, NativeContext, NativeModules } from './native.ts';
import type { ProjectConnection } from '../services/project.ts';
import type { CompletionService } from '../services/completion-service.ts';
import { reviewConfigurationSchema, reviewRetrySchema } from '../contracts/completion.ts';
import { nativeToolParameters } from './tool-parameters.ts';
import { messageIdentity } from '../services/message-presentation.ts';
import { ProjectError } from '../services/errors.ts';
const schema = z.union([
  z
    .object({
      action: z.literal('query'),
      reviewId: z.uuid().optional(),
      offset: z.number().int().nonnegative().default(0),
    })
    .strict(),
  reviewConfigurationSchema
    .omit({ operationId: true })
    .extend({ action: z.literal('configure') })
    .strict(),
  reviewRetrySchema
    .omit({ operationId: true })
    .extend({ action: z.literal('retry'), reviewId: z.uuid() })
    .strict(),
  z.object({ action: z.literal('configuration'), ticketId: z.string().min(1).optional() }).strict(),
]);
export function installReviewTools(
  ctx: NativeContext,
  owner: NativeAgent,
  modules: NativeModules,
  resolve: (agent: NativeAgent) => { connection: ProjectConnection; sessionId: string },
  service: CompletionService,
) {
  ctx.tools.register(
    modules.defineTool({
      name: 'mat_review',
      description:
        '查询固定版本审核、等待和通知进展。configuration读取默认或逐票安排；仅实际主管可configure或显式retry原审核，不另交付、不创建第二审核。query按nextOffset完整续读。正式意见另有入口，不以查询或重试代表通过。',
      parameters: nativeToolParameters(
        z
          .object({
            action: z.enum(['query', 'configuration', 'configure', 'retry']),
            reviewId: z.uuid().optional(),
            offset: z.number().int().nonnegative().optional(),
            ticketId: z.string().min(1).optional(),
            reviewerRoleId: z.string().nullable().optional(),
            inherit: z.boolean().optional(),
            reason: z.string().optional(),
          })
          .strict(),
      ),
      output: {
        schema: { type: 'string' },
        render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
      },
      execute: (raw: unknown, exec: { agent: NativeAgent; callId: string }) => {
        if (exec.agent !== owner)
          throw new ProjectError('TOOL_CALLER_MISMATCH', '审核工具不是实际调用会话');
        const input = schema.parse(raw),
          { connection, sessionId } = resolve(exec.agent),
          project = connection.snapshot().id,
          catalog = connection.reviews();
        if (input.action === 'query') {
          const reviewId = input.reviewId ?? catalog.forSession(sessionId)?.id,
            document = Array.from(JSON.stringify(service.query(project, reviewId))),
            end = Math.min(document.length, input.offset + 2000);
          return JSON.stringify({
            content: document.slice(input.offset, end).join(''),
            offset: input.offset,
            nextOffset: end < document.length ? end : null,
            totalCharacters: document.length,
          });
        }
        if (input.action === 'configuration')
          return JSON.stringify(catalog.configuration(input.ticketId));
        const event = owner.session
          .snapshotEvents()
          .findLast(
            (event) =>
              event.type === 'tool/call' &&
              event.data.name === 'mat_review' &&
              event.data.callId === exec.callId,
          );
        if (!event) throw new ProjectError('TOOL_CALL_ID_REQUIRED', '审核变更缺少实际工具调用记录');
        const operationId = messageIdentity(
            'mat_review:' + owner.id + ':' + event.seq + ':' + exec.callId,
          ),
          actor = { kind: 'session' as const, sessionId };
        if (input.action === 'configure') {
          return JSON.stringify(
            catalog.configure(actor, {
              ticketId: input.ticketId,
              reviewerRoleId: input.reviewerRoleId,
              inherit: input.inherit,
              operationId,
            }),
          );
        }
        const saved = service.retry(project, actor, input.reviewId, {
          operationId,
          reason: input.reason,
        });
        return JSON.stringify({
          reviewId: saved.id,
          versionId: saved.versionId,
          status: saved.status,
          note: '接续已登记，详细进展使用query回读；不代表已办理意见',
        });
      },
    }),
  );
}
