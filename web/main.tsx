import { StrictMode, useState, lazy, Suspense } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes, useParams, useSearchParams } from 'react-router';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import { z } from 'zod';
import { projectSchema } from '../src/contracts/project';
import type { ProjectView } from '../src/contracts/project';
import styles from './workbench.module.css';
import { request } from './request';
import { RoleAndSessionPanel } from './roles-and-sessions';
import { ProjectControls } from './controls';
import { ReviewSettings } from './review-progress';
import { projectRuntimeSchema } from '../src/contracts/controls';
import shell from './workspace-shell.module.css';
const ChatPanel = lazy(() => import('./chat').then((module) => ({ default: module.ChatPanel })));
const Overview = lazy(() =>
  import('./project-overview').then((module) => ({ default: module.ProjectOverview })),
);
const TicketWorkbench = lazy(() =>
  import('./workbench').then((module) => ({ default: module.TicketWorkbench })),
);
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function useWorkspace() {
  return useQuery({
    queryKey: ['workspace'],
    queryFn: async () =>
      z
        .object({ root: z.string(), project: projectSchema.nullable() })
        .parse(await request('/api/workspace')),
  });
}
function CreateDialog({ mode, root }: { mode: 'create' | 'attach'; root: string }) {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (body: unknown) =>
      projectSchema.parse(
        await request(mode === 'create' ? '/api/projects' : '/api/projects/attach', body),
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['workspace'] });
      setOpen(false);
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    mutation.mutate(
      mode === 'attach'
        ? { root }
        : {
            root,
            name: String(data.get('name') ?? ''),
            supervisor: {
              provider: String(data.get('provider') ?? ''),
              model: String(data.get('model') ?? ''),
            },
          },
    );
  }
  const title = mode === 'create' ? '初始化当前项目' : '接入当前项目';
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!mutation.isPending) {
          setOpen(value);
          mutation.reset();
        }
      }}
    >
      <Dialog.Trigger type="button" className={mode === 'create' ? styles.primary : styles.button}>
        {title}
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.dialog}>
          <Dialog.Title className={styles.dialogTitle}>{title}</Dialog.Title>
          <Dialog.Description className={styles.description}>
            {mode === 'create'
              ? '初始化启动时绑定的目录，登记项目与主管。已有资料会保留。'
              : '接入启动时绑定的目录。接入会保留原有项目和角色身份。'}
          </Dialog.Description>
          <form onSubmit={submit} className={styles.form}>
            {mode === 'create' && (
              <label>
                项目名称
                <input name="name" required maxLength={160} autoComplete="off" />
              </label>
            )}
            <label>
              项目根目录
              <input name="root" value={root} readOnly />
            </label>
            {mode === 'create' && (
              <div className={styles.columns}>
                <label>
                  主管 Provider
                  <input name="provider" required autoComplete="off" />
                </label>
                <label>
                  主管模型
                  <input name="model" required autoComplete="off" />
                </label>
              </div>
            )}
            {mutation.isError && (
              <p role="alert" className={styles.error}>
                {mutation.error.message}
              </p>
            )}
            <div className={styles.actions}>
              <Dialog.Close type="button" className={styles.button} disabled={mutation.isPending}>
                取消
              </Dialog.Close>
              <button className={styles.primary} type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? '正在保存…' : mode === 'create' ? '新建并接入' : '确认接入'}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
