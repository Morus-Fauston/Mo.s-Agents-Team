import { captureWorkspace, readSnapshotFile } from '../src/services/workspace-snapshot.ts';
import { test, expect } from 'vitest';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { localCommitFixture } from './local-commit-fixture.ts';
import {
  inspectWorktreeCleanup,
  inspectWorktreeRemoval,
  verifyRetainedGitSnapshots,
} from '../src/services/local-git.ts';
test('清理只允许已合入且干净的准确检出，删除后分支仍保留；未提交及独有commit拒绝', async () => {
  const f = localCommitFixture();
  try {
    f.git('add', '--', 'a.txt');
    f.git('commit', '-m', 'baseline');
    const base = f.git('rev-parse', 'HEAD'),
      pool = join(f.root, '.agents', 'worktrees');
    mkdirSync(pool, { recursive: true });
    writeFileSync(join(pool, '.gitignore'), '*\n');
    const target = join(pool, 'cleanup-test');
    f.git('worktree', 'add', '-b', 'cleanup-test', '--', target, base);
    const clean = await inspectWorktreeCleanup(f.root, target);
    expect(clean.merged).toBe(true);
    expect(clean.clean).toBe(true);
    writeFileSync(join(target, 'a.txt'), 'not saved\n');
    expect((await inspectWorktreeCleanup(f.root, target)).clean).toBe(false);
    f.git('-C', target, 'add', '--', 'a.txt');
    f.git('-C', target, 'commit', '-m', 'unique work');
    const unique = await inspectWorktreeCleanup(f.root, target);
    expect(unique.clean).toBe(true);
    expect(unique.merged).toBe(false);
    f.git('merge', '--ff-only', 'cleanup-test');
    const merged = await inspectWorktreeCleanup(f.root, target);
    expect(merged.merged).toBe(true);
    const storage = join(f.root, '.TEAM', '运行数据', 'cleanup-evidence'),
      snapshot = captureWorkspace({ cwd: target, storage });
    await verifyRetainedGitSnapshots(merged.commonDir, snapshot.roots);
    f.git('worktree', 'remove', '--', target);
    const removed = await inspectWorktreeRemoval(f.root, target, 'cleanup-test', merged.head);
    expect(removed.removed).toBe(true);
    expect(removed.branchRetained).toBe(true);
    await verifyRetainedGitSnapshots(merged.commonDir, snapshot.roots);
    expect(readSnapshotFile(snapshot, 0, 'a.txt', storage).toString()).toBe('not saved\n');
  } finally {
    f.close();
  }
}, 30_000);

test('忽略文件也是现场内容，未明确保存时不把Git干净当可清理', async () => {
  const f = localCommitFixture();
  try {
    f.git('add', '--', 'a.txt');
    f.git('commit', '-m', 'baseline');
    const pool = join(f.root, '.agents', 'worktrees');
    mkdirSync(pool, { recursive: true });
    writeFileSync(join(pool, '.gitignore'), '*\n');
    const target = join(pool, 'ignored-test');
    f.git('worktree', 'add', '-b', 'ignored-test', '--', target, 'HEAD');
    appendFileSync(join(f.root, '.git', 'info', 'exclude'), '\nignored-local.bin\n');
    writeFileSync(join(target, 'ignored-local.bin'), 'unique local material');
    const observed = await inspectWorktreeCleanup(f.root, target);
    expect(observed.changes).toHaveLength(0);
    expect(observed.ignoredPaths).toEqual(['ignored-local.bin']);
    expect(observed.clean).toBe(false);
  } finally {
    f.close();
  }
}, 30_000);
