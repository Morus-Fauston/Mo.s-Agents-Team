import type { NativeAgent, NativeContext } from './native.ts';
import { ProjectError } from '../services/errors.ts';
interface ManagedGitProcess {
  done: Promise<{ exitCode: number | null; signal?: string | null }>;
  collected: {
    stdout: { readFrom(offset: number): { text: string; lossy: boolean } };
    stderr: { readFrom(offset: number): { text: string; lossy: boolean } };
  };
  terminate(): unknown;
  waitForExit(): Promise<unknown>;
}
/** Only the already checked checkout-removal argv is generated here; creation stays on official worktrees.create. */
export async function removeManagedCheckout(
  ctx: NativeContext,
  _agent: NativeAgent,
  repository: string,
  path: string,
  signal: AbortSignal,
) {
  if (!ctx.subprocess?.resolveExecutable)
    throw new ProjectError('WORKTREE_REMOVAL_UNAVAILABLE', '原生受管进程接口缺少Git执行器解析');
  const control = AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
    git = await ctx.subprocess.resolveExecutable('git', undefined, control);
  control.throwIfAborted();
  const env: Record<string, string | undefined> = Object.fromEntries(
    Object.keys(process.env)
      .filter((k) => k.startsWith('GIT_'))
      .map((k) => [k, undefined]),
  );
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_LFS_SKIP_SMUDGE: '1',
  });
  const child = ctx.subprocess.spawn({
    argv: [git, '--literal-pathspecs', '-C', repository, 'worktree', 'remove', '--', path],
    cwd: repository,
    env,
    signal: control,
    graceMs: 3000,
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 65536 } },
  }) as ManagedGitProcess;
  let result: { exitCode: number | null; output: string } | undefined,
    rangeGone = false,
    error: unknown;
  try {
    const outcome = await child.done,
      stdout = child.collected.stdout.readFrom(0),
      stderr = child.collected.stderr.readFrom(0);
    if (stdout.lossy || stderr.lossy)
      throw new ProjectError('WORKTREE_REMOVE_OUTPUT', 'Git清理输出不完整，结果保留未知');
    result = { exitCode: outcome.exitCode, output: stdout.text + stderr.text };
  } catch (e) {
    error = e;
  } finally {
    child.terminate();
    rangeGone = (await child.waitForExit()) === true;
  }
  if (error) throw error;
  if (!result) throw new ProjectError('WORKTREE_REMOVE_UNKNOWN', '原受管Git没有完整结果');
  return { ...result, rangeGone };
}
