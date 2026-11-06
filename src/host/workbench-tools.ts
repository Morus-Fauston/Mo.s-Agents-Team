import { z } from 'zod';
import type { NativeAgent, NativeContext, NativeModules } from './native.ts';
import type { ProjectConnection } from '../services/project.ts';
import type { WorkflowType } from '../contracts/roles.ts';
import { nativeToolParameters } from './tool-parameters.ts';
import { ProjectError } from '../services/errors.ts';
import { messageIdentity } from '../services/message-presentation.ts';
import {
  feedbackInputSchema,
  appendLogSchema,
  logUpdateSchema,
  checklistUpdateSchema,
  ticketUpdateSchema,
  ticketStateSchema,
  phaseInputSchema,
  categoryInputSchema,
} from '../contracts/workbench.ts';
type Execution = { agent?: NativeAgent; callId: string; signal: AbortSignal };
function encode(value: unknown): string {
  const result = JSON.stringify(value);
  if (result.length > 7500)
    throw new ProjectError(
      'TOOL_RESULT_BUDGET',
      '工具结果超出完整预算，请按nextOffset继续读取，不能视为已读全文',
    );
  return result;
}
function documentPage(value: unknown, offset: number) {
  const points = Array.from(JSON.stringify(value));
  let end = offset,
    part = '';
  while (end < points.length && end - offset < 2500) {
    const next = part + points[end]!;
    if (JSON.stringify(next).length > 5700) break;
    part = next;
    end++;
  }
  return {
    content: part,
    offset,
    nextOffset: end < points.length ? end : null,
    totalCharacters: points.length,
    format: 'JSON文档连续片段；有nextOffset时尚未读完',
  };
}
export function installWorkbenchTools(
  ctx: NativeContext,
  owner: NativeAgent,
  modules: NativeModules,
  roleType: WorkflowType,
  resolve: (agent: NativeAgent) => { connection: ProjectConnection; sessionId: string },
): void {
  const binding = () => resolve(owner),
    actor = () => ({ kind: 'session' as const, sessionId: binding().sessionId }),
    wb = () => binding().connection.workbench();
  const operation = (name: string, exec: Execution) => {
    const event = owner.session
      .snapshotEvents()
      .findLast(
        (event) =>
          event.type === 'tool/call' &&
          event.data.callId === exec.callId &&
          event.data.name === name,
      );
    if (!event)
      throw new ProjectError('TOOL_CALL_ID_REQUIRED', '缺少真实工具调用记录，不能猜测写入身份');
    return messageIdentity(name + ':' + owner.id + ':' + event.seq + ':' + exec.callId);
  };
  const register = <S extends z.ZodType>(
    name: string,
    description: string,
    schema: S,
    run: (input: z.output<S>, exec: Execution) => unknown | Promise<unknown>,
  ) => {
    const parameters = nativeToolParameters(schema);
    ctx.tools.register(
      modules.defineTool({
        name,
        description,
        parameters,
        output: {
          schema: { type: 'string' },
          render: (_args: unknown, value: string) => [{ type: 'text', text: value }],
        },
        execute: async (args: unknown, exec: Execution) => {
          if (exec.agent !== owner)
            throw new ProjectError('TOOL_CALLER_MISMATCH', '此工作台工具不属于实际调用会话');
          resolve(exec.agent);
          return encode(await run(schema.parse(args), exec));
        },
      }),
    );
  };
  const offset = z.number().int().nonnegative().default(0),
    ticket = z.string().min(1);
  register(
    'mat_tickets',
    '查询当前项目票据简表，可筛选；列出不代表可领取或获准开工。完整内容用mat_ticket。',
    z
      .object({
        phaseId: z.uuid().optional(),
        categoryId: z.uuid().optional(),
        state: ticketStateSchema.optional(),
        offset,
      })
      .strict(),
    (input) =>
      documentPage(
        wb()
          .listTickets(input)
          .map((item) => ({
            id: item.id,
            code: item.code,
            title: item.title,
            state: item.state,
            goalPreview: item.goal.slice(0, 160),
            goalPreviewComplete: item.goal.length <= 160,
            phaseId: item.phaseId,
            categoryId: item.categoryId,
          })),
        input.offset,
      ),
  );
  register(
    'mat_ticket',
    '按准确票号或ID读取同源票据。section选择overview、body、checklist、log-index、log、revisions、log-history或materials；全文分段读取，不把目录当正文。',
    z
      .object({
        ticket,
        section: z
          .enum([
            'overview',
            'body',
            'checklist',
            'log-index',
            'log',
            'revisions',
            'log-history',
            'materials',
          ])
          .default('overview'),
        logId: z.string().optional(),
        archiveMode: z.enum(['active', 'archived', 'all']).default('active'),
        offset,
      })
      .strict(),
    (input) => {
      const catalog = wb(),
        value = catalog.getTicket(input.ticket);
      let content: unknown;
      switch (input.section) {
        case 'body':
          content = {
            title: value.title,
            goal: value.goal,
            included: value.included,
            excluded: value.excluded,
            dependencies: value.dependencies,
            revision: value.revision,
          };
          break;
        case 'checklist':
          content = value.checklist;
          break;
        case 'log-index':
          content = catalog.logs(value.id, input.archiveMode).map((log) => ({
            id: log.id,
            title: log.title,
            type: log.type,
            importance: log.importance,
            archived: log.archived,
            author: log.author,
            createdAt: log.createdAt,
          }));
          break;
        case 'log':
          if (!input.logId) throw new ProjectError('LOG_ID_REQUIRED', '请指定稳定Log ID');
          content = catalog.getLog(value.id, input.logId);
          break;
        case 'revisions':
          content = catalog.ticketHistory(value.id);
          break;
        case 'log-history':
          if (!input.logId) throw new ProjectError('LOG_ID_REQUIRED', '请指定Log ID');
          content = catalog.logHistory(value.id, input.logId);
          break;
        case 'materials':
          content = {
            root: value.materialRoot,
            currentExecution: value.currentExecution,
            domains: catalog.materialDomains(value.id),
            currentDelivery: null,
            note: '未有实际执行或审阅时不伪造材料域；文件工具写入仍遵守分配范围',
          };
          break;
        default:
          content = {
            id: value.id,
            code: value.code,
            title: value.title,
            state: value.state,
            revision: value.revision,
            phase: catalog.getPhase(value.phaseId),
            dependencies: value.dependencies,
            currentExecution: value.currentExecution,
            materialRoot: value.materialRoot,
            actionsUnavailable: ['派工', '独审', '结票'],
          };
      }
      return { ticketId: value.id, section: input.section, ...documentPage(content, input.offset) };
    },
  );
  register(
    'mat_phases',
    '读取项目独立期次、主管定义类别与开放事实；查询不启动工作。',
    z.object({ offset }).strict(),
    (input) => documentPage({ phases: wb().phases(), categories: wb().categories() }, input.offset),
  );
  register(
    'mat_history',
    '读取同源项目关键事件和主管叙述；当前状态须回到原票查询。',
    z.object({ offset }).strict(),
    (input) => documentPage(wb().projectHistory(), input.offset),
  );
  register(
    'mat_feedback',
    '测试期提交本系统的具体问题或建议，保存后继续原工作，不等待答复；不转票、不派工、不唤醒。来源及背景由软件取得。',
    feedbackInputSchema.omit({ operationId: true }).strict(),
    (input, exec) => {
      const value = wb().submitFeedback(actor(), {
        ...input,
        operationId: operation('mat_feedback', exec),
      });
      return {
        id: value.id,
        saved: true,
        author: value.author,
        executionId: value.executionId,
        note: '已保存供用户集中查看；反馈不代替阻塞升级，不等待答复',
      };
    },
  );
  if (roleType === 'developer' || roleType === 'investigator') {
    register(
      'mat_log',
      '维护当前获准票内工作Log。action=append追加正文；metadata仅维护分类、重要性或归档，正文纠正通过corrects追加。无实际执行责任时拒绝写入。',
      z
        .object({
          ticket,
          action: z.enum(['append', 'metadata']),
          logId: z.string().optional(),
          entry: appendLogSchema.omit({ operationId: true }).optional(),
          metadata: logUpdateSchema.omit({ operationId: true }).optional(),
        })
        .strict(),
      (input, exec) => {
        const catalog = wb(),
          id = catalog.getTicket(input.ticket).id,
          operationId = operation('mat_log', exec);
        if (input.action === 'append') {
          if (!input.entry || input.metadata || input.logId)
            throw new ProjectError('INVALID_LOG_ACTION', '追加需要entry，不能混入元数据操作');
          const saved = catalog.appendLog(actor(), id, { ...input.entry, operationId });
          return { ticketId: id, logId: saved.id, saved: true };
        }
        if (!input.logId || !input.metadata || input.entry)
          throw new ProjectError('INVALID_LOG_ACTION', '元数据操作需要logId和metadata');
        const saved = catalog.updateLog(actor(), id, input.logId, {
          ...input.metadata,
          operationId,
        });
        return { ticketId: id, logId: saved.id, archived: saved.archived, saved: true };
      },
    );
    register(
      'mat_checklist',
      '当前主执行或获授权辅助按真实Log更新Checklist结果；每项expectedRevision必须是实际读取的条件revision，旧版本拒绝。不改条件、不代填人工、不自动结票。',
      checklistUpdateSchema.omit({ operationId: true }).extend({ ticket }).strict(),
      (input, exec) => {
        const { ticket, ...update } = input,
          value = wb().updateChecklist(actor(), wb().getTicket(ticket).id, {
            ...update,
            operationId: operation('mat_checklist', exec),
          });
        return {
          ticketId: value.id,
          saved: true,
          state: value.state,
          checklist: value.checklist.map((item) => ({
            id: item.id,
            checked: item.checked,
            logId: item.logId,
          })),
        };
      },
    );
  }
  if (roleType === 'supervisor') {
    register(
      'mat_update_ticket',
      '在既有授权内维护已有票据要求，必须给出当前版本和理由。正式新票由用户明确确认入口建立；不接受任意状态赋值。',
      ticketUpdateSchema.omit({ operationId: true }).extend({ ticket }).strict(),
      (input, exec) => {
        const { ticket, ...update } = input,
          value = wb().updateTicket(actor(), wb().getTicket(ticket).id, {
            ...update,
            operationId: operation('mat_update_ticket', exec),
          });
        return { ticketId: value.id, revision: value.revision, state: value.state, saved: true };
      },
    );
    register(
      'mat_plan',
      '建立未开放期次或主管定义类别。记录计划不获得开工授权，开放期次只接受用户入口。',
      z
        .object({
          phase: phaseInputSchema.omit({ operationId: true }).optional(),
          category: categoryInputSchema.omit({ operationId: true }).optional(),
        })
        .strict(),
      (input, exec) => {
        if ((input.phase === undefined) === (input.category === undefined))
          throw new ProjectError('ONE_PLAN_ACTION', '每次只建立一个明确期次或类别');
        const operationId = operation('mat_plan', exec),
          value = input.phase
            ? wb().createPhase(actor(), { ...input.phase, operationId })
            : wb().createCategory(actor(), { ...input.category, operationId });
        return { id: value.id, saved: true };
      },
    );
    register(
      'mat_supervisor_tasks',
      '读取主管正式长期/短期清单，默认未完成和挂起；不把临时Todo或Goal当清单。',
      z
        .object({
          id: z.uuid().optional(),
          history: z.boolean().default(false),
          includeCompleted: z.boolean().default(false),
          offset,
        })
        .strict(),
      (input) =>
        documentPage(
          input.id
            ? input.history
              ? wb().taskHistory(input.id)
              : wb().getTask(input.id)
            : wb().tasks(input.includeCompleted),
          input.offset,
        ),
    );
    register(
      'mat_update_supervisor_tasks',
      '在职责内建立近期安排，或维护既有清单状态与关联。长期目标建立或改名走用户确认入口；勾选不代替票据验收。',
      z
        .object({
          id: z.uuid().optional(),
          expectedRevision: z.number().int().positive().optional(),
          title: z.string().min(1).optional(),
          parentId: z.uuid().optional(),
          state: z.enum(['unchecked', 'held', 'checked']).optional(),
          basis: z.string().min(1),
          reason: z.string().min(1).optional(),
          ticketIds: z.array(z.uuid()).optional(),
        })
        .strict(),
      (input, exec) => {
        const operationId = operation('mat_update_supervisor_tasks', exec);
        if (input.id) {
          if (input.expectedRevision === undefined || !input.reason || input.parentId)
            throw new ProjectError(
              'TASK_REVISION_REQUIRED',
              '维护需要当前版本和理由，不能改挂目标',
            );
          const value = wb().updateTask(actor(), input.id, {
            operationId,
            expectedRevision: input.expectedRevision,
            reason: input.reason,
            basis: input.basis,
            ...(input.title ? { title: input.title } : {}),
            ...(input.state ? { state: input.state } : {}),
            ...(input.ticketIds ? { ticketIds: input.ticketIds } : {}),
          });
          return { id: value.id, state: value.state, revision: value.revision, saved: true };
        }
        if (!input.title || input.state || input.expectedRevision || input.reason)
          throw new ProjectError('TASK_TITLE_REQUIRED', '新近期安排需要标题与依据，不代填完成状态');
        const value = wb().createTask(actor(), {
          operationId,
          level: 'short',
          title: input.title,
          basis: input.basis,
          ...(input.parentId ? { parentId: input.parentId } : {}),
          ticketIds: input.ticketIds ?? [],
        });
        return { id: value.id, state: value.state, saved: true };
      },
    );
    register(
      'mat_add_history',
      '按需补充跨票脉络或纠正原叙述，保留作者与依据，不生成正式决定或覆盖原文。',
      z
        .object({
          content: z.string().min(1),
          references: z.array(z.string()).default([]),
          corrects: z.uuid().optional(),
        })
        .strict(),
      (input, exec) => {
        const value = wb().addHistory(actor(), {
          ...input,
          operationId: operation('mat_add_history', exec),
        });
        return { id: value.id, saved: true };
      },
    );
  }
}
