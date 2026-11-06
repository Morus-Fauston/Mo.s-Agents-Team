import { z } from 'zod';
import type { NativeAgent, NativeContext, NativeModules } from './native.ts';
import type { ProjectConnection } from '../services/project.ts';
import type { ReviewResultService } from '../services/review-result-service.ts';
import type { WorkflowType } from '../contracts/roles.ts';
import { reviewOpinionBodySchema } from '../contracts/review-results.ts';
import { nativeToolParameters } from './tool-parameters.ts';
import { messageIdentity } from '../services/message-presentation.ts';
import { ProjectError } from '../services/errors.ts';
export function installReviewResultTools(
  ctx: NativeContext,
  owner: NativeAgent,
  modules: NativeModules,
  role: WorkflowType,
  resolve: (agent: NativeAgent) => { connection: ProjectConnection; sessionId: string },
  service: ReviewResultService,
) {
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
          render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
        },
        execute: (raw: unknown, exec: Exec) => {
          if (exec.agent !== owner)
            throw new ProjectError('TOOL_CALLER_MISMATCH', '正式审计工具不是实际调用Agent');
          resolve(exec.agent);
          return JSON.stringify(run(schema.parse(raw), exec));
        },
      }),
    );
  const operation = (name: string, exec: Exec) => {
    const event = owner.session
      .snapshotEvents()
      .findLast(
        (event) =>
          event.type === 'tool/call' &&
          event.data.name === name &&
          event.data.callId === exec.callId,
      );
    if (!event) throw new ProjectError('TOOL_CALL_ID_REQUIRED', '正式审计动作缺少真实工具调用记录');
    return messageIdentity(name + ':' + owner.id + ':' + event.seq + ':' + exec.callId);
  };
  if (role === 'reviewer')
    register(
      'mat_review_opinion',
      '仅当前指定实际独审提交固定版本整票正式通过pass或退回return。scope写审核范围，basis写依据，return必须给issues修正要求。不另改状态或复制Chat。保存后原执行接续或收尾均以分步回执为准，通过不是结票。',
      reviewOpinionBodySchema,
      (input, exec) => {
        const source = resolve(owner),
          saved = service.submit(source.connection.snapshot().id, source.sessionId, owner, {
            ...input,
            operationId: operation('mat_review_opinion', exec),
          });
        return {
          resultId: saved.id,
          reviewId: saved.reviewId,
          versionId: saved.versionId,
          verdict: saved.verdict,
          progress: saved.progress,
        };
      },
    );
  register(
    'mat_review_result',
    '只读正式审计意见、问题、前次结果与原生办理进展。按nextOffset读取完整JSON，不把已读或通知当接受，不唤醒会话。',
    z
      .object({
        resultId: z.uuid().optional(),
        executionId: z.uuid().optional(),
        offset: z.number().int().nonnegative().default(0),
      })
      .strict(),
    (input) => {
      const source = resolve(owner),
        project = source.connection.snapshot().id;
      let value: unknown;
      if (input.resultId) value = service.query(project, input.resultId);
      else {
        const executionId =
          input.executionId ??
          source.connection.executions().currentForSession(source.sessionId)?.id ??
          source.connection.reviews().forSession(source.sessionId)?.executionId;
        value = source.connection.reviewResults().list(executionId);
      }
      const document = Array.from(JSON.stringify(value)),
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
      'mat_review_result_retry',
      '仅实际主管在核对未知原因后显式接续原正式结果。沿原Agent/Goal/版本，不新增意见或替代执行；上级控制仍优先。若明确解除已停稳的上级暂停，填写已核实的expectedControlRevision，仅放行原结果协调，不声称Goal已恢复；未知、在途或终止仍拒绝。',
      z
        .object({
          resultId: z.uuid(),
          reason: z.string().trim().min(1).max(8000),
          expectedControlRevision: z.number().int().nonnegative().optional(),
        })
        .strict(),
      (input, exec) => {
        const source = resolve(owner),
          saved = service.retry(
            source.connection.snapshot().id,
            { kind: 'session', sessionId: source.sessionId },
            input.resultId,
            {
              operationId: operation('mat_review_result_retry', exec),
              reason: input.reason,
              ...(input.expectedControlRevision === undefined
                ? {}
                : { expectedControlRevision: input.expectedControlRevision }),
            },
          );
        return { resultId: saved.id, verdict: saved.verdict, progress: saved.progress };
      },
    );
}
