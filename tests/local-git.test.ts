import { test, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  captureLocalGit,
  assertLocalGitReady,
  verifyLocalCommit,
} from '../src/services/local-git.ts';
function fixture() {
  const base = resolve('E:/MAT-Test');
  mkdirSync(base, { recursive: true });
  const root = mkdtempSync(join(base, 'mat-local-git-'));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith('GIT_')) delete env[name];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = join(root, '.git', 'mat-test-global');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], {
      windowsHide: true,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'MAT isolated test');
  git('config', 'user.email', 'mat-test@example.invalid');
  git('config', 'core.autocrlf', 'false');
  mkdirSync(join(root, '.git', 'test-hooks'));
  git('config', 'core.hooksPath', join(root, '.git', 'test-hooks'));
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.fsmonitor', 'false');
  git('config', 'core.safecrlf', 'false');
  git('config', 'core.attributesFile', join(root, '.git', 'mat-test-attributes'));
  return {
    root,
    git,
    write: (path: string, body: string) => writeFileSync(join(root, path), body),
    seed() {
      writeFileSync(join(root, 'a.txt'), 'base\n');
      git('add', '--', 'a.txt');
      git('commit', '-m', 'test baseline');
    },
    close() {
      if (dirname(resolve(root)) !== base || !basename(root).startsWith('mat-local-git-'))
        throw new Error('拒绝清理非本测试目录');
      rmSync(root, { recursive: true, force: true });
    },
  };
}
test('初始本地提交按明确文件核对；只读核查不建索引，不纳入无关改动，重复读不再提交', async () => {
  const f = fixture();
  try {
    f.write('a.txt', 'first\n');
    f.write('keep.txt', '保留无关修改\n');
    expect(existsSync(join(f.root, '.git', 'index'))).toBe(false);
    const plan = await captureLocalGit(f.root, ['a.txt'], 'baseline');
    expect(plan.head).toBeNull();
    expect(existsSync(join(f.root, '.git', 'index'))).toBe(false);
    expect((await verifyLocalCommit(plan)).state).toBe('not-observed');
    await assertLocalGitReady(plan);
    f.git('add', '--', 'a.txt');
    f.git('commit', '-m', 'authorized initial baseline');
    const result = await verifyLocalCommit(plan);
    expect(result.state).toBe('verified');
    expect(result.paths).toEqual(['a.txt']);
    expect((await verifyLocalCommit(plan)).commit).toBe(result.commit);
    expect(f.git('rev-list', '--count', 'HEAD')).toBe('1');
    expect(f.git('status', '--porcelain')).toContain('keep.txt');
    expect(readFileSync(join(f.root, 'keep.txt'), 'utf8')).toBe('保留无关修改\n');
  } finally {
    f.close();
  }
}, 30_000);
test('已有暂存或在途状态拒绝新安排，核查保留用户索引', async () => {
  const f = fixture();
  try {
    f.seed();
    f.write('a.txt', 'changed\n');
    f.write('keep.txt', 'other\n');
    f.git('add', '--', 'keep.txt');
    const before = readFileSync(join(f.root, '.git', 'index'));
    await expect(captureLocalGit(f.root, ['a.txt'], 'commit')).rejects.toThrow('暂存');
    expect(readFileSync(join(f.root, '.git', 'index'))).toEqual(before);
    // A merge marker is sufficient to hold the operation; nothing resolves or removes it.
    writeFileSync(join(f.root, '.git', 'MERGE_HEAD'), f.git('rev-parse', 'HEAD') + '\n');
    await expect(captureLocalGit(f.root, ['a.txt'], 'commit')).rejects.toThrow('在途');
    expect(existsSync(join(f.root, '.git', 'MERGE_HEAD'))).toBe(true);
  } finally {
    f.close();
  }
}, 30_000);
test('批准后文件变化或实际commit混入其他文件，保留真实对象并拒绝冒充获准结果', async () => {
  const f = fixture();
  try {
    f.seed();
    f.write('a.txt', 'approved\n');
    const plan = await captureLocalGit(f.root, ['a.txt'], 'commit');
    f.write('a.txt', 'later\n');
    await expect(assertLocalGitReady(plan)).rejects.toThrow('差异');
    f.git('add', '--', 'a.txt');
    f.git('commit', '-m', 'changed content');
    expect((await verifyLocalCommit(plan)).state).toBe('mismatch');
    f.write('a.txt', 'next approved\n');
    const next = await captureLocalGit(f.root, ['a.txt'], 'commit');
    f.write('other.txt', 'unrelated\n');
    f.git('add', '--', 'a.txt', 'other.txt');
    f.git('commit', '-m', 'mixed content');
    expect((await verifyLocalCommit(next)).state).toBe('mismatch');
    expect(f.git('rev-list', '--count', 'HEAD')).toBe('3');
    expect(readFileSync(join(f.root, 'other.txt'), 'utf8')).toBe('unrelated\n');
  } finally {
    f.close();
  }
}, 30_000);
test('核对Git规范化blob并保留工作区原文；目录和越界路径不能作为全部暂存范围', async () => {
  const f = fixture();
  try {
    f.write('.gitattributes', '*.txt text eol=lf\n');
    f.write('a.txt', 'base\n');
    f.git('add', '--', '.gitattributes', 'a.txt');
    f.git('commit', '-m', 'attributes');
    f.write('a.txt', 'next\r\n');
    const plan = await captureLocalGit(f.root, ['a.txt'], 'commit');
    f.git('add', '--', 'a.txt');
    f.git('commit', '-m', 'normalized content');
    expect((await verifyLocalCommit(plan)).state).toBe('verified');
    expect(readFileSync(join(f.root, 'a.txt'), 'utf8')).toBe('next\r\n');
    await expect(captureLocalGit(f.root, ['.'], 'commit')).rejects.toThrow();
    await expect(captureLocalGit(f.root, ['../outside'], 'commit')).rejects.toThrow();
    await expect(captureLocalGit(f.root, ['.git/HEAD'], 'commit')).rejects.toThrow();
  } finally {
    f.close();
  }
}, 30_000);
test('带方括号的真实文件按字面定位，不把批准文件解释为Git路径模式', async () => {
  const f = fixture();
  try {
    f.write('a[1].txt', 'literal\n');
    f.write('a1.txt', 'unrelated\n');
    f.git('--literal-pathspecs', 'add', '--', 'a[1].txt', 'a1.txt');
    f.git('update-index', '--chmod=+x', '--', 'a1.txt');
    f.git('commit', '-m', 'path baseline');
    f.write('a[1].txt', 'changed literal\n');
    const plan = await captureLocalGit(f.root, ['a[1].txt'], 'commit');
    expect(plan.files[0]!.mode).toBe('100644');
    f.git('--literal-pathspecs', 'add', '--', 'a[1].txt');
    f.git('commit', '-m', 'literal path');
    expect((await verifyLocalCommit(plan)).state).toBe('verified');
    expect(readFileSync(join(f.root, 'a1.txt'), 'utf8')).toBe('unrelated\n');
  } finally {
    f.close();
  }
}, 30_000);
