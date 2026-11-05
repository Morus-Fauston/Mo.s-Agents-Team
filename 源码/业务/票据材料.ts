import { mkdirSync, existsSync, lstatSync, realpathSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { ProjectError } from './错误.ts';
const within = (root: string, path: string) => {
  const rest = relative(root, path);
  return rest !== '..' && !rest.startsWith('..' + sep) && !isAbsolute(rest);
};
export function ensureMaterialRoot(projectRoot: string, code: string): string {
  if (!/^P\d{3}(?:SP)?-[A-Z]{1,16}-\d{3}(?:-[a-z])?$/.test(code))
    throw new ProjectError('INVALID_MATERIAL_CODE', '材料入口必须使用系统分配的稳定票号');
  const root = realpathSync(projectRoot);
  let current = root;
  for (const name of ['.TEAM', '票据材料', code]) {
    current = join(current, name);
    if (!within(root, current)) throw new ProjectError('MATERIAL_RANGE', '材料入口超出项目范围');
    if (existsSync(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new ProjectError('MATERIAL_LINK', '材料入口存在链接或异常目录');
    } else mkdirSync(current);
  }
  return current;
}
function checked(root: string, path: string): string {
  try {
    const base = realpathSync(root);
    if (resolve(root).toLowerCase() !== base.toLowerCase())
      throw new ProjectError('MATERIAL_LINK', '材料根或其祖先路径存在链接，不跟随读取');
    if (lstatSync(root).isSymbolicLink())
      throw new ProjectError('MATERIAL_LINK', '材料根目录不能是链接');
    if (isAbsolute(path))
      throw new ProjectError('MATERIAL_RANGE', '请选择票内材料相对路径，不能扩大范围');
    const candidate = resolve(base, path);
    if (!within(base, candidate)) throw new ProjectError('MATERIAL_RANGE', '文件超出票内材料范围');
    let cursor = base;
    for (const part of relative(base, candidate).split(sep).filter(Boolean)) {
      cursor = join(cursor, part);
      if (lstatSync(cursor).isSymbolicLink())
        throw new ProjectError('MATERIAL_LINK', '材料路径包含链接，不跟随读取');
    }
    if (!within(base, realpathSync(candidate)))
      throw new ProjectError('MATERIAL_RANGE', '文件超出票内材料范围');
    return candidate;
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    throw new ProjectError('MATERIAL_UNAVAILABLE', '材料不存在或不可访问，请核对原始交付');
  }
}
export function listMaterials(root: string, path: string) {
  const directory = materialDirectory(root, path);
  return readdirSync(directory, { withFileTypes: true }).map((entry) => ({
    name: entry.name,
    path: relative(root, join(directory, entry.name)).replaceAll('\\', '/'),
    kind: entry.isSymbolicLink() ? 'unavailable' : entry.isDirectory() ? 'directory' : 'file',
    size: entry.isFile() ? lstatSync(join(directory, entry.name)).size : null,
  }));
}
export function materialDirectory(root: string, path: string): string {
  const directory = checked(root, path);
  if (!lstatSync(directory).isDirectory())
    throw new ProjectError('MATERIAL_NOT_DIRECTORY', '此入口不是材料目录');
  return directory;
}
export function ensureMaterialSubdomain(
  projectRoot: string,
  code: string,
  kind: 'main' | 'assistant' | 'review',
  id: string,
): string {
  if (!/^[0-9a-f-]{36}$/i.test(id))
    throw new ProjectError('INVALID_MATERIAL_DOMAIN', '材料子域须使用系统分配身份');
  const root = ensureMaterialRoot(projectRoot, code);
  let path = root;
  for (const part of [kind === 'review' ? '审阅' : kind === 'assistant' ? '协作' : '执行', id]) {
    path = join(path, part);
    if (existsSync(path)) {
      if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory())
        throw new ProjectError('MATERIAL_LINK', '材料子域存在链接或异常目录');
    } else mkdirSync(path);
  }
  return materialDirectory(root, relative(root, path));
}
export function materialFile(root: string, path: string): string {
  const file = checked(root, path);
  if (!lstatSync(file).isFile())
    throw new ProjectError('MATERIAL_NOT_FILE', '此入口不是可读取的普通文件');
  return file;
}
export function readMaterial(root: string, path: string): Buffer {
  return readFileSync(materialFile(root, path));
}
