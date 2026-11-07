import { z } from 'zod';
import type { NativeAgent, NativeContext, NativeModules } from './native.ts';
import type { ProjectConnection } from '../services/project.ts';
import { LocalCommitService, localCommitPreviewSchema } from '../services/local-commits.ts';
import {
  localCommitArrangeSchema,
  localCommitInspectSchema,
  localCommitReportSchema,
  localCommitReconcileSchema,
} from '../contracts/local-commits.ts';
import { nativeToolParameters } from './tool-parameters.ts';
import { messageIdentity } from '../services/message-presentation.ts';
import { ProjectError } from '../services/errors.ts';
export function installLocalCommitTools(
  ctx: NativeContext,
  owner: NativeAgent,
  modules: NativeModules,
  resolve: (agent: NativeAgent) => { connection: ProjectConnection; sessionId: string },
  service: LocalCommitService,
) {
  const schema = z
    .object({
      action: z.enum([
        'preview',
        'arrange',
        'inspect',
        'report',
        'reconcile',
        'query',
        'retry-notice',
        'cancel',
      ]),
      id: z.uuid().optional(),
      preview: localCommitPreviewSchema.optional(),
      arrange: localCommitArrangeSchema.omit({ operationId: true }).optional(),
      inspect: localCommitInspectSchema.omit({ operationId: true }).optional(),
      report: localCommitReportSchema.omit({ operationId: true }).optional(),
      reconcile: localCommitReconcileSchema.omit({ operationId: true }).optional(),
      cancel: localCommitReconcileSchema.omit({ operationId: true }).optional(),
      offset: z.number().int().nonnegative().optional(),
    })
    .strict();
  ctx.tools.register(
    modules.defineTool({
      name: 'mat_local_commit',
      description:
        '主管明确的二期本地基线/必要提交，沿原清单事项。preview填preview取得准确Git差异指纹并分页读全部当前差异目录；arrange仅填arrange，绑定原提交类型实际会话、获准files和expectedFingerprint。提交者先query读原安排，再inspect填id及inspect.expectedRevision；仅ready可办理一次获准Git。禁止全部暂存、stash、reset、clean、push，禁止业务修复。report仅原提交者，填id及report；自报不等于核定。unknown先reconcile回读原对象，不盲目重做或新派工。query填id分页读完整依据/历史；retry-notice只补原通知，不重做Git。工具操作身份取真实调用，正文不能传actor/proof。cancel仅原主管，填id及cancel.expectedRevision/reason；只有核定无本次提交且原生安静才撤销，不表示Git完成。组合核验发现的已审必要修正，仅在arrange.mergeId明确关联原合入，并绑定原组合票新已审versionIds、原提交者及全部准确差异时办理；其他事项不填mergeId。不是正式发布或业务验收。',
      parameters: nativeToolParameters(schema),
      output: {
        schema: { type: 'string' },
        render: (_a: unknown, v: string) => [{ type: 'text', text: v }],
      },
      execute: async (raw: unknown, exec: { agent?: NativeAgent; callId: string }) => {
        if (exec.agent !== owner)
          throw new ProjectError('TOOL_CALLER_MISMATCH', '本地提交工具不属于实际调用会话');
        const input = schema.parse(raw),
          s = resolve(owner),
          actor = { kind: 'session' as const, sessionId: s.sessionId },
          project = s.connection.snapshot().id;
        const key = ['preview', 'arrange', 'inspect', 'report', 'reconcile', 'cancel'].includes(
          input.action,
        )
          ? input.action
          : null;
        for (const field of [
          'preview',
          'arrange',
          'inspect',
          'report',
          'reconcile',
          'cancel',
        ] as const)
          if (field !== key && input[field] !== undefined)
            throw new ProjectError('LOCAL_COMMIT_INPUT', '只提供当前动作对应参数');
        if (
          key &&
          !input[key as 'preview' | 'arrange' | 'inspect' | 'report' | 'reconcile' | 'cancel']
        )
          throw new ProjectError('LOCAL_COMMIT_INPUT', '缺少当前动作对应参数');
        if (
          ['preview', 'arrange'].includes(input.action)
            ? input.id !== undefined
            : input.id === undefined
        )
          throw new ProjectError(
            'LOCAL_COMMIT_INPUT',
            '查询/办理原事项须准确id；预览/安排不填旧id',
          );
        if (!['query', 'preview'].includes(input.action) && input.offset !== undefined)
          throw new ProjectError('LOCAL_COMMIT_INPUT', '分页只用于query或preview');
        if (input.action === 'query') {
          const catalog = s.connection.localCommits(),
            document = JSON.stringify({
              arrangement: catalog.get(actor, input.id!),
              history: catalog.history(actor, input.id!),
            }),
            points = Array.from(document),
            offset = input.offset ?? 0;
          let end = offset,
            content = '';
          while (
            end < points.length &&
            end - offset < 1800 &&
            JSON.stringify(content + points[end]!).length < 5600
          )
            content += points[end++]!;
          return JSON.stringify({ content, offset, nextOffset: end < points.length ? end : null });
        }
        const event = owner.session
          .snapshotEvents()
          .findLast(
            (e) =>
              e.type === 'tool/call' &&
              e.data.name === 'mat_local_commit' &&
              e.data.callId === exec.callId,
          );
        if (!event) throw new ProjectError('TOOL_CALL_ID_REQUIRED', '办理缺少真实原生工具调用事件');
        const operationId = messageIdentity(
          'mat-local-commit:' + owner.id + ':' + event.seq + ':' + exec.callId,
        );
        if (input.action === 'preview') {
          const plan = await service.preview(project, actor, input.preview),
            document = JSON.stringify({ ...plan, capturedAt: undefined }),
            points = Array.from(document),
            offset = input.offset ?? 0;
          let end = offset,
            content = '';
          while (
            end < points.length &&
            end - offset < 1800 &&
            JSON.stringify(content + points[end]!).length < 5500
          )
            content += points[end++]!;
          return JSON.stringify({
            fingerprint: plan.fingerprint,
            repository: plan.repository,
            head: plan.head,
            kind: plan.kind,
            fileCount: plan.files.length,
            content,
            offset,
            nextOffset: end < points.length ? end : null,
          });
        }
        const value =
          input.action === 'arrange'
            ? await service.arrange(project, actor, { ...input.arrange, operationId })
            : input.action === 'inspect'
              ? await service.inspect(
                  project,
                  actor,
                  input.id!,
                  { ...input.inspect, operationId },
                  exec.callId,
                )
              : input.action === 'report'
                ? await service.report(
                    project,
                    actor,
                    input.id!,
                    { ...input.report, operationId },
                    exec.callId,
                  )
                : input.action === 'reconcile'
                  ? await service.reconcile(
                      project,
                      actor,
                      input.id!,
                      { ...input.reconcile, operationId },
                      exec.callId,
                    )
                  : input.action === 'cancel'
                    ? await service.cancel(project, actor, input.id!, {
                        ...input.cancel,
                        operationId,
                      })
                    : await service.retry(project, actor, input.id!);
        return JSON.stringify({
          id: value.id,
          revision: value.revision,
          status: value.status,
          taskId: value.taskId,
          materialPath: value.materialPath,
          inspection: value.lastInspection,
          proof: value.lastProof,
          quiescence: value.lastQuiescence,
          notices: value.notices.map((n) => ({ id: n.id, state: n.state })),
          detailTool: 'mat_local_commit query',
        });
      },
    }),
  );
}
