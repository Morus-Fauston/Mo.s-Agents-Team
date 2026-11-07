import { z } from 'zod';
import type { NativeEvent, NativeMessage } from './native.ts';

const spliceSchema = z.object({
  target: z.enum(['next-step', 'next-turn']),
  start: z.number().int().nonnegative(),
  removedCount: z.number().int().nonnegative().optional(),
  inserted: z.array(z.object({ id: z.string() }).passthrough()),
  outcome: z.string().optional(),
});

/** Installed DSH claims inbox input before pre-step. A canceled turn can therefore
 * consume a message without recording a model step or user history. Only a full,
 * contiguous native log proving that precise case permits restoring the same input. */
export function unstartedInput(events: NativeEvent[], expected: NativeMessage): boolean {
  const queues: Record<string, { id: string; [key: string]: unknown }[]> = {
    'next-step': [],
    'next-turn': [],
  };
  let turn: unknown,
    claimed = false,
    proven = false;
  for (let index = 0; index < events.length; index++) {
    const event = events[index]!;
    if (event.seq !== index) return false;
    if (event.type === 'turn/start') {
      if (turn !== undefined) return false;
      turn = event.data.turn;
      claimed = false;
    } else if (event.type === 'agent/inbox/spliced') {
      const parsed = spliceSchema.safeParse(event.data);
      if (!parsed.success) return false;
      const { target, start, removedCount = 0, inserted, outcome } = parsed.data;
      const queue = queues[target]!;
      if (start > queue.length || start + removedCount > queue.length) return false;
      const removed = queue.splice(start, removedCount, ...inserted);
      for (const message of inserted)
        if (message.id === expected.id) {
          proven = false;
          if (
            message.role !== expected.role ||
            JSON.stringify(message.source) !== JSON.stringify(expected.source) ||
            JSON.stringify(message.content) !== JSON.stringify(expected.content)
          )
            return false;
        }
      if (removed.some((message) => message.id === expected.id)) {
        proven = false;
        claimed = turn !== undefined && outcome === undefined && inserted.length === 0;
      }
    } else if (event.type === 'step/start') {
      if (claimed) return false;
    } else if (event.type === 'user/message' && event.data.id === expected.id) {
      return false;
    } else if (event.type === 'turn/end') {
      if (turn !== event.data.turn) return false;
      const reason = event.data.reason as { kind?: string } | undefined;
      if (claimed) proven = reason?.kind === 'aborted' || reason?.kind === 'blocked';
      turn = undefined;
      claimed = false;
    }
  }
  return (
    proven &&
    turn === undefined &&
    !Object.values(queues).some((queue) => queue.some((message) => message.id === expected.id))
  );
}
