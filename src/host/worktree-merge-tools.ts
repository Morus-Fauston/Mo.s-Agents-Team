import { z } from 'zod';
import type { NativeAgent, NativeContext, NativeModules } from './native.ts';
import type { ProjectConnection } from '../services/project.ts';
import type { WorktreeMergeService } from '../services/worktree-merges.ts';
import {
  mergePreviewInputSchema,
  mergeArrangeInputSchema,
  mergeInspectInputSchema,
  mergeReportInputSchema,
  mergeReconcileInputSchema,
  mergeRepairInputSchema,
  mergeReviewLinkInputSchema,
} from '../contracts/worktree-merges.ts';
import { nativeToolParameters } from './tool-parameters.ts';
import { messageIdentity } from '../services/message-presentation.ts';
import { ProjectError } from '../services/errors.ts';
const page = (value: unknown, offset: number) => {
  const points = Array.from(JSON.stringify(value));
  let end = offset,
    content = '';
  while (
    end < points.length &&
    end - offset < 1800 &&
    JSON.stringify(content + points[end]!).length < 5500
  )
    content += points[end++]!;
  return { content, offset, nextOffset: end < points.length ? end : null };
};
export function installWorktreeMergeTools(
  ctx: NativeContext,
  owner: NativeAgent,
  modules: NativeModules,
  resolve: (agent: NativeAgent) => { connection: ProjectConnection; sessionId: string },
  service: WorktreeMergeService,
) {
  const schema = z
    .object({
      action: z.enum([
        'preview',
        'arrange',
        'query',
        'inspect',
        'report',
        'reconcile',
        'prepare-repair',
        'confirm-repair',
        'confirm-combination',
        'record-combination-failure',
        'retry-notice',
        'cancel',
      ]),
      id: z.uuid().optional(),
      offset: z.number().int().nonnegative().optional(),
      preview: mergePreviewInputSchema.optional(),
      arrange: mergeArrangeInputSchema.omit({ operationId: true }).optional(),
      inspect: mergeInspectInputSchema.omit({ operationId: true }).optional(),
      report: mergeReportInputSchema.omit({ operationId: true }).optional(),
      reconcile: mergeReconcileInputSchema.omit({ operationId: true }).optional(),
      repair: mergeRepairInputSchema.omit({ operationId: true }).optional(),
      review: mergeReviewLinkInputSchema.omit({ operationId: true }).optional(),
      cancel: mergeReconcileInputSchema.omit({ operationId: true }).optional(),
    })
    .strict();
  ctx.tools.register(
    modules.defineTool({
      name: 'mat_merge',
      description:
        '主管安排跨树普通合入。preview明确目标repo、源worktree/version/result/完整sourceCommit并分页读完；arrange填arrange绑定原提交会话、指纹及另行组合票。query用id分页完整读原输入/历史。原提交者inspect，仅ready时执行一次git -C 准确目标 merge --no-edit --no-overwrite-ignore -- 原sourceCommit；already-contained不写Git。冲突不得擅选一边或重做。主管prepare-repair填repair明确新修正票与范围，再mat_dispatch带mergeId派开发者；新固定交付和指定pass后confirm-repair填review。原提交者再inspect：continue-stage只git add -A -- repair.paths，随后再次inspect；continue-commit才git commit --no-edit，不再merge。report如实保存自报，reconcile沿原id独立回读未知。Git核定只awaiting-verification：主管另派组合票带mergeId，完成新固定版本与指定pass后confirm-combination填review。record-combination-failure填review保存当前指定return、失败固定版本和恢复条件，不释放原执行。组合实质修正的新固定交付和指定pass齐备后，主管用mat_local_commit arrange.mergeId关联本事项并绑定新versionIds，明确全部准确必要提交；本地回执核定后沿本id reconcile，再用mat_delivery_supplement在新HEAD安排组合补做（dispatch.mergeId仍填本id），新检查和新意见后再confirm-combination。retry-notice只补原通知；cancel仅核定原合入未发生且安静可撤销，不abort/reset/stash/重写历史/推送。正文不能传actor/proof/native/操作身份，不能把旧pass当新差异通过。',
      parameters: nativeToolParameters(schema),
      output: {
        schema: { type: 'string' },
        render: (_a: unknown, value: string) => [{ type: 'text', text: value }],
      },
      execute: async (raw: unknown, exec: { agent?: NativeAgent; callId: string }) => {
        if (exec.agent !== owner)
          throw new ProjectError('TOOL_CALLER_MISMATCH', '合入工具不属于实际调用者');
        const input = schema.parse(raw),
          s = resolve(owner),
          actor = { kind: 'session' as const, sessionId: s.sessionId },
          project = s.connection.snapshot().id;
        const field =
          input.action === 'prepare-repair'
            ? 'repair'
            : ['confirm-repair', 'confirm-combination', 'record-combination-failure'].includes(
                  input.action,
                )
              ? 'review'
              : ['preview', 'arrange', 'inspect', 'report', 'reconcile', 'cancel'].includes(
                    input.action,
                  )
                ? input.action
                : null;
        for (const name of [
          'preview',
          'arrange',
          'inspect',
          'report',
          'reconcile',
          'repair',
          'review',
          'cancel',
        ] as const)
          if (
            (name !== field && input[name] !== undefined) ||
            (name === field && input[name] === undefined)
          )
            throw new ProjectError('MERGE_TOOL_INPUT', '只填写当前动作对应参数');
        if (
          ['preview', 'arrange'].includes(input.action)
            ? input.id !== undefined
            : input.id === undefined
        )
          throw new ProjectError('MERGE_TOOL_INPUT', '办理原事项须准确id；预核/安排不填旧id');
        if (!['query', 'preview'].includes(input.action) && input.offset !== undefined)
          throw new ProjectError('MERGE_TOOL_INPUT', '分页仅用于query或preview');
        if (input.action === 'query')
          return JSON.stringify(
            page(
              {
                arrangement: s.connection.worktreeMerges().get(actor, input.id!),
                history: s.connection.worktreeMerges().history(actor, input.id!),
              },
              input.offset ?? 0,
            ),
          );
        const event = owner.session
          .snapshotEvents()
          .findLast(
            (e) =>
              e.type === 'tool/call' &&
              e.data.name === 'mat_merge' &&
              e.data.callId === exec.callId,
          );
        if (!event) throw new ProjectError('TOOL_CALL_ID_REQUIRED', '合入动作缺少真实原生调用事件');
        const operationId = messageIdentity(
          'mat-merge:' + owner.id + ':' + event.seq + ':' + exec.callId,
        );
        if (input.action === 'preview') {
          const preview = await service.preview(project, actor, input.preview);
          return JSON.stringify({
            fingerprint: preview.fingerprint,
            mode: preview.plan.mode,
            conflictCount: preview.plan.conflictPaths.length,
            ...page(
              {
                ...preview,
                plan: { ...preview.plan, objectDirectory: undefined, capturedAt: undefined },
              },
              input.offset ?? 0,
            ),
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
                  ? await service.reconcile(project, actor, input.id!, {
                      ...input.reconcile,
                      operationId,
                    })
                  : input.action === 'prepare-repair'
                    ? await service.prepareRepair(project, actor, input.id!, {
                        ...input.repair,
                        operationId,
                      })
                    : input.action === 'confirm-repair'
                      ? await service.confirmRepair(project, actor, input.id!, {
                          ...input.review,
                          operationId,
                        })
                      : input.action === 'confirm-combination'
                        ? await service.confirmCombination(project, actor, input.id!, {
                            ...input.review,
                            operationId,
                          })
                        : input.action === 'record-combination-failure'
                          ? await service.recordCombinationFailure(project, actor, input.id!, {
                              ...input.review,
                              operationId,
                            })
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
          inspection: value.lastInspection,
          proof: value.lastProof
            ? {
                state: value.lastProof.state,
                resultHead: value.lastProof.resultHead,
                currentHead: value.lastProof.currentHead,
                resultTree: value.lastProof.resultTree,
                reason: value.lastProof.reason,
                conflictCount: value.lastProof.conflictPaths.length,
              }
            : null,
          quiescence: value.lastQuiescence,
          repair: value.repair
            ? {
                executionId: value.repair.executionId,
                version: value.repair.version?.versionId,
                pathCount: value.repair.paths.length,
                expectedTree: value.repair.expectedTree,
              }
            : null,
          combination: value.combination,
          noticeCount: value.notices.length,
          detailTool: 'mat_merge query',
        });
      },
    }),
  );
}
