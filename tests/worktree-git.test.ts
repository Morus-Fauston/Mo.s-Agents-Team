import { test, expect } from 'vitest';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { localCommitFixture } from './local-commit-fixture.ts';
import { inspectWorktreeSource, inspectRegisteredWorktree } from '../src/services/local-git.ts';
test('工作树从明确本地commit建立；原树未提交/已暂存内容不自动携带，目录登记与共同仓库须匹配', async () => {
  const f = localCommitFixture();
  try {
    f.git('add', '--', 'a.txt');
    f.git('commit', '-m', 'test source baseline');
    const base = f.git('rev-parse', 'HEAD');
    f.write('a.txt', 'uncommitted source text\n');
    f.git('add', '--', 'keep.txt');
    const source = await inspectWorktreeSource(f.root, base);
    expect(source.commit).toBe(base);
    expect(source.indexPaths).toEqual(['keep.txt']);
    const target = join(f.directory, 'checkout');
    f.git('worktree', 'add', '-b', 'unit-worktree', '--', target, base);
    const result = await inspectRegisteredWorktree(f.root, target);
    expect(result.head).toBe(base);
    expect(result.commonDir).toBe(source.commonDir);
    expect(result.changes).toHaveLength(0);
    expect(f.git('show', 'HEAD:a.txt')).toBe('local baseline');
    expect(f.git('status', '--porcelain=v1')).toContain('M a.txt');
    expect(f.git('status', '--porcelain=v1')).toContain('A  keep.txt');
    const foreign = join(f.directory, 'plain');
    mkdirSync(foreign);
    await expect(inspectRegisteredWorktree(f.root, foreign)).rejects.toThrow();
  } finally {
    f.close();
  }
}, 30_000);
