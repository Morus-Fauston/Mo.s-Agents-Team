import { removeManagedCheckout } from './worktree-remove.ts';
import type { NativeAgent, NativeContext } from './native.ts';
import type { ProjectService } from '../services/project-service.ts';
import type { WorktreeHost } from '../services/worktrees.ts';
import type { NativeProcessRanges } from './process-ranges.ts';
import { inFlightNativeTools } from '../services/quiescence.ts';
import { nativeTerminalJobStatuses } from '../contracts/controls.ts';
import { ProjectError } from '../services/errors.ts';
export function createWorktreeHost(
  ctx: NativeContext,
  projects: ProjectService,
  peek: (p: string, s: string) => NativeAgent | undefined,
  ranges: NativeProcessRanges,
  epoch: string,
): WorktreeHost {
  // Cordis reflect.get returns only an active optional provider; direct property access requires inject.
  const official = () =>
    ctx.reflect ? (ctx.reflect.get('worktrees') as NativeContext['worktrees']) : ctx.worktrees;
  return {
    remove: (agent, source, path, signal) =>
      removeManagedCheckout(ctx, agent, source, path, signal),
    get poolDirectory() {
      return official()?.config.directory;
    },
    peek,
    directory: (agent) => ctx.workingDirectory.get(agent.session),
    setDirectory: (agent, path) => ctx.workingDirectory.set(agent, path),
    flush: (agent) => ctx.sessions.flush(agent.session),
    create: async (agent, input, signal, onPhase) => {
      const provider = official();
      if (!provider)
        throw new ProjectError(
          'WORKTREE_UNAVAILABLE',
          '当前宿主没有官方worktrees服务，不启动替代服务',
        );
      return provider.create(agent, input, signal, onPhase);
    },
    safe: (project, session, callId, executionId) => {
      const c = projects.forProject(project),
        s = c.session(session),
        agent = peek(project, session),
        unknown = (note: string) => ({ state: 'unknown' as const, note });
      if (!agent || agent.id !== s.nativeSessionId || !ctx.jobs || !ctx.goals || !ranges.available)
        return unknown('原生身份、Goal、作业或受管范围接口缺件，不推定安全');
      const events = agent.session.snapshotEvents(),
        own =
          callId &&
          events.some(
            (e) =>
              e.type === 'tool/call' &&
              e.data.callId === callId &&
              ['create_worktree', 'mat_worktree'].includes(String(e.data.name)),
          )
            ? callId
            : undefined;
      if (
        inFlightNativeTools(events, -1).some((id) => id !== own) ||
        (agent.status !== 'idle' && !own)
      )
        return unknown('调用会话还有其他模型/工具在途');
      const goal = ctx.goals.get(agent);
      if (executionId) {
        const e = c.executions().get(executionId);
        if (
          e.nativeSessionId !== agent.id ||
          e.hostEpoch !== epoch ||
          !goal ||
          goal.id !== e.goalId
        )
          return unknown('不是本次原执行及原Goal，不替换其他工作');
      } else if (goal) return unknown('主管仍有其他Goal，不接管');
      if (
        agent.inbox.nextStep.some(
          (m) =>
            ![
              'agent-instructions',
              'skill-catalog',
              'skill-invocation',
              'working-directory',
            ].includes(String(m.source.kind)),
        )
      )
        return unknown('仍有普通待处理输入，不把输入当工作树授权');
      if (
        ctx.jobs
          .list(agent.id)
          .some(
            (j) =>
              j.owner === undefined ||
              (j.owner === agent.id && !nativeTerminalJobStatuses.includes(j.status)),
          )
      )
        return unknown('原生后台作业未确认结束或来源未知');
      if (ranges.forSession(session).some((r) => r.state !== 'gone'))
        return unknown('仍有未确认退出的受管范围');
      const creating = c
        .worktrees()
        .list({ kind: 'user' })
        .findLast(
          (v) =>
            v.creatorSessionId === session &&
            v.nativeSessionId === agent.id &&
            ['creating', 'unknown'].includes(v.status) &&
            v.phases.some((p) => p.name === 'native-create'),
        );
      if (creating && creating.ranges.length === 0)
        return unknown('官方创建缺少实际受管范围退出观察，先回读原记录');
      return {
        state: 'confirmed',
        note: '原会话、原Goal、其他工具/输入、原生jobs及受管范围核定；不是OS隔离',
      };
    },
  };
}
