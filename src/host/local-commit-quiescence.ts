import type { NativeAgent, NativeContext } from './native.ts';
import type { LocalCommitRecord } from '../contracts/local-commits.ts';
import type { LocalCommitObservation } from '../services/local-commits.ts';
import { inFlightNativeTools } from '../services/quiescence.ts';
import { nativeTerminalJobStatuses } from '../contracts/controls.ts';
export function observeLocalCommit(
  ctx: NativeContext,
  agent: NativeAgent | undefined,
  nativeId: string | null,
  epoch: string,
  rangesAvailable: boolean,
  value?: Pick<LocalCommitRecord, 'native'>,
  callId?: string,
  toolName = 'mat_local_commit',
): LocalCommitObservation {
  const events = agent?.session.snapshotEvents() ?? [],
    native = value?.native ?? null,
    boundary = native?.boundary ?? events.at(-1)?.seq ?? -1;
  const observation: LocalCommitObservation = {
    nativeSessionId: agent?.id ?? '',
    epoch,
    boundary,
    ranges: native?.ranges ?? [],
    state: 'unknown',
    note: '原生会话未加载或身份/观察接口缺件，不推断安静',
    observedAt: new Date().toISOString(),
  };
  if (
    !agent ||
    agent.id !== nativeId ||
    (native && native.nativeSessionId !== agent.id) ||
    !ctx.jobs ||
    !ctx.goals ||
    !rangesAvailable
  )
    return observation;
  const ownCall =
    callId &&
    events.some(
      (e) =>
        e.type === 'tool/call' &&
        e.seq > boundary &&
        e.data.callId === callId &&
        e.data.name === toolName,
    )
      ? callId
      : undefined;
  const calls = inFlightNativeTools(events, -1).filter((id) => id !== ownCall),
    terminals = events.filter(
      (e) =>
        e.seq > boundary &&
        e.type === 'tool/call' &&
        ['pwsh', 'bash'].includes(String(e.data.name)),
    );
  const reasons = [];
  if (calls.length) reasons.push('原生工具仍在途');
  if (agent.status !== 'idle' && !ownCall) reasons.push('原提交会话仍在运行');
  if (ctx.goals.get(agent)) reasons.push('仍有关联Goal，不能接管或推定停止');
  if (
    agent.inbox.nextStep.some(
      (m) =>
        !['agent-instructions', 'skill-catalog', 'skill-invocation'].includes(
          String(m.source.kind),
        ),
    )
  )
    reasons.push('仍有待处理输入');
  if (
    ctx.jobs
      .list(agent.id)
      .some((j) => j.owner === agent.id && !nativeTerminalJobStatuses.includes(j.status))
  )
    reasons.push('仍有原生后台作业');
  if (native) {
    if (native.ranges.some((r) => r.nativeOwner !== agent.id || r.state !== 'gone'))
      reasons.push('受管进程范围未确认退出');
    if (
      terminals.some(
        (e) => !native.ranges.some((r) => r.callId === e.data.callId && r.nativeOwner === agent.id),
      )
    )
      reasons.push('原终端调用缺少受管范围观察，不从tool结果推定后台已退出');
  }
  observation.state = reasons.length ? 'unknown' : 'confirmed';
  observation.note =
    reasons.join('；') ||
    '原会话身份、Goal、输入、工具、原生后台作业及受管范围已核定；不是设备或业务验收';
  return observation;
}
