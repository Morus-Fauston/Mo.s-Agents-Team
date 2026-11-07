import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, lstatSync, existsSync, createReadStream } from 'node:fs';
import { resolve, isAbsolute, join, relative, sep } from 'node:path';
import { localGitPlanSchema } from '../contracts/local-commits.ts';
import type { LocalGitPlan, LocalGitProof } from '../contracts/local-commits.ts';
import { ProjectError } from './errors.ts';
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
async function fileHash(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const key = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
const environment = () => {
  const result: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
  };
  for (const name of [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_INDEX_FILE',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_COMMON_DIR',
  ])
    delete result[name];
  return result;
};
/** Local read commands only. No add, commit, reset, stash or remote command is issued here. */
function git(
  root: string,
  args: string[],
  allowed: number[] = [],
): Promise<{ status: number; output: Buffer }> {
  return new Promise((done, reject) => {
    execFile(
      'git',
      ['--literal-pathspecs', '-C', root, ...args],
      { windowsHide: true, env: environment(), maxBuffer: 8 * 1024 * 1024, encoding: 'buffer' },
      (error, stdout, stderr) => {
        if (!error) {
          done({ status: 0, output: stdout });
          return;
        }
        if (typeof error.code === 'number' && allowed.includes(error.code)) {
          done({ status: error.code, output: stdout });
          return;
        }
        reject(
          new ProjectError(
            'LOCAL_GIT_READ_FAILED',
            error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' || error.code === 'ENOBUFS'
              ? 'Git核对输出超出8MiB预算，未返回不完整事实'
              : `Git只读核对未完成（${args[0]}）：${stderr.toString('utf8').trim() || '请检查本机Git及原仓库状态'}`,
          ),
        );
      },
    );
  });
}
const text = async (root: string, args: string[], allowed: number[] = []) => {
  const r = await git(root, args, allowed);
  return {
    status: r.status,
    value: new TextDecoder('utf-8', { fatal: true }).decode(r.output).trim(),
  };
};
async function repository(input: string) {
  if (!isAbsolute(input)) throw new ProjectError('LOCAL_GIT_ROOT', '仓库必须为准确绝对路径');
  const requested = realpathSync(input),
    root = realpathSync((await text(requested, ['rev-parse', '--show-toplevel'])).value);
  if (key(requested) !== key(root))
    throw new ProjectError('LOCAL_GIT_ROOT', '请指定真实Git根，不用子目录代替操作对象');
  const gitDir = realpathSync((await text(root, ['rev-parse', '--absolute-git-dir'])).value),
    commonDir = realpathSync(
      (await text(root, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).value,
    );
  const branchResult = await text(root, ['symbolic-ref', '-q', 'HEAD'], [1]),
    branch = branchResult.status === 0 ? branchResult.value : null;
  const headResult = await text(root, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], [1]);
  const head: string | null = headResult.status === 0 ? headResult.value : null;
  if (
    head === null &&
    (!branch || (await text(root, ['show-ref', '--verify', '--quiet', branch], [1])).status !== 1)
  )
    throw new ProjectError('LOCAL_GIT_HEAD_UNKNOWN', 'HEAD无法解释为明确初始基线，未推断为空仓库');
  const fileMode = await text(root, ['config', '--bool', '--get', 'core.filemode'], [1]);
  return {
    root,
    gitDir,
    commonDir,
    head,
    branch,
    fileMode: fileMode.status === 1 || fileMode.value === 'true',
  };
}
type Repository = Awaited<ReturnType<typeof repository>>;
function requireNoOperation(repo: Repository) {
  const names = [
    'index.lock',
    'HEAD.lock',
    'MERGE_HEAD',
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'REBASE_HEAD',
    'rebase-merge',
    'rebase-apply',
    'sequencer',
    'packed-refs.lock',
  ];
  const found = [...new Set([repo.gitDir, repo.commonDir])].flatMap((root) =>
    names.filter((name) => existsSync(join(root, name))).map((name) => join(root, name)),
  );
  if (repo.branch && existsSync(join(repo.commonDir, repo.branch + '.lock')))
    found.push(join(repo.commonDir, repo.branch + '.lock'));
  if (found.length)
    throw new ProjectError(
      'LOCAL_GIT_IN_PROGRESS',
      'Git存在在途操作或锁，未自动清理：' + found.join('、'),
    );
}
async function status(root: string) {
  const parts = new TextDecoder('utf-8', { fatal: true })
      .decode((await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).output)
      .split('\0'),
    entries: { path: string; x: string; y: string; originalPath?: string }[] = [];
  for (let i = 0; i < parts.length; i++) {
    const row = parts[i];
    if (!row) continue;
    if (row.length < 4) throw new ProjectError('LOCAL_GIT_STATUS_UNKNOWN', 'Git状态记录不完整');
    const entry = {
      path: row.slice(3),
      x: row[0]!,
      y: row[1]!,
      ...(/[RC]/.test(row.slice(0, 2)) ? { originalPath: parts[++i] } : {}),
    };
    if (/[RC]/.test(row.slice(0, 2)) && !entry.originalPath)
      throw new ProjectError('LOCAL_GIT_STATUS_UNKNOWN', 'Git重命名来源缺失');
    entries.push(entry);
  }
  return entries;
}
const indexed = (entries: Awaited<ReturnType<typeof status>>) =>
  entries.filter((e) => e.x !== ' ' && e.x !== '?').map((e) => e.path);
