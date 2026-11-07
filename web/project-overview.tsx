import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { executionSchema } from '../src/contracts/execution';
import { sessionSchema } from '../src/contracts/sessions';
import { decisionRequestSchema } from '../src/contracts/decision-requests';
import type { ProjectView } from '../src/contracts/project';
import type { SupervisorTask } from '../src/contracts/workbench';
import { workbenchSnapshotSchema } from './workbench';
import type { WorkbenchSnapshot } from './workbench';
import { request } from './request';
import { useProjectUpdates } from './project-events';
import { stateLabels, historyLabels } from './ticket-state';
import styles from './workspace-shell.module.css';

const phaseLabels = { unopened: '未开放', opened: '已开放', closing: '收口中', closed: '已收口' };
const taskLabels = { unchecked: '未完成', held: '已挂起', checked: '已完成' };
const taskSymbols = { unchecked: '□', held: '▣', checked: '☑' };
const interruptionLabels: Record<string, string> = {
  waiting: '执行等待',
  paused: '执行暂停',
  error: '执行异常',
};
type Ticket = WorkbenchSnapshot['tickets'][number];

function TaskLine({
  item,
  tickets,
  openTicket,
  child = false,
}: {
  item: SupervisorTask;
  tickets: Ticket[];
  openTicket: (id: string) => void;
  child?: boolean;
}) {
  return (
    <details className={child ? `${styles.task} ${styles.taskChild}` : styles.task}>
      <summary>
        <span aria-hidden="true" className={styles.statusSymbol}>
          {taskSymbols[item.state]}
        </span>
        {item.title} <span className={styles.meta}>{taskLabels[item.state]}</span>
      </summary>
      <p>{item.basis}</p>
      {item.ticketIds
        .map((id) => tickets.find((ticket) => ticket.id === id))
        .filter((ticket) => ticket !== undefined)
        .map((ticket) => (
          <button
            type="button"
            className={styles.action}
            key={ticket.id}
            onClick={() => openTicket(ticket.id)}
          >
            {ticket.code} · {ticket.title}
          </button>
        ))}
    </details>
  );
}

