import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const pnpm = process.env.npm_execpath;
if (!pnpm) throw new Error('请通过 pnpm run package 执行，以使用当前固定的包管理器');
const root = resolve('.');
const directory = join(root, '.scratch', '构建', '打包', randomUUID());
const staging = join(directory, '准备');
const output = join(directory, '产物');
mkdirSync(staging, { recursive: true });
mkdirSync(output);
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
// 仅复制自有产物及锁文件，避免包管理器自动纳入根 README 的既有 WIP。
for (const path of ['package.json', ...manifest.files])
  cpSync(join(root, path), join(staging, path), { recursive: true });
const result = execFileSync(
  process.execPath,
  [pnpm, 'pack', '--pack-destination', output, '--json'],
  { cwd: staging, encoding: 'utf8', windowsHide: true },
);
writeFileSync(join(directory, '打包清单.json'), result);
// pnpm pack 固定排除 pnpm-lock.yaml，同批次锁文件作为产物的配套文件交付。
cpSync(join(root, 'pnpm-lock.yaml'), join(output, 'pnpm-lock.yaml'));
console.log(result);
