import { test, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  captureWorkspace,
  compareWorkspaces,
  readSnapshotFile,
  inspectWorkspace,
} from '../src/services/workspace-snapshot.ts';

test('Git派工快照包含既有暂存和未暂存成果，交付差异只算之后修改，真实index字节不变', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mat-version-')),
    root = join(directory, '源码'),
    storage = join(directory, '原件');
  mkdirSync(root);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { windowsHide: true });
  try {
    git('init', '--quiet');
    git('config', 'user.name', 'snapshot-test');
    git('config', 'user.email', 'snapshot@example.invalid');
    writeFileSync(join(root, '已有.txt'), '已提交\n');
    writeFileSync(join(root, '.gitignore'), '忽略.txt\n');
    git('add', '--', '已有.txt', '.gitignore');
    git('commit', '--quiet', '-m', 'test baseline');
    writeFileSync(join(root, '已有.txt'), '前票已审但未提交\n');
    git('add', '--', '已有.txt');
    writeFileSync(join(root, '未暂存.txt'), '派工前就存在\n');
    writeFileSync(join(root, '忽略.txt'), '不进入快照');
    const before = readFileSync(join(root, '.git/index')),
      head = git('rev-parse', 'HEAD').toString().trim(),
      baseline = captureWorkspace({ cwd: root, storage });
    expect(baseline.roots[0]!.kind).toBe('git');
    expect(baseline.roots[0]!.head).toBe(head);
    expect(readFileSync(join(root, '.git/index')).equals(before)).toBe(true);
    writeFileSync(join(root, '本票.txt'), '本票第一次交付\n');
    const delivery = captureWorkspace({ cwd: root, storage }),
      diff = compareWorkspaces(baseline, delivery, storage);
    expect(diff.changes.map((file) => file.path)).toEqual(['本票.txt']);
    expect(diff.patch).toContain('+本票第一次交付');
    expect(diff.patch).not.toContain('前票已审');
    expect(readSnapshotFile(delivery, 0, '已有.txt', storage).toString()).toBe(
      '前票已审但未提交\n',
    );
    expect(readFileSync(join(root, '.git/index')).equals(before)).toBe(true);
    expect(git('rev-parse', 'HEAD').toString().trim()).toBe(head);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);

test('审前核对只读现场，不新增Git引用或原件，不以当前文件更新原版本', () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-inspect-version-')),
    storage = join(root, '原件');
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', root, ...args], { windowsHide: true });
  try {
    git('init', '--quiet');
    writeFileSync(join(root, 'a.txt'), '送审正文');
    const saved = captureWorkspace({ cwd: root, storage }),
      refs = git('for-each-ref', 'refs/mat').toString();
    expect(inspectWorkspace({ cwd: root, storage }).fingerprint).toBe(saved.fingerprint);
    writeFileSync(join(root, 'a.txt'), '送审后变化');
    expect(inspectWorkspace({ cwd: root, storage }).fingerprint).not.toBe(saved.fingerprint);
    expect(git('for-each-ref', 'refs/mat').toString()).toBe(refs);
    expect(readSnapshotFile(saved, 0, 'a.txt', storage).toString()).toBe('送审正文');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30000);

test('仅明确声明的其他仓库和票内材料进入版本，不自动扫描旁边目录', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mat-version-scope-')),
    root = join(directory, '主仓库'),
    other = join(directory, '另一仓库'),
    materials = join(root, '票内材料'),
    storage = join(directory, '原件');
  for (const path of [root, other, materials]) mkdirSync(path, { recursive: true });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { windowsHide: true });
  try {
    git(root, 'init', '--quiet');
    git(other, 'init', '--quiet');
    writeFileSync(join(root, '主.txt'), '主成果');
    writeFileSync(join(other, '副.txt'), '明确声明');
    writeFileSync(join(materials, '证据.txt'), '原始证据');
    writeFileSync(join(directory, '未声明.txt'), '不属于票内版本');
    const snapshot = captureWorkspace({
      cwd: root,
      storage,
      additionalRepositories: [other],
      materialRoots: [materials],
    });
    expect(snapshot.roots.map((item) => item.kind)).toEqual(['git', 'git', 'files']);
    expect(snapshot.roots[0]!.files.map((item) => item.path)).toEqual(['主.txt']);
    expect(snapshot.roots[1]!.files.map((item) => item.path)).toEqual(['副.txt']);
    expect(readSnapshotFile(snapshot, 2, '证据.txt', storage).toString()).toBe('原始证据');
    expect(
      snapshot.roots.flatMap((item) => item.files).some((item) => item.path.includes('未声明')),
    ).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);

test('非Git版本保留原件，当前文件变化不替旧送审版本背书，返修另作比较', () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-files-version-')),
    storage = join(root, '版本原件');
  try {
    writeFileSync(join(root, '成果.txt'), '派工时已有内容\n');
    const baseline = captureWorkspace({ cwd: root, storage });
    writeFileSync(join(root, '成果.txt'), '第一次交付\n');
    const delivery = captureWorkspace({ cwd: root, storage });
    writeFileSync(join(root, '成果.txt'), '修复审阅问题\n');
    const repair = captureWorkspace({ cwd: root, storage });
    expect(baseline.roots[0]!.kind).toBe('files');
    expect(delivery.fingerprint).not.toBe(repair.fingerprint);
    expect(readSnapshotFile(delivery, 0, '成果.txt', storage).toString()).toBe('第一次交付\n');
    expect(compareWorkspaces(baseline, repair, storage).patch).toContain('-派工时已有内容');
    expect(compareWorkspaces(delivery, repair, storage).patch).toContain('-第一次交付');
    expect(compareWorkspaces(delivery, repair, storage).patch).not.toContain('派工时已有内容');
    expect(repair.roots[0]!.files.map((file) => file.path)).toEqual(['成果.txt']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test.each(['git', 'files'])('%s范围预算不足时明确拒绝，不产生裁剪的成功版本', (kind) => {
  const root = mkdtempSync(join(tmpdir(), 'mat-version-budget-')),
    storage = join(root, '原件');
  try {
    if (kind === 'git') execFileSync('git', ['-C', root, 'init', '--quiet'], { windowsHide: true });
    writeFileSync(join(root, '太大.txt'), '超过一字节预算');
    expect(() => captureWorkspace({ cwd: root, storage, maxBytes: 1 })).toThrow('预算');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('目录链接不会把未声明的外部文件纳入非Git快照', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mat-version-link-')),
    root = join(directory, '声明目录'),
    outside = join(directory, '未声明目录'),
    storage = join(directory, '原件');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, '外部.txt'), '不应被读取');
  try {
    symlinkSync(outside, join(root, '链接'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => captureWorkspace({ cwd: root, storage })).toThrow('符号链接');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('原件存储入口是目录链接时拒绝写入目标目录', () => {
  const directory = mkdtempSync(join(tmpdir(), 'mat-version-store-link-')),
    root = join(directory, '源码'),
    outside = join(directory, '外部目录'),
    storage = join(directory, '原件');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(root, 'a.txt'), '原件');
  try {
    symlinkSync(outside, storage, process.platform === 'win32' ? 'junction' : 'dir');
    expect(() => captureWorkspace({ cwd: root, storage })).toThrow('链接');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