const navigation = [
  ['overview', '总览', 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z'],
  ['supervisor', '主管交流', 'M4 4h16v12H9l-5 4zM8 9h8m-8 3h5'],
  ['chat', '私聊', 'M3 5h12v9H8l-5 4zM16 9h5v9h-4l-3 3v-4'],
  [
    'members',
    '成员',
    'M9 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM3 20v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2m2-14a3 3 0 0 1 0 6m0 2a4 4 0 0 1 4 4v2',
  ],
  ['tickets', '票据', 'M3 6h18v4a2 2 0 0 0 0 4v4H3v-4a2 2 0 0 0 0-4zM9 9h6m-6 6h6'],
  ['history', '历史', 'M3 10a9 9 0 1 1 1 7m-1-7V4m0 6h6m3-3v5l3 2'],
  ['settings', '配置', 'M4 6h16M4 12h16M4 18h16M8 4v4m8 2v4m-5 2v4'],
] as const;
type WorkspaceView = (typeof navigation)[number][0];
const runtimeLabels = {
  stopped: '已停止',
  starting: '准备中',
  running: '已启动',
  stopping: '停止中',
  unknown: '状态待核对',
  error: '启动异常',
  'forced-stopped': '已强制退出',
};

function ProjectDetails({ project }: { project: ProjectView }) {
  const [params, setParams] = useSearchParams();
  const active = navigation.find(([key]) => key === params.get('view')) ?? navigation[0];
  const [view, title] = active;
  const runtime = useQuery({
    queryKey: ['project-control', project.id],
    queryFn: async () =>
      z
        .object({ runtime: projectRuntimeSchema, desiredStarted: z.boolean() })
        .parse(await request(`/api/projects/${project.id}/control`)),
    refetchInterval: 2000,
  });
  const selectView = (next: WorkspaceView, values: Record<string, string> = {}) => {
    setParams(new URLSearchParams({ ...(next === 'overview' ? {} : { view: next }), ...values }));
  };
  const openTicket = (id: string, section?: 'materials' | 'acceptance') =>
    selectView('tickets', { ticket: id, ...(section ? { section } : {}) });
  return (
    <div className={shell.shell}>
      <a className={styles.skip} href="#main-content">
        跳至项目内容
      </a>
      <nav className={shell.rail} aria-label="工作台导航">
        <span className={shell.railBrand} aria-label="Mo's Agents Team">
          MAT
        </span>
        {navigation.map(([key, label, path]) => (
          <Link
            key={key}
            to={{ search: key === 'overview' ? '' : '?view=' + key }}
            aria-label={label}
            aria-current={view === key ? 'page' : undefined}
            className={shell.railButton}
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d={path} />
            </svg>
            <span aria-hidden="true" className={shell.railLabel}>
              {label}
            </span>
          </Link>
        ))}
      </nav>
      <div className={shell.main}>
        <header className={shell.projectHeader}>
          <div className={shell.projectName}>
            <strong>{project.name}</strong>
            <span>项目工作台</span>
          </div>
          <span className={shell.runtime}>
            {runtime.isError
              ? '运行状态待核对'
              : runtime.data
                ? runtimeLabels[runtime.data.runtime.state]
                : '读取运行状态…'}
          </span>
        </header>
        <main id="main-content" className={shell.canvas} tabIndex={-1}>
          <h1 className={shell.pageTitle}>{title}</h1>
          <Suspense fallback={<p role="status">正在载入{title}…</p>}>
            {view === 'overview' && (
              <>
                <p className={shell.pageNote}>从实际期次、执行和决定记录查看项目现场。</p>
                <Overview
                  project={project}
                  openTicket={openTicket}
                  openPhase={(id) => selectView('tickets', { phase: id })}
                  openRequests={(id) =>
                    selectView('tickets', { panel: 'requests', ...(id ? { request: id } : {}) })
                  }
                  openHistory={() => selectView('history')}
                  openSupervisor={() => selectView('supervisor')}
                />
              </>
            )}
            {(view === 'supervisor' || view === 'chat') && (
              <ChatPanel
                key={project.id + ':' + view + ':' + (params.get('session') ?? '')}
                project={project}
                mode={view === 'supervisor' ? 'supervisor' : 'private'}
                managerSessionId={runtime.data?.runtime.managerSessionId ?? null}
                initialSessionId={params.get('session')}
              />
            )}
            {view === 'members' && (
              <RoleAndSessionPanel
                project={project}
                mode="members"
                openChat={(id) => selectView('chat', { session: id })}
              />
            )}
            {(view === 'tickets' || view === 'history') && (
              <TicketWorkbench key={project.id} project={project} />
            )}
            {view === 'settings' && (
              <div className={shell.column}>
                <section className={shell.surface} aria-label="绑定项目与运行">
                  <h2>绑定项目与运行</h2>
                  <dl className={styles.facts}>
                    <dt>项目 ID</dt>
                    <dd>{project.id}</dd>
                    <dt>项目根</dt>
                    <dd>{project.root}</dd>
                    <dt>共用规范</dt>
                    <dd>{project.paths.team}</dd>
                  </dl>
                  <ProjectControls projectId={project.id} />
                  <ReviewSettings projectId={project.id} />
                </section>
                <section className={shell.surface} aria-label="角色与项目配置">
                  <RoleAndSessionPanel project={project} mode="settings" />
                </section>
              </div>
            )}
          </Suspense>
        </main>
      </div>
    </div>
  );
}
function Workspace() {
  const { projectId } = useParams();
  const workspace = useWorkspace();
  const selected = workspace.data?.project;
  const wrongProject = !!workspace.data && !!projectId && projectId !== selected?.id;
  if (selected && !wrongProject) return <ProjectDetails project={selected} />;
  return (
    <>
      <a className={styles.skip} href="#main-content">
        跳至项目内容
      </a>
      <header className={styles.header}>
        <Link to="/" className={styles.brand}>
          Mo's Agents Team
        </Link>
        <span>项目工作台</span>
      </header>
      <main id="main-content" className={styles.page}>
        <div className={styles.pageHeader}>
          <div>
            <h1>项目工作台</h1>
            <p>{workspace.data?.root}</p>
          </div>
        </div>
        {workspace.isPending && <p role="status">正在读取当前项目…</p>}
        {workspace.isError && (
          <p role="alert" className={styles.error}>
            {workspace.error.message}
          </p>
        )}
        {workspace.data && !selected && !projectId && (
          <section className={styles.empty}>
            <h2>当前目录尚未初始化</h2>
            <p>在上方绑定目录登记项目，或接入已准备的资料。</p>
            <CreateDialog mode="create" root={workspace.data.root} />
            <CreateDialog mode="attach" root={workspace.data.root} />
          </section>
        )}
        {wrongProject ? (
          <section className={styles.empty}>
            <h2>此项目未绑定当前工作台</h2>
            <Link to="/">返回当前项目</Link>
          </section>
        ) : null}
      </main>
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Workspace />} />
          <Route path="/projects/:projectId" element={<Workspace />} />
          <Route
            path="*"
            element={
              <main className={styles.page}>
                <h1>未找到页面</h1>
                <Link to="/">返回项目</Link>
              </main>
            }
          />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
