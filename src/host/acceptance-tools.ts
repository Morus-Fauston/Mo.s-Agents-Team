import { z } from 'zod';
import type { NativeAgent, NativeContext, NativeModules } from './native.ts';
import type { WorkflowType } from '../contracts/roles.ts';
import type { ProjectConnection } from '../services/project.ts';
import type { AcceptanceService } from '../services/acceptance-service.ts';
import {
  acceptanceAssignmentInputSchema,
  acceptanceRecordInputSchema,
  ticketAcceptanceInputSchema,
  supplementInputSchema,
  escalationInputSchema,
} from '../contracts/acceptance.ts';
import { nativeToolParameters } from './tool-parameters.ts';
import { messageIdentity } from '../services/message-presentation.ts';
import { ProjectError } from '../services/errors.ts';
export function installAcceptanceTools(
  ctx: NativeContext,
  owner: NativeAgent,
  modules: NativeModules,
  role: WorkflowType,
  resolve: (agent: NativeAgent) => { connection: ProjectConnection; sessionId: string },
  service: AcceptanceService,
) {
  type Exec = { agent: NativeAgent; callId: string };
  const register = <S extends z.ZodType>(
    name: string,
    description: string,
    schema: S,
    run: (input: z.output<S>, source: ReturnType<typeof resolve>, exec: Exec) => unknown,
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
            throw new ProjectError('TOOL_CALLER_MISMATCH', '验收办理不是实际调用Agent');
          return JSON.stringify(run(schema.parse(raw), resolve(exec.agent), exec));
        },
      }),
    );
  const action = <S extends z.ZodType>(
    name: string,
    description: string,
    kind: 'assign' | 'record' | 'complete' | 'supplement' | 'escalate',
    schema: S,
  ) =>
    register(name, description, schema, (input, source, exec) => {
      const event = owner.session
        .snapshotEvents()
        .findLast(
          (event) =>
            event.type === 'tool/call' &&
            event.data.name === name &&
            event.data.callId === exec.callId,
        );
      if (!event)
        throw new ProjectError('TOOL_CALL_ID_REQUIRED', '正式验收动作缺少真实工具调用身份');
      return service.act(
        source.connection.snapshot().id,
        { kind: 'session', sessionId: source.sessionId },
        kind,
        {
          ...(input as object),
          operationId: messageIdentity(name + ':' + owner.id + ':' + event.seq + ':' + exec.callId),
        },
      );
    });
  register(
    'mat_acceptance',
    '只读本票指定验收、实际责任方不可变结果、主管接受、补做和争议。读完nextOffset，不唤醒、不将读取或通知当办结。',
    z.object({ ticketId: z.uuid(), offset: z.number().int().nonnegative().default(0) }).strict(),
    (input, source) => {
      const chars = Array.from(
          JSON.stringify(service.query(source.connection.snapshot().id, input.ticketId)),
        ),
        end = Math.min(chars.length, input.offset + 4000);
      return {
        content: chars.slice(input.offset, end).join(''),
        nextOffset: end < chars.length ? end : null,
        totalCharacters: chars.length,
      };
    },
  );
  action(
    'mat_acceptance_record',
    '仅实际指定责任方记录对应版本接受accept或退回return及依据。checkCondition=true显式更新所承担的单个Checklist并同次保存验证Log；不能代填人工。接受不自动结票；主管若需退回已收尾成果补做，另用mat_delivery_supplement。',
    'record',
    acceptanceRecordInputSchema.omit({ operationId: true }),
  );
  if (role === 'supervisor') {
    action(
      'mat_acceptance_assign',
      '仅实际主管安排对应审阅通过版本的必要验收。条件用conditionId，额外事项用criterion。必需人工条件只指定user且required=true。先读正式意见、版本与Checklist，不把所有验收推给用户。',
      'assign',
      acceptanceAssignmentInputSchema.omit({ operationId: true }),
    );
    action(
      'mat_ticket_accept',
      '仅实际主管明确核对有效独审、对应当前成果版本、必要指定验收、Checklist及原执行收尾后确认完成。缺件直接拒绝；不能靠全勾、Git或idle结票。basis必须说明整体接受依据，用户接受不能替主管结票。',
      'complete',
      ticketAcceptanceInputSchema.omit({ operationId: true }),
    );
    action(
      'mat_delivery_supplement',
      '仅实际主管明确退回已收尾成果补做。保留旧版本及意见，原子建立同票关联新尝试与全新会话Goal。dispatch指定roleId和cwd，不能普通唤醒旧Goal；原范围外需求先决定，不暗中扩围。',
      'supplement',
      supplementInputSchema.omit({ operationId: true }),
    );
  }
  if (role === 'developer' || role === 'investigator')
    action(
      'mat_review_escalate',
      '原主执行在扩围、争议或无可继续方案时才显式升级，关联原正式意见resultId并说明问题依据。形成主管待处理，不改审阅结果或需求，正常退回直接原范围修正无需广播。',
      'escalate',
      escalationInputSchema.omit({ operationId: true }),
    );
}
