import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { executionSchema, executionStepSchema, nativeGoalSchema } from '../源码/契约/执行';
import { request } from './请求';
import styles from './工作台.module.css';
const detailSchema = z.object({
  record: executionSchema,
  steps: z.array(executionStepSchema),
  events: z.array(z.object({ kind: z.string(), at: z.string(), data: z.unknown() })),
  native: z.object({
    loaded: z.boolean(),
    status: z.string().nullable(),
    cwd: z.string().nullable(),
    selection: z.unknown(),
    goal: nativeGoalSchema.nullable(),
    lastGoalSnapshot: nativeGoalSchema.nullable(),
    goalError: z.string().nullable(),
  }),
  requests: z.array(z.unknown()),
  materials: z.array(z.unknown()),
  unavailableActions: z.array(z.string()),
  coordinationBasis: z.string(),
});
const stages = {
  registered: '已登记，尚未准备',
  'creating-session': '正在创建会话',
  'session-prepared': '会话已准备，尚未确认开始',
  starting: '正在启动，等待实际步骤',
  confirmed: '持续启动已确认',
  error: '启动或执行异常',
  unknown: '结果未知，保留原执行核对',
};
export function ExecutionObservation({
  projectId,
  executionId,
}: {
  projectId: string;
  executionId: string | null;
}) {
  const query = useQuery({
    queryKey: ['execution', projectId, executionId],
    enabled: !!executionId,
    queryFn: async () =>
      detailSchema.parse(await request(`/api/projects/${projectId}/executions/${executionId}`)),
  });
  if (!executionId) return <p>尚无正式派工。请通过 Chat 向主管提出单票派工要求。</p>;
  if (query.isPending) return <p role="status">正在读取执行事实…</p>;
  if (query.isError) return <p role="alert">{query.error.message}</p>;
  const { record: r, native, steps } = query.data,
    goal = native.goal ?? native.lastGoalSnapshot;
  return (
    <section aria-label="执行观察">
      <h4>{stages[r.startupState]}</h4>
      <p>
        启动观察：已完成 {r.completedSteps} 个实际 Agent 步骤，持续启动要求至少 3
        步。此数不代表票据完成度。
      </p>
      <dl className={styles.facts}>
        <dt>派工</dt>
        <dd>{r.dispatchId}</dd>
        <dt>执行</dt>
        <dd>{r.id}</dd>
        <dt>会话</dt>
        <dd>
          {r.sessionId ?? '尚未取得'} ·{' '}
          {native.loaded ? `已加载 · ${native.status}` : '未加载；查询不会唤醒'}
        </dd>
        <dt>写入占用</dt>
        <dd>
          {r.writeOccupancy} · {r.lifecycleState}
        </dd>
        <dt>源码目录</dt>
        <dd>{r.cwd}</dd>
        <dt>声明写域</dt>
        <dd>{r.writeScopes.join('、') || '未声明源码写入'}</dd>
        <dt>首次实际请求</dt>
        <dd>
          {r.firstRequestId ?? '尚无'} · {r.firstStartedAt ?? '—'}
        </dd>
        <dt>Goal</dt>
        <dd>
          {r.goalId ?? '尚未取得'} ·{' '}
          {goal
            ? `${goal.phase} · ${goal.activation} · 已开始 ${goal.roundsStarted} 轮`
            : '不可读取'}{' '}
          · {native.goal ? '当前宿主读取' : '最后持久快照'}
        </dd>
      </dl>
      {r.failure && (
        <p role="alert">
          {r.failure.message} · {r.failure.code}。保留原执行核对，不自动重派。
        </p>
      )}
      {native.goalError && <p role="alert">{native.goalError}</p>}
      <h4>实际步骤</h4>
      <div className={styles.tableWrap}>
        <table>
          <thead>
            <tr>
              <th>轮 / 步</th>
              <th>请求次数</th>
              <th>请求结果</th>
              <th>步骤已收尾</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((step) => (
              <tr key={`${step.turn}:${step.step}`}>
                <td>
                  {step.turn} / {step.step}
                </td>
                <td>{step.requestIds.length}</td>
                <td>
                  {step.lastRequestStatus ?? '尚无请求'}
                  {step.failed ? ' · 该步失败' : ''}
                </td>
                <td>{step.settled ? '是' : '尚未确认'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details>
        <summary>本次配置与实际请求</summary>
        <pre className={styles.filePreview}>
          {JSON.stringify(
            {
              configurationBasis: r.configurationBasis,
              requested: r.requestedConfiguration,
              resolved: r.resolvedConfiguration,
              currentNative: native.selection,
              requests: query.data.requests,
            },
            null,
            2,
          )}
        </pre>
      </details>
      <details>
        <summary>材料写域</summary>
        <pre className={styles.filePreview}>{JSON.stringify(query.data.materials, null, 2)}</pre>
      </details>
      <details>
        <summary>公开执行事件与通知</summary>
        <pre className={styles.filePreview}>
          {JSON.stringify({ events: query.data.events, notifications: r.notifications }, null, 2)}
        </pre>
      </details>
      <p>{query.data.coordinationBasis}</p>
      <p>{query.data.unavailableActions.join('；')}</p>
    </section>
  );
}
