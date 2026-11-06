import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve, relative, isAbsolute, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import type {
  SnapshotInput,
  SnapshotRoot,
  SnapshotFile,
  WorkspaceSnapshot,
  WorkspaceDiff,
} from '../契约/版本.ts';
import { ProjectError } from './错误.ts';
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const within = (root: string, path: string) => {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (!rel.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) &&
      rel !== '..' &&
      !isAbsolute(rel))
  );
};
function checkedDirectory(path: string) {
  const actual = realpathSync(path),
    declared = resolve(path),
    key = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  if (
    key(actual) !== key(declared) ||
    lstatSync(path).isSymbolicLink() ||
    !lstatSync(path).isDirectory()
  )
    throw new ProjectError('SNAPSHOT_LINK', '原件存储或其祖先是链接，拒绝跟随读写');
}
function git(
  root: string,
  args: string[],
  options: { input?: Buffer; index?: string; allowFailure?: boolean } = {},
) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of [
    'GIT_INDEX_FILE',
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  ])
    delete (env as Record<string, string | undefined>)[key];
  if (options.index) (env as Record<string, string | undefined>).GIT_INDEX_FILE = options.index;
  const run = spawnSync('git', ['-C', root, '-c', 'core.quotepath=false', ...args], {
    input: options.input,
    env,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    timeout: 30000,
  });
  if (run.error || (!options.allowFailure && run.status !== 0))
    throw new ProjectError(
      'SNAPSHOT_GIT_ERROR',
      run.error?.message ?? run.stderr.toString().trim(),
    );
  return { status: run.status, bytes: run.stdout };
}
function safeFile(root: string, path: string) {
  const full = resolve(root, path);
  if (!within(root, full)) throw new ProjectError('SNAPSHOT_PATH', '快照路径越出声明范围');
  // Reject linked parents as well as linked leaves; never follow a declared path into another tree.
  let cursor = root;
  for (const part of relative(root, full).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    if (lstatSync(cursor).isSymbolicLink())
      throw new ProjectError('SNAPSHOT_LINK', '快照不跟随符号链接：' + path);
  }
  const stat = lstatSync(full);
  if (!stat.isFile()) throw new ProjectError('SNAPSHOT_STRUCTURE', '快照只接受普通文件：' + path);
  return full;
}
function gitFiles(
  root: string,
  excluded: string[],
  budget: { files: number; bytes: number; maxFiles: number; maxBytes: number },
) {
  const names = [
    ...new Set(
      git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
        .bytes.toString()
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  const modes = new Map<string, string>();
  for (const entry of git(root, ['ls-files', '--stage', '-z'])
    .bytes.toString()
    .split('\0')
    .filter(Boolean)) {
    const tab = entry.indexOf('\t'),
      [mode, , stage] = entry.slice(0, tab).split(' '),
      path = entry.slice(tab + 1);
    if (stage !== '0' || mode === '160000')
      throw new ProjectError('SNAPSHOT_STRUCTURE', '未合并索引或子模块不能冒充完整工作区：' + path);
    modes.set(path, mode!);
  }
  return names.flatMap((path) => {
    const full = resolve(root, path);
    if (excluded.some((ex) => within(ex, full))) return [];
    const stat = lstatSync(full, { throwIfNoEntry: false });
    if (!stat) return []; // Only ENOENT means deletion; permission failures and broken links are not omissions.
    safeFile(root, path);
    const size = stat.size;
    if (
      size > 8 * 1024 * 1024 ||
      budget.bytes + size > budget.maxBytes ||
      budget.files + 1 > budget.maxFiles
    )
      throw new ProjectError('SNAPSHOT_BUDGET', '单文件8MiB或总快照预算超限，未读取或裁剪该文件');
    const bytes = readFileSync(full);
    budget.files++;
    budget.bytes += bytes.length;
    if (budget.files > budget.maxFiles || budget.bytes > budget.maxBytes)
      throw new ProjectError('SNAPSHOT_BUDGET', '文件数或字节数超出完整快照预算，未裁剪');
    const mode = modes.get(path) ?? '100644';
    if (!['100644', '100755'].includes(mode))
      throw new ProjectError('SNAPSHOT_STRUCTURE', '不支持的文件类型：' + path);
    return [
      {
        file: {
          path,
          sha256: hash(bytes),
          size: bytes.length,
          mode: mode as SnapshotFile['mode'],
          objectId: null as string | null,
        },
        bytes,
      },
    ];
  });
}
function indexBytes(root: string) {
  const path = resolve(
    root,
    git(root, ['rev-parse', '--git-path', 'index']).bytes.toString().trim(),
  );
  return existsSync(path) ? readFileSync(path) : null;
}
function captureFiles(
  root: string,
  storage: string,
  excluded: string[],
  budget: { files: number; bytes: number; maxFiles: number; maxBytes: number },
  persist = true,
): SnapshotRoot {
  const scan = () => {
    const found: { file: SnapshotFile; bytes: Buffer }[] = [];
    let totalBytes = 0;
    const walk = (directory: string) => {
      if (directory !== root && existsSync(join(directory, '.git')))
        throw new ProjectError('SNAPSHOT_STRUCTURE', '非Git范围含未声明嵌套仓库：' + directory);
      for (const name of readdirSync(directory).sort()) {
        const full = join(directory, name);
        if (excluded.some((ex) => within(ex, full))) continue;
        const stat = lstatSync(full);
        if (stat.isSymbolicLink())
          throw new ProjectError('SNAPSHOT_LINK', '快照不跟随符号链接：' + full);
        if (stat.isDirectory()) {
          walk(full);
          continue;
        }
        safeFile(root, relative(root, full));
        if (
          stat.size > 8 * 1024 * 1024 ||
          totalBytes + stat.size > budget.maxBytes ||
          found.length + 1 > budget.maxFiles
        )
          throw new ProjectError('SNAPSHOT_BUDGET', '单文件8MiB或范围预算超限，未读取或裁剪该文件');
        const bytes = readFileSync(full);
        totalBytes += bytes.length;
        found.push({
          file: {
            path: relative(root, full).replaceAll('\\', '/'),
            sha256: hash(bytes),
            size: bytes.length,
            mode: process.platform !== 'win32' && stat.mode & 0o111 ? '100755' : '100644',
            objectId: null,
          },
          bytes,
        });
        if (found.length > budget.maxFiles || totalBytes > budget.maxBytes)
          throw new ProjectError('SNAPSHOT_BUDGET', '非Git范围超出完整快照预算，未裁剪');
      }
    };
    walk(root);
    return found.sort((a, b) => a.file.path.localeCompare(b.file.path, 'en'));
  };
  const items = scan();
  budget.files += items.length;
  budget.bytes += items.reduce((sum, item) => sum + item.bytes.length, 0);
  if (budget.files > budget.maxFiles || budget.bytes > budget.maxBytes)
    throw new ProjectError('SNAPSHOT_BUDGET', '总范围超出完整快照预算，未裁剪');
  if (persist) {
    const originalRoot = join(storage, 'sha256');
    mkdirSync(originalRoot, { recursive: true });
    checkedDirectory(originalRoot);
    for (const { file, bytes } of items) {
      const path = join(originalRoot, file.sha256);
      if (lstatSync(path, { throwIfNoEntry: false })) {
        safeFile(storage, 'sha256/' + file.sha256);
        if (lstatSync(path).size !== file.size || hash(readFileSync(path)) !== file.sha256)
          throw new ProjectError('SNAPSHOT_CORRUPT', '已存原件哈希不符，未覆盖');
      } else writeFileSync(path, bytes, { flag: 'wx' });
    }
  }
  if (
    JSON.stringify(items.map((item) => item.file)) !==
    JSON.stringify(scan().map((item) => item.file))
  )
    throw new ProjectError('SNAPSHOT_CHANGED', '采样期间文件变化，未固定该版本');
  return {
    root,
    kind: 'files',
    head: null,
    tree: null,
    ref: null,
    files: items.map((item) => item.file),
  };
}
function captureGit(
  root: string,
  id: string,
  excluded: string[],
  budget: { files: number; bytes: number; maxFiles: number; maxBytes: number },
  persist = true,
): SnapshotRoot {
  const before = indexBytes(root),
    items = gitFiles(root, excluded, budget);
  if (!persist) {
    const checked = gitFiles(root, excluded, { ...budget, files: 0, bytes: 0 }),
      after = indexBytes(root);
    if (
      JSON.stringify(items.map((item) => item.file)) !==
      JSON.stringify(checked.map((item) => item.file))
    )
      throw new ProjectError('SNAPSHOT_CHANGED', '只读核对期间工作区发生变化');
    if ((before === null) !== (after === null) || (before && after && !before.equals(after)))
      throw new ProjectError('SNAPSHOT_INDEX_CHANGED', '只读核对期间真实暂存区变化');
    const head = git(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
    return {
      root,
      kind: 'git',
      head: head.status === 0 ? head.bytes.toString().trim() : null,
      tree: null,
      ref: null,
      files: items.map((item) => item.file),
    };
  }
  const directory = mkdtempSync(join(tmpdir(), 'mat-snapshot-index-')),
    index = join(directory, 'index');
  try {
    const objectFormat = git(root, ['rev-parse', '--show-object-format']).bytes.toString().trim();
    for (let offset = 0; offset < items.length;) {
      const batch = [];
      let length = 0;
      do {
        const item = items[offset++]!;
        batch.push(item);
        length += item.file.path.length + 1;
      } while (
        offset < items.length &&
        batch.length < 200 &&
        length + items[offset]!.file.path.length < 12000
      );
      const ids = git(root, [
        'hash-object',
        '-w',
        '--no-filters',
        '--',
        ...batch.map((item) => item.file.path),
      ])
        .bytes.toString()
        .trim()
        .split(/\r?\n/);
      if (ids.length !== batch.length)
        throw new ProjectError('SNAPSHOT_OBJECTS', 'Git未返回完整对象身份');
      batch.forEach((item, i) => {
        const expected = createHash(objectFormat)
          .update(`blob ${item.bytes.length}\0`)
          .update(item.bytes)
          .digest('hex');
        if (ids[i] !== expected)
          throw new ProjectError('SNAPSHOT_CHANGED', '建立对象时文件发生变化：' + item.file.path);
        item.file.objectId = ids[i]!;
      });
    }
    git(root, ['read-tree', '--empty'], { index });
    git(root, ['update-index', '-z', '--index-info'], {
      index,
      input: Buffer.from(
        items.map(({ file }) => `${file.mode} ${file.objectId}\t${file.path}\0`).join(''),
      ),
    });
    const tree = git(root, ['write-tree'], { index }).bytes.toString().trim();
    const afterItems = gitFiles(root, excluded, {
      files: 0,
      bytes: 0,
      maxFiles: budget.maxFiles,
      maxBytes: budget.maxBytes,
    });
    if (
      JSON.stringify(items.map((item) => [item.file.path, item.file.sha256, item.file.mode])) !==
      JSON.stringify(afterItems.map((item) => [item.file.path, item.file.sha256, item.file.mode]))
    )
      throw new ProjectError('SNAPSHOT_CHANGED', '采样期间工作区发生变化，未固定该版本');
    const after = indexBytes(root);
    if ((before === null) !== (after === null) || (before && after && !before.equals(after)))
      throw new ProjectError(
        'SNAPSHOT_INDEX_CHANGED',
        '真实暂存区在采样期间变化，不能宣称前后一致',
      );
    const ref = 'refs/mat/snapshots/' + id;
    git(root, ['update-ref', ref, tree]);
    const head = git(root, ['rev-parse', '--verify', 'HEAD'], { allowFailure: true });
    return {
      root,
      kind: 'git',
      head: head.status === 0 ? head.bytes.toString().trim() : null,
      tree,
      ref,
      files: items.map((item) => item.file),
    };
  } finally {
    if (!within(tmpdir(), directory) || !directory.includes('mat-snapshot-index-'))
      throw new ProjectError('SNAPSHOT_TEMP_PATH', '临时index清理路径不符');
    rmSync(directory, { recursive: true, force: true });
  }
}
function sampleWorkspace(input: SnapshotInput, persist: boolean): WorkspaceSnapshot {
  if (
    !isAbsolute(input.cwd) ||
    !isAbsolute(input.storage) ||
    [
      ...(input.additionalRepositories ?? []),
      ...(input.materialRoots ?? []),
      ...(input.excluded ?? []),
    ].some((path) => !isAbsolute(path))
  )
    throw new ProjectError('SNAPSHOT_PATH', '快照范围及存储须为明确绝对路径');
  const cwd = realpathSync(input.cwd),
    id = randomUUID(),
    excluded = [input.storage, ...(input.excluded ?? [])].map((path) => resolve(path)),
    budget = {
      files: 0,
      bytes: 0,
      maxFiles: input.maxFiles ?? 10000,
      maxBytes: input.maxBytes ?? 256 * 1024 * 1024,
    };
  if (persist) mkdirSync(input.storage, { recursive: true });
  if (existsSync(input.storage)) checkedDirectory(input.storage);
  const locate = (path: string) => {
    const result = git(path, ['rev-parse', '--show-toplevel'], { allowFailure: true });
    if (result.status === 0) return realpathSync(result.bytes.toString().trim());
    let cursor = path;
    while (true) {
      if (existsSync(join(cursor, '.git')))
        throw new ProjectError(
          'SNAPSHOT_GIT_ERROR',
          '已声明Git目录无法解析，未按非Git目录降级：' + path,
        );
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (existsSync(join(path, 'HEAD')) && existsSync(join(path, 'objects')))
      throw new ProjectError('SNAPSHOT_STRUCTURE', '裸仓库不能冒充源码工作区');
    return null;
  };
  const main = locate(cwd),
    additional = [
      ...new Set(
        (input.additionalRepositories ?? []).map((path) => {
          const root = locate(realpathSync(path));
          if (!root)
            throw new ProjectError(
              'SNAPSHOT_SCOPE',
              '声明的额外仓库不是可取得的Git工作区：' + path,
            );
          return root;
        }),
      ),
    ]
      .filter((path) => path !== main)
      .sort();
  const materials = [
    ...new Set((input.materialRoots ?? []).map((path) => realpathSync(path))),
  ].sort();
  if (materials.some((path) => within(resolve(input.storage), path)))
    throw new ProjectError('SNAPSHOT_SCOPE', '原件存储不能成为材料输入');
  const codeExcluded = [...excluded, ...materials],
    root = main ?? cwd;
  const roots = [
    main
      ? captureGit(root, id, [...codeExcluded, ...additional], budget, persist)
      : captureFiles(root, input.storage, [...codeExcluded, ...additional], budget, persist),
    ...additional.map((root) => captureGit(root, id, codeExcluded, budget, persist)),
    ...materials.map((root) =>
      captureFiles(
        root,
        input.storage,
        excluded.filter((ex) => !within(ex, root)),
        budget,
        persist,
      ),
    ),
  ];
  const fingerprint = hash(
    Buffer.from(
      JSON.stringify(
        roots.map(({ root, kind, files }) => ({
          root,
          kind,
          files: files.map(({ path, sha256, mode }) => ({ path, sha256, mode })),
        })),
      ),
    ),
  );
  return { id, createdAt: new Date().toISOString(), fingerprint, roots, excluded };
}
export function captureWorkspace(input: SnapshotInput): WorkspaceSnapshot {
  return sampleWorkspace(input, true);
}
export function inspectWorkspace(input: SnapshotInput): WorkspaceSnapshot {
  return sampleWorkspace(input, false);
}
export function readSnapshotFile(
  snapshot: WorkspaceSnapshot,
  rootIndex: number,
  path: string,
  storage: string,
): Buffer {
  const root = snapshot.roots[rootIndex],
    file = root?.files.find((file) => file.path === path);
  if (!root || !file || !/^[0-9a-f]{64}$/.test(file.sha256))
    throw new ProjectError('SNAPSHOT_FILE_MISSING', '该固定版本没有此文件原件');
  const bytes =
    root.kind === 'git' && file.objectId
      ? git(root.root, ['cat-file', 'blob', file.objectId]).bytes
      : (() => {
          checkedDirectory(storage);
          const path = safeFile(storage, 'sha256/' + file.sha256);
          if (lstatSync(path).size !== file.size)
            throw new ProjectError('SNAPSHOT_CORRUPT', '固定原件大小或哈希不符');
          return readFileSync(path);
        })();
  if (hash(bytes) !== file.sha256) throw new ProjectError('SNAPSHOT_CORRUPT', '固定原件哈希不符');
  return bytes;
}
export function compareWorkspaces(
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
  storage: string,
): WorkspaceDiff {
  const changes: WorkspaceDiff['changes'] = [];
  let patch = '';
  if (
    JSON.stringify(before.roots.map((root) => root.root)) !==
    JSON.stringify(after.roots.map((root) => root.root))
  )
    throw new ProjectError('SNAPSHOT_SCOPE_CHANGED', '快照范围不同，不能作为同票版本比较');
  for (let i = 0; i < before.roots.length; i++) {
    const a = before.roots[i]!,
      b = after.roots[i]!,
      old = new Map(a.files.map((file) => [file.path, file])),
      next = new Map(b.files.map((file) => [file.path, file]));
    if (a.kind !== b.kind)
      throw new ProjectError('SNAPSHOT_SCOPE_CHANGED', '仓库类型变化，不能替换原版本');
    for (const path of [...new Set([...old.keys(), ...next.keys()])].sort()) {
      const from = old.get(path),
        to = next.get(path);
      if (from?.sha256 === to?.sha256 && from?.mode === to?.mode) continue;
      changes.push({
        root: a.root,
        path,
        status: !from ? 'added' : !to ? 'deleted' : 'modified',
        before: from?.sha256 ?? null,
        after: to?.sha256 ?? null,
      });
      if (a.kind === 'files') {
        const original = from ? readSnapshotFile(before, i, path, storage) : Buffer.alloc(0),
          updated = to ? readSnapshotFile(after, i, path, storage) : Buffer.alloc(0);
        try {
          const decoder = new TextDecoder('utf-8', { fatal: true }),
            left = decoder.decode(original),
            right = decoder.decode(updated);
          if (left.includes('\0') || right.includes('\0')) throw new Error('binary');
          const lines = (text: string) =>
            text === '' ? [] : text.split('\n').slice(0, text.endsWith('\n') ? -1 : undefined);
          const l = lines(left),
            r = lines(right);
          patch +=
            `--- ${from ? 'a/' + path : '/dev/null'}\n+++ ${to ? 'b/' + path : '/dev/null'}\n@@ -${l.length ? '1,' + l.length : '0,0'} +${r.length ? '1,' + r.length : '0,0'} @@\n` +
            l.map((line) => '-' + line + '\n').join('') +
            (left && !left.endsWith('\n') ? '\\ No newline at end of file\n' : '') +
            r.map((line) => '+' + line + '\n').join('') +
            (right && !right.endsWith('\n') ? '\\ No newline at end of file\n' : '');
        } catch {
          patch += `Binary files differ: ${path}\n`;
        }
        if (Buffer.byteLength(patch) > 8 * 1024 * 1024)
          throw new ProjectError('SNAPSHOT_DIFF_BUDGET', '完整差异超过8MiB，不返回截断结果');
      }
    }
    if (a.kind === 'git') {
      if (!a.tree || !b.tree) throw new ProjectError('SNAPSHOT_TREE_MISSING', 'Git版本树缺件');
      patch += git(a.root, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-renames',
        '--binary',
        a.tree,
        b.tree,
        '--',
      ]).bytes.toString();
    }
    if (Buffer.byteLength(patch) > 8 * 1024 * 1024)
      throw new ProjectError('SNAPSHOT_DIFF_BUDGET', '完整差异超过8MiB，不返回截断结果');
  }
  return { changes, patch };
}
