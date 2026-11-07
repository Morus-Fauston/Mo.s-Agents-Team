import { z } from 'zod';
import type { NativeAgent, NativeContext, NativeModules, ToolDefinition } from './native.ts';
import type { ProjectConnection } from '../services/project.ts';
import type { WorktreeService } from '../services/worktrees.ts';
import {
  worktreeCreateSchema,
  worktreeReconcileSchema,
  worktreeCleanupInputSchema,
} from '../contracts/worktrees.ts';
import { nativeToolParameters } from './tool-parameters.ts';
import { messageIdentity } from '../services/message-presentation.ts';
import { ProjectError } from '../services/errors.ts';
export function installWorktreeTools(
  ctx: NativeContext,
  owner: NativeAgent,
  modules: NativeModules,
  role: string,
  resolve: (agent: NativeAgent) => { connection: ProjectConnection; sessionId: string },
  service: WorktreeService,
  observe: (definition: ToolDefinition) => ToolDefinition = (definition) => definition,
) {
  type Exec = { agent?: NativeAgent; callId: string; signal: AbortSignal };
  const caller = (exec: Exec) => {
    if (exec.agent !== owner)
      throw new ProjectError('TOOL_CALLER_MISMATCH', '工作树工具不属于实际调用者');
    const s = resolve(owner);
    return {
      ...s,
      actor: { kind: 'session' as const, sessionId: s.sessionId },
      project: s.connection.snapshot().id,
    };
  };
  const op = (name: string, exec: Exec) => {
    const e = owner.session
      .snapshotEvents()
      .findLast(
        (e) => e.type === 'tool/call' && e.data.name === name && e.data.callId === exec.callId,
      );
    if (!e) throw new ProjectError('TOOL_CALL_ID_REQUIRED', '工作树动作缺少真实原生调用事件');
    return messageIdentity(
      'mat-worktree:' + name + ':' + owner.id + ':' + e.seq + ':' + exec.callId,
    );
  };
  const page = (value: unknown, offset = 0) => {
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
  const summary = (v: Awaited<ReturnType<WorktreeService['create']>>) => ({
    worktreeId: v.id,
    status: v.status,
    revision: v.revision,
    path: v.path,
    branch: v.branch,
    sourceRepository: v.source.repository,
    baseCommit: v.source.commit,
    uncommittedPolicy: '只从明确本地commit检出；不搬运原树未提交内容',
    sourceChanges: v.source.changes.length,
    sourceStagedPaths: v.source.indexPaths,
    executionId: v.executionId,
    materialPolicy: '固定宿主项目.TEAM及原执行材料域，不随树迁移',
    directoryPublication: v.directoryPublication,
    restoredOriginalCwd: v.restore,
    retention: v.retention,
    error: v.error,
    cleanup: v.cleanup
      ? { state: v.cleanup.state, proof: v.cleanup.proof, error: v.cleanup.error }
      : null,
    detailTool: 'mat_worktree query',
  });
  const register = (
    name: string,
    description: string,
    schema: z.ZodType,
    execute: (raw: unknown, exec: Exec) => Promise<unknown>,
    when?: () => boolean,
  ) =>
    ctx.tools.register(
      observe(
        modules.defineTool({
          name,
          description,
          parameters: nativeToolParameters(schema),
          output: {
            schema: { type: 'string' },
            render: (_a: unknown, v: string) => [{ type: 'text', text: v }],
          },
          execute: async (raw: unknown, exec: Exec) => JSON.stringify(await execute(raw, exec)),
        }),
      ),
      when ? { when } : undefined,
    );
  const create = worktreeCreateSchema.omit({ operationId: true });
  const query = z
    .object({
      action: z.enum(['create', 'query', 'reconcile', 'cleanup']),
      id: z.uuid().optional(),
      create: create.optional(),
      reconcile: worktreeReconcileSchema.omit({ operationId: true }).optional(),
      cleanup: worktreeCleanupInputSchema.omit({ operationId: true }).optional(),
      offset: z.number().int().nonnegative().optional(),
    })
    .strict();
  register(
    'mat_worktree',
    '按需官方工作树及原票/执行关联。create仅填create；主管准备明确ticketId/repository/from(本地基线)/name/basis，主执行只在本票原源码未改且没有送审/活动协作时创建，不转授Git提交权。query可不填id列目录，填id分页读原记录。reconcile填id/reconcile.expectedRevision及reason，仅回读原Git登记和目录，不重新create。目录缺失或unknown不回旧根写入。默认保留。cleanup仅主管在明确清理授权内填id及cleanup.expectedRevision/expectedHead/basis；核对无在途、干净且已合入、原件已保留后只移除检出，不删分支/记录，不force；unknown先reconcile，不能重复remove。相关下一票由主管mat_dispatch明确worktreeId续用，不建长期团队。项目.TEAM及材料固定原宿主根。',
    query,
    async (raw, exec) => {
      const input = query.parse(raw),
        s = caller(exec),
        catalog = s.connection.worktrees();
      if (input.action === 'query') {
        if (input.create || input.reconcile || input.cleanup)
          throw new ProjectError('WORKTREE_INPUT', 'query只填id/offset');
        return page(
          input.id
            ? {
                record: catalog.get(s.actor, input.id),
                history: catalog.history(s.actor, input.id),
              }
            : catalog.list(s.actor).map((v) => ({
                id: v.id,
                ticketId: v.ticketId,
                executionId: v.executionId,
                path: v.path,
                branch: v.branch,
                baseCommit: v.source.commit,
                status: v.status,
                revision: v.revision,
                retention: v.retention,
              })),
          input.offset,
        );
      }
      if (input.offset !== undefined) throw new ProjectError('WORKTREE_INPUT', '只有query分页');
      const operationId = op('mat_worktree', exec);
      if (input.action === 'create') {
        if (!input.create || input.reconcile || input.cleanup || input.id)
          throw new ProjectError('WORKTREE_INPUT', 'create只填create');
        return summary(
          await service.create(
            s.project,
            s.actor,
            { ...input.create, operationId },
            exec.callId,
            exec.signal,
          ),
        );
      }
      if (input.action === 'cleanup') {
        if (!input.id || !input.cleanup || input.create || input.reconcile)
          throw new ProjectError('WORKTREE_INPUT', 'cleanup须准确id及cleanup，不混其他参数');
        return summary(
          await service.cleanup(
            s.project,
            s.actor,
            input.id,
            { ...input.cleanup, operationId },
            exec.callId,
            exec.signal,
          ),
        );
      }
      if (!input.id || !input.reconcile || input.create || input.cleanup)
        throw new ProjectError('WORKTREE_INPUT', 'reconcile须指定原id和核对内容');
      return summary(
        await service.reconcile(
          s.project,
          s.actor,
          input.id,
          { ...input.reconcile, operationId },
          exec.callId,
        ),
      );
    },
  );
  if (['supervisor', 'developer', 'investigator'].includes(role))
    register(
      'create_worktree',
      '调用当前宿主官方worktrees.create创建并进入明确本地基线的新树；MAT额外保存原票、真实来源及结果。name/from沿官方含义，from不fetch、不携带未提交内容。主管代准备须ticketId和basis，可明确repository，成功恢复主管原cwd；原主仅本票早期自用，原Goal/材料不变，旧启动基线保留。辅助/审阅/提交不开放；未知先mat_worktree query/reconcile，不重复创建。',
      create.partial({ basis: true }),
      async (raw, exec) => {
        const s = caller(exec),
          input = create.partial({ basis: true }).parse(raw);
        return summary(
          await service.create(
            s.project,
            s.actor,
            {
              ...input,
              basis:
                input.basis ??
                '本票已授权范围内的独立源码空间；未提交修改留在原树，不取得提交/合入权',
              operationId: op('create_worktree', exec),
            },
            exec.callId,
            exec.signal,
          ),
        );
      },
      () => {
        if (!service.available) return false;
        const binding = resolve(owner);
        return !binding.connection.collaborations().currentForSession(binding.sessionId);
      },
    );
}
