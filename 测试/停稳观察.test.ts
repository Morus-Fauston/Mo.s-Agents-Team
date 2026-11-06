import { expect, test } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  windowsArguments,
  observeJobProcesses,
  fingerprintPaths,
  inFlightNativeTools,
} from '../源码/业务/停稳观察.ts';
test('Windows参数按引号和反斜线解码，命令内容保持字面值', () => {
  expect(
    windowsArguments('"C:\\Program Files\\pwsh.exe" -Command "Write-Output \\"hello world\\""'),
  ).toEqual(['C:\\Program Files\\pwsh.exe', '-Command', 'Write-Output "hello world"']);
  expect(windowsArguments('app.exe "D:\\资料目录\\\\" tail')).toEqual([
    'app.exe',
    'D:\\资料目录\\',
    'tail',
  ]);
});
test('真实命令参数与Host后代关联，子进程仍活着时不以父进程退出当停稳', () => {
  const job = { label: 'Write-Output "probe"', startedAt: 1000 },
    host = { pid: 10, started: 100 },
    snapshot = {
      complete: true,
      at: 2000,
      processes: [
        { pid: 10, parentPid: 1, started: 100, commandLine: 'host' },
        {
          pid: 20,
          parentPid: 10,
          started: 1100,
          commandLine: 'pwsh.exe -Command "Write-Output \\"probe\\""',
        },
        { pid: 30, parentPid: 20, started: 1200, commandLine: 'node writer.js' },
      ],
    };
  const first = observeJobProcesses(job, snapshot, host);
  expect(first.state).toBe('running');
  expect(first.witness.members.map((item) => item.pid)).toEqual([20, 30]);
  const childAlive = observeJobProcesses(
    job,
    { ...snapshot, at: 3000, processes: [snapshot.processes[0]!, snapshot.processes[2]!] },
    host,
    first.witness,
  );
  expect(childAlive.state).toBe('running');
  const gone = observeJobProcesses(
    job,
    { ...snapshot, at: 4000, processes: [snapshot.processes[0]!] },
    host,
    childAlive.witness,
  );
  expect(gone.state).toBe('gone');
});
test('没有初始进程关联、CIM不完整或PID复用不能伪造完整停稳证据', () => {
  const job = { label: 'Start-Sleep 5', startedAt: 1000 },
    host = { pid: 10, started: 100 },
    hostRow = { pid: 10, parentPid: 1, started: 100, commandLine: 'host' },
    empty = { complete: true, at: 2000, processes: [hostRow] };
  expect(observeJobProcesses(job, empty, host).state).toBe('unknown');
  const first = observeJobProcesses(
    job,
    {
      ...empty,
      processes: [
        hostRow,
        { pid: 20, parentPid: 10, started: 1100, commandLine: 'pwsh.exe -Command "Start-Sleep 5"' },
      ],
    },
    host,
  );
  expect(first.state).toBe('running');
  expect(observeJobProcesses(job, { ...empty, complete: false }, host, first.witness).state).toBe(
    'unknown',
  );
  const reused = observeJobProcesses(
    job,
    {
      ...empty,
      processes: [
        hostRow,
        { pid: 20, parentPid: 999, started: 3000, commandLine: 'unrelated.exe' },
      ],
    },
    host,
    first.witness,
  );
  expect(reused.state).toBe('gone');
  expect(reused.witness.members[0]!.started).toBe(1100);
});
test('文件指纹来自真实临时文件，内容变化和预算超限不能报稳定', () => {
  const root = mkdtempSync(join(tmpdir(), 'mat-quiescence-'));
  try {
    const path = join(root, '记录.txt');
    writeFileSync(path, '第一版');
    const first = fingerprintPaths([root]);
    writeFileSync(path, '第二版');
    const second = fingerprintPaths([root]);
    expect(first.complete).toBe(true);
    expect(second.digest).not.toBe(first.digest);
    expect(fingerprintPaths([root], { maxFiles: 0 }).complete).toBe(false);
    expect(fingerprintPaths([root], { maxBytes: 1 }).complete).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('已知PID创建时刻不可读时保留未知，不把被过滤记录当作退出', () => {
  const host = { pid: 10, started: 100 },
    job = { label: 'Start-Sleep 5', startedAt: 1000 },
    first = observeJobProcesses(
      job,
      {
        complete: true,
        at: 2000,
        processes: [
          { pid: 10, parentPid: 1, started: 100, commandLine: 'host' },
          {
            pid: 20,
            parentPid: 10,
            started: 1100,
            commandLine: 'pwsh.exe -Command "Start-Sleep 5"',
          },
        ],
      },
      host,
    );
  expect(
    observeJobProcesses(
      job,
      {
        complete: true,
        at: 3000,
        processes: [
          { pid: 10, parentPid: 1, started: 100, commandLine: 'host' },
          { pid: 20, parentPid: 10, started: 0, commandLine: null },
        ],
      },
      host,
      first.witness,
    ).state,
  ).toBe('unknown');
});

test('实际工具结果的嵌套callId结束在途记录，取消结果也结算但未返回调用保留', () => {
  expect(
    inFlightNativeTools(
      [
        { type: 'tool/call', seq: 1, data: { callId: 'old' } },
        { type: 'tool/call', seq: 3, data: { callId: 'done' } },
        { type: 'tool/call', seq: 4, data: { callId: 'pending' } },
        {
          type: 'tool/result',
          seq: 5,
          data: {
            message: {
              toolCallId: 'done',
              isError: true,
              source: { kind: 'tool', callId: 'done' },
            },
          },
        },
      ],
      2,
    ),
  ).toEqual(['pending']);
});
