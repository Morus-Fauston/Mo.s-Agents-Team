import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { z } from 'zod';
import type { ProjectView } from '../src/contracts/project';
import {
  phaseSchema,
  categorySchema,
  ticketSchema,
  supervisorTaskSchema,
  feedbackSchema,
  historyEntrySchema,
} from '../src/contracts/workbench';
import type { PhaseRecord } from '../src/contracts/workbench';
import { request } from './request';
import { useProjectUpdates } from './project-events';
import {
  WorkbenchForm,
  useWorkbenchCommand,
  text,
  lines,
  VerificationSelect,
} from './workbench-form';
import type { WorkbenchCommand } from './workbench-form';
import { TicketDetails } from './ticket-details';
import { stateLabels, historyLabels } from './ticket-state';
import styles from './workbench.module.css';
export const ticketBriefSchema = ticketSchema.pick({
  id: true,
  code: true,
  title: true,
  goal: true,
  state: true,
  phaseId: true,
  categoryId: true,
  dependencies: true,
  currentExecution: true,
});
export const workbenchSnapshotSchema = z.object({
  phases: z.array(phaseSchema),
  categories: z.array(categorySchema),
  tickets: z.array(ticketBriefSchema),
  tasks: z.array(supervisorTaskSchema),
  feedback: z.array(feedbackSchema),
  history: z.array(historyEntrySchema),
});
export type WorkbenchSnapshot = z.infer<typeof workbenchSnapshotSchema>;
const phaseLabels = {
  unopened: '未开放',
  opened: '已开放',
  closing: '收口中',
  closed: '已收口',
} as const;
function PhaseForms({
  base,
  phase,
  phases,
  run,
}: {
  base: string;
  phase: PhaseRecord | undefined;
  phases: PhaseRecord[];
  run: WorkbenchCommand;
}) {
  return (
    <div className={styles.actions}>
      <WorkbenchForm
        title="建立期次"
        trigger="新建期次"
        onSubmit={(data) =>
          run(base + '/phases', {
            name: text(data, 'name'),
            goal: text(data, 'goal'),
            basis: text(data, 'basis'),
            note: text(data, 'note'),
            ...(text(data, 'parentId') ? { parentId: text(data, 'parentId') } : {}),
            checklist: lines(text(data, 'conditions')).map((condition) => ({
              condition,
              verification: 'manual',
            })),
          })
        }
      >
        <label>
          名称
          <input aria-label="名称" name="name" required maxLength={160} />
        </label>
        <label>
          一句目标
          <textarea name="goal" aria-label="期次目标" required />
        </label>
        <label>
          主要依据
          <textarea name="basis" aria-label="期次依据" required />
        </label>
        <label>
          说明
          <textarea aria-label="说明" name="note" />
        </label>
        <label>
          补充哪一期（可选）
          <select aria-label="补充哪一期（可选）" name="parentId" defaultValue="">
            <option value="">普通新期次</option>
            {phases
              .filter((item) => item.parentId === null)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.code} {item.name}
                </option>
              ))}
          </select>
        </label>
        <label>
          期次确认条件（每行一项）
          <textarea aria-label="期次确认条件（每行一项）" name="conditions" />
        </label>
      </WorkbenchForm>
      <WorkbenchForm
        title="定义票据类别"
        trigger="新增类别"
        onSubmit={(data) =>
          run(base + '/categories', { code: text(data, 'code'), name: text(data, 'name') })
        }
      >
        <label>
          类别标识
          <input
            aria-label="类别标识"
            name="code"
            required
            pattern="[A-Z]{1,16}"
            placeholder="填写项目所需的大写字母"
          />
        </label>
        <label>
          类别名称
          <input aria-label="类别名称" name="name" required maxLength={160} />
        </label>
      </WorkbenchForm>
      {phase && (
        <>
          <WorkbenchForm
            title="维护期次记录"
            trigger="编辑期次"
            onSubmit={(data) =>
              run(
                base + `/phases/${phase.id}`,
                {
                  expectedRevision: phase.revision,
                  name: text(data, 'name'),
                  goal: text(data, 'goal'),
                  basis: text(data, 'basis'),
                  note: text(data, 'note'),
                  reason: text(data, 'reason'),
                },
                'PATCH',
              )
            }
          >
            <label>
              名称
              <input aria-label="名称" name="name" defaultValue={phase.name} required />
            </label>
            <label>
              目标
              <textarea aria-label="目标" name="goal" defaultValue={phase.goal} required />
            </label>
            <label>
              主要依据
              <textarea aria-label="主要依据" name="basis" defaultValue={phase.basis} required />
            </label>
            <label>
              说明
              <textarea aria-label="说明" name="note" defaultValue={phase.note} />
            </label>
            <label>
              修改理由
              <input aria-label="修改理由" name="reason" required />
            </label>
          </WorkbenchForm>
          {phase.state === 'unopened' && (
            <WorkbenchForm
              title="用户开放期次"
              trigger="开放此期"
              description="此操作记录你对本期范围的开工授权。仍须逐票检查依赖和写入范围，保存后不会自动派工。"
              onSubmit={(data) =>
                run(base + `/phases/${phase.id}/open`, { reason: text(data, 'reason') })
              }
            >
              <p>
                {phase.code} · {phase.name}
              </p>
              <label>
                本次开放依据
                <textarea
                  aria-label="本次开放依据"
                  name="reason"
                  required
                  defaultValue="允许在本期已确认范围内逐票安排工作。"
                />
              </label>
            </WorkbenchForm>
          )}
        </>
      )}
    </div>
  );
}
function PhaseChecklist({
  phase,
  base,
  run,
}: {
  phase: PhaseRecord;
  base: string;
  run: WorkbenchCommand;
}) {
  const path = base + `/phases/${phase.id}/checklist`;
  return (
    <section>
      <h4>期次 Checklist</h4>
      {phase.checklist.length === 0 && (
        <p className={styles.description}>尚未填写开工门槛或收口条件。</p>
      )}
      {phase.checklist.map((item) => (
        <div key={item.id} className={styles.checklistRow}>
          <span>
            {item.checked ? '☑' : '☐'} {item.id} {item.condition}
          </span>
          <small>{item.result || '未记录结果'}</small>
          <WorkbenchForm
            title={`期次条件 ${item.id}`}
            trigger={`记录期次结果 ${item.id}`}
            onSubmit={(data) =>
              run(path, {
                action: 'result',
                expectedRevision: item.revision,
                id: item.id,
                checked: text(data, 'checked') === 'true',
                result: text(data, 'result'),
                reason: text(data, 'reason'),
              })
            }
          >
            <label>
              结果
              <select aria-label="结果" name="checked" defaultValue={String(item.checked)}>
                <option value="false">未满足</option>
                <option value="true">已满足</option>
              </select>
            </label>
            <label>
              依据与结果
              <textarea aria-label="依据与结果" name="result" defaultValue={item.result} required />
            </label>
            <label>
              本次记录理由
              <input aria-label="本次记录理由" name="reason" required />
            </label>
          </WorkbenchForm>
          <WorkbenchForm
            title={`修改期次条件 ${item.id}`}
            trigger={`编辑期次条件 ${item.id}`}
            onSubmit={(data) =>
              run(path, {
                action: 'condition',
                id: item.id,
                expectedRevision: item.revision,
                condition: text(data, 'condition'),
                verification: text(data, 'verification'),
                reason: text(data, 'reason'),
              })
            }
          >
            <label>
              条件
              <textarea aria-label="条件" name="condition" defaultValue={item.condition} required />
            </label>
            <VerificationSelect value={item.verification} />
            <label>
              修改理由
              <input aria-label="修改理由" name="reason" required />
            </label>
          </WorkbenchForm>
        </div>
      ))}
      <WorkbenchForm
        title="增加期次条件"
        trigger="增加期次条件"
        onSubmit={(data) =>
          run(path, {
            action: 'add',
            condition: text(data, 'condition'),
            verification: text(data, 'verification'),
            reason: text(data, 'reason'),
          })
        }
      >
        <label>
          条件
          <textarea aria-label="条件" name="condition" required />
        </label>
        <VerificationSelect />
        <label>
          依据
          <input aria-label="依据" name="reason" required />
        </label>
      </WorkbenchForm>
    </section>
  );
}
function NewTicket({
  data,
  phaseId,
  base,
  run,
  onCreated,
}: {
  data: WorkbenchSnapshot;
  phaseId: string;
  base: string;
  run: WorkbenchCommand;
  onCreated: (id: string) => void;
}) {
  return (
    <WorkbenchForm
      title="确认建立正式票据"
      trigger="新建票据"
      description="确认本票目标、范围与条件。软件分配稳定编号和材料入口，建立后仍为待办。"
      onSubmit={async (form) => {
        const saved = ticketSchema.parse(
          await run(base + '/tickets', {
            phaseId: text(form, 'phaseId'),
            categoryId: text(form, 'categoryId'),
            title: text(form, 'title'),
            goal: text(form, 'goal'),
            included: text(form, 'included'),
            excluded: text(form, 'excluded'),
            dependencies: form.getAll('dependencies').map(String),
            conditions: [
              ...lines(text(form, 'automated')).map((condition) => ({
                condition,
                verification: 'automated',
              })),
              ...lines(text(form, 'manual')).map((condition) => ({
                condition,
                verification: 'manual',
              })),
            ],
            ...(text(form, 'supplementOf') ? { supplementOf: text(form, 'supplementOf') } : {}),
          }),
        );
        onCreated(saved.id);
      }}
    >
      <label>
        期次
        <select aria-label="期次" name="phaseId" defaultValue={phaseId} required>
          {data.phases.map((phase) => (
            <option key={phase.id} value={phase.id}>
              {phase.code} {phase.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        类别
        <select
          aria-label="类别"
          name="categoryId"
          required
          defaultValue={data.categories[0]?.id ?? ''}
        >
          <option value="" disabled>
            先定义项目类别
          </option>
          {data.categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.code} {category.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        票据名称
        <input aria-label="票据名称" name="title" required maxLength={160} />
      </label>
      <label>
        主要结果
        <textarea name="goal" aria-label="票据目标" required />
      </label>
      <label>
        包含范围
        <textarea aria-label="包含范围" name="included" required />
      </label>
      <label>
        不包含
        <textarea aria-label="不包含" name="excluded" />
      </label>
      <label>
        直接依赖（可多选）
        <select aria-label="直接依赖（可多选）" name="dependencies" multiple>
          {data.tickets.map((ticket) => (
            <option key={ticket.id} value={ticket.id}>
              {ticket.code} {ticket.title}
            </option>
          ))}
        </select>
      </label>
      <label>
        自动化条件（每行一项）
        <textarea aria-label="自动化条件（每行一项）" name="automated" />
      </label>
      <label>
        人工条件（每行一项）
        <textarea aria-label="人工条件（每行一项）" name="manual" />
      </label>
      <p className={styles.description}>至少填写一条可判定条件。</p>
      <label>
        补充哪张票（可选）
        <select aria-label="补充哪张票（可选）" name="supplementOf" defaultValue="">
          <option value="">独立基础票</option>
          {data.tickets.map((ticket) => (
            <option key={ticket.id} value={ticket.id}>
              {ticket.code} {ticket.title}
            </option>
          ))}
        </select>
      </label>
    </WorkbenchForm>
  );
}
function SupervisorTasks({
  data,
  base,
  run,
}: {
  data: WorkbenchSnapshot;
  base: string;
  run: WorkbenchCommand;
}) {
  return (
    <section>
      <div className={styles.sectionHeader}>
        <h3>主管清单</h3>
        <WorkbenchForm
          title="记录确认目标或近期安排"
          trigger="新增清单项"
          onSubmit={(form) =>
            run(base + '/supervisor-tasks', {
              level: text(form, 'level'),
              title: text(form, 'title'),
              basis: text(form, 'basis'),
              ticketIds: form.getAll('ticketIds').map(String),
              ...(text(form, 'parentId') ? { parentId: text(form, 'parentId') } : {}),
            })
          }
        >
          <label>
            层次
            <select aria-label="层次" name="level">
              <option value="long">用户确认的长期目标</option>
              <option value="short">近期安排</option>
            </select>
          </label>
          <label>
            标题
            <input aria-label="标题" name="title" required />
          </label>
          <label>
            确认或安排依据
            <textarea aria-label="确认或安排依据" name="basis" required />
          </label>
          <label>
            关联长期目标（仅短期）
            <select aria-label="关联长期目标（仅短期）" name="parentId" defaultValue="">
              <option value="">无</option>
              {data.tasks
                .filter((task) => task.level === 'long')
                .map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
            </select>
          </label>
          <label>
            关联票据
            <select aria-label="关联票据" name="ticketIds" multiple>
              {data.tickets.map((ticket) => (
                <option key={ticket.id} value={ticket.id}>
                  {ticket.code} {ticket.title}
                </option>
              ))}
            </select>
          </label>
        </WorkbenchForm>
      </div>
      <p className={styles.description}>
        长期目标与近期安排持久保存；半勾表示等待，不表示完成一半。
      </p>
      {data.tasks.length === 0 && <p>暂无正式清单项。</p>}
      {data.tasks.map((task) => (
        <article key={task.id} className={styles.recordRow}>
          <h4>
            {task.state === 'checked' ? '☑' : task.state === 'held' ? '◩' : '☐'} {task.title}
          </h4>
          <p>
            {task.level === 'long' ? '长期目标' : '近期安排'} · {task.basis}
          </p>
          <p>
            {task.ticketIds
              .map((id) => data.tickets.find((ticket) => ticket.id === id)?.code ?? id)
              .join('、') || '无票据关联'}
          </p>
          <WorkbenchForm
            title="维护主管清单"
            trigger={`维护 ${task.title}`}
            onSubmit={(form) =>
              run(
                base + `/supervisor-tasks/${task.id}`,
                {
                  expectedRevision: task.revision,
                  title: text(form, 'title'),
                  state: text(form, 'state'),
                  basis: text(form, 'basis'),
                  reason: text(form, 'reason'),
                },
                'PATCH',
              )
            }
          >
            <label>
              标题
              <input aria-label="标题" name="title" defaultValue={task.title} required />
            </label>
            <label>
              状态
              <select aria-label="状态" name="state" defaultValue={task.state}>
                <option value="unchecked">未完成</option>
                <option value="held">挂起等待</option>
                <option value="checked">有依据完成</option>
              </select>
            </label>
            <label>
              完成或等待依据
              <textarea
                aria-label="完成或等待依据"
                name="basis"
                defaultValue={task.basis}
                required
              />
            </label>
            <label>
              修改理由
              <input aria-label="修改理由" name="reason" required />
            </label>
          </WorkbenchForm>
          <SupervisorTaskHistory base={base} id={task.id} />
        </article>
      ))}
    </section>
  );
}
function SupervisorTaskHistory({ base, id }: { base: string; id: string }) {
  const [open, setOpen] = useState(false),
    query = useQuery({
      queryKey: ['supervisor-task-history', base.split('/').at(-1), id],
      enabled: open,
      queryFn: async () =>
        z
          .array(z.object({ value: supervisorTaskSchema, reason: z.string(), at: z.string() }))
          .parse(await request(base + `/supervisor-tasks/${id}/revisions`)),
    });
  return (
    <section>
      <button type="button" className={styles.textButton} onClick={() => setOpen(!open)}>
        {open ? '收起' : '查看'}清单历史
      </button>
      {open && (
        <>
          {query.isPending && <p role="status">正在读取历史…</p>}
          {query.isError && (
            <p role="alert" className={styles.error}>
              {query.error.message}
            </p>
          )}
          {query.data?.map((record, n) => (
            <div key={n} className={styles.recordRow}>
              <p>
                修订 {record.value.revision} · {record.value.title} ·{' '}
                {record.value.state === 'checked'
                  ? '有依据完成'
                  : record.value.state === 'held'
                    ? '挂起等待'
                    : '未完成'}
              </p>
              <p>
                {record.reason} · {new Date(record.at).toLocaleString()}
              </p>
              <p>{record.value.basis}</p>
            </div>
          ))}
        </>
      )}
    </section>
  );
}
export function TicketWorkbench({ project }: { project: ProjectView }) {
  const base = `/api/projects/${project.id}`,
    run = useWorkbenchCommand(project.id),
    client = useQueryClient(),
    updates = useProjectUpdates(project.id);
  const [view, setView] = useState<'tickets' | 'tasks' | 'history' | 'feedback'>('tickets'),
    [phaseId, setPhaseId] = useState(''),
    [selectedTicket, setSelectedTicket] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ['workbench', project.id],
    queryFn: async () => workbenchSnapshotSchema.parse(await request(base + '/workbench')),
  });
  if (query.isPending) return <p role="status">正在读取工作台…</p>;
  if (query.isError)
    return (
      <p role="alert" className={styles.error}>
        {query.error.message}
      </p>
    );
  const data = query.data,
    phase = data.phases.find((item) => item.id === phaseId) ?? data.phases[0],
    tickets = data.tickets.filter((ticket) => ticket.phaseId === phase?.id);
  return (
    <section>
      <div className={styles.sectionHeader}>
        <h3>期次与票据</h3>
        <button
          type="button"
          className={styles.button}
          onClick={() =>
            void client.invalidateQueries({
              predicate: (query) => query.queryKey.includes(project.id),
            })
          }
        >
          刷新工作台
        </button>
      </div>
      <p className={styles.description}>{updates}</p>
      <div className={styles.tabs} role="tablist" aria-label="工作台视图">
        {(
          [
            ['tickets', '期次与票据'],
            ['tasks', '主管清单'],
            ['history', '项目历史'],
            ['feedback', '测试期意见'],
          ] as const
        ).map(([key, label]) => (
          <button
            type="button"
            role="tab"
            aria-selected={view === key}
            key={key}
            onClick={() => setView(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {view === 'tickets' && (
        <>
          <PhaseForms base={base} phase={phase} phases={data.phases} run={run} />
          {data.phases.length === 0 ? (
            <p className={styles.description}>
              先建立未开放期次，再定义本项目类别。系统不预设票据类别。
            </p>
          ) : (
            <>
              <label className={styles.phasePicker}>
                查看期次
                <select
                  aria-label="查看期次"
                  value={phase?.id ?? ''}
                  onChange={(event) => {
                    setPhaseId(event.target.value);
                    setSelectedTicket(null);
                  }}
                >
                  {data.phases.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.code} {item.name} · {phaseLabels[item.state]}
                    </option>
                  ))}
                </select>
              </label>
              {phase && (
                <>
                  <h4>
                    {phase.code} {phase.name} · {phaseLabels[phase.state]}
                  </h4>
                  <dl className={styles.facts}>
                    <dt>目标</dt>
                    <dd>{phase.goal}</dd>
                    <dt>主要依据</dt>
                    <dd>{phase.basis}</dd>
                    <dt>说明</dt>
                    <dd>{phase.note || '未填写'}</dd>
                  </dl>
                  <PhaseChecklist phase={phase} base={base} run={run} />
                  <div className={styles.sectionHeader}>
                    <h4>本期票据</h4>
                    <NewTicket
                      data={data}
                      phaseId={phase.id}
                      base={base}
                      run={run}
                      onCreated={setSelectedTicket}
                    />
                  </div>
                  {phase.state === 'unopened' && (
                    <p className={styles.description}>本期未开放。可维护计划；不能派工。</p>
                  )}
                  <div className={styles.tableWrap}>
                    <table className={styles.ticketTable}>
                      <thead>
                        <tr>
                          <th>编号与名称</th>
                          <th>状态</th>
                          <th>直接依赖</th>
                          <th>执行</th>
                        </tr>
                      </thead>
                      <tbody>
                        {tickets.map((ticket) => (
                          <tr key={ticket.id}>
                            <td>
                              <button
                                type="button"
                                className={styles.textButton}
                                onClick={() => setSelectedTicket(ticket.id)}
                              >
                                {ticket.code} · {ticket.title}
                              </button>
                            </td>
                            <td>{stateLabels[ticket.state]}</td>
                            <td>
                              {ticket.dependencies
                                .map(
                                  (id) => data.tickets.find((item) => item.id === id)?.code ?? id,
                                )
                                .join('、') || '无'}
                            </td>
                            <td>{ticket.currentExecution ?? '尚未派工'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {tickets.length === 0 && <p>本期暂无票据。</p>}
                </>
              )}
              {selectedTicket && (
                <TicketDetails
                  key={selectedTicket}
                  projectId={project.id}
                  ticketId={selectedTicket}
                  data={data}
                  run={run}
                />
              )}
            </>
          )}
        </>
      )}
      {view === 'tasks' && <SupervisorTasks data={data} base={base} run={run} />}
      {view === 'history' && (
        <section>
          <div className={styles.sectionHeader}>
            <h4>项目历史</h4>
            <WorkbenchForm
              title="补充项目脉络"
              trigger="补充历史"
              onSubmit={(form) =>
                run(base + '/history', {
                  content: text(form, 'content'),
                  references: lines(text(form, 'references')),
                  ...(text(form, 'corrects') ? { corrects: text(form, 'corrects') } : {}),
                })
              }
            >
              <label>
                背景或判断
                <textarea aria-label="背景或判断" name="content" required />
              </label>
              <label>
                原记录引用（每行一项）
                <textarea aria-label="原记录引用（每行一项）" name="references" />
              </label>
              <label>
                纠正原叙述 ID（可选）
                <input aria-label="纠正原叙述 ID（可选）" name="corrects" />
              </label>
            </WorkbenchForm>
          </div>
          <p className={styles.description}>事件保留发生时的含义；当前票据状态以原记录为准。</p>
          {data.history.map((entry) => (
            <article className={styles.recordRow} key={entry.id}>
              <p>
                {new Date(entry.at).toLocaleString()} · {historyLabels[entry.kind] ?? '业务记录'} ·{' '}
                {entry.actor.roleCode ?? '用户'}
              </p>
              <p>{entry.reason}</p>
              <small>
                记录 ID {entry.id} · 原对象 {entry.objectId}
                {entry.corrects ? ' · 纠正 ' + entry.corrects : ''}
              </small>
              {data.tickets.some((ticket) => ticket.id === entry.objectId) && (
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => {
                    const ticket = data.tickets.find((ticket) => ticket.id === entry.objectId)!;
                    setPhaseId(ticket.phaseId);
                    setSelectedTicket(ticket.id);
                    setView('tickets');
                  }}
                >
                  查看原票
                </button>
              )}
            </article>
          ))}
        </section>
      )}
      {view === 'feedback' && (
        <section>
          <h4>测试期意见箱</h4>
          <p className={styles.description}>
            成员反馈保存后继续工作；此处不自动转票、派工或认定采纳。
          </p>
          {data.feedback.length === 0 ? (
            <p>暂无已保存意见。</p>
          ) : (
            data.feedback.map((item) => (
              <article className={styles.recordRow} key={item.id}>
                <h4>
                  {item.id} · {item.title}
                </h4>
                <p>{item.content}</p>
                <p>
                  {item.author.roleCode} · {item.author.address} ·{' '}
                  {new Date(item.createdAt).toLocaleString()}
                </p>
                {item.scenario && <p>触发场景：{item.scenario}</p>}
                {item.expected && <p>期望：{item.expected}</p>}
                {item.references.map((reference, n) => (
                  <p key={n}>依据：{reference}</p>
                ))}
                <details>
                  <summary>真实来源与背景</summary>
                  <dl className={styles.facts}>
                    <dt>角色 ID</dt>
                    <dd>{item.author.roleId}</dd>
                    <dt>来源会话</dt>
                    <dd>{item.author.sessionId}</dd>
                    <dt>执行关联</dt>
                    <dd>{item.executionId ?? '尚无关联'}</dd>
                    <dt>请求记录</dt>
                    <dd>{item.background.requestId ?? '未取得'}</dd>
                    <dt>模型配置</dt>
                    <dd>
                      {String(item.background.configuration?.provider ?? '未取得')} /{' '}
                      {String(item.background.configuration?.model ?? '未取得')}
                    </dd>
                  </dl>
                </details>
              </article>
            ))
          )}
        </section>
      )}
    </section>
  );
}
