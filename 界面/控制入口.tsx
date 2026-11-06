import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import { controlSchema, ownedJobSchema, projectRuntimeSchema } from '../源码/契约/控制';
import { WorkbenchForm, useWorkbenchCommand, text } from './工作台表单';
import { request } from './请求';
import styles from './工作台.module.css';
const projectStates = {
  stopped: '已核对停止',
  starting: '正在准备',
  running: '已启动',
  stopping: '停止请求处理中',
  unknown: '尚未停稳或情况未知',
  error: '启动异常',
  'forced-stopped': '已强制退出，停稳未保证',
};
export function ProjectControls({ projectId }: { projectId: string }) {
  const base = `/api/projects/${projectId}/control`,
    run = useWorkbenchCommand(projectId),
    client = useQueryClient(),
    query = useQuery({
      queryKey: ['project-control', projectId],
      queryFn: async () =>
        z
          .object({ runtime: projectRuntimeSchema, desiredStarted: z.boolean() })
          .parse(await request(base)),
      refetchInterval: 1500,
    });
  if (query.isPending) return <p>正在读取项目运行状态…</p>;
  if (query.isError) return <p role="alert">{query.error.message}</p>;
  return (
    <section aria-label="项目控制">
      <p>
        {projectStates[query.data.runtime.state]} · {query.data.runtime.reason}
      </p>
      <div className={styles.actions}>
        {(['start', 'stop', 'force-stop'] as const).map((action) => (
          <WorkbenchForm
            key={action}
            title={{ start: '启动项目', stop: '停止项目', 'force-stop': '强制退出项目' }[action]}
            trigger={{ start: '启动项目', stop: '停止项目', 'force-stop': '强制退出' }[action]}
            description={
              action === 'start'
                ? '开始接收派工并通知主管；暂停的执行仍须明确恢复。'
                : action === 'stop'
                  ? '立即停止接收新派工，要求本项目现有执行收尾。网页关闭不会代替停止。'
                  : '将请求本项目已关联执行硬停止；未知工具和外部进程可能仍在运行，写入占用继续保留，不退出DSH。'
            }
            onSubmit={async (form) => {
              await run(base, { action, reason: text(form, 'reason') });
              await client.invalidateQueries({ queryKey: ['projects'] });
            }}
          >
            <label>
              原因
              <input aria-label="原因" name="reason" required />
            </label>
          </WorkbenchForm>
        ))}
      </div>
    </section>
  );
}
const statusLabels = {
  requested: '请求已保存',
  delivered: '要求已投递',
  handoff: '挂起回报已保存',
  checking: '正在核对停稳',
  stopped: '本次范围已核对停止',
  unknown: '情况未知',
  failed: '失败',
  resumed: '恢复已接纳，实际运行另验',
  terminated: '原尝试已终止',
};
export function ExecutionControls({
  projectId,
  executionId,
}: {
  projectId: string;
  executionId: string;
}) {
  const path = `/api/projects/${projectId}/executions/${executionId}/control`,
    run = useWorkbenchCommand(projectId),
    query = useQuery({
      queryKey: ['execution-control', projectId, executionId],
      queryFn: async () =>
        z
          .object({
            revision: z.number(),
            controls: z.array(controlSchema),
            jobs: z.array(ownedJobSchema),
          })
          .parse(await request(path)),
      refetchInterval: 1500,
    });
  if (query.isPending) return <p>正在读取控制与作业…</p>;
  if (query.isError) return <p role="alert">{query.error.message}</p>;
  const data = query.data;
  return (
    <section aria-label="执行控制">
      <h4>执行控制</h4>
      <p>请求、会话中断、后台结束和外部停稳分别记录；未知状态不释放写入占用。</p>
      <div className={styles.actions}>
        {(['soft-stop', 'hard-stop', 'terminate', 'resume', 'reconcile'] as const).map((action) => (
          <WorkbenchForm
            key={action}
            title={
              {
                'soft-stop': '软停止',
                'hard-stop': '硬停止',
                terminate: '终止本次执行',
                resume: '明确恢复',
                reconcile: '核对停止现场',
              }[action]
            }
            trigger={
              {
                'soft-stop': '软停止',
                'hard-stop': '硬停止',
                terminate: '终止本次执行',
                resume: '明确恢复',
                reconcile: '核对现场',
              }[action]
            }
            description={
              action === 'soft-stop'
                ? '投递收尾要求，由会话自己保存记录、结束作业并挂起回报；不调用cancel或kill。'
                : action === 'hard-stop' || action === 'terminate'
                  ? '请求中断原轮并逐个处理已登记作业，不回滚文件。终止另行clear原Goal，不等于结票或封存。'
                  : action === 'resume'
                    ? '核对最新票据、规范、原Goal、消息与写域后恢复同次尝试；终止或未知副作用不能绕过。'
                    : '只按已有记录与真实现场核对，不唤醒模型，不补发未知副作用。'
            }
            onSubmit={(form) =>
              run(path, {
                action,
                reason: text(form, 'reason'),
                content: text(form, 'content'),
                expectedRevision: data.revision,
              })
            }
          >
            <label>
              原因
              <input aria-label="原因" name="reason" required />
            </label>
            {action === 'soft-stop' && (
              <label>
                收尾正文
                <textarea aria-label="收尾正文" name="content" />
              </label>
            )}
          </WorkbenchForm>
        ))}
      </div>
      <h4>后台作业</h4>
      {data.jobs.length ? (
        data.jobs.map((job) => (
          <p key={job.id}>
            {job.id} · {job.status} · 登记事件 {job.registeredSeq ?? '缺失'} · 结束事件{' '}
            {job.settledSeq ?? '尚无'}
            <br />
            {job.label}
          </p>
        ))
      ) : (
        <p>当前无已关联后台作业记录；此项本身不证明外部已停稳。</p>
      )}
      <h4>控制记录</h4>
      {[...data.controls].reverse().map((value) => (
        <article key={value.id} className={styles.recordRow}>
          <h5>
            {statusLabels[value.status]} · 修订 {value.revision}
          </h5>
          <p>
            {value.action} · {value.reason} · {value.id}
          </p>
          {value.report && <p>实际回报：{value.report.content}</p>}
          <details>
            <summary>Goal、取消、逐作业回执与外部观察</summary>
            <pre className={styles.filePreview}>
              {JSON.stringify(
                {
                  goal: value.goal,
                  cancel: value.cancel,
                  jobs: value.jobKills,
                  observation: value.observation,
                  resumeSnapshot: value.resumeSnapshot,
                },
                null,
                2,
              )}
            </pre>
          </details>
        </article>
      ))}
    </section>
  );
}
