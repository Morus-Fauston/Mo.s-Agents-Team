import { z } from 'zod';
import type { NativeAgent, NativeContext, NativeModules } from './原生接口.ts';
import type { ProjectConnection } from '../业务/项目.ts';
import type { CommunicationService } from '../业务/私聊服务.ts';
import { messageIdentity } from '../业务/消息呈递.ts';
import { fileReferenceSchema } from '../契约/私聊.ts';
import { ProjectError } from '../业务/错误.ts';
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
  z.object({ retryMessageId: z.uuid() }).strict(),
  z
    .object({
      target: z.string().min(1),
      content: z.string().refine((text) => text.trim().length > 0),
      replyTo: z.uuid().optional(),
      references: z.array(fileReferenceSchema).optional(),
    })
    .strict(),
]);
export function installCommunicationTools(
  ctx: NativeContext,
  owner: NativeAgent,
  modules: NativeModules,
  resolve: (agent: NativeAgent) => Caller,
  communication: CommunicationService,
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
    '向明确会话发送普通私聊，或用retryMessageId重试自己原消息。不等待对方回复。保存、内存接纳、持久接纳、进入模型和业务办理分开；未知结果先查询原消息，不换新身份盲发。当前不支持完成/挂起、派工或控制动作。',
    {
      target: { type: 'string', description: '通讯录或创建工具返回的完整会话地址，或有资格的user' },
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
    },
    async (args, exec) => {
      const source = caller(exec),
        projectId = source.connection.snapshot().id,
        actor = { kind: 'session' as const, sessionId: source.sessionId },
        input = chatSchema.parse(args);
      let saved;
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
