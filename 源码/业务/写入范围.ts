import { existsSync, realpathSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve, relative, dirname, join, sep } from 'node:path';
import { ProjectError } from './错误.ts';
export function canonicalDirectory(path: string): string {
  if (!isAbsolute(path)) throw new ProjectError('INVALID_CWD', '工作目录须使用已有绝对路径');
  try {
    const canonical = realpathSync(path);
    if (!lstatSync(canonical).isDirectory()) throw new Error();
    return canonical;
  } catch {
    throw new ProjectError('INVALID_CWD', '源码工作目录不存在或不可访问');
  }
}
export function canonicalWriteScope(path: string): string {
  if (!isAbsolute(path) || /[*?]/.test(path))
    throw new ProjectError('INVALID_WRITE_SCOPE', '协调写域须为准确绝对路径，不使用通配符');
  const target = resolve(path);
  let parent = target;
  while (!existsSync(parent)) {
    const next = dirname(parent);
    if (next === parent) throw new ProjectError('INVALID_WRITE_SCOPE', '写域没有可核对的现有祖先');
    parent = next;
  }
  return resolve(join(realpathSync(parent), relative(parent, target)));
}
export function withinPath(root: string, path: string): boolean {
  const rest = relative(root, path);
  return rest !== '..' && !rest.startsWith('..' + sep) && !isAbsolute(rest);
}
export const scopesOverlap = (a: string, b: string) => withinPath(a, b) || withinPath(b, a);
