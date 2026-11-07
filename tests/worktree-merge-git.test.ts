import { test, expect, vi } from 'vitest';
import { execFile } from 'node:child_process';
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, execFile: vi.fn(actual.execFile) };
});
import { join } from 'node:path';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { localCommitFixture } from './local-commit-fixture.ts';
import {
  captureMergeGit,
  verifyMergeGit,
  captureMergeIndexTree,
} from '../src/services/worktree-merge-git.ts';
import { captureWorkspace } from '../src/services/workspace-snapshot.ts';
function fixture() {
  const f = localCommitFixture();
  f.write('.git/info/exclude', '.TEAM/\n.agents/\n');
  f.git('add', '--', 'a.txt', 'keep.txt');
  f.git('commit', '-m', 'approved shared baseline');
  const base = f.git('rev-parse', 'HEAD'),
    source = join(f.root, '.agents/worktrees/source');
  f.git('worktree', 'add', '-b', 'source', source, base);
  const editSource = (content: string) => {
    writeFileSync(join(source, 'a.txt'), content);
    f.git('-C', source, 'add', '--', 'a.txt');
    f.git('-C', source, 'commit', '-m', 'source reviewed change');
    return f.git('-C', source, 'rev-parse', 'HEAD');
  };
  return {
    ...f,
    base,
    source,
    editSource,
    objectDir: join(f.root, '.TEAM/运行数据/merge-preview', randomUUID(), 'objects'),
  };
}
function objectFiles(root: string) {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const path = join(e.parentPath, e.name);
      return [path, createHash('sha256').update(readFileSync(path)).digest('hex')];
    })
    .sort();
}
test('继续合入仅核已审raw文件对应的真实stage0索引，独立副本写树且保留真实index', async () => {
  const f = fixture();
  try {
    const source = f.editSource('source\n');
    f.write('a.txt', 'target\n');
    f.git('add', '--', 'a.txt');
    f.git('commit', '-m', 'target');
    const plan = await captureMergeGit(f.root, f.source, source, f.objectDir);
    expect(() => f.git('merge', '--no-edit', '--', source)).toThrow();
    f.write('a.txt', 'approved resolution\r\n');
    // Real Git clean conversion differs from the raw snapshot blob.
    f.git('config', 'core.autocrlf', 'true');
    const proof = await verifyMergeGit(plan);
    const saved = captureWorkspace({
      cwd: f.root,
      storage: join(f.directory, 'originals'),
      mergeRepair: {
        repository: f.root,
        expectedHead: plan.target.head,
        expectedMergeHeads: [source],
        expectedIndexFingerprint: proof.indexFingerprint,
      },
    }).roots[0]!;
    await expect(
      captureMergeIndexTree(plan, saved, join(f.directory, 'stage-unresolved')),
    ).rejects.toThrow(/未解决/);
    f.git('add', '--', 'a.txt');
    const bytes = readFileSync(join(f.root, '.git/index')),
      objects = objectFiles(join(f.root, '.git/objects'));
    const staged = await captureMergeIndexTree(plan, saved, join(f.directory, 'stage-approved'));
    expect(staged.tree).not.toBe(saved.tree);
    expect(readFileSync(join(f.root, '.git/index'))).toEqual(bytes);
    expect(objectFiles(join(f.root, '.git/objects'))).toEqual(objects);
    f.write('a.txt', 'unreviewed later edit\n');
    await expect(
      captureMergeIndexTree(plan, saved, join(f.directory, 'stage-changed')),
    ).rejects.toThrow(/变化|不符/);
    f.write('a.txt', 'approved resolution\r\n');
    f.git('commit', '--no-edit');
    expect((await verifyMergeGit(plan, staged.tree)).state).toBe('verified');
  } finally {
    f.close();
  }
}, 60000);
test('合入预核固定源与目标，FF保留原提交；预核不改检出、索引或共同对象库', async () => {
  const f = fixture();
  try {
    const sourceCommit = f.editSource('reviewed source\n'),
      index = readFileSync(join(f.root, '.git/index')),
      objects = objectFiles(join(f.root, '.git/objects'));
    const p = await captureMergeGit(f.root, f.source, sourceCommit, f.objectDir);
    expect(p.target.head).toBe(f.base);
    expect(p.sourceCommit).toBe(sourceCommit);
    expect(p.mode).toBe('fast-forward');
    expect(p.conflictPaths).toEqual([]);
    expect(p.mergeTree).toBe(f.git('-C', f.source, 'rev-parse', 'HEAD^{tree}'));
    expect(f.git('rev-parse', 'HEAD')).toBe(f.base);
    expect(readFileSync(join(f.root, '.git/index')).equals(index)).toBe(true);
    expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('local baseline\n');
    expect(objectFiles(join(f.root, '.git/objects'))).toEqual(objects);
    f.git('merge', '--no-edit', '--', sourceCommit);
    const result = await verifyMergeGit(p);
    expect(result.state).toBe('verified');
    expect(result.resultHead).toBe(sourceCommit);
    expect(result.resultTree).toBe(p.mergeTree);
  } finally {
    f.close();
  }
}, 30_000);
test('普通双亲合入按固定输入树核对，不把源码分支包含关系当组合正确', async () => {
  const f = fixture();
  try {
    const sourceCommit = f.editSource('reviewed source\n');
    f.write('keep.txt', 'target independent change\n');
    f.git('add', '--', 'keep.txt');
    f.git('commit', '-m', 'target approved independent change');
    const target = f.git('rev-parse', 'HEAD'),
      objects = objectFiles(join(f.root, '.git/objects'));
    const p = await captureMergeGit(f.root, f.source, sourceCommit, f.objectDir);
    expect(p.mode).toBe('merge');
    expect(p.conflictPaths).toEqual([]);
    expect(objectFiles(join(f.root, '.git/objects'))).toEqual(objects);
    f.git('merge', '--no-edit', '--', sourceCommit);
    const result = await verifyMergeGit(p);
    expect(result.state).toBe('verified');
    expect(result.parents).toEqual([target, sourceCommit]);
    expect(result.resultTree).toBe(p.mergeTree);
    expect(readFileSync(join(f.root, 'keep.txt'), 'utf8')).toBe('target independent change\n');
  } finally {
    f.close();
  }
}, 30_000);
test('业务冲突保存实际MERGE_HEAD和未合并路径；原输入未完成不能冒称已合入', async () => {
  const f = fixture();
  try {
    const sourceCommit = f.editSource('source business choice\n');
    f.write('a.txt', 'target business choice\n');
    f.git('add', '--', 'a.txt');
    f.git('commit', '-m', 'target business change');
    const target = f.git('rev-parse', 'HEAD'),
      index = readFileSync(join(f.root, '.git/index'));
    const p = await captureMergeGit(f.root, f.source, sourceCommit, f.objectDir);
    expect(p.conflictPaths).toEqual(['a.txt']);
    expect(f.git('rev-parse', 'HEAD')).toBe(target);
    expect(readFileSync(join(f.root, '.git/index')).equals(index)).toBe(true);
    expect(() => f.git('merge', '--no-edit', '--', sourceCommit)).toThrow();
    const result = await verifyMergeGit(p);
    expect(result.state).toBe('conflict');
    expect(result.resultHead).toBe(target);
    expect(result.mergeHeads).toEqual([sourceCommit]);
    expect(result.conflictPaths).toEqual(['a.txt']);
    expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toContain('<<<<<<<');
  } finally {
    f.close();
  }
}, 30_000);

