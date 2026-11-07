import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  readFileSync,
} from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import type { WorktreeSource } from '../contracts/worktrees.ts';
import { inspectWorktreeSource, inspectRegisteredWorktree } from './local-git.ts';
import { canonicalWriteScope, withinPath } from './write-scopes.ts';
import { ProjectError } from './errors.ts';
import type { GitMergePlan, GitMergeProof } from '../contracts/worktree-merges.ts';
import type { SnapshotRoot } from '../contracts/versions.ts';
import { inspectWorkspace } from './workspace-snapshot.ts';
export type { GitMergePlan, GitMergeProof } from '../contracts/worktree-merges.ts';
const oid = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const key = (v: string) => (process.platform === 'win32' ? v.toLowerCase() : v);
async function git(
  repository: string,
  args: string[],
  allowed: number[] = [],
  extra?: Record<string, string>,
) {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('GIT_')) delete env[k];
  Object.assign(
    env,
    {
      GIT_OPTIONAL_LOCKS: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_NO_LAZY_FETCH: '1',
      GIT_NO_REPLACE_OBJECTS: '1',
    },
    extra,
  );
  return new Promise<{ code: number; output: string }>((done, reject) => {
    execFile(
      'git',
      ['--literal-pathspecs', '--no-replace-objects', '-C', repository, ...args],
      { env, windowsHide: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 },
      (error, stdout, stderr) => {
        if (!error) return done({ code: 0, output: stdout });
        if (typeof error.code === 'number' && allowed.includes(error.code))
          return done({ code: error.code, output: stdout });
        reject(
          new ProjectError(
            'MERGE_GIT_READ',
            'Git合入核对失败：' + (stderr || error.message).slice(0, 3000),
          ),
        );
      },
    );
  });
}
const nul = (s: string) => s.split('\0').filter(Boolean);
async function revision(repository: string, value: string) {
  const id = (
    await git(repository, ['rev-parse', '--verify', '--end-of-options', value])
  ).output.trim();
  if (!oid.test(id)) throw new ProjectError('MERGE_OBJECT', '实际Git对象身份不完整');
  return id;
}
async function ancestor(repository: string, a: string, b: string) {
  return (await git(repository, ['merge-base', '--is-ancestor', a, b], [1])).code === 0;
}
function plain(path: string) {
  if (
    !lstatSync(path).isDirectory() ||
    lstatSync(path).isSymbolicLink() ||
    key(realpathSync(path)) !== key(resolve(path))
  )
    throw new ProjectError('MERGE_DIRECTORY', '合入目录含链接或已替换');
}
function clean(v: WorktreeSource) {
  if (v.changes.length || v.indexPaths.length)
    throw new ProjectError('MERGE_DIRTY', '源或目标仍有未提交内容/真实暂存，不纳入归属不明成果');
}
/** Computes the pinned merge in an isolated material object store. Never updates checkout, real index, HEAD or common objects. */
export async function captureMergeGit(
  target: string,
  source: string,
  sourceCommit: string,
  objectDirectory: string,
): Promise<GitMergePlan> {
  if (!oid.test(sourceCommit))
    throw new ProjectError('MERGE_SOURCE_COMMIT', '先固定完整本地源commit，不接受浮动分支');
  const [a, b] = await Promise.all([
    inspectWorktreeSource(target),
    inspectWorktreeSource(source, sourceCommit),
  ]);
  clean(a);
  clean(b);
  plain(a.repository);
  plain(b.repository);
  if (
    key(a.commonDir) !== key(b.commonDir) ||
    key(a.gitDir) === key(b.gitDir) ||
    !a.branch ||
    !b.branch ||
    b.head !== sourceCommit
  )
    throw new ProjectError(
      'MERGE_SOURCE',
      '须为同一共同仓库的两个明确分支检出，源HEAD对应原完整commit',
    );
  await inspectRegisteredWorktree(a.repository, b.repository);
  const baseCommit = (await git(a.repository, ['merge-base', a.head, sourceCommit])).output.trim();
  if (!oid.test(baseCommit))
    throw new ProjectError('MERGE_BASE', '没有明确共同基线，不合并无关历史');
  const mode: GitMergePlan['mode'] = (await ancestor(a.repository, sourceCommit, a.head))
    ? 'already-contained'
    : (await ancestor(a.repository, a.head, sourceCommit))
      ? 'fast-forward'
      : 'merge';
  if (
    !isAbsolute(objectDirectory) ||
    key(canonicalWriteScope(objectDirectory)) !== key(resolve(objectDirectory)) ||
    existsSync(objectDirectory) ||
    withinPath(a.gitDir, objectDirectory) ||
    withinPath(b.gitDir, objectDirectory) ||
    withinPath(objectDirectory, a.repository) ||
    withinPath(objectDirectory, b.repository)
  )
    throw new ProjectError(
      'MERGE_MATERIAL_OBJECTS',
      '预核对象目录须为新建普通材料路径，不能覆盖原Git目录或检出',
    );
  mkdirSync(objectDirectory, { recursive: true });
  plain(objectDirectory);
  const objectEnv = {
    GIT_OBJECT_DIRECTORY: realpathSync(objectDirectory),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(
      realpathSync(join(a.commonDir, 'objects')).replaceAll('\\', '/'),
    ),
  };
  const merge = await git(
      a.repository,
      ['merge-tree', '--write-tree', '-z', '--name-only', '--no-messages', a.head, sourceCommit],
      [1],
      objectEnv,
    ),
    parts = merge.output.split('\0'),
    mergeTree = parts.shift()!.trim();
  if (!oid.test(mergeTree))
    throw new ProjectError('MERGE_PREVIEW_RESULT', 'Git没有返回完整预核合并树，保留材料待核对');
  const conflictPaths = [...new Set(parts.filter(Boolean))].sort();
  if ((merge.code === 1) !== conflictPaths.length > 0)
    throw new ProjectError('MERGE_PREVIEW_RESULT', 'Git冲突状态与完整路径目录不一致');
  const changedPaths = nul(
    (
      await git(
        a.repository,
        ['diff', '--no-renames', '--name-only', '-z', a.head, mergeTree],
        [],
        objectEnv,
      )
    ).output,
  ).sort();
  const ignored = nul(
    (await git(a.repository, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z']))
      .output,
  );
  if (
    ignored.some((path) =>
      changedPaths.some(
        (change) =>
          withinPath(resolve(a.repository, path), resolve(a.repository, change)) ||
          withinPath(resolve(a.repository, change), resolve(a.repository, path)),
      ),
    )
  )
    throw new ProjectError(
      'MERGE_IGNORED_CONTENT',
      '目标ignored未保存内容与合入路径重叠，先交主管协调，不覆盖',
    );
  const [afterA, afterB] = await Promise.all([
    inspectWorktreeSource(a.repository),
    inspectWorktreeSource(b.repository),
  ]);
  if (
    JSON.stringify(a) !== JSON.stringify(afterA) ||
    JSON.stringify(b) !== JSON.stringify({ ...afterB, commit: sourceCommit })
  )
    throw new ProjectError('MERGE_INPUT_CHANGED', '预核期间真实索引、HEAD、分支或内容已变化');
  const fixed = {
    target: a,
    source: b,
    sourceCommit,
    baseCommit,
    mode,
    mergeTree,
    conflictPaths,
    changedPaths,
  };
  return {
    ...fixed,
    objectDirectory: realpathSync(objectDirectory),
    fingerprint: createHash('sha256').update(JSON.stringify(fixed)).digest('hex'),
    capturedAt: new Date().toISOString(),
  };
}
export async function verifyMergeGit(
  plan: GitMergePlan,
  expectedTree = plan.mergeTree,
  correction?: { head: string; parents: string[] },
): Promise<GitMergeProof> {
  plain(plan.target.repository);
  const dir = realpathSync(
      (
        await git(plan.target.repository, ['rev-parse', '--path-format=absolute', '--git-dir'])
      ).output.trim(),
    ),
    common = realpathSync(
      (
        await git(plan.target.repository, [
          'rev-parse',
          '--path-format=absolute',
          '--git-common-dir',
        ])
      ).output.trim(),
    );
  if (key(dir) !== key(plan.target.gitDir) || key(common) !== key(plan.target.commonDir))
    throw new ProjectError('MERGE_DIRECTORY', '目标Git身份与原安排不同');
  const indexHash = () =>
    existsSync(join(dir, 'index'))
      ? createHash('sha256')
          .update(readFileSync(join(dir, 'index')))
          .digest('hex')
      : null;
  const indexBefore = indexHash();
  const branch = (
      await git(plan.target.repository, ['symbolic-ref', '-q', 'HEAD'], [1])
    ).output.trim(),
    resultHead = await revision(plan.target.repository, 'HEAD'),
    resultTree = await revision(plan.target.repository, resultHead + '^{tree}'),
    parentLine = (
      await git(plan.target.repository, ['rev-list', '--parents', '-n', '1', resultHead])
    ).output
      .trim()
      .split(' '),
    parents = parentLine.slice(1),
    mergeHeads = existsSync(join(dir, 'MERGE_HEAD'))
      ? readFileSync(join(dir, 'MERGE_HEAD'), 'utf8').trim().split(/\s+/)
      : [],
    conflictPaths = [
      ...new Set(
        nul((await git(plan.target.repository, ['ls-files', '-u', '-z'])).output).map((line) =>
          line.slice(line.indexOf('\t') + 1),
        ),
      ),
    ].sort(),
    indexPaths = nul(
      (await git(plan.target.repository, ['diff', '--cached', '--name-only', '-z'])).output,
    ).sort(),
    containsSource = await ancestor(plan.target.repository, plan.sourceCommit, resultHead);
  const proof: GitMergeProof = {
    state: 'mismatch',
    resultHead,
    currentHead: resultHead,
    resultTree,
    parents,
    mergeHeads,
    conflictPaths,
    indexPaths,
    indexFingerprint: indexBefore ?? '',
    containsSource,
    reason: '结果仍与原输入不符，不重做merge',
    observedAt: new Date().toISOString(),
  };
  const foreign = [
    'CHERRY_PICK_HEAD',
    'REVERT_HEAD',
    'rebase-merge',
    'rebase-apply',
    'sequencer',
    'index.lock',
    'MERGE_AUTOSTASH',
  ].some((f) => existsSync(join(dir, f)));
  const fencedHead = await revision(plan.target.repository, 'HEAD');
  const fencedBranch = (
    await git(plan.target.repository, ['symbolic-ref', '-q', 'HEAD'], [1])
  ).output.trim();
  const fencedMergeHeads = existsSync(join(dir, 'MERGE_HEAD'))
    ? readFileSync(join(dir, 'MERGE_HEAD'), 'utf8').trim().split(/\s+/)
    : [];
  if (
    fencedHead !== resultHead ||
    fencedBranch !== branch ||
    indexHash() !== indexBefore ||
    JSON.stringify(fencedMergeHeads) !== JSON.stringify(mergeHeads)
  )
    return {
      ...proof,
      currentHead: fencedHead,
      reason: '回读期间HEAD、分支、真实索引或原合入状态已变化',
    };
  if (foreign || branch !== plan.target.branch) return proof;
  if (mergeHeads.length) {
    if (
      resultHead === plan.target.head &&
      mergeHeads.length === 1 &&
      mergeHeads[0] === plan.sourceCommit
    )
      return {
        ...proof,
        state: 'conflict',
        reason: '原普通合入尚未完成；保留MERGE_HEAD及真实索引，业务修正交开发者',
      };
    return proof;
  }
  const actual = await inspectWorktreeSource(plan.target.repository);
  if (
    actual.head !== resultHead ||
    actual.branch !== branch ||
    key(actual.gitDir) !== key(dir) ||
    key(actual.commonDir) !== key(common) ||
    indexHash() !== indexBefore
  )
    return {
      ...proof,
      currentHead: actual.head,
      reason: '回读期间目标身份或实际HEAD/索引已变化，旧结果不为当前目录背书',
    };
  if (actual.changes.length || actual.indexPaths.length)
    return { ...proof, reason: '当前检出/索引仍有未核定内容，不能以HEAD变化办结' };
  if (resultHead === plan.target.head && plan.mode !== 'already-contained')
    return {
      ...proof,
      state: 'not-observed',
      reason: '独立回读尚未观察到原合入发生；不从提交者自报推断',
    };
  const history = correction
    ? resultHead === correction.head &&
      JSON.stringify(parents) === JSON.stringify(correction.parents)
    : plan.mode === 'already-contained'
      ? resultHead === plan.target.head
      : plan.mode === 'fast-forward'
        ? resultHead === plan.sourceCommit
        : parents.length === 2 &&
          parents[0] === plan.target.head &&
          parents[1] === plan.sourceCommit;
  if (history && containsSource && resultTree === expectedTree)
    return {
      ...proof,
      state: 'verified',
      reason: '实际父级、源commit纳入、结果树及干净索引对应原明确输入；组合验证另行核对',
    };
  return proof;
}
/** Only reads the real stage-0 index; writes a copied index/tree into fresh fixed materials. */
export async function captureMergeIndexTree(
  plan: GitMergePlan,
  reviewed: SnapshotRoot,
  material: string,
) {
  const proof = await verifyMergeGit(plan);
  if (proof.state !== 'conflict' || proof.conflictPaths.length)
    throw new ProjectError('MERGE_STAGE_UNRESOLVED', '原合入不在继续状态或仍有未解决索引');
  if (key(reviewed.root) !== key(plan.target.repository) || reviewed.kind !== 'git')
    throw new ProjectError('MERGE_STAGE_VERSION', '已审版本不属于原目标');
  const current = inspectWorkspace({
    cwd: plan.target.repository,
    storage: material,
    mergeRepair: {
      repository: plan.target.repository,
      expectedHead: plan.target.head,
      expectedMergeHeads: [plan.sourceCommit],
      expectedIndexFingerprint: proof.indexFingerprint,
    },
  }).roots[0]!;
  const raw = (r: SnapshotRoot) =>
    r.files.map(({ path, sha256, size, mode }) => [path, sha256, size, mode]);
  if (JSON.stringify(raw(current)) !== JSON.stringify(raw(reviewed)))
    throw new ProjectError('MERGE_STAGE_CHANGED', '当前raw文件与修正已审版本不符');
  const tracked = nul(
    (await git(plan.target.repository, ['ls-files', '--cached', '-z'])).output,
  ).sort();
  if (
    JSON.stringify(tracked) !== JSON.stringify(reviewed.files.map((f) => f.path).sort()) ||
    (await git(plan.target.repository, ['diff', '--quiet', '--no-ext-diff', '--'], [1])).code !== 0
  )
    throw new ProjectError('MERGE_STAGE_CHANGED', '真实索引路径或暂存后的文件变化与已审源码不符');
  if (
    !isAbsolute(material) ||
    key(canonicalWriteScope(material)) !== key(resolve(material)) ||
    existsSync(material) ||
    withinPath(plan.target.commonDir, material) ||
    withinPath(plan.target.gitDir, material) ||
    withinPath(material, plan.target.repository)
  )
    throw new ProjectError(
      'MERGE_STAGE_MATERIAL',
      '索引副本须在新建普通材料域，不能覆盖真实Git或检出',
    );
  mkdirSync(material, { recursive: true });
  plain(material);
  const index = join(material, 'index'),
    objects = join(material, 'objects');
  mkdirSync(objects);
  copyFileSync(join(plan.target.gitDir, 'index'), index);
  if (createHash('sha256').update(readFileSync(index)).digest('hex') !== proof.indexFingerprint)
    throw new ProjectError('MERGE_STAGE_CHANGED', '复制期间真实索引已变化');
  const tree = (
    await git(plan.target.repository, ['write-tree'], [], {
      GIT_INDEX_FILE: index,
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(
        realpathSync(join(plan.target.commonDir, 'objects')).replaceAll('\\', '/'),
      ),
    })
  ).output.trim();
  const after = await verifyMergeGit(plan);
  if (
    !oid.test(tree) ||
    after.state !== 'conflict' ||
    after.indexFingerprint !== proof.indexFingerprint ||
    after.conflictPaths.length
  )
    throw new ProjectError('MERGE_STAGE_CHANGED', '核定期间原合入或真实索引已变化');
  const final = inspectWorkspace({
    cwd: plan.target.repository,
    storage: material,
    mergeRepair: {
      repository: plan.target.repository,
      expectedHead: plan.target.head,
      expectedMergeHeads: [plan.sourceCommit],
      expectedIndexFingerprint: proof.indexFingerprint,
    },
  }).roots[0]!;
  if (JSON.stringify(raw(final)) !== JSON.stringify(raw(reviewed)))
    throw new ProjectError('MERGE_STAGE_CHANGED', '核定期间已审raw文件发生变化');
  return { tree, indexFingerprint: proof.indexFingerprint };
}
export async function inspectMergeTargetRegistration(plan: GitMergePlan, proof: GitMergeProof) {
  const entries = (
    await git(plan.target.repository, ['worktree', 'list', '--porcelain', '-z'])
  ).output.split('\0\0');
  const entry = entries.find((e) =>
    e
      .split('\0')
      .some(
        (line) =>
          line.startsWith('worktree ') &&
          key(resolve(line.slice(9))) === key(plan.target.repository),
      ),
  );
  const lines = entry?.split('\0') ?? [];
  if (
    !entry ||
    !lines.includes('HEAD ' + proof.currentHead) ||
    !lines.includes('branch ' + plan.target.branch) ||
    lines.some(
      (l) =>
        l === 'locked' || l.startsWith('locked ') || l === 'prunable' || l.startsWith('prunable '),
    )
  )
    throw new ProjectError(
      'MERGE_TARGET_REGISTRATION',
      '原目标Git工作树登记不符或已锁定，不回旧根开工',
    );
  const rows = nul(
    (await git(plan.target.repository, ['status', '--porcelain=v1', '-z', '--untracked-files=all']))
      .output,
  );
  const changes: GitMergePlan['target']['changes'] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (row.length < 4) throw new ProjectError('MERGE_TARGET_STATUS', '实际工作树状态不完整');
    const change = { x: row[0]!, y: row[1]!, path: row.slice(3) };
    if ('RC'.includes(change.x) || 'RC'.includes(change.y)) {
      const originalPath = rows[++i];
      if (!originalPath) throw new ProjectError('MERGE_TARGET_STATUS', '实际重命名状态不完整');
      changes.push({ ...change, originalPath });
    } else changes.push(change);
  }
  return { changes, indexPaths: proof.indexPaths };
}
