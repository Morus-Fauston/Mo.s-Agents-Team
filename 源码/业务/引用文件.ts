import { isAbsolute, relative, resolve } from 'node:path';
import { lstatSync, realpathSync, readFileSync, accessSync, constants } from 'node:fs';
import type { ProjectConnection } from './项目.ts';
import type { ChatActor, ChatMessage } from '../契约/私聊.ts';
import { ProjectError } from './错误.ts';
const within = (root: string, path: string) => {
  const rest = relative(root, path);
  return rest !== '..' && !rest.startsWith('../') && !rest.startsWith('..\\') && !isAbsolute(rest);
};
export function checkReferences(
  connection: ProjectConnection,
  actor: ChatActor,
  target: string,
  references: ChatMessage['references'],
): ChatMessage['references'] {
  if (references.length === 0) return [];
  const project = connection.snapshot();
  const recipient =
    target === 'user'
      ? undefined
      : connection.session(connection.messages().resolveTarget(target).id);
  const sender = actor.kind === 'session' ? connection.session(actor.sessionId) : undefined;
  const roots = [
    project.root,
    ...(sender ? [sender.cwd] : []),
    ...(recipient ? [recipient.cwd] : []),
    ...[sender, recipient].flatMap((session) => {
      const execution = session && connection.executions().currentForSession(session.id);
      return execution ? [execution.cwd] : [];
    }),
  ].map((root) => realpathSync(root));
  return references.map((reference) => {
    try {
      if (!isAbsolute(reference.path)) throw new Error('文件引用须提供绝对路径');
      const stat = lstatSync(reference.path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('引用必须是可读普通文件');
      const path = realpathSync(reference.path);
      if (!roots.some((root) => within(root, path)))
        throw new Error('引用超出已关联的项目或工作目录');
      const normalized = path.replaceAll('\\', '/');
      if (
        /(?:^|\/)\.TEAM\/运行数据(?:\/|$)/i.test(normalized) ||
        /(?:^|\/)\.credentials\.yaml$/i.test(normalized)
      )
        throw new Error('运行数据或凭据文件不作为聊天引用提供');
      if (
        /(?:^|\/)\.TEAM\/USER\.md$/i.test(normalized) &&
        ((sender && sender.roleType !== 'supervisor') ||
          (recipient && recipient.roleType !== 'supervisor'))
      )
        throw new Error('USER.md仅主管适用，文件引用不扩大私密资料范围');
      accessSync(path, constants.R_OK);
      if (
        reference.startLine !== undefined &&
        reference.endLine !== undefined &&
        reference.endLine < reference.startLine
      )
        throw new Error('引用结束行不能小于开始行');
      if (reference.snippet !== undefined) {
        if (reference.startLine === undefined || reference.endLine === undefined)
          throw new Error('显式片段须带准确行范围');
        const actual = readReferenceText({ ...reference, path });
        if (actual !== reference.snippet)
          throw new Error('所选片段与当前文件行范围不一致，请重新核对');
      }
      return { ...reference, path: resolve(path) };
    } catch (error) {
      throw new ProjectError(
        'INVALID_REFERENCE',
        error instanceof Error ? error.message : '无法核对引用文件',
      );
    }
  });
}
export function readReferenceText(reference: ChatMessage['references'][number]): string {
  const stat = lstatSync(reference.path);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new ProjectError('REFERENCE_UNAVAILABLE', '引用文件已不可用');
  if (stat.size > 1048576)
    throw new ProjectError(
      'REFERENCE_BUDGET',
      '文件超出1MiB文本预览预算，不静默裁剪；请使用准确片段或本机文件工具',
    );
  const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(reference.path));
  if (reference.startLine === undefined && reference.endLine === undefined) return text;
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const start = reference.startLine ?? 1,
    end = reference.endLine ?? lines.length;
  if (start > lines.length || end > lines.length)
    throw new ProjectError('REFERENCE_RANGE', '引用行范围超出当前文件');
  return lines.slice(start - 1, end).join('\n');
}
