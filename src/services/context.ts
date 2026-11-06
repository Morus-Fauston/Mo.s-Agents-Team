import { createHash } from 'node:crypto';
import { lstatSync, openSync, fstatSync, readFileSync, closeSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ProjectView } from '../contracts/project.ts';
import type { RegisteredRole } from '../contracts/roles.ts';
import type { SessionRecord } from '../contracts/sessions.ts';
import { ProjectError } from './errors.ts';

export interface ContextSource {
  kind: 'platform' | 'type' | 'project' | 'role' | 'workspace' | 'user-private';
  path: string;
  sha256: string;
  bytes: number;
  modifiedAt: string;
}
export interface AssembledContext {
  projectId: string;
  roleId: string;
  version: string;
  body: string;
  sources: ContextSource[];
  sections: { source: ContextSource; body: string }[];
  identity: string;
}
const digest = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
function optionalStat(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new ProjectError('DOCUMENT_UNREADABLE', `无法核对规范路径：${path}`);
  }
}
function plainDirectory(path: string): void {
  const stat = optionalStat(path);
  if (!stat?.isDirectory() || stat.isSymbolicLink())
    throw new ProjectError('UNSAFE_PATH', `规范祖先必须是普通目录：${path}`);
}
function workspaceDirectories(cwd: string): string[] {
  const chain: string[] = [];
  let current = cwd;
  while (true) {
    chain.push(current);
    if (optionalStat(join(current, '.git'))) return chain.reverse();
    const parent = dirname(current);
    if (parent === current) return [cwd];
    current = parent;
  }
}
/** No identity is inferred from cwd, file content or a preset name. */
export function assembleContext(
  project: ProjectView,
  role: RegisteredRole,
  session: SessionRecord,
  cwd: string,
  limits: { fileBytes?: number; totalBytes?: number } = {},
): AssembledContext {
  const registered = project.roles.find((r) => r.id === role.id);
  if (
    !registered ||
    registered.type !== role.type ||
    session.roleId !== role.id ||
    session.roleType !== role.type
  )
    throw new ProjectError('IDENTITY_MISMATCH', '项目、角色与会话的正式关联不一致');
  if (!isAbsolute(cwd)) throw new ProjectError('INVALID_CWD', '工作目录必须为绝对路径');
  const workingDirectory = realpathSync(cwd);
  plainDirectory(workingDirectory);
  const resources = fileURLToPath(new URL('../../assets/', import.meta.url));
  const team = join(project.root, '.TEAM');
  const roleDirectory = join(team, '角色', role.id);
  for (const path of [project.root, team, join(team, '角色'), roleDirectory]) plainDirectory(path);
  const sources: ContextSource[] = [];
  const sections: { source: ContextSource; body: string }[] = [];
  const identity = {
    projectId: project.id,
    projectRoot: project.root,
    roleId: role.id,
    roleCode: role.code,
    roleType: role.type,
    sessionId: session.id,
    addresses: session.addresses,
    name: session.name,
    purpose: session.purpose,
    cwd: workingDirectory,
    requestedConfiguration: session.configuration,
    responsibility: '尚未派工',
    authorization: '未关联正式票据或执行授权；创建会话不等于开工',
    registeredRoles: project.roles.map((r) => ({ id: r.id, code: r.code, type: r.type })),
  };
  const parts = [
    `MAT 真实关联（系统记录，本次用途不产生额外权限）\n${JSON.stringify(identity, null, 2)}`,
  ];
  let total = Buffer.byteLength(parts[0]!);
  const totalLimit = limits.totalBytes ?? 65536;
  const append = (path: string, kind: ContextSource['kind'], optional = false) => {
    const before = optionalStat(path);
    if (!before && optional) return;
    if (!before) throw new ProjectError('MISSING_DOCUMENT', `缺少必需规范：${path}`);
    if (!before.isFile() || before.isSymbolicLink())
      throw new ProjectError('UNSAFE_PATH', `规范必须是普通文件：${path}`);
    if (before.size > (limits.fileBytes ?? 1048576))
      throw new ProjectError('CONTEXT_BUDGET', `规范文件超出完整读取预算：${path}`);
    let descriptor: number | undefined;
    let content: string;
    let bytes: Buffer;
    try {
      descriptor = openSync(path, 'r');
      const opened = fstatSync(descriptor);
      if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev)
        throw new Error('读取前规范发生变化');
      bytes = readFileSync(descriptor);
      const after = fstatSync(descriptor);
      const final = lstatSync(path);
      if (
        after.size !== bytes.length ||
        after.mtimeMs !== before.mtimeMs ||
        final.ino !== before.ino ||
        final.isSymbolicLink()
      )
        throw new Error('读取期间规范发生变化');
      content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new ProjectError('DOCUMENT_UNREADABLE', `规范无法完整读取，拒绝继续装配：${path}`);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
    const sha256 = digest(bytes);
    const section = `来源：${path}\n类型：${kind}\nSHA256：${sha256}\n正文开始\n${content}\n正文结束`;
    total += Buffer.byteLength(section) + 2;
    if (total > totalLimit)
      throw new ProjectError(
        'CONTEXT_BUDGET',
        '核心规范超出完整装配预算，请缩减规范或明确调整预算，不静默截断',
      );
    const source = {
      kind,
      path,
      sha256,
      bytes: bytes.length,
      modifiedAt: before.mtime.toISOString(),
    };
    sources.push(source);
    sections.push({ source, body: section });
    parts.push(section);
  };
  append(join(resources, 'platform.md'), 'platform');
  append(join(resources, 'workflows', `${role.type}.md`), 'type');
  append(join(team, 'TEAM.md'), 'project');
  append(join(roleDirectory, 'SOUL.md'), 'role');
  append(join(roleDirectory, 'AGENT.md'), 'role');
  for (const directory of workspaceDirectories(workingDirectory)) {
    // Reject junctions in an applicable ancestor chain instead of following them silently.
    const remainder = relative(directory, workingDirectory);
    let descendant = directory;
    plainDirectory(descendant);
    for (const segment of remainder.split(/[\\/]/).filter(Boolean)) {
      descendant = resolve(descendant, segment);
      plainDirectory(descendant);
    }
    for (const file of ['AGENTS.md', 'CLAUDE.md', 'AGENTS.local.md', 'CLAUDE.local.md'])
      append(join(directory, file), 'workspace', true);
  }
  // Do not stat or open USER.md for ordinary execution/review roles.
  if (role.type === 'supervisor') append(join(team, 'USER.md'), 'user-private', true);
  const body = parts.join('\n\n');
  if (Buffer.byteLength(body) > totalLimit)
    throw new ProjectError('CONTEXT_BUDGET', '身份与核心规范超出完整装配预算');
  return {
    projectId: project.id,
    roleId: role.id,
    version: digest(body),
    body,
    sources,
    sections,
    identity: parts[0]!,
  };
}
