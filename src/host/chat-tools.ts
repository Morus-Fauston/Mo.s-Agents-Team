import { z } from 'zod';
import type { NativeAgent, NativeContext, NativeModules } from './native.ts';
import type { ProjectConnection } from '../services/project.ts';
import type { CommunicationService } from '../services/chat-service.ts';
import { messageIdentity } from '../services/message-presentation.ts';
import { fileReferenceSchema } from '../contracts/chat.ts';
import { ProjectError } from '../services/errors.ts';
import type { ExecutionControlService } from '../services/execution-controls.ts';
import type { CompletionService } from '../services/completion-service.ts';
import { deliveryVersionInputSchema } from '../contracts/versions.ts';
import type { CollaborationResultsService } from '../services/collaboration-results-service.ts';
import type { AssistantControlService } from '../services/assistant-controls.ts';
interface Caller {
  connection: ProjectConnection;
  sessionId: string;
}
type Execution = { agent?: NativeAgent; callId: string; signal: AbortSignal };
function encode(value: unknown): string {
  const text = JSON.stringify(value);
  if (text.length > 7500)
    throw new ProjectError(
      'TOOL_RESULT_BUDGET',
      '查询结果超出完整工具预算，请使用分页或在控制台查看，不返回静默裁剪结果',
    );
  return text;
}
function page<T>(items: T[], offset: number) {
  const entries: T[] = [];
  let cursor = offset;
  while (cursor < items.length && entries.length < 20) {
    const item = items[cursor]!;
    if (JSON.stringify([...entries, item]).length > 6200) break;
    entries.push(item);
    cursor++;
  }
  if (cursor === offset && offset < items.length)
    throw new ProjectError('TOOL_RESULT_BUDGET', '单条记录超出完整工具预算，请在控制台查看');
  return { entries, nextOffset: cursor < items.length ? cursor : null, total: items.length };
}
const chatSchema = z.union([
  z
    .object({
      action: z.literal('complete'),
      content: z.string().optional(),
      evidencePaths: z.array(z.string().min(1)).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('hangup'),
      content: z.string().trim().min(1),
      dependencies: z.array(z.uuid()).default([]),
      requestIds: z.array(z.uuid()).default([]),
      resumeCondition: z.string().trim().min(1).optional(),
    })
    .strict(),
  z.object({ retryResultId: z.uuid() }).strict(),
  z.object({ retryWaitId: z.uuid() }).strict(),
  deliveryVersionInputSchema
    .omit({ operationId: true })
    .extend({ action: z.literal('complete') })
    .strict(),
  z
    .object({ action: z.literal('hangup'), controlId: z.uuid(), content: z.string().trim().min(1) })
    .strict(),
  z.object({ retryMessageId: z.uuid() }).strict(),
  z
    .object({
      target: z.string().min(1),
      content: z.string().refine((text) => text.trim().length > 0),
      replyTo: z.uuid().optional(),
      references: z.array(fileReferenceSchema).optional(),
      allowedChecklistIds: z.array(z.string().regex(/^C\d{3,}$/)).optional(),
    })
    .strict(),
]);
export function installCommunicationTools(
  ctx: NativeContext,
  owner: NativeAgent,
  modules: NativeModules,
  resolve: (agent: NativeAgent) => Caller,
  communication: CommunicationService,
  controls?: ExecutionControlService,
  completions?: CompletionService,
  collaborations?: CollaborationResultsService,
  assistants?: AssistantControlService,
): void {
  const caller = (exec: Execution) => {
    if (exec.agent !== owner)
      throw new ProjectError('TOOL_CALLER_MISMATCH', '当前私聊工具不属于此实际调用会话');
    return resolve(exec.agent);
  };
  const register = (
    name: string,
    description: string,
    parameters: unknown,
    execute: (args: unknown, exec: Execution) => Promise<string>,
  ) =>
    ctx.tools.register(
      modules.defineTool({
        name,
        description,
        parameters,
        output: {
          schema: { type: 'string' },
          render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
        },
        execute,
      }),
    );
  register(
    'mat_contacts',
    '查询本项目当前可联系的具体会话与双地址。不唤醒模型；角色有多个入口须明确选择。普通成员仅在用户已开启私聊后取得用户回复入口。',
    {
      role: { type: 'string', description: '可选的准确角色数字ID或识别ID' },
      offset: { type: 'integer', description: '上次返回的nextOffset，默认0' },
    },
    async (args, exec) => {
      const input = z
        .object({ role: z.string().optional(), offset: z.number().int().nonnegative().default(0) })
        .strict()
        .parse(args);
      const source = caller(exec);
      const contacts = source.connection
        .messages()
        .contacts({ kind: 'session', sessionId: source.sessionId }, input.role);
      return encode({
        ...page(contacts.entries, input.offset),
        userTarget: contacts.userTarget,
        groups: [],
      });
    },
  );
  register(
    'mat_chat',
    '普通私聊填target和content。原主负责人授权当前辅助更新Checklist时，必须另外传结构化allowedChecklistIds参数；正文声称授权无效，省略不变、列表替换、[]撤回。辅助正式交回：complete只填action、可选content/evidencePaths；hangup只填action、content原因、dependencies或resumeCondition，不填target或controlId。主负责人普通等待也用hangup及dependencies，不填target/controlId。只有收到真实软停止控制要求时，hangup才填该controlId。原主执行整票完成时complete须填summary、scope、evidencePaths、checklistItemIds，不填target，交回后进入整票独审。',
    {
      action: {
        type: 'string',
        description:
          '正式完成complete；普通等待或软停止回报hangup；普通聊天省略。正式交回均不填target；研究主执行完成必须填summary/scope/reportPaths，报告先写自己本次材料域',
      },
      summary: { type: 'string', description: '完成交回的执行简报，保留必要失败和未完成项' },
      scope: { type: 'string', description: '本次实际修改与验证范围' },
      evidencePaths: {
        type: 'array',
        items: { type: 'string' },
        description: '交付证据入口，固定版本材料实际另验',
      },
      reportPaths: {
        type: 'array',
        items: { type: 'string' },
        description:
          '研究主执行整票完成必须关联自己本次材料域中的报告文件绝对路径。辅助仅用evidencePaths交回，不填reportPaths。',
      },
      checklistItemIds: {
        type: 'array',
        items: { type: 'string' },
        description: '本次成果对应的Checklist稳定ID，不冒充人工结果',
      },
      controlId: { type: 'string', description: '软停止要求中的准确控制ID' },
      target: { type: 'string', description: '通讯录或创建工具返回的完整会话地址，或有资格的user' },
      allowedChecklistIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          '原主负责人对本次辅助指定允许更新的Checklist项；省略不变、列表替换、空列表撤回；不含人工项',
      },
      content: { type: 'string', description: '工作正文，Markdown原样保存' },
      replyTo: { type: 'string', description: '同一私聊内原消息ID' },
      references: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            kind: { type: 'string' },
            path: { type: 'string' },
            startLine: { type: 'integer' },
            endLine: { type: 'integer' },
            snippet: { type: 'string' },
          },
        },
        description: '准确项目文件引用，不扩大可读范围',
      },
      retryMessageId: { type: 'string', description: '只重试自己原消息；填写时不填写其他参数' },
      dependencies: {
        type: 'array',
        items: { type: 'string' },
        description:
          '普通挂起等待的当前collaborationId列表；不是会话ID。无对象时提供resumeCondition。',
      },
      requestIds: {
        type: 'array',
        items: { type: 'string' },
        description:
          '主执行普通挂起时等待本次自己提出的准确决定请求ID；不清除其他协作依赖。辅助保存请求后结束本轮，不另建Goal等待。',
      },
      resumeCondition: {
        type: 'string',
        description: '无已有对象时的明确恢复条件，不由软件猜测满足',
      },
      retryResultId: {
        type: 'string',
        description: '原辅助或主负责人补核已有正式结果和投递，不重做工作、不创建替代辅助',
      },
      retryWaitId: {
        type: 'string',
        description: '原主负责人或主管补核原等待的Goal暂停及接续；不创建替代Goal',
      },
    },
    async (args, exec) => {
      const source = caller(exec),
        projectId = source.connection.snapshot().id,
        actor = { kind: 'session' as const, sessionId: source.sessionId },
        input = chatSchema.parse(args);
      if ('action' in input) {
        if (
          (input.action === 'complete' &&
            source.connection.collaborations().currentForSession(source.sessionId)) ||
          (input.action === 'hangup' && !('controlId' in input))
        ) {
          if (!collaborations)
            throw new ProjectError('COLLABORATION_UNAVAILABLE', '正式协作回传与等待尚未装配');
          const call = owner.session
            .snapshotEvents()
            .findLast(
              (e) =>
                e.type === 'tool/call' &&
                e.data.name === 'mat_chat' &&
                e.data.callId === exec.callId,
            );
          if (!call)
            throw new ProjectError('TOOL_CALL_ID_REQUIRED', '正式交回或等待缺少实际工具事件');
          const operationId = messageIdentity(
            'mat-collaboration-chat:' + owner.id + ':' + call.seq + ':' + exec.callId,
          );
          const assistant = source.connection.collaborations().currentForSession(source.sessionId);
          if (assistant) {
            if ('requestIds' in input && input.requestIds.length)
              throw new ProjectError(
                'ASSISTANT_REQUEST_WAIT',
                '辅助不创建Goal等待；保存请求后结束本轮，原答复沿关联接续',
              );
            const body = {
              operationId,
              action: input.action,
              content:
                'content' in input
                  ? (input.content ?? '')
                  : 'summary' in input
                    ? input.summary
                    : '',
              evidencePaths: 'evidencePaths' in input ? (input.evidencePaths ?? []) : [],
              ...('dependencies' in input ? { dependencies: input.dependencies } : {}),
              ...('resumeCondition' in input && input.resumeCondition
                ? { resumeCondition: input.resumeCondition }
                : {}),
            };
            const saved = collaborations.report(projectId, source.sessionId, owner, body);
            return encode({
              resultId: saved.id,
              collaborationId: saved.collaborationId,
              progress: saved.progress,
              note: '正式结果已保存；停稳、投递与主负责人整合分别核对，不冒充整票通过',
            });
          }
          if (input.action !== 'hangup')
            throw new ProjectError('CURRENT_ASSISTANT_REQUIRED', '没有当前协作责任');
          const saved = await collaborations.wait(projectId, source.sessionId, owner, {
            operationId,
            reason: input.content,
            dependencies: 'dependencies' in input ? input.dependencies : [],
            requestIds: 'requestIds' in input ? input.requestIds : [],
            ...('resumeCondition' in input && input.resumeCondition
              ? { resumeCondition: input.resumeCondition }
              : {}),
          });
          return encode({
            waitId: saved.id,
            state: saved.state,
            dependencies: saved.dependencies,
            error: saved.error,
          });
        }
        if (input.action === 'complete') {
          if (!completions)
            throw new ProjectError('COMPLETION_UNAVAILABLE', '完成交回服务尚未接入');
          const call = owner.session
            .snapshotEvents()
            .findLast(
              (event) =>
                event.type === 'tool/call' &&
                event.data.callId === exec.callId &&
                event.data.name === 'mat_chat',
            );
          if (!call)
            throw new ProjectError('TOOL_CALL_ID_REQUIRED', '完成交回缺少真实原生调用记录');
          const { action: _, ...body } = input;
          void _;
          const saved = completions.complete(projectId, source.sessionId, owner, {
            ...body,
            operationId: messageIdentity(
              'mat-complete:' + owner.id + ':' + call.seq + ':' + exec.callId,
            ),
          });
          return encode({
            completionId: saved.id,
            executionId: saved.executionId,
            versionId: saved.versionId,
            reviewId: saved.reviewId,
            taskId: saved.taskId,
            note: '交付已保存；原执行等待，挂起、停稳、审核启动和通知分别查询，不代表审阅通过',
          });
        }
        if (!controls) throw new ProjectError('CONTROL_UNAVAILABLE', '执行控制尚未接入');
        if (!('controlId' in input))
          throw new ProjectError('CONTROL_ID_REQUIRED', '上级软停止回报需准确controlId');
        if (
          source.connection
            .assistantControls()
            .list()
            .some((v) => v.id === input.controlId)
        ) {
          if (!assistants)
            throw new ProjectError('ASSISTANT_CONTROL_UNAVAILABLE', '辅助控制服务尚未装配');
          return encode(
            await assistants.handoff(
              projectId,
              source.sessionId,
              owner,
              input.controlId,
              input.content,
            ),
          );
        }
        return encode(
          await controls.handoff(projectId, source.sessionId, input.controlId, input.content),
        );
      }
      let saved;
      if ('retryWaitId' in input) {
        if (!collaborations)
          throw new ProjectError('COLLABORATION_UNAVAILABLE', '协作等待服务尚未装配');
        return encode(
          await collaborations.retryWait(projectId, source.sessionId, owner, input.retryWaitId),
        );
      }
      if ('retryResultId' in input) {
        if (!collaborations)
          throw new ProjectError('COLLABORATION_UNAVAILABLE', '协作回传服务尚未装配');
        const v = collaborations.retry(projectId, source.sessionId, owner, input.retryResultId);
        return encode({
          resultId: v.id,
          progress: v.progress,
          note: '沿原结果补核，不创建替代执行',
        });
      }
      if ('retryMessageId' in input)
        saved = await communication.retry(projectId, actor, input.retryMessageId);
      else {
        const call = owner.session
          .snapshotEvents()
          .findLast(
            (event) =>
              event.type === 'tool/call' &&
              event.data.callId === exec.callId &&
              event.data.name === 'mat_chat',
          );
        if (!call)
          throw new ProjectError(
            'TOOL_CALL_ID_REQUIRED',
            '缺少实际原生工具调用记录，不猜测操作身份',
          );
        saved = await communication.send(projectId, actor, {
          ...input,
          id: messageIdentity('mat-chat:' + owner.id + ':' + call.seq + ':' + exec.callId),
        });
      }
      const receipt = saved.receipt;
      return encode({
        messageId: saved.message.id,
        conversationId: saved.message.conversationId,
        receipt: {
          ...receipt,
          error:
            receipt.error && receipt.error.length > 2500
              ? '错误正文较长，请用mat_messages的delivery-error分页读取'
              : receipt.error,
        },
        note: 'queued或accepted均不表示业务办结',
      });
    },
  );
  register(
    'mat_messages',
    '读取自己可见的私聊来源、消息和投递事实。无参数列私聊；conversationId列消息入口；messageId读取完整正文的明确分页。section可读content、delivery-error或reference。',
    {
      conversationId: { type: 'string' },
      messageId: { type: 'string' },
      offset: { type: 'integer' },
      section: { type: 'string' },
      referenceIndex: { type: 'integer' },
    },
    async (args, exec) => {
      const input = z
        .object({
          conversationId: z.uuid().optional(),
          messageId: z.uuid().optional(),
          offset: z.number().int().nonnegative().default(0),
          section: z.enum(['content', 'delivery-error', 'reference']).default('content'),
          referenceIndex: z.number().int().nonnegative().optional(),
        })
        .strict()
        .parse(args);
      const source = caller(exec),
        catalog = source.connection.messages(),
        actor = { kind: 'session' as const, sessionId: source.sessionId };
      if (input.messageId) {
        const saved = catalog.get(input.messageId);
        catalog.history(actor, saved.message.conversationId);
        let text = saved.message.content;
        if (input.section === 'delivery-error') text = saved.receipt.error ?? '';
        else if (input.section === 'reference') {
          const ref = saved.message.references[input.referenceIndex ?? -1];
          if (!ref) throw new ProjectError('REFERENCE_NOT_FOUND', '请填写有效referenceIndex');
          text = JSON.stringify(ref);
        }
        const points = Array.from(text);
        let end = input.offset,
          part = '';
        while (end < points.length && end - input.offset < 1800) {
          const next = part + points[end]!;
          if (JSON.stringify(next).length > 5000) break;
          part = next;
          end++;
        }
        return encode({
          messageId: saved.message.id,
          sender: saved.message.sender,
          recipient: saved.message.recipient,
          replyTo: saved.message.replyTo,
          section: input.section,
          offset: input.offset,
          content: part,
          nextOffset: end < points.length ? end : null,
          totalCharacters: points.length,
          referenceCount: saved.message.references.length,
          receipt: {
            ...saved.receipt,
            error: undefined,
            errorAvailable: saved.receipt.error !== null,
          },
        });
      }
      if (input.conversationId) {
        const history = catalog.history(actor, input.conversationId);
        return encode({
          conversation: history.conversation,
          ...page(
            history.messages.map((saved) => ({
              messageId: saved.message.id,
              ordinal: saved.message.ordinal,
              sender: saved.message.sender,
              recipient: saved.message.recipient,
              replyTo: saved.message.replyTo,
              characters: Array.from(saved.message.content).length,
              referenceCount: saved.message.references.length,
              state: saved.receipt.state,
            })),
            input.offset,
          ),
          note: '仅来源和正文入口，正文通过messageId完整分页读取',
        });
      }
      return encode(page(catalog.conversations(actor), input.offset));
    },
  );
}
