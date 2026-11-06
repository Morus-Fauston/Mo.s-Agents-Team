import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { registeredRoleSchema } from '../src/contracts/roles';
import { completionSchema, reviewSchema } from '../src/contracts/completion';
import { request } from './request';
import { WorkbenchForm, text, useWorkbenchCommand } from './workbench-form';
import styles from './workbench.module.css';
const settingsSchema = z.object({
  scope: z.string(),
  reviewerRoleId: z.string().nullable(),
  inherit: z.boolean(),
});
export function ReviewSettings({ projectId, ticketId }: { projectId: string; ticketId?: string }) {
  const base = `/api/projects/${projectId}`,
    run = useWorkbenchCommand(projectId),
    query = useQuery({
      queryKey: ['review-settings', projectId, ticketId ?? 'project'],
      queryFn: async () => ({
        settings: settingsSchema.parse(
          await request(
            base +
              '/review-settings' +
              (ticketId ? '?ticketId=' + encodeURIComponent(ticketId) : ''),
          ),
        ),
        roles: z
          .array(registeredRoleSchema)
          .parse(await request(base + '/roles'))
          .filter((role) => role.type === 'reviewer'),
      }),
    });
  if (query.isPending) return <p role="status">正在读取审阅安排…</p>;
  if (query.isError) return <p role="alert">{query.error.message}</p>;
  const { settings, roles } = query.data,
    current = roles.find((role) => role.id === settings.reviewerRoleId);
  return (
    <section aria-label={ticketId ? '本票审阅安排' : '项目默认审阅安排'}>
      <p>
        {ticketId ? '本票审阅安排' : '项目默认审阅安排'}：
        {ticketId && settings.inherit ? '继承项目默认 · ' : ''}
        {current ? `${current.code} · ${current.name}` : '未指定；交回后保留主管待处理'}
      </p>
      <WorkbenchForm
        title={ticketId ? '本票审阅安排' : '项目默认审阅安排'}
        trigger={ticketId ? '设置本票审阅者' : '设置默认审阅者'}
        description="每次新开空上下文审阅会话。安排变更仅供后续交回或显式接续尚未预留会话的审核使用。"
        onSubmit={(form) => {
          const role = text(form, 'reviewerRoleId');
          return run(
            base + '/review-settings',
            {
              ...(ticketId ? { ticketId } : {}),
              reviewerRoleId: role === 'inherit' || !role ? null : role,
              inherit: role === 'inherit',
            },
            'PUT',
          );
        }}
      >
        <label>
          审阅角色
          <select
            aria-label="审阅角色"
            name="reviewerRoleId"
            defaultValue={
              ticketId && settings.inherit ? 'inherit' : (settings.reviewerRoleId ?? '')
            }
          >
            {ticketId && <option value="inherit">继承项目默认</option>}
            <option value="">不指定，交回后由主管处理</option>
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.code} · {role.name}
              </option>
            ))}
          </select>
        </label>
        {!roles.length && <p>请先在角色与会话中登记审阅类型角色。</p>}
      </WorkbenchForm>
    </section>
  );
}
const detailSchema = z.object({
  review: reviewSchema,
  completion: completionSchema,
  task: z.unknown(),
  versions: z.array(z.unknown()),
  requests: z.array(z.unknown()),
  native: z.object({
    loaded: z.boolean(),
    status: z.string().nullable(),
    goal: z.unknown(),
    goalError: z.string().nullable(),
  }),
});
function ReviewDetail({ projectId, reviewId }: { projectId: string; reviewId: string }) {
  const base = `/api/projects/${projectId}`,
    run = useWorkbenchCommand(projectId),
    query = useQuery({
      queryKey: ['review', projectId, reviewId],
      queryFn: async () => detailSchema.parse(await request(base + '/reviews/' + reviewId)),
    });
  if (query.isPending) return <p role="status">正在读取审核进展…</p>;
  if (query.isError) return <p role="alert">{query.error.message}</p>;
  const { review: r, completion: c, native } = query.data;
  return (
    <article aria-label="审核详情">
      <h4>固定交付 · {r.status}</h4>
      <dl className={styles.facts}>
        <dt>固定版本</dt>
        <dd>{r.versionId}</dd>
        <dt>审核</dt>
        <dd>{r.id}</dd>
        <dt>审阅角色</dt>
        <dd>
          {r.reviewerRole ? `${r.reviewerRole.code} · ${r.reviewerRole.name}` : '缺少合法审阅角色'}
        </dd>
        <dt>新审阅会话</dt>
        <dd>
          {r.sessionId ?? '尚未预留'} · {native.loaded ? native.status : '未加载；查询不会唤醒'}
        </dd>
        <dt>原执行等待</dt>
        <dd>
          {r.wait.state} · {r.wait.resultId ?? '尚无正式意见'}
        </dd>
        <dt>原执行挂起</dt>
        <dd>
          {r.authorPause.state} · {r.authorPause.note}
        </dd>
        <dt>独审创建</dt>
        <dd>
          {r.create.state} · {r.create.note}
        </dd>
        <dt>独审启动</dt>
        <dd>
          {r.start.state} · {r.start.note}
        </dd>
        <dt>审前工作区</dt>
        <dd>
          {r.workspaceCheck?.matches === true
            ? '与固定版本匹配'
            : r.workspaceCheck?.matches === false
              ? '已变化，审核应读取固定原件'
              : '尚未核对'}
          {r.workspaceCheck?.error}
        </dd>
        <dt>审阅材料域</dt>
        <dd>{r.materialPath ?? '尚未分配'}</dd>
        <dt>主管待处理</dt>
        <dd>{c.taskId}</dd>
      </dl>
      <h5>执行简报</h5>
      <p className={styles.markdown}>{c.input.summary}</p>
      <p>范围：{c.input.scope}</p>
      <p>证据入口：{c.input.evidencePaths.join('、') || '未提供'}</p>
      <p>{r.reason}</p>
      <ul>
        {r.notifications.map((notice) => (
          <li key={notice.messageId}>
            主管通知 {notice.messageId} · {notice.progress.state} · {notice.progress.note}
          </li>
        ))}
      </ul>
      {['missing-reviewer', 'unknown', 'failed', 'pending'].includes(r.status) && (
        <WorkbenchForm
          title="接续原审核"
          trigger="核对后接续原审核"
          description="沿原交付、审核和已预留会话接续。原生接纳未知时先核对，不另开替代。"
          onSubmit={(form) =>
            run(base + '/reviews/' + r.id + '/retry', { reason: text(form, 'reason') })
          }
        >
          <label>
            核对依据与接续理由
            <textarea aria-label="核对依据与接续理由" name="reason" required />
          </label>
        </WorkbenchForm>
      )}
      <details>
        <summary>正式待处理、请求和等待原始记录</summary>
        <pre className={styles.filePreview}>{JSON.stringify(query.data, null, 2)}</pre>
      </details>
      <p>通知接纳、已读或 Goal 结束均不代表审阅通过。正式意见与结票分别办理。</p>
    </article>
  );
}
export function ReviewProgress({
  projectId,
  executionId,
}: {
  projectId: string;
  executionId: string;
}) {
  const query = useQuery({
    queryKey: ['reviews', projectId, executionId],
    queryFn: async () =>
      z
        .array(reviewSchema)
        .parse(await request(`/api/projects/${projectId}/reviews?executionId=${executionId}`)),
  });
  if (query.isPending) return <p role="status">正在读取交回记录…</p>;
  if (query.isError) return <p role="alert">{query.error.message}</p>;
  return (
    <section aria-label="交回与独审进展">
      <h4>交回与独审</h4>
      {query.data.length ? (
        query.data.map((review) => (
          <ReviewDetail key={review.id} projectId={projectId} reviewId={review.id} />
        ))
      ) : (
        <p>尚未正式交回。原执行通过完成 Chat 固定版本并进入等待。</p>
      )}
    </section>
  );
}
