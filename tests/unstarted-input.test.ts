import { expect, test } from 'vitest';
import { unstartedInput } from '../src/host/unstarted-input.ts';
import type { NativeEvent, NativeMessage } from '../src/host/native.ts';

const message: NativeMessage = {
  id: 'original',
  role: 'user',
  source: { kind: 'mat-message' },
  content: [{ type: 'text', text: 'original body' }],
};
function events(ending = 'aborted'): NativeEvent[] {
  return [
    {
      type: 'agent/inbox/spliced',
      seq: 0,
      data: { target: 'next-step', start: 0, inserted: [message] },
    },
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    {
      type: 'agent/inbox/spliced',
      seq: 2,
      data: { target: 'next-step', start: 0, removedCount: 1, inserted: [] },
    },
    { type: 'turn/end', seq: 3, data: { turn: 1, reason: { kind: ending } } },
  ];
}
test('原生完整记录证明原输入被领取但模型步骤未开始，才允许恢复原身份', () => {
  for (const ending of ['aborted', 'blocked'])
    expect(unstartedInput(events(ending), message)).toBe(true);
  expect(unstartedInput(events('completed'), message)).toBe(false);
  const canceled = events();
  canceled[2]!.data.outcome = 'canceled';
  expect(unstartedInput(canceled, message)).toBe(false);
  const started = events();
  started.splice(3, 0, { type: 'step/start', seq: 3, data: { turn: 1, step: 1 } });
  started[4]!.seq = 4;
  expect(unstartedInput(started, message)).toBe(false);
  expect(unstartedInput(events().slice(0, -1), message)).toBe(false);
  expect(
    unstartedInput(
      events().filter((e) => e.seq !== 1),
      message,
    ),
  ).toBe(false);
  expect(
    unstartedInput(events(), { ...message, content: [{ type: 'text', text: 'changed' }] }),
  ).toBe(false);
  const later = events();
  later.push({ type: 'user/message', seq: 4, data: message as unknown as Record<string, unknown> });
  expect(unstartedInput(later, message)).toBe(false);
  const reinserted = events();
  reinserted.push({
    type: 'agent/inbox/spliced',
    seq: 4,
    data: { target: 'next-step', start: 0, inserted: [message] },
  });
  expect(unstartedInput(reinserted, message)).toBe(false);
});
