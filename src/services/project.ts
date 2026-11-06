import { DatabaseSync } from 'node:sqlite';
import { randomInt } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
  accessSync,
  constants,
} from 'node:fs';
import { join, isAbsolute } from 'node:path';
import type { ExecutionConfiguration, InitializeInput, ProjectView } from '../contracts/project.ts';
import { initializeSchema } from '../contracts/project.ts';
import { ProjectError } from './errors.ts';
import { transaction } from '../storage/transaction.ts';
import { RoleCatalog, migrateRoles } from '../storage/role-catalog.ts';
import { SessionCatalog, migrateSessions } from '../storage/session-catalog.ts';
import type { RoleInput, RegisteredRole, RoleUpdate } from '../contracts/roles.ts';
import type { SessionInput, SessionRecord } from '../contracts/sessions.ts';
import type { RequestRecord } from '../contracts/session-runtime.ts';
import { RequestCatalog } from '../storage/request-catalog.ts';
import { MessageCatalog, migrateMessages } from '../storage/message-catalog.ts';
import { WorkbenchCatalog, migrateWorkbench } from '../storage/workbench-catalog.ts';
import { ExecutionCatalog, migrateExecutions } from '../storage/execution-catalog.ts';
import { ControlCatalog, migrateControls } from '../storage/control-catalog.ts';
import { VersionCatalog, migrateVersions } from '../storage/version-catalog.ts';
import { ReviewCatalog, migrateCompletions } from '../storage/review-catalog.ts';
import { ReviewResultCatalog, migrateReviewResults } from '../storage/review-results-catalog.ts';
import { AcceptanceCatalog, ensureAcceptanceSchema } from '../storage/acceptance-catalog.ts';
export { ProjectError } from './errors.ts';
export type {
  ExecutionConfiguration,
  InitializeInput,
  RoleView,
  ProjectView,
} from '../contracts/project.ts';
function databaseError(error: unknown): unknown {
  if (error instanceof Error && 'errcode' in error && [5, 6].includes(Number(error.errcode)))
    return new ProjectError(
      'PROJECT_BUSY',
      '项目数据库正在使用中，请通过当前插件维护，或核对原连接已关闭',
    );
  return error;
}
const numericId = () => String(randomInt(100000000, 999999999));
export function resolveProjectRoot(root: string): string {
  if (typeof root !== 'string' || !isAbsolute(root))
    throw new ProjectError('INVALID_ROOT', '项目根必须是现有目录的绝对路径');
  let canonical: string;
  try {
    canonical = realpathSync(root);
  } catch {
    throw new ProjectError('ROOT_UNAVAILABLE', `项目目录不存在或无法访问：${root}`);
  }
  if (!lstatSync(canonical).isDirectory()) throw new ProjectError('INVALID_ROOT', '项目根不是目录');
  return canonical;
}
function requireDocuments(project: ProjectView): void {
  for (const path of [
    join(project.root, '.TEAM', '角色'),
    ...project.roles.map((role) => join(project.root, '.TEAM', '角色', role.id)),
  ]) {
    if (!existsSync(path)) throw new ProjectError('MISSING_DOCUMENT', `缺少规范目录：${path}`);
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ProjectError('UNSAFE_PATH', `规范祖先必须是普通目录，不能是符号链接：${path}`);
  }
  for (const path of [
    project.paths.team,
    ...project.roles.flatMap((role) => [role.paths.soul, role.paths.agent]),
  ]) {
    if (!existsSync(path)) throw new ProjectError('MISSING_DOCUMENT', `缺少规范文件：${path}`);
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new ProjectError('UNSAFE_PATH', `规范必须是普通文件：${path}`);
    try {
      accessSync(path, constants.R_OK);
    } catch {
      throw new ProjectError('DOCUMENT_UNREADABLE', `无法读取规范文件：${path}`);
    }
  }
}
function directory(path: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new ProjectError('UNSAFE_PATH', `受管目录必须是普通目录：${path}`);
  } else mkdirSync(path);
}
function createDocument(path: string, content: string): void {
  if (existsSync(path)) {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new ProjectError('UNSAFE_PATH', `规范必须是普通文件：${path}`);
    return;
  }
  writeFileSync(path, content, { flag: 'wx', encoding: 'utf8' });
}
function databasePath(root: string): string {
  return join(root, '.TEAM', '运行数据', 'mat.db');
}
function view(db: DatabaseSync, root: string): ProjectView {
  const row = db.prepare('SELECT id,name,attached,started FROM project WHERE singleton=1').get();
  if (!row) throw new ProjectError('NOT_INITIALIZED', '项目尚未正式登记');
  const roles = db
    .prepare('SELECT id,code,type,configuration FROM role ORDER BY id')
    .all()
    .map((role) => {
      const id = String(role.id);
      if (!/^\d+$/.test(id))
        throw new ProjectError('INVALID_REGISTRATION', '角色数字ID无效，拒绝推导资料路径');
      return {
        id,
        code: String(role.code),
        type: String(role.type),
        configuration: JSON.parse(String(role.configuration)) as ExecutionConfiguration,
        paths: {
          soul: join(root, '.TEAM', '角色', id, 'SOUL.md'),
          agent: join(root, '.TEAM', '角色', id, 'AGENT.md'),
        },
      };
    });
  return {
    id: String(row.id),
    name: String(row.name),
    root,
    attached: row.attached === 1,
    started: row.started === 1,
    roles,
    paths: { team: join(root, '.TEAM', 'TEAM.md'), database: databasePath(root) },
  };
}
function migrate(db: DatabaseSync): void {
  const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (version > 10) throw new ProjectError('FUTURE_SCHEMA', '数据库版本高于当前软件，拒绝降级写入');
  if (version === 0) {
    db.exec(`CREATE TABLE project(singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL UNIQUE,name TEXT NOT NULL,attached INTEGER NOT NULL DEFAULT 0 CHECK(attached IN(0,1)),started INTEGER NOT NULL DEFAULT 0 CHECK(started IN(0,1)));
      CREATE TABLE role(id TEXT PRIMARY KEY,code TEXT NOT NULL UNIQUE,type TEXT NOT NULL,configuration TEXT NOT NULL);
      CREATE TABLE initialization(singleton INTEGER PRIMARY KEY CHECK(singleton=1),project_id TEXT NOT NULL,role_id TEXT NOT NULL,request TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  if (version < 2) migrateRoles(db);
  if (version < 3) migrateSessions(db);
  if (version < 4) migrateMessages(db);
  if (version < 5) migrateWorkbench(db);
  if (version < 6) migrateExecutions(db);
  if (version < 7) migrateControls(db);
  if (version < 8) migrateVersions(db);
  if (version < 9) migrateCompletions(db);
  if (version < 10) migrateReviewResults(db);
  ensureAcceptanceSchema(db);
}
export function initializeProject(input: InitializeInput): ProjectView {
  if (!input || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 160)
    throw new ProjectError('INVALID_NAME', '请填写不超过160字的项目名称');
  if (
    !input.supervisor ||
    typeof input.supervisor.provider !== 'string' ||
    !input.supervisor.provider.trim() ||
    typeof input.supervisor.model !== 'string' ||
    !input.supervisor.model.trim()
  )
    throw new ProjectError('MISSING_CONFIGURATION', '必须明确主管的provider和model');
  const parsed = initializeSchema.safeParse(input);
  if (!parsed.success)
    throw new ProjectError('INVALID_INPUT', '初始化参数不合法，请核对项目根、名称和主管执行配置');
  const name = parsed.data.name;
  const supervisor = {
    provider: parsed.data.supervisor.provider,
    model: parsed.data.supervisor.model,
    ...(parsed.data.supervisor.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: parsed.data.supervisor.reasoningEffort }),
  };
  const request = JSON.stringify({ name, supervisor });
  const root = resolveProjectRoot(parsed.data.root);
  directory(join(root, '.TEAM'));
  directory(join(root, '.TEAM', '运行数据'));
  directory(join(root, '.TEAM', '角色'));
  const path = databasePath(root);
  if (existsSync(path) && lstatSync(path).isSymbolicLink())
    throw new ProjectError('UNSAFE_PATH', '数据库不能是符号链接');
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys=ON');
    const existingSnapshot = () => {
      const existing = db.prepare('SELECT attached FROM project WHERE singleton=1').get();
      if (!existing) return undefined;
      if (existing.attached === 1)
        throw new ProjectError('ALREADY_ATTACHED', '项目已接入插件，请通过控制台维护');
      const snapshot = view(db, root);
      requireDocuments(snapshot);
      return snapshot;
    };
    type Preparation =
      | { kind: 'complete'; snapshot: ProjectView }
      | { kind: 'pending'; projectId: string; roleId: string };
    const preparation = transaction<Preparation>(db, () => {
      migrate(db);
      const existing = existingSnapshot();
      if (existing) return { kind: 'complete', snapshot: existing };
      const pending = db
        .prepare('SELECT project_id,role_id,request FROM initialization WHERE singleton=1')
        .get();
      if (pending && pending.request !== request)
        throw new ProjectError(
          'INITIALIZATION_PENDING',
          '已有未完成的初始化准备，请使用原名称及执行配置重试，不覆盖已有资料',
        );
      const projectId = pending ? String(pending.project_id) : numericId();
      const roleId = pending ? String(pending.role_id) : numericId();
      if (!/^\d+$/.test(projectId) || !/^\d+$/.test(roleId))
        throw new ProjectError('INVALID_REGISTRATION', '初始化准备的数字ID无效');
      if (!pending)
        db.prepare(
          'INSERT INTO initialization(singleton,project_id,role_id,request) VALUES(1,?,?,?)',
        ).run(projectId, roleId, request);
      return { kind: 'pending', projectId, roleId };
    });
    if (preparation.kind === 'complete') return preparation.snapshot;
    return transaction(db, () => {
      const existing = existingSnapshot();
      if (existing) return existing;
      const pending = db
        .prepare('SELECT project_id,role_id,request FROM initialization WHERE singleton=1')
        .get();
      if (
        !pending ||
        pending.project_id !== preparation.projectId ||
        pending.role_id !== preparation.roleId ||
        pending.request !== request
      )
        throw new ProjectError('INITIALIZATION_CHANGED', '初始化准备已经变化，请回读当前项目资料');
      const { projectId, roleId } = preparation;
      directory(join(root, '.TEAM', '角色', roleId));
      createDocument(
        join(root, '.TEAM', 'TEAM.md'),
        `# ${name}\n\n| 角色ID | 类型 | 职责 |\n|---|---|---|\n| ${roleId} | 主管 | 管理用户已授权的项目工作 |\n`,
      );
      createDocument(join(root, '.TEAM', '角色', roleId, 'SOUL.md'), '');
      createDocument(join(root, '.TEAM', '角色', roleId, 'AGENT.md'), '');
      db.prepare('INSERT INTO project(singleton,id,name) VALUES(1,?,?)').run(projectId, name);
      db.prepare('INSERT INTO role(id,code,type,configuration) VALUES(?,?,?,?)').run(
        roleId,
        'SUP',
        'supervisor',
        JSON.stringify(supervisor),
      );
      db.prepare('DELETE FROM initialization WHERE singleton=1').run();
      db.prepare('INSERT INTO role_alias(alias,role_id) VALUES(?,?)').run('SUP', roleId);
      const snapshot = view(db, root);
      requireDocuments(snapshot);
      return snapshot;
    });
  } catch (error) {
    throw databaseError(error);
  } finally {
    db.close();
  }
}
export function readProject(inputRoot: string): ProjectView {
  const root = resolveProjectRoot(inputRoot);
  const path = databasePath(root);
  if (!existsSync(path)) throw new ProjectError('NOT_INITIALIZED', '项目尚未初始化');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return view(db, root);
  } finally {
    db.close();
  }
}
export interface ProjectConnection {
  controls(): ControlCatalog;
  versions(): VersionCatalog;
  reviews(): ReviewCatalog;
  reviewResults(): ReviewResultCatalog;
  acceptance(): AcceptanceCatalog;
  executions(): ExecutionCatalog;
  workbench(): WorkbenchCatalog;
  messages(): MessageCatalog;
  skillSourceRoot(): string | null;
  setSkillSourceRoot(root: string): void;
  requests(sessionId: string): RequestRecord[];
  saveRequest(record: RequestRecord): void;
  snapshot(): ProjectView;
  roles(): RegisteredRole[];
  registerRole(input: RoleInput): RegisteredRole;
  updateRole(id: string, input: RoleUpdate): RegisteredRole;
  reserveSession(input: SessionInput): SessionRecord;
  sessions(): SessionRecord[];
  session(id: string): SessionRecord;
  bindSession(id: string, nativeSessionId: string): SessionRecord;
  failSession(id: string, error: string): SessionRecord;
  recordSessionError(id: string, error: string | null): void;
  setCommunicationState(id: string, state: SessionRecord['communicationState']): void;
  closeSession(id: string): void;
  close(): void;
}
export function connectProject(inputRoot: string): ProjectConnection {
  const root = resolveProjectRoot(inputRoot);
  const path = databasePath(root);
  for (const managed of [join(root, '.TEAM'), join(root, '.TEAM', '运行数据'), path]) {
    if (!existsSync(managed)) throw new ProjectError('NOT_INITIALIZED', '项目尚未初始化');
    if (lstatSync(managed).isSymbolicLink())
      throw new ProjectError('UNSAFE_PATH', '受管路径不能是符号链接');
  }
  const db = new DatabaseSync(path);
  let closed = false;
  try {
    db.exec('PRAGMA foreign_keys=ON');
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
    if (version < 1 || version > 10)
      throw new ProjectError('SCHEMA_MISMATCH', '项目数据库版本不匹配，请先核对升级与初始化结果');
    db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE');
    try {
      migrate(db);
      requireDocuments(view(db, root));
      db.prepare('UPDATE project SET attached=1 WHERE singleton=1').run();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    const roles = new RoleCatalog(db, root);
    const sessions = new SessionCatalog(db, roles);
    const requests = new RequestCatalog(db);
    const messages = new MessageCatalog(db, sessions, roles, view(db, root).id);
    const workbench = new WorkbenchCatalog(db, root, sessions, roles);
    const executions = new ExecutionCatalog(db, sessions, roles, workbench);
    const controls = new ControlCatalog(db, workbench, executions, sessions);
    const versions = new VersionCatalog(db, executions, workbench, sessions, root);
    const reviews = new ReviewCatalog(
      db,
      executions,
      workbench,
      sessions,
      roles,
      versions,
      controls,
    );
    const reviewResults = new ReviewResultCatalog(
      db,
      reviews,
      executions,
      workbench,
      sessions,
      controls,
    );
    const acceptance = new AcceptanceCatalog(
      db,
      workbench,
      executions,
      versions,
      reviewResults,
      reviews,
      sessions,
    );
    messages.bindControlledMessages(
      (id, session) => controls.resultMessage(id, session),
      (id, kind) => controls.controlMessage(id, kind),
    );
    workbench.bindExecutionAccess(
      (id) => reviews.scopeForSession(id) ?? executions.scopeForSession(id),
    );
    const requireOpen = () => {
      if (closed) throw new ProjectError('CONNECTION_CLOSED', '项目连接已经关闭');
    };
    return {
      acceptance() {
        requireOpen();
        return acceptance;
      },
      reviewResults() {
        requireOpen();
        return reviewResults;
      },
      reviews() {
        requireOpen();
        return reviews;
      },
      versions() {
        requireOpen();
        return versions;
      },
      controls() {
        requireOpen();
        return controls;
      },
      executions() {
        requireOpen();
        return executions;
      },
      workbench() {
        requireOpen();
        return workbench;
      },
      messages() {
        requireOpen();
        return messages;
      },
      skillSourceRoot() {
        requireOpen();
        const row = db.prepare('SELECT skill_source_root FROM project WHERE singleton=1').get();
        return row?.skill_source_root === null ? null : String(row?.skill_source_root);
      },
      setSkillSourceRoot(root) {
        requireOpen();
        if (!isAbsolute(root))
          throw new ProjectError('INVALID_SKILL_ROOT', 'Skill来源必须为绝对目录');
        db.prepare('UPDATE project SET skill_source_root=? WHERE singleton=1').run(
          realpathSync(root),
        );
      },
      requests(sessionId) {
        requireOpen();
        sessions.get(sessionId);
        return requests.list(sessionId);
      },
      saveRequest(record) {
        requireOpen();
        sessions.get(record.sessionId);
        requests.save(record);
      },
      roles() {
        requireOpen();
        return roles.list();
      },
      registerRole(input) {
        requireOpen();
        return roles.register(input);
      },
      updateRole(id, input) {
        requireOpen();
        return roles.update(id, input);
      },
      reserveSession(input) {
        requireOpen();
        return sessions.reserve(input);
      },
      sessions() {
        requireOpen();
        return sessions.list();
      },
      session(id) {
        requireOpen();
        return sessions.get(id);
      },
      bindSession(id, nativeSessionId) {
        requireOpen();
        return sessions.bind(id, nativeSessionId);
      },
      failSession(id, error) {
        requireOpen();
        return sessions.fail(id, error);
      },
      recordSessionError(id, error) {
        requireOpen();
        sessions.executionError(id, error);
      },
      setCommunicationState(id, state) {
        requireOpen();
        sessions.communicationState(id, state);
      },
      closeSession(id) {
        requireOpen();
        sessions.close(id);
      },
      snapshot() {
        if (closed) throw new ProjectError('CONNECTION_CLOSED', '项目连接已经关闭');
        return view(db, root);
      },
      close() {
        if (!closed) {
          closed = true;
          db.close();
        }
      },
    };
  } catch (error) {
    db.close();
    throw databaseError(error);
  }
}