function normalize(path: string) {
  const value = path.replaceAll('\\', '/');
  if (
    isAbsolute(path) ||
    value.includes('\0') ||
    value
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  )
    throw new ProjectError(
      'LOCAL_GIT_PATH',
      '必须明确单个仓库内相对文件，不能使用目录、Git元数据或越界范围',
    );
  return value;
}
async function file(repo: Repository, path: string) {
  const full = resolve(repo.root, path),
    rest = relative(repo.root, full);
  if (rest === '..' || rest.startsWith('..' + sep) || isAbsolute(rest))
    throw new ProjectError('LOCAL_GIT_PATH', '文件超出明确仓库');
  let cursor = repo.root;
  for (const part of path.split('/')) {
    cursor = join(cursor, part);
    let stat;
    try {
      stat = lstatSync(cursor);
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink())
      throw new ProjectError('LOCAL_GIT_PATH', '获准路径包含链接，未跟随读写');
  }
  if (!existsSync(full)) return { path, workingSha256: null, blob: null, mode: null };
  const stat = lstatSync(full);
  if (!stat.isFile())
    throw new ProjectError('LOCAL_GIT_PATH', '范围必须是明确普通文件，不自动展开目录');
  const workingSha256 = await fileHash(full);
  const old = (await text(repo.root, ['ls-files', '--stage', '-z', '--', path])).value,
    tracked = old.split(' ')[0];
  const mode: '100644' | '100755' =
    !repo.fileMode && ['100644', '100755'].includes(tracked ?? '')
      ? (tracked as '100644' | '100755')
      : (stat.mode & 0o111) !== 0
        ? '100755'
        : '100644';
  const blob = (await text(repo.root, ['hash-object', '--path=' + path, '--', path])).value;
  if (
    !existsSync(full) ||
    lstatSync(full).isSymbolicLink() ||
    (await fileHash(full)) !== workingSha256
  )
    throw new ProjectError(
      'LOCAL_GIT_DIFF_CHANGED',
      '核对期间文件已变化，未保存不一致差异：' + path,
    );
  return { path, workingSha256, blob, mode };
}
export async function captureLocalGit(
  root: string,
  paths: string[],
  kind: 'baseline' | 'commit',
): Promise<LocalGitPlan> {
  if (!paths.length || paths.length > 512)
    throw new ProjectError('LOCAL_GIT_RANGE', '必须明确1至512个文件，不自动全部暂存');
  const normalizedPaths = paths.map(normalize);
  const repo = await repository(root);
  requireNoOperation(repo);
  if ((kind === 'baseline') !== (repo.head === null))
    throw new ProjectError(
      'LOCAL_GIT_BASELINE',
      '初始基线或已有HEAD与明确安排不符，请回读而不是重做',
    );
  const entries = await status(repo.root);
  if (entries.some((e) => e.x === 'U' || e.y === 'U' || ['DD', 'AA'].includes(e.x + e.y)))
    throw new ProjectError('LOCAL_GIT_CONFLICT', '仓库有未解决冲突，提交者不代选业务一边');
  if (indexed(entries).length)
    throw new ProjectError('LOCAL_GIT_INDEX_BUSY', '已有暂存内容，不能推定归属或覆盖用户索引');
  const dirty = entries.flatMap((e) => [e.path, ...(e.originalPath ? [e.originalPath] : [])]),
    seen = new Set<string>();
  const files = [];
  for (const normalized of normalizedPaths) {
    const id = key(normalized);
    if (seen.has(id)) throw new ProjectError('LOCAL_GIT_RANGE', '同一文件不能重复安排');
    seen.add(id);
    const actual = dirty.find((path) => key(path) === id);
    if (!actual)
      throw new ProjectError('LOCAL_GIT_NO_DIFF', '指定文件没有可核对的待提交差异：' + normalized);
    files.push(await file(repo, actual));
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  const final = await repository(repo.root);
  requireNoOperation(final);
  if (
    final.head !== repo.head ||
    final.branch !== repo.branch ||
    final.gitDir !== repo.gitDir ||
    (await status(repo.root)).some((e) => e.x !== ' ' && e.x !== '?')
  )
    throw new ProjectError('LOCAL_GIT_DIFF_CHANGED', '核对期间基线或索引变化，未保存不一致预览');
  if (entries.length > 4096)
    throw new ProjectError('LOCAL_GIT_STATUS_BUDGET', '工作区差异超过4096项，先明确隔离范围再办理');
  const value = {
    repository: repo.root,
    gitDir: repo.gitDir,
    commonDir: repo.commonDir,
    head: repo.head,
    branch: repo.branch,
    kind,
    files,
  };
  return localGitPlanSchema.parse({
    ...value,
    fingerprint: sha(JSON.stringify(value)),
    capturedAt: new Date().toISOString(),
    worktreeChanges: entries,
  });
}
export async function assertLocalGitReady(plan: LocalGitPlan): Promise<void> {
  const current = await captureLocalGit(
    plan.repository,
    plan.files.map((f) => f.path),
    plan.kind,
  );
  if (current.fingerprint !== plan.fingerprint)
    throw new ProjectError(
      'LOCAL_GIT_DIFF_CHANGED',
      '原批准差异或基线已变化，请协调后重新明确范围',
    );
}
export async function verifyLocalCommit(
  plan: LocalGitPlan,
  commit?: string,
): Promise<LocalGitProof> {
  const repo = await repository(plan.repository),
    entries = await status(repo.root),
    head = repo.head;
  const proof: LocalGitProof = {
    state: 'mismatch',
    commit: commit ?? head,
    parents: [],
    paths: [],
    currentHead: head,
    indexPaths: indexed(entries),
    message: null,
    reason: '尚未核定',
    observedAt: new Date().toISOString(),
  };
  if (
    repo.gitDir !== plan.gitDir ||
    repo.commonDir !== plan.commonDir ||
    repo.branch !== plan.branch
  )
    return { ...proof, reason: '实际Git目录或分支已变化，先回原事项核对' };
  requireNoOperation(repo);
  if (proof.indexPaths.length)
    return { ...proof, reason: '核对时仍有暂存内容，保留索引并交原责任方核对' };
  if (!head || head === plan.head)
    return {
      ...proof,
      state: 'not-observed',
      reason: '尚无本次获准本地提交结果；查询没有执行Git写入',
    };
  if (commit && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))
    throw new ProjectError('LOCAL_GIT_COMMIT', '请选择准确本地commit对象ID');
  if (commit && commit !== head)
    return { ...proof, reason: '当前HEAD与回报对象不符，保留原对象并核对现场' };
  requireNoOperation(repo);
  proof.message = (await text(repo.root, ['show', '-s', '--format=%B', head])).value;
  const parents = (await text(repo.root, ['rev-list', '--parents', '-n', '1', head])).value
    .split(/\s+/)
    .slice(1);
  proof.parents = parents;
  if (JSON.stringify(parents) !== JSON.stringify(plan.head ? [plan.head] : []))
    return { ...proof, reason: '实际父提交不对应原基线，不接受混入其他操作或merge' };
  proof.paths = new TextDecoder('utf-8', { fatal: true })
    .decode(
      (
        await git(repo.root, [
          'diff-tree',
          '--root',
          '--no-commit-id',
          '--name-only',
          '--no-renames',
          '-r',
          '-z',
          head,
        ])
      ).output,
    )
    .split('\0')
    .filter(Boolean)
    .sort();
  if (JSON.stringify(proof.paths) !== JSON.stringify(plan.files.map((f) => f.path).sort()))
    return { ...proof, reason: '实际commit文件范围与明确批准不一致，未回滚或再提交' };
  for (const expected of plan.files) {
    const entry = (await text(repo.root, ['ls-tree', '-z', head, '--', expected.path])).value,
      metadata = entry ? entry.slice(0, entry.indexOf('\t')).split(' ') : null;
    if ((metadata?.[2] ?? null) !== expected.blob || (metadata?.[0] ?? null) !== expected.mode)
      return { ...proof, reason: '实际commit内容或模式不对应获准差异：' + expected.path };
    if (JSON.stringify(await file(repo, expected.path)) !== JSON.stringify(expected))
      return {
        ...proof,
        reason: '当前获准文件已再次变化，保留commit事实并交责任方核对：' + expected.path,
      };
  }
  if (
    (await repository(plan.repository)).head !== head ||
    (await status(repo.root)).some((e) => e.x !== ' ' && e.x !== '?')
  )
    return { ...proof, reason: '只读核对期间HEAD或索引发生变化，未推定结果稳定' };
  return {
    ...proof,
    state: 'verified',
    reason: '本地commit父提交、准确文件及Git规范化内容与原批准一致；不是远程发布或业务验收结果',
    tree: (await text(plan.repository, ['rev-parse', '--verify', head + '^{tree}'])).value,
  };
}
/** Resolve the explicitly selected local object; staged/uncommitted source changes remain observations. */
export async function inspectWorktreeSource(root: string, from?: string) {
  const repo = await repository(root);
  requireNoOperation(repo);
  if (!repo.head)
    throw new ProjectError(
      'WORKTREE_BASELINE_REQUIRED',
      '没有明确本地提交基线，先由主管安排基线，不假定携带未提交内容',
    );
  const selected = from ?? repo.head;
  if (!selected.trim() || selected.includes('\0'))
    throw new ProjectError('WORKTREE_BASELINE_REQUIRED', '请选择明确本地提交、分支或tag');
  const commit = (
    await text(repo.root, ['rev-parse', '--verify', '--end-of-options', selected + '^{commit}'])
  ).value;
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit))
    throw new ProjectError('WORKTREE_BASELINE_UNKNOWN', '本地基线未解析为完整commit对象');
  const changes = await status(repo.root);
  if (changes.some((e) => e.x === 'U' || e.y === 'U' || ['DD', 'AA'].includes(e.x + e.y)))
    throw new ProjectError('WORKTREE_SOURCE_CONFLICT', '原仓库存在未解决冲突，先交主管协调');
  return {
    repository: repo.root,
    gitDir: repo.gitDir,
    commonDir: repo.commonDir,
    head: repo.head,
    branch: repo.branch,
    commit,
    indexPaths: indexed(changes),
    changes,
  };
}
/** A directory alone is not a workspace: verify Git registration and the real common repository. */
export async function inspectRegisteredWorktree(source: string, path: string) {
  const original = await repository(source),
    target = await repository(path);
  requireNoOperation(original);
  requireNoOperation(target);
  const entries = new TextDecoder('utf-8', { fatal: true })
    .decode((await git(original.root, ['worktree', 'list', '--porcelain', '-z'])).output)
    .split('\0\0');
  const found = entries.find((entry) =>
    entry
      .split('\0')
      .some(
        (line) => line.startsWith('worktree ') && key(resolve(line.slice(9))) === key(target.root),
      ),
  );
  if (
    !found ||
    key(original.commonDir) !== key(target.commonDir) ||
    key(original.gitDir) === key(target.gitDir)
  )
    throw new ProjectError('WORKTREE_MEMBERSHIP', '目录不是原共同仓库中登记的独立工作树');
  const fields = found.split('\0');
  if (
    fields.some(
      (f) =>
        f === 'locked' || f.startsWith('locked ') || f === 'prunable' || f.startsWith('prunable '),
    )
  )
    throw new ProjectError('WORKTREE_REGISTRATION_UNKNOWN', '工作树登记被锁定或失效，先核对原目录');
  const registeredHead = fields.find((f) => f.startsWith('HEAD '))?.slice(5),
    registeredBranch = fields.find((f) => f.startsWith('branch '))?.slice(7) ?? null;
  if (!target.head || target.head !== registeredHead || target.branch !== registeredBranch)
    throw new ProjectError('WORKTREE_REGISTRATION_UNKNOWN', '实际HEAD或分支与工作树登记不符');
  const changes = await status(target.root);
  return {
    path: target.root,
    repository: original.root,
    gitDir: target.gitDir,
    commonDir: target.commonDir,
    head: target.head,
    branch: target.branch,
    indexPaths: indexed(changes),
    changes,
  };
}
export async function assertWorktreeDestinationUnused(source: string, path: string, name: string) {
  if (lstatSync(path, { throwIfNoEntry: false }))
    throw new ProjectError('WORKTREE_PATH_EXISTS', '目标目录已存在，保留原现场，不接管或重建');
  await text(source, ['check-ref-format', 'refs/heads/' + name]);
  if (
    (await text(source, ['show-ref', '--verify', '--quiet', 'refs/heads/' + name], [1])).status ===
    0
  )
    throw new ProjectError(
      'WORKTREE_BRANCH_EXISTS',
      '本地分支已存在，先明确复用或核对原创建，不重建',
    );
}
export async function inspectWorktreeCleanup(source: string, path: string) {
  const original = await repository(source);
  requireNoOperation(original);
  if (!original.head)
    throw new ProjectError('WORKTREE_COMMON_HEAD_UNKNOWN', '共同源码根没有可核对HEAD，不清理');
  const actual = await inspectRegisteredWorktree(source, path),
    ignoredPaths = new TextDecoder('utf-8', { fatal: true })
      .decode(
        (await git(actual.path, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']))
          .output,
      )
      .split('\0')
      .filter(Boolean);
  const merged =
    (await text(original.root, ['merge-base', '--is-ancestor', actual.head, original.head], [1]))
      .status === 0;
  return {
    ...actual,
    sourceHead: original.head,
    ignoredPaths,
    clean: actual.changes.length === 0 && ignoredPaths.length === 0,
    merged,
  };
}
export async function inspectWorktreeRemoval(
  source: string,
  path: string,
  branch: string,
  expectedHead: string,
) {
  const original = await repository(source);
  requireNoOperation(original);
  const listed = new TextDecoder('utf-8', { fatal: true }).decode(
      (await git(original.root, ['worktree', 'list', '--porcelain', '-z'])).output,
    ),
    registered = listed
      .split('\0')
      .some(
        (line) =>
          line.startsWith('worktree ') && key(resolve(line.slice(9))) === key(resolve(path)),
      ),
    tip = await text(
      original.root,
      ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch + '^{commit}'],
      [1],
    );
  return {
    removed: !lstatSync(path, { throwIfNoEntry: false }) && !registered,
    registered,
    branchRetained: tip.status === 0 && tip.value === expectedHead,
    head: tip.status === 0 ? tip.value : null,
    observedAt: new Date().toISOString(),
  };
}
export async function verifyRetainedGitSnapshots(
  commonDir: string,
  roots: {
    commonDir: string | null;
    ref: string | null;
    tree: string | null;
    files: { objectId: string | null; size: number }[];
  }[],
): Promise<void> {
  const objects = new Map<string, number>();
  for (const root of roots) {
    if (
      !root.commonDir ||
      key(realpathSync(root.commonDir)) !== key(realpathSync(commonDir)) ||
      !root.ref ||
      !root.tree
    )
      throw new ProjectError(
        'WORKTREE_EVIDENCE_UNPROVEN',
        '固定原件没有独立共同Git目录及保留ref，不能删除其现场',
      );
    if (
      (await text(commonDir, ['rev-parse', '--verify', '--end-of-options', root.ref + '^{tree}']))
        .value !== root.tree
    )
      throw new ProjectError('WORKTREE_EVIDENCE_UNPROVEN', '原固定版本保留ref与实际对象不符');
    for (const file of root.files) {
      if (!file.objectId || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(file.objectId))
        throw new ProjectError('WORKTREE_EVIDENCE_UNPROVEN', '固定版本缺少可核定Git对象');
      objects.set(file.objectId, file.size);
    }
  }
  if (!objects.size) return;
  const ids = [...objects.keys()];
  const output = await new Promise<Buffer>((done, reject) => {
    const child = execFile(
      'git',
      ['--literal-pathspecs', '-C', commonDir, 'cat-file', '--batch-check'],
      {
        windowsHide: true,
        env: environment(),
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'buffer',
        timeout: 30_000,
      },
      (error, stdout) => {
        if (error)
          reject(
            new ProjectError('WORKTREE_EVIDENCE_UNPROVEN', '固定原件对象批量读取未完成；未清理'),
          );
        else done(stdout);
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(ids.join('\n') + '\n');
  });
  const lines = output.toString('utf8').trim().split(/\r?\n/);
  if (
    lines.length !== ids.length ||
    lines.some((line, i) => {
      const [id, type, size] = line.split(' ');
      return id !== ids[i] || type !== 'blob' || Number(size) !== objects.get(id!);
    })
  )
    throw new ProjectError(
      'WORKTREE_EVIDENCE_UNPROVEN',
      '固定版本有缺失或不符的blob，不能删除唯一现场',
    );
}
