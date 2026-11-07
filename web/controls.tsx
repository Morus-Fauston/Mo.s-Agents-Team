import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { z } from 'zod';
import {
  controlSchema,
  ownedJobSchema,
  projectRuntimeSchema,
  recoveryPreviewSchema,
} from '../src/contracts/controls';
import { assistantControlInventorySchema } from '../src/contracts/assistant-controls';
import { WorkbenchForm, useWorkbenchCommand, text } from './workbench-form';
import { request } from './request';
import styles from './workbench.module.css';
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
  const [recoveryPage, setRecoveryPage] = useState(0),
    [recoveryRead, setRecoveryRead] = useState(0);
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
            assistants: z.array(assistantControlInventorySchema).default([]),
          })
          .parse(await request(path)),
      refetchInterval: 1500,
    }),
    recovery = useQuery({
      queryKey: ['recovery-preview', projectId, executionId, recoveryPage, recoveryRead],
      enabled: recoveryRead > 0,
      queryFn: async () =>
        recoveryPreviewSchema.parse(
          await request(
            `/api/projects/${projectId}/executions/${executionId}/recovery?offset=${recoveryPage * 40}`,
          ),
        ),
      retry: false,
      refetchOnWindowFocus: false,
    });
  if (query.isPending) return <p>正在读取控制与作业…</p>;
  if (query.isError) return <p role="alert">{query.error.message}</p>;
  const data = query.data;
  return (
    <section aria-label="执行控制">
      <h4>执行控制</h4>
      <p>请求、会话中断、后台结束和外部停稳分别记录；未知状态不释放写入占用。</p>
      <button
        type="button"
        onClick={() => {
          setRecoveryPage(0);
          setRecoveryRead((value) => value + 1);
        }}
      >
        核对恢复差异
      </button>
      {recoveryRead > 0 && recovery.isFetching && <p role="status">正在核对停稳后的现场…</p>}
      {recoveryRead > 0 && recovery.isError && <p role="alert">{recovery.error.message}</p>}
      {recovery.data && (
        <section aria-label="恢复差异" className={styles.recordRow}>
          <h5>{recovery.data.hasChanges ? '需要原主管判断' : '未发现实质变化'}</h5>
          {recovery.data.expectedRevision !== data.revision && <p>控制修订已变，请重新核对。</p>}
          {recovery.data.baselineMissing && <p>缺少完整停稳基线，不能判为未变化。</p>}
          {recovery.data.requirementsChanged && <p>票据要求有变化。</p>}
          {recovery.data.scopeChanged && <p>声明写域或目录有变化。</p>}
          {recovery.data.dependencyChanged && <p>直接依赖的有效版本有变化。</p>}
          <p>
            控制修订 {recovery.data.expectedRevision} · 文件变化 {recovery.data.fileCount} 项 ·
            规范变化 {recovery.data.norms.length} 项
          </p>
          {[
            ...recovery.data.files.map((item) => ({ ...item, kind: '文件' })),
            ...recovery.data.norms.map((item) => ({ ...item, kind: '规范' })),
          ].map((item) => (
            <p key={item.kind + item.path}>
              {item.kind} · {item.path} ·{' '}
              {item.before === null ? '新增' : item.after === null ? '已移除' : '内容变化'}
            </p>
          ))}
          {recoveryPage > 0 && (
            <button type="button" onClick={() => setRecoveryPage(recoveryPage - 1)}>
              上一页文件
            </button>
          )}
          {(recoveryPage + 1) * 40 < recovery.data.fileCount && (
            <button type="button" onClick={() => setRecoveryPage(recoveryPage + 1)}>
              下一页文件
            </button>
          )}
          {recovery.data.hasChanges && (
            <p>可在 Chat 交原主管判断是否沿本次差异恢复。此处查看不会恢复执行。</p>
          )}
        </section>
      )}
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
      <AssistantControls projectId={projectId} targets={data.assistants} />
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

function AssistantControls({
  projectId,
  targets,
}: {
  projectId: string;
  targets: z.infer<typeof assistantControlInventorySchema>[];
}) {
  const run = useWorkbenchCommand(projectId);
  if (!targets.length) return <p>本次主执行尚无辅助控制目标。</p>;
  const booleanFact = (value: boolean | null | undefined, yes: string, no: string) =>
    value === true ? yes : value === false ? no : '未核实';
  const sourceStates: Record<string, string> = {
    active: '工作关联有效',
    waiting: '等待后续',
    reporting: '正在交回',
    completed: '已完成',
    terminated: '已终止',
    unknown: '情况未知',
    error: '异常',
    creating: '正在准备',
    registered: '已登记',
  };
  return (
    <section aria-label="辅助逐目标控制">
      <h4>辅助逐目标状态</h4>
      <p>
        主控制只传播到本次未结束协作。恢复主负责人不会自动恢复辅助；独立暂停保留。下表显示各目标最近一次控制采样。
      </p>
      <div className={styles.tableWrap}>
        <table>
          <thead>
            <tr>
              <th>辅助</th>
              <th>控制来源</th>
              <th>控制进展</th>
              <th>会话</th>
              <th>在途工具</th>
              <th>文件</th>
              <th>作业与进程</th>
            </tr>
          </thead>
          <tbody>
            {targets.map((t) => (
              <tr key={t.collaborationId}>
                <td>
                  {t.address ?? '尚无会话'}
                  <br />
                  {t.name}
                  <br />
                  {sourceStates[t.state] ?? t.state}
                </td>
                <td>
                  {t.current ? (t.current.parentControlId ? '继承主控制' : '独立控制') : '尚无控制'}
                  {t.current?.blockedBy.length ? (
                    <>
                      <br />
                      另受独立暂停限制
                    </>
                  ) : null}
                </td>
                <td>{t.current ? statusLabels[t.current.status] : '尚无控制记录'}</td>
                <td>{booleanFact(t.current?.observation?.agentIdle, '已空闲', '仍在运行')}</td>
                <td>
                  {booleanFact(t.current?.observation?.inFlightTools, '仍有在途工具', '无在途工具')}
                </td>
                <td>
                  {booleanFact(t.current?.observation?.filesStable, '已采样稳定', '仍在变化')}
                </td>
                <td>
                  {booleanFact(
                    t.current?.observation?.processesComplete,
                    '范围已核清',
                    '范围未核清',
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {targets.map((t) => {
        const ended = ['completed', 'terminated'].includes(t.state),
          label = t.address ?? t.name;
        return (
          <details key={t.collaborationId} className={styles.request}>
            <summary>{label} · 操作与证据</summary>
            <p>
              控制修订 {t.revision} · 关联 {t.collaborationId}
            </p>
            <div className={styles.actions}>
              {t.sessionId &&
                !ended &&
                (['soft-stop', 'hard-stop', 'terminate', 'resume'] as const)
                  .filter((action) => action !== 'resume' || t.current?.status === 'stopped')
                  .map((action) => {
                    const actionLabel = {
                      'soft-stop': '软停止',
                      'hard-stop': '硬停止',
                      terminate: '终止',
                      resume: '明确恢复',
                    }[action];
                    return (
                      <WorkbenchForm
                        key={action}
                        title={`${actionLabel}辅助 ${label}`}
                        trigger={`${actionLabel} ${label}`}
                        description={
                          action === 'resume'
                            ? '先核对原主负责人已恢复、当前范围和未知副作用。这里只恢复此辅助，不新建会话或Goal。'
                            : action === 'soft-stop'
                              ? '仅向此辅助投递收尾要求，不cancel或kill。真实回报与停稳分开核对。'
                              : '只控制此协作实际原生目标及其登记作业，不回滚文件；未知不释放占用。'
                        }
                        onSubmit={(form) =>
                          run(
                            `/api/projects/${projectId}/collaborations/${t.collaborationId}/control`,
                            {
                              action,
                              expectedRevision: t.revision,
                              reason: text(form, 'reason'),
                              ...(action === 'soft-stop' ? { content: text(form, 'content') } : {}),
                            },
                          )
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
                    );
                  })}
              {t.current && t.current.status !== 'resumed' && (
                <WorkbenchForm
                  title={`补核辅助 ${label}`}
                  trigger={`补核 ${label}`}
                  description="沿原控制ID读取实际停稳。软停止要求未确认送达时可补投同一要求；不重放工作或新建替代会话。"
                  onSubmit={(form) =>
                    run(`/api/projects/${projectId}/assistant-controls/${t.current!.id}/retry`, {
                      expectedRevision: t.current!.revision,
                      reason: text(form, 'reason'),
                    })
                  }
                >
                  <label>
                    补核原因
                    <input aria-label="补核原因" name="reason" required />
                  </label>
                </WorkbenchForm>
              )}
            </div>
            {t.current?.report && <p>实际辅助回报：{t.current.report.content}</p>}
            {t.current?.error && <p role="status">{t.current.error}</p>}
            {t.current && (
              <pre className={styles.filePreview}>
                {JSON.stringify(
                  {
                    controlId: t.current.id,
                    parentControlId: t.current.parentControlId,
                    blockedBy: t.current.blockedBy,
                    goal: t.current.goal,
                    cancel: t.current.cancel,
                    jobKills: t.current.jobKills,
                    observation: t.current.observation,
                    resumeSnapshot: t.current.resumeSnapshot,
                  },
                  null,
                  2,
                )}
              </pre>
            )}
          </details>
        );
      })}
    </section>
  );
}
