import { StrictMode, useState, lazy, Suspense } from 'react';
import type { FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Link, Route, Routes, useParams } from 'react-router';
import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import { z } from 'zod';
import { projectEntrySchema, projectSchema } from '../源码/契约/项目';
import type { ProjectView } from '../源码/契约/项目';
import styles from './工作台.module.css';
import { request } from './请求';
import { RoleAndSessionPanel } from './角色与会话';
import { ProjectControls } from './控制入口';
const ChatPanel = lazy(() => import('./私聊').then((module) => ({ default: module.ChatPanel })));
const TicketWorkbench = lazy(() =>
  import('./票据工作台').then((module) => ({ default: module.TicketWorkbench })),
);
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
function useProjects() {
  return useQuery({
    queryKey: ['projects'],
    queryFn: async () => z.array(projectEntrySchema).parse(await request('/api/projects')),
  });
}
function CreateDialog({ mode }: { mode: 'create' | 'attach' }) {
  const [open, setOpen] = useState(false);
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (body: unknown) =>
      projectSchema.parse(
        await request(mode === 'create' ? '/api/projects' : '/api/projects/attach', body),
      ),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['projects'] });
      setOpen(false);
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const root = String(data.get('root') ?? '');
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
  const title = mode === 'create' ? '新建项目' : '接入已有项目';
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
              ? '选择本机已有目录，登记项目与主管。已有资料会保留。'
              : '填写已完成 MAT 初始化的项目根目录。接入会保留原有项目和角色身份。'}
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
              <input name="root" required placeholder="D:\项目\我的项目" autoComplete="off" />
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
function ProjectDetails({ project }: { project: ProjectView }) {
  const [view, setView] = useState<'roles' | 'chat' | 'workbench'>('roles');
  return (
    <section className={styles.details}>
      <div className={styles.sectionHeader}>
        <h2>{project.name}</h2>
        <span>{project.started ? '已启动' : '未启动'}</span>
      </div>
      <dl className={styles.facts}>
        <dt>项目 ID</dt>
        <dd>{project.id}</dd>
        <dt>项目根</dt>
        <dd>{project.root}</dd>
        <dt>共用规范</dt>
        <dd>{project.paths.team}</dd>
      </dl>
      <ProjectControls projectId={project.id} />
      <div className={styles.tabs} role="tablist" aria-label="项目视图">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'roles'}
          onClick={() => setView('roles')}
        >
          角色与会话
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'chat'}
          onClick={() => setView('chat')}
        >
          私聊
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'workbench'}
          onClick={() => setView('workbench')}
        >
          期次与票据
        </button>
      </div>
      {view === 'roles' ? (
        <RoleAndSessionPanel key={project.id} project={project} />
      ) : view === 'chat' ? (
        <Suspense fallback={<p role="status">正在载入私聊…</p>}>
          <ChatPanel key={project.id} project={project} />
        </Suspense>
      ) : (
        <Suspense fallback={<p role="status">正在载入工作台…</p>}>
          <TicketWorkbench key={project.id} project={project} />
        </Suspense>
      )}
    </section>
  );
}
function Workspace() {
  const { projectId } = useParams();
  const projects = useProjects();
  const selected = projects.data?.find(
    (p): p is ProjectView => !('unavailable' in p) && p.id === projectId,
  );
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
            <h1>项目</h1>
            <p>登记项目，保留身份与资料，再开始工作。</p>
          </div>
          <div className={styles.actions}>
            <CreateDialog mode="attach" />
            <CreateDialog mode="create" />
          </div>
        </div>
        {projects.isPending && <p role="status">正在读取项目…</p>}
        {projects.isError && (
          <p role="alert" className={styles.error}>
            {projects.error.message}
          </p>
        )}
        {projects.data?.length === 0 && (
          <section className={styles.empty}>
            <h2>还没有接入项目</h2>
            <p>从新建项目开始，或接入已经初始化的项目。</p>
          </section>
        )}
        {!!projects.data?.length && (
          <div className={styles.workspace}>
            <nav aria-label="已接入项目" className={styles.projectList}>
              {projects.data.map((project) =>
                'unavailable' in project ? (
                  <div key={project.root} className={styles.unavailable}>
                    <strong>项目暂不可用</strong>
                    <p>{project.root}</p>
                    <p role="alert">{project.error}</p>
                  </div>
                ) : (
                  <Link
                    key={project.id}
                    to={`/projects/${project.id}`}
                    className={`${styles.projectLink} ${projectId === project.id ? styles.selected : ''}`}
                  >
                    <strong>{project.name}</strong>
                    <span>{project.started ? '已启动' : '未启动'}</span>
                    <small>{project.root}</small>
                  </Link>
                ),
              )}
            </nav>
            <div>
              {selected ? (
                <ProjectDetails project={selected} />
              ) : (
                <section className={styles.empty}>
                  <h2>{projectId ? '未找到这个项目' : '选择一个项目'}</h2>
                  <p>从左侧查看正式登记与角色资料。</p>
                </section>
              )}
            </div>
          </div>
        )}
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
