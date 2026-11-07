import { z } from 'zod';
import type { NativeAgent, NativeContext, NativeModules } from './native.ts';
import type { ProjectConnection } from '../services/project.ts';
import type { DecisionRequestService } from '../services/decision-requests.ts';
import {
  decisionCreateSchema,
  decisionReplySchema,
  decisionEscalateSchema,
  decisionWithdrawSchema,
  decisionSupplementSchema,
} from '../contracts/decision-requests.ts';
import { nativeToolParameters } from './tool-parameters.ts';
import { messageIdentity } from '../services/message-presentation.ts';
import { ProjectError } from '../services/errors.ts';
type Execution = { agent?: NativeAgent; callId: string };
export function installDecisionRequestTools(
  ctx: NativeContext,
  owner: NativeAgent,
  modules: NativeModules,
  resolve: (agent: NativeAgent) => { connection: ProjectConnection; sessionId: string },
  service: DecisionRequestService,
): void {
  const caller = (exec: Execution) => {
    if (exec.agent !== owner)
      throw new ProjectError('TOOL_CALLER_MISMATCH', '请求工具不属于实际调用会话');
    const s = resolve(owner);
    return {
      ...s,
      actor: { kind: 'session' as const, sessionId: s.sessionId },
      project: s.connection.snapshot().id,
    };
  };
  const operation = (name: string, exec: Execution) => {
    const e = owner.session
      .snapshotEvents()
      .findLast(
        (e) => e.type === 'tool/call' && e.data.name === name && e.data.callId === exec.callId,
      );
    if (!e) throw new ProjectError('TOOL_CALL_ID_REQUIRED', '请求动作缺少真实工具调用事件');
    return messageIdentity('mat-decision:' + owner.id + ':' + e.seq + ':' + exec.callId);
  };
  function register(
    name: string,
    description: string,
    schema: z.ZodType,
    execute: (raw: unknown, exec: Execution) => Promise<unknown>,
  ) {
    ctx.tools.register(
      modules.defineTool({
        name,
        description,
        parameters: nativeToolParameters(schema),
        output: {
          schema: { type: 'string' },
          render: (_a: unknown, v: string) => [{ type: 'text', text: v }],
        },
        execute: async (raw: unknown, exec: Execution) => JSON.stringify(await execute(raw, exec)),
      }),
    );
  }
  const query = z
    .object({
      id: z.uuid().optional(),
      scope: z.enum(['mine', 'related']).default('mine'),
      offset: z.number().int().nonnegative().default(0),
    })
    .strict();
  register(
    'mat_pending_actions',
    '只读查询当前自己尚欠的处理动作，不唤醒模型。不填id默认列出当前负责的未办请求及已有主管清单/正式审阅动作；填稳定id读原记录、最新状态和办理入口。scope=related读取职责内关联请求历史，查看不产生代办权。长详情用返回nextOffset完整读取。',
    query,
    async (raw, exec) => {
      const input = query.parse(raw),
        s = caller(exec),
        c = s.connection;
      let document: unknown;
      if (input.id) {
        try {
          document = {
            request: c.decisionRequests().get(s.actor, input.id),
            notices: c.decisionRequests().notices(input.id),
          };
        } catch (error) {
          if (!(error instanceof ProjectError) || error.code !== 'DECISION_NOT_FOUND') throw error;
          const tree = c
            .worktrees()
            .list(s.actor)
            .find((v) => v.id === input.id);
          const local = c
            .localCommits()
            .list(s.actor)
            .find((v) => v.id === input.id);
          const merge = c
            .worktreeMerges()
            .list(s.actor)
            .find((v) => v.id === input.id);
          if (tree)
            document = {
              record: tree,
              history: c.worktrees().history(s.actor, tree.id),
              actionTool: 'mat_worktree',
            };
          else if (local)
            document = {
              arrangement: local,
              history: c.localCommits().history(s.actor, local.id),
              actionTool: 'mat_local_commit',
            };
          else if (merge)
            document = {
              arrangement: merge,
              history: c.worktreeMerges().history(s.actor, merge.id),
              actionTool: 'mat_merge',
            };
          else if (c.session(s.sessionId).roleType === 'supervisor')
            document = {
              task: c.workbench().getTask(input.id),
              history: c.workbench().taskHistory(input.id),
              note: '沿对应业务工具办理，不提供万能办结',
            };
          else {
            const review = c.reviews().get(input.id);
            if (review.sessionId !== s.sessionId)
              throw new ProjectError('PENDING_ACTION_SCOPE', '不是本会话负责的原业务动作');
            document = { review, actionTool: 'mat_review_opinion' };
          }
        }
      } else {
        const requests = (
          input.scope === 'mine'
            ? c.decisionRequests().pending(s.actor)
            : c.decisionRequests().list(s.actor)
        ).map((r) => ({
          id: r.id,
          kind: 'decision-request',
          title: r.subject,
          state: r.state,
          revision: r.revision,
          ticketId: r.ticketId,
          executionId: r.executionId,
          assignee: r.assignee,
          nextAction: r.state === 'needs-info' ? '原提出者补充' : '准确责任入口答复',
          detailTool: 'mat_pending_actions',
        }));
        const role = c.session(s.sessionId).roleType;
        const existing =
          role === 'supervisor'
            ? c
                .workbench()
                .tasks()
                .map((t) => ({
                  id: t.id,
                  kind: 'supervisor-arrangement',
                  title: t.title,
                  state: t.state,
                  ticketIds: t.ticketIds,
                  detailTool: 'mat_supervisor_tasks',
                  note: '沿原业务工具办理，不提供万能办结',
                }))
            : c
                .reviews()
                .list()
                .filter((r) => r.sessionId === s.sessionId && r.status === 'active')
                .map((r) => ({
                  id: r.id,
                  kind: 'formal-review',
                  state: r.status,
                  ticketId: r.ticketId,
                  detailTool: 'mat_review',
                  actionTool: 'mat_review_opinion',
                }));
        const localCommits = (
          input.scope === 'mine'
            ? c.localCommits().pending(s.actor)
            : c.localCommits().list(s.actor)
        )
          .filter(
            (v) =>
              input.scope === 'related' ||
              [v.managerSessionId, v.committerSessionId].includes(s.sessionId),
          )
          .map((v) => ({
            id: v.id,
            kind: 'local-commit',
            taskId: v.taskId,
            revision: v.revision,
            state: v.status,
            repository: v.plan.repository,
            detailTool: 'mat_local_commit',
            note: 'Git对象、在途与原通知分别读取；unknown不重做',
          }));
        const worktrees = c
          .worktrees()
          .list(s.actor)
          .filter(
            (v) =>
              input.scope === 'related' ||
              ['reserved', 'creating', 'unknown', 'missing'].includes(v.status),
          )
          .map((v) => ({
            id: v.id,
            kind: 'worktree',
            ticketId: v.ticketId,
            executionId: v.executionId,
            state: v.status,
            revision: v.revision,
            detailTool: 'mat_worktree query',
          }));
        const merges = c
          .worktreeMerges()
          .list(s.actor)
          .filter(
            (v) =>
              input.scope === 'related' ||
              (!['completed', 'cancelled'].includes(v.status) &&
                [v.managerSessionId, v.committerSessionId].includes(s.sessionId)),
          )
          .map((v) => ({
            id: v.id,
            kind: 'worktree-merge',
            taskId: v.taskId,
            revision: v.revision,
            state: v.status,
            sourceVersionId: v.preview.source.versionId,
            target: v.preview.plan.target.repository,
            detailTool: 'mat_merge query',
            note: 'Git结果、冲突修正与组合核验分别读取；unknown不重做',
          }));
        document = { requests, existing, localCommits, worktrees, merges };
      }
      const points = Array.from(JSON.stringify(document));
      let end = input.offset,
        content = '';
      while (end < points.length && end - input.offset < 2000) {
        const next = content + points[end]!;
        if (JSON.stringify(next).length > 5700) break;
        content = next;
        end++;
      }
      return {
        content,
        offset: input.offset,
        nextOffset: end < points.length ? end : null,
        totalCharacters: points.length,
      };
    },
  );
  const fields = z
    .object({
      action: z.enum(['create', 'escalate', 'supplement', 'withdraw', 'retry']),
      requestId: z.uuid().optional(),
      expectedRevision: z.number().int().positive().optional(),
      subject: decisionCreateSchema.shape.subject.optional(),
      question: decisionCreateSchema.shape.question.optional(),
      impact: decisionCreateSchema.shape.impact.optional(),
      reason: decisionCreateSchema.shape.reason.optional(),
      requestedWriteScopes: decisionCreateSchema.shape.requestedWriteScopes,
      references: z
        .array(z.string().min(1))
        .max(64)
        .optional()
        .describe('仅create或supplement填写；其他动作省略，不填空列表'),
      basis: z.string().trim().min(1).optional(),
    })
    .strict();
  register(
    'mat_decision_request',
    '提出/撤回正式请求及原链补充、升级，立即保存稳定ID，不悬住调用。create只填subject/question/impact/reason及可选references；主执行明确扩围使用scope-change，并填requestedWriteScopes为完整拟议写域。escalate只填requestId/expectedRevision/reason/basis；supplement只填requestId/expectedRevision/question/impact/basis及可选references；withdraw只填requestId/expectedRevision/basis；retry只填requestId。普通问答用Chat。辅助clarification先交原主；扩围、资源冲突或无可行方案才显式升级；忙、正常等待、暂停不是parent-unavailable。主执行管理请求先交主管，只有主管human-decision升级用户。不因请求创建新票/Goal或改变控制。无可做部分主执行可mat_chat hangup明确requestIds；辅助无Goal，保存后结束本轮等原答复。已处理不能撤回；retry仅补原通知。',
    fields,
    async (raw, exec) => {
      const input = fields.parse(raw),
        s = caller(exec),
        { action, requestId, ...rest } = input;
      let r;
      if (action === 'retry') {
        z.object({}).strict().parse(rest);
        if (!requestId) throw new ProjectError('DECISION_ID_REQUIRED', '须绑定原请求');
        r = await service.retry(s.project, s.actor, requestId);
      } else {
        const schemas = {
          create: decisionCreateSchema,
          escalate: decisionEscalateSchema,
          supplement: decisionSupplementSchema,
          withdraw: decisionWithdrawSchema,
        };
        if (action === 'create' && requestId)
          throw new ProjectError('DECISION_INPUT', '新请求不自填旧身份');
        r = await service.act(
          s.project,
          s.actor,
          action,
          requestId,
          schemas[action].parse({ ...rest, operationId: operation('mat_decision_request', exec) }),
        );
      }
      return {
        requestId: r.id,
        revision: r.revision,
        state: r.state,
        assignee: r.assignee,
        note: '保存、通知持久接纳和实际办理分别查询；没有新授权或恢复控制。',
      };
    },
  );
  const reply = decisionReplySchema
    .omit({ operationId: true })
    .extend({ requestId: z.uuid() })
    .strict();
  register(
    'mat_decision_reply',
    '当前实际责任入口准确答复原requestId和expectedRevision。保存自由文本answer、明确choice与完整restrictions；need-info保留后续责任，accept仅覆盖本次明确事项。普通Chat或已读不办结；答复不修改票据/文件权限，不解除暂停，不冒充工作已交付。正式审阅争议继续原窄链。',
    reply,
    async (raw, exec) => {
      const input = reply.parse(raw),
        s = caller(exec),
        { requestId, ...body } = input;
      const r = await service.act(s.project, s.actor, 'reply', requestId, {
        ...body,
        operationId: operation('mat_decision_reply', exec),
      });
      return {
        requestId: r.id,
        revision: r.revision,
        state: r.state,
        assignee: r.assignee,
        choice: r.reply?.choice,
        answerSaved: true,
        restrictionsSaved: true,
        detailTool: 'mat_pending_actions',
      };
    },
  );
}
