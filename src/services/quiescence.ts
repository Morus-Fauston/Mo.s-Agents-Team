import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { z } from 'zod';
import { withinPath } from './write-scopes.ts';
import type { NativeEvent } from '../host/native.ts';
export function inFlightNativeTools(events: NativeEvent[], boundary: number): string[] {
  const calls = new Set<string>();
  for (const event of events) {
    if (event.seq <= boundary) continue;
    const message = event.data.message as
      { toolCallId?: string; source?: { callId?: string } } | undefined;
    const id = event.data.callId ?? message?.toolCallId ?? message?.source?.callId;
    if (typeof id !== 'string') continue;
    if (event.type === 'tool/call') calls.add(id);
    else if (event.type === 'tool/result') calls.delete(id);
  }
  return [...calls];
}
export interface ProcessIdentity {
  pid: number;
  started: number;
}
export interface ObservedProcess extends ProcessIdentity {
  parentPid: number;
  commandLine: string | null;
}
export interface ProcessSnapshot {
  complete: boolean;
  at: number;
  processes: ObservedProcess[];
  error?: string;
}
export const processWitnessSchema = z.object({
  host: z.object({ pid: z.number(), started: z.number() }),
  members: z.array(z.object({ pid: z.number(), started: z.number() })),
  associationComplete: z.boolean(),
  observedAt: z.number(),
});
export type ProcessWitness = z.infer<typeof processWitnessSchema>;
// Microsoft CRT rules: https://learn.microsoft.com/en-us/cpp/c-language/parsing-c-command-line-arguments
export function windowsArguments(commandLine: string): string[] {
  const values: string[] = [];
  let index = 0;
  while (index < commandLine.length) {
    while (/[ \t]/.test(commandLine[index] ?? '') && index < commandLine.length) index++;
    if (index >= commandLine.length) break;
    let text = '',
      quoted = false;
    while (index < commandLine.length) {
      const char = commandLine[index]!;
      if (!quoted && /[ \t]/.test(char)) break;
      if (char === '\\') {
        let count = 0;
        while (commandLine[index] === '\\') {
          count++;
          index++;
        }
        if (commandLine[index] === '"') {
          text += '\\'.repeat(Math.floor(count / 2));
          if (count % 2) {
            text += '"';
            index++;
          } else {
            quoted = !quoted;
            index++;
          }
        } else text += '\\'.repeat(count);
        continue;
      }
      if (char === '"') {
        if (quoted && commandLine[index + 1] === '"') {
          text += '"';
          index += 2;
        } else {
          quoted = !quoted;
          index++;
        }
      } else {
        text += char;
        index++;
      }
    }
    values.push(text);
  }
  return values;
}
const encodingPrefix =
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $OutputEncoding = [System.Text.UTF8Encoding]::new($false); ';
function matchesCommand(row: ObservedProcess, label: string): boolean {
  if (!row.commandLine) return false;
  const args = windowsArguments(row.commandLine),
    program = basename(args[0] ?? '').toLowerCase();
  if (!['pwsh.exe', 'powershell.exe', 'pwsh', 'powershell'].includes(program)) return false;
  const at = args.findIndex((arg) => ['-command', '-c'].includes(arg.toLowerCase()));
  if (at < 0) return false;
  const command = args[at + 1];
  return command === label || command === encodingPrefix + label;
}
const same = (left: ProcessIdentity, right: ProcessIdentity) =>
  left.pid === right.pid && left.started === right.started;