export function ProjectOverview({
  project,
  openTicket,
  openPhase,
  openRequests,
  openHistory,
  openSupervisor,
}: {
  project: ProjectView;
  openTicket: (id: string, section?: 'materials' | 'acceptance') => void;
  openPhase: (id: string) => void;
  openRequests: (id?: string) => void;
  openHistory: () => void;
  openSupervisor: () => void;
}) {
  const base = `/api/projects/${project.id}`;
  useProjectUpdates(project.id);
  const work = useQuery({
    queryKey: ['workbench', project.id],
    queryFn: async () => workbenchSnapshotSchema.parse(await request(base + '/workbench')),
  });
  const executions = useQuery({
    queryKey: ['overview-executions', project.id],
    queryFn: async () => z.array(executionSchema).parse(await request(base + '/executions')),
  });
  const sessions = useQuery({
    queryKey: ['sessions', project.id],
    queryFn: async () => z.array(sessionSchema).parse(await request(base + '/sessions')),
  });
  const decisions = useQuery({
    queryKey: ['decision-requests', project.id, ''],
    queryFn: async () =>
      z.array(decisionRequestSchema).parse(await request(base + '/decision-requests')),
  });
  if (work.isPending) return <p role="status">正在读取项目总览…</p>;
  if (work.isError)
    return (
      <p role="alert">
        项目总览暂时无法读取。{work.error.message}{' '}
        <button type="button" className={styles.action} onClick={() => void work.refetch()}>
          重试
        </button>
      </p>
    );
  const { phases, tickets, tasks, history } = work.data;
  const long = tasks.filter((item) => item.level === 'long');
  const standalone = tasks.filter(
    (item) => item.level === 'short' && !long.some((parent) => parent.id === item.parentId),
  );
  const executionFor = (ticket: Ticket) =>
    executions.data?.find((record) => record.id === ticket.currentExecution);
  const sessionFor = (ticket: Ticket) =>
    sessions.data?.find((session) => session.id === executionFor(ticket)?.sessionId);
  const pending = decisions.data?.filter(
    (item) => item.assignee.kind === 'user' && ['pending', 'needs-info'].includes(item.state),
  );
  const interruptedState = (ticket: Ticket) =>
    interruptionLabels[executionFor(ticket)?.lifecycleState ?? ''];
  const knownActive = (ticket: Ticket) => executionFor(ticket)?.lifecycleState === 'active';
  const ongoing = tickets.filter(
    (ticket) =>
      ticket.state === 'awaiting-review' || (ticket.state === 'in-progress' && knownActive(ticket)),
  );
  const interrupted = tickets.filter(
    (ticket) =>
      ticket.state === 'blocked' || (ticket.state === 'in-progress' && interruptedState(ticket)),
  );
  const unconfirmed = tickets.filter(
    (ticket) => ticket.state === 'in-progress' && !knownActive(ticket) && !interruptedState(ticket),
  );
  const deliveries = tickets.filter((ticket) =>
    ['review-passed', 'awaiting-acceptance'].includes(ticket.state),
  );
  const ticketList = (
    items: Ticket[],
    empty: string,
    choose: (id: string) => void,
    state: (ticket: Ticket) => string = (ticket) => stateLabels[ticket.state],
  ) =>
    items.length ? (
      <ul className={styles.list}>
        {items.map((ticket) => (
          <li key={ticket.id}>
            <button className={styles.row} type="button" onClick={() => choose(ticket.id)}>
              <span>
                {ticket.code} · {ticket.title}
                {sessionFor(ticket) ? ` · ${sessionFor(ticket)!.addresses.readable}` : ''}
              </span>
              <span className={styles.meta}>{state(ticket)}</span>
            </button>
          </li>
        ))}
      </ul>
    ) : (
      <p className={styles.empty}>{empty}</p>
    );
  return (
    <div className={styles.overview}>
      <div className={styles.column}>
        <section className={styles.surface} aria-labelledby="overview-tasks">
          <div className={styles.sectionTitle}>
            <h2 id="overview-tasks">主管任务清单</h2>
            <button type="button" className={styles.action} onClick={openSupervisor}>
              和主管交流
            </button>
          </div>
          {tasks.length ? (
            <ul className={styles.list}>
              {long.map((item) => (
                <li key={item.id}>
                  <TaskLine item={item} tickets={tickets} openTicket={openTicket} />
                  {tasks
                    .filter((row) => row.level === 'short' && row.parentId === item.id)
                    .map((row) => (
                      <TaskLine
                        key={row.id}
                        item={row}
                        tickets={tickets}
                        openTicket={openTicket}
                        child
                      />
                    ))}
                </li>
              ))}
              {standalone.map((item) => (
                <li key={item.id}>
                  <TaskLine item={item} tickets={tickets} openTicket={openTicket} />
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>主管尚未登记任务。清单会随实际记录更新。</p>
          )}
        </section>
        <section className={styles.surface} aria-labelledby="overview-current">
          <h2 id="overview-current">在途工作</h2>
          {executions.isError || sessions.isError ? (
            <p role="alert">部分执行或会话信息未能读取，票据状态仍按已保存记录显示。</p>
          ) : null}
          {ticketList(
            ongoing,
            unconfirmed.length ? '暂无已核实的在途执行。' : '当前没有进行中或待审阅的票据。',
            openTicket,
          )}
        </section>
        <section className={styles.surface} aria-labelledby="overview-held">
          <h2 id="overview-held">挂起与阻塞</h2>
          {ticketList(
            interrupted,
            unconfirmed.length
              ? '部分执行状态待核对，暂不能判断是否挂起。'
              : '当前没有已记录的挂起或阻塞。',
            openTicket,
            (ticket) =>
              ticket.state === 'blocked'
                ? '票据阻塞'
                : (interruptedState(ticket) ?? stateLabels[ticket.state]),
          )}
          {!!unconfirmed.length && (
            <div aria-label="执行状态待核对">
              {ticketList(unconfirmed, '', openTicket, () => '执行待核对')}
            </div>
          )}
        </section>
      </div>
      <div className={styles.column}>
        <section className={styles.surface} aria-labelledby="overview-phases">
          <h2 id="overview-phases">期次</h2>
          {phases.length ? (
            <ul className={styles.list}>
              {phases.map((phase) => (
                <li key={phase.id}>
                  <button type="button" className={styles.row} onClick={() => openPhase(phase.id)}>
                    <span>
                      {phase.code} · {phase.name}
                    </span>
                    <span className={styles.meta}>{phaseLabels[phase.state]}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>尚未登记期次。</p>
          )}
        </section>
        <section className={styles.surface} aria-labelledby="overview-deliveries">
          <h2 id="overview-deliveries">待验收与审阅通过</h2>
          {ticketList(deliveries, '当前没有待办成果。', (id) => openTicket(id, 'acceptance'))}
        </section>
        <section className={styles.surface} aria-labelledby="overview-decisions">
          <div className={styles.sectionTitle}>
            <h2 id="overview-decisions">需要你决定</h2>
            <button type="button" className={styles.action} onClick={() => openRequests()}>
              决定请求
            </button>
          </div>
          {decisions.isPending ? (
            <p role="status" className={styles.empty}>
              正在读取决定请求…
            </p>
          ) : decisions.isError ? (
            <p role="alert">决定请求未能读取。{decisions.error.message}</p>
          ) : pending?.length ? (
            <ul className={styles.list}>
              {pending.map((item) => (
                <li key={item.id}>
                  <button
                    type="button"
                    className={styles.row}
                    onClick={() => openRequests(item.id)}
                  >
                    <span>{item.subject}</span>
                    <span className={styles.meta}>
                      {item.state === 'needs-info' ? '待补充' : '待决定'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.empty}>当前没有分配给你的待决定事项。</p>
          )}
        </section>
        <section className={styles.surface} aria-labelledby="overview-history">
          <div className={styles.sectionTitle}>
            <h2 id="overview-history">最近变化</h2>
            <button type="button" className={styles.action} onClick={openHistory}>
              项目历史
            </button>
          </div>
          {history.length ? (
            <ul className={styles.list}>
              {[...history]
                .sort((a, b) => b.at.localeCompare(a.at))
                .slice(0, 4)
                .map((entry) => (
                  <li className={styles.line} key={entry.id}>
                    <span className={styles.historyExcerpt}>
                      <strong>{historyLabels[entry.kind] ?? '业务记录'}</strong>
                      <span>{entry.reason}</span>
                    </span>
                    <time className={styles.meta} dateTime={entry.at}>
                      {new Date(entry.at).toLocaleString('zh-CN', {
                        month: 'numeric',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </time>
                  </li>
                ))}
            </ul>
          ) : (
            <p className={styles.empty}>暂无项目历史。</p>
          )}
        </section>
      </div>
    </div>
  );
}