test('忽略文件会被源新增路径覆盖时拒绝预核，保留唯一未保存内容', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.source, 'generated.txt'), 'reviewed generated content\n');
    f.git('-C', f.source, 'add', '--', 'generated.txt');
    f.git('-C', f.source, 'commit', '-m', 'source adds generated file');
    const sourceCommit = f.git('-C', f.source, 'rev-parse', 'HEAD');
    f.write('.git/info/exclude', '.TEAM/\n.agents/\ngenerated.txt\n');
    f.write('generated.txt', 'unique ignored user content\n');
    expect(f.git('status', '--porcelain=v1')).toBe('');
    await expect(captureMergeGit(f.root, f.source, sourceCommit, f.objectDir)).rejects.toThrow(
      'ignored',
    );
    expect(readFileSync(join(f.root, 'generated.txt'), 'utf8')).toBe(
      'unique ignored user content\n',
    );
    expect(f.git('rev-parse', 'HEAD')).toBe(f.base);
  } finally {
    f.close();
  }
}, 30_000);

test('父级与源纳入都正确但合并树夹带未批准内容时仍拒绝verified', async () => {
  const f = fixture();
  try {
    const sourceCommit = f.editSource('reviewed source\n');
    f.write('keep.txt', 'independent target\n');
    f.git('add', '--', 'keep.txt');
    f.git('commit', '-m', 'independent target');
    const p = await captureMergeGit(f.root, f.source, sourceCommit, f.objectDir);
    f.git('merge', '--no-edit', '--no-commit', '--no-overwrite-ignore', '--', sourceCommit);
    f.write('extra.txt', 'not part of original merge\n');
    f.git('add', '--', 'extra.txt');
    f.git('commit', '--no-edit');
    const result = await verifyMergeGit(p);
    expect(result.containsSource).toBe(true);
    expect(result.parents).toEqual([p.target.head, sourceCommit]);
    expect(result.resultTree).not.toBe(p.mergeTree);
    expect(result.state).toBe('mismatch');
  } finally {
    f.close();
  }
}, 30_000);
test('已有真实暂存、源浮动及业务未提交内容不能因分支可合并而放行', async () => {
  const f = fixture();
  try {
    const sourceCommit = f.editSource('reviewed source\n');
    f.write('keep.txt', 'existing stage\n');
    f.git('add', '--', 'keep.txt');
    const index = readFileSync(join(f.root, '.git/index'));
    await expect(captureMergeGit(f.root, f.source, sourceCommit, f.objectDir)).rejects.toThrow(
      '暂存',
    );
    expect(readFileSync(join(f.root, '.git/index')).equals(index)).toBe(true);
    f.git('commit', '-m', 'independent approved target');
    writeFileSync(join(f.source, 'a.txt'), 'uncommitted source\n');
    await expect(captureMergeGit(f.root, f.source, sourceCommit, f.objectDir)).rejects.toThrow(
      '未提交',
    );
    f.git('-C', f.source, 'add', '--', 'a.txt');
    f.git('-C', f.source, 'commit', '-m', 'later source');
    await expect(captureMergeGit(f.root, f.source, sourceCommit, f.objectDir)).rejects.toThrow(
      '源HEAD',
    );
  } finally {
    f.close();
  }
}, 30_000);

test('回读期间目标又前进时不能以先读到的旧合入结果给当前目录背书', async () => {
  const f = fixture();
  try {
    const sourceCommit = f.editSource('reviewed source\n'),
      p = await captureMergeGit(f.root, f.source, sourceCommit, f.objectDir);
    f.git('merge', '--no-edit', '--no-overwrite-ignore', '--', sourceCommit);
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    let changed = false;
    vi.mocked(execFile).mockImplementation(((...args: unknown[]) => {
      const argv = args[1] as string[];
      if (!changed && argv.includes('--show-toplevel')) {
        changed = true;
        f.write('keep.txt', 'later unrelated target change\n');
        f.git('add', '--', 'keep.txt');
        f.git('commit', '-m', 'later target advance');
      }
      return Reflect.apply(actual.execFile, undefined, args);
    }) as typeof execFile);
    const result = await verifyMergeGit(p);
    expect(changed).toBe(true);
    expect(result.state).toBe('mismatch');
    expect(result.reason).toContain('回读期间');
  } finally {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    vi.mocked(execFile).mockImplementation(actual.execFile);
    f.close();
  }
}, 30_000);
