import { z } from 'zod';
import { authorSchema } from './workbench.ts';
import { receiptSchema, stoppedObservationSchema } from './controls.ts';
import { assistantSchema } from './collaboration.ts';
export const assistantControlInputSchema = z
  .object({
    operationId: z.uuid(),
    collaborationId: z.uuid(),
    action: z.enum(['soft-stop', 'hard-stop', 'terminate', 'resume']),
    reason: z.string().trim().min(1).max(10000),
    content: z.string().max(48000).default(''),
    expectedRevision: z.number().int().nonnegative(),
    stopMode: z.enum(['soft', 'hard']).default('hard'),
  })
  .strict();
export const assistantControlSchema = z.object({
  id: z.uuid(),
  operationId: z.uuid(),
  collaborationId: z.uuid(),
  executionId: z.uuid(),
  parentSessionId: z.uuid(),
  sessionId: z.uuid(),
  nativeSessionId: z.string().nullable(),
  parentControlId: z.uuid().nullable(),
  blockedBy: z.array(z.string()),
  revision: z.number().int().positive(),
  actor: authorSchema,
  action: assistantControlInputSchema.shape.action,
  reason: z.string(),
  content: z.string(),
  stopMode: z.enum(['soft', 'hard']),
  status: z.enum([
    'requested',
    'delivered',
    'handoff',
    'checking',
    'stopped',
    'unknown',
    'resumed',
    'terminated',
  ]),
  handoffRequired: z.boolean(),
  error: z.string().nullable(),
  goal: receiptSchema.nullable(),
  cancel: receiptSchema.nullable(),
  jobKills: z.array(z.object({ jobId: z.string(), receipt: receiptSchema })),
  observation: stoppedObservationSchema.nullable(),
  observations: z.array(stoppedObservationSchema),
  report: z.object({ sessionId: z.uuid(), content: z.string(), at: z.string() }).nullable(),
  messageId: z.uuid(),
  resumeMessageId: z.uuid(),
  resumeSnapshot: z.unknown().nullable(),
  writeScopes: z.array(z.string()),
  materialPaths: z.array(z.string()),
  epoch: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type AssistantControlRecord = z.infer<typeof assistantControlSchema>;
export const assistantControlInventorySchema = z.object({
  collaborationId: z.uuid(),
  name: z.string(),
  sessionId: z.uuid().nullable(),
  address: z.string().nullable(),
  state: assistantSchema.shape.state,
  communicationState: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  current: assistantControlSchema.nullable(),
});