export function observeJobProcesses(
  job: { label: string; startedAt: number },
  snapshot: ProcessSnapshot,
  host: ProcessIdentity,
  previous?: ProcessWitness,
): { state: 'gone' | 'running' | 'unknown'; witness: ProcessWitness; note: string } {
  const witness: ProcessWitness = previous
    ? structuredClone(previous)
    : { host, members: [], associationComplete: false, observedAt: snapshot.at };
  witness.observedAt = snapshot.at;
  if (!snapshot.complete || (previous && !same(previous.host, host)))
    return { state: 'unknown', witness, note: '进程快照不完整或宿主身份变化；不推断已停止' };
  const byPid = new Map(snapshot.processes.map((row) => [row.pid, row]));
  const underHost = (row: ObservedProcess): boolean => {
    const seen = new Set<number>();
    let value: ObservedProcess | undefined = row;
    while (value && !seen.has(value.pid)) {
      seen.add(value.pid);
      if (same(value, host)) return true;
      const parent = byPid.get(value.parentPid);
      if (!parent || parent.started > value.started) return false;
      value = parent;
    }
    return false;
  };
  const candidates = snapshot.processes.filter(
    (row) =>
      row.started >= job.startedAt - 1000 && underHost(row) && matchesCommand(row, job.label),
  );
  const roots = [
    ...candidates,
    ...witness.members.flatMap((member) => {
      const row = byPid.get(member.pid);
      return row && same(member, row) ? [row] : [];
    }),
  ];
  if (candidates.length > 0) witness.associationComplete = true;
  const adopted = new Map(
    witness.members.map((member) => [member.pid + ':' + member.started, member]),
  );
  const reachable = new Set(roots.map((row) => row.pid));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of snapshot.processes) {
      const parent = byPid.get(row.parentPid);
      if (
        !reachable.has(row.pid) &&
        reachable.has(row.parentPid) &&
        parent &&
        parent.started <= row.started
      ) {
        reachable.add(row.pid);
        changed = true;
      }
    }
  }
  for (const row of snapshot.processes)
    if (reachable.has(row.pid))
      adopted.set(row.pid + ':' + row.started, { pid: row.pid, started: row.started });
  witness.members = [...adopted.values()].sort((a, b) => a.pid - b.pid || a.started - b.started);
  if (!witness.associationComplete || witness.members.length === 0)
    return { state: 'unknown', witness, note: '尚未取得原生作业命令与宿主后代进程的实际关联' };
  if (
    snapshot.processes.some(
      (row) =>
        row.started <= 0 &&
        (row.pid === host.pid ||
          witness.members.some((member) => member.pid === row.pid) ||
          reachable.has(row.parentPid)),
    )
  )
    return { state: 'unknown', witness, note: '相关进程的创建时刻缺失，不能把PID当作已消失' };
  const live = witness.members.some((member) => {
    const row = byPid.get(member.pid);
    return row && same(member, row);
  });
  return {
    state: live ? 'running' : 'gone',
    witness,
    note: live
      ? '已关联进程仍存在'
      : '本次完整快照未见已登记 PID 与创建时刻对应的进程；只覆盖已观察范围',
  };
}
const execute = promisify(execFile);
export async function windowsProcessSnapshot(): Promise<ProcessSnapshot> {
  const at = Date.now();
  if (process.platform !== 'win32')
    return { complete: false, at, processes: [], error: '当前停稳适配仅支持Windows CIM' };
  try {
    const script =
      '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); try { $matRows = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop | ForEach-Object { [pscustomobject]@{ pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; started=if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString("o") } else { $null }; commandLine=$_.CommandLine } }); ConvertTo-Json -InputObject $matRows -Compress -Depth 4 } catch { exit 2 }';
    const output = await execute(
      join(
        process.env.SystemRoot ?? 'C:/Windows',
        'System32/WindowsPowerShell/v1.0/powershell.exe',
      ),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
    );
    const raw = z
      .array(
        z.object({
          pid: z.number().int(),
          parentPid: z.number().int(),
          started: z.string().nullable(),
          commandLine: z.string().nullable(),
        }),
      )
      .parse(JSON.parse(output.stdout.replace(/^\uFEFF/, '')));
    return {
      complete: true,
      at,
      processes: raw.map((row) => ({
        pid: row.pid,
        parentPid: row.parentPid,
        started:
          row.started !== null && Number.isFinite(Date.parse(row.started))
            ? Date.parse(row.started)
            : 0,
        commandLine: row.commandLine,
      })),
    };
  } catch {
    return {
      complete: false,
      at,
      processes: [],
      error: 'Windows CIM快照不可取得或超出观察预算，保留未知',
    };
  }
}
export function fingerprintPaths(
  paths: string[],
  options: { maxFiles?: number; maxBytes?: number; excluded?: string[] } = {},
): { complete: boolean; digest: string | null; files: number; bytes: number; note: string } {
  const digest = createHash('sha256');
  let files = 0,
    bytes = 0;
  const seen = new Set<string>(),
    excluded = (options.excluded ?? []).map((path) => resolve(path));
  try {
    const visit = (path: string): void => {
      path = resolve(path);
      if (excluded.some((root) => withinPath(root, path))) {
        digest.update('excluded-platform:' + path + '\n');
        return;
      }
      if (seen.has(path)) return;
      seen.add(path);
      if (!existsSync(path)) {
        digest.update('missing:' + path + '\n');
        return;
      }
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('链接路径不能作为完整观察');
      if (realpathSync(path).toLowerCase() !== path.toLowerCase()) throw new Error('路径已变更');
      if (stat.isDirectory()) {
        digest.update('directory:' + path + '\n');
        for (const entry of readdirSync(path).sort()) visit(join(path, entry));
      } else if (stat.isFile()) {
        files++;
        bytes += stat.size;
        if (files > (options.maxFiles ?? 10000) || bytes > (options.maxBytes ?? 64 * 1024 * 1024))
          throw new Error('超出观察预算');
        digest
          .update('file:' + path + '\n')
          .update(readFileSync(path))
          .update('\n');
      } else throw new Error('非普通文件');
    };
    for (const path of [...paths].sort()) visit(path);
    return {
      complete: true,
      digest: digest.digest('hex'),
      files,
      bytes,
      note: '完整读取指定范围；平台运行数据排除项单独标记，非OS写入锁',
    };
  } catch (error) {
    return {
      complete: false,
      digest: null,
      files,
      bytes,
      note: error instanceof Error ? error.message : '范围指纹不可取得',
    };
  }
}
