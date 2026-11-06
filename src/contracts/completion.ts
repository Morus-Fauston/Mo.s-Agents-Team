import { z } from 'zod';
import { deliveryVersionInputSchema } from './versions.ts';
import { registeredRoleSchema } from './roles.ts';
import { nativeGoalSchema } from './execution.ts';
import { stoppedObservationSchema, ownedJobSchema } from './controls.ts';
export const reviewRetrySchema = z
  .object({ operationId: z.uuid(), reason: z.string().trim().min(1).max(8000) })
  .strict();
export const reviewConfigurationSchema = z
  .object({
    operationId: z.uuid(),
    ticketId: z.string().min(1).optional(),
    reviewerRoleId: z.string().nullable(),
    inherit: z.boolean().default(false),
  })
  .strict();
export const actionProgressSchema = z.object({
  state: z.enum(['pending', 'reserved', 'prepared', 'confirmed', 'unknown', 'failed']),
  note: z.string(),
  at: z.string(),
});
export const completionSchema = z.object({
  id: z.uuid(),
  operationId: z.uuid(),
  executionId: z.uuid(),
  ticketId: z.uuid(),
  sourceSessionId: z.uuid(),
  goalId: z.string(),
  versionId: z.uuid(),
  reviewId: z.uuid(),
  taskId: z.uuid(),
  input: deliveryVersionInputSchema,
  createdAt: z.string(),
});
export const reviewSchema = z.object({
  id: z.uuid(),
  completionId: z.uuid(),
  executionId: z.uuid(),
  ticketId: z.uuid(),
  versionId: z.uuid(),
  reviewerRole: registeredRoleSchema.nullable(),
  status: z.enum([
    'pending',
    'missing-reviewer',
    'creating',
    'starting',
    'active',
    'unknown',
    'failed',
    'decided',
    'cancelled',
  ]),
  sessionId: z.uuid().nullable(),
  nativeSessionId: z.string().nullable(),
  goalId: z.string().nullable(),
  goalSnapshot: nativeGoalSchema.nullable().default(null),
  startBoundarySeq: z.number().int().nonnegative().nullable().default(null),
  quiet: stoppedObservationSchema.nullable().default(null),
  jobs: z.array(ownedJobSchema).default([]),
  control: actionProgressSchema.nullable().default(null),
  stopObservation: stoppedObservationSchema.nullable().default(null),
  closure: actionProgressSchema.nullable().default(null),
  wait: z
    .object({
      state: z.enum(['registered', 'armed', 'signalled']),
      resultId: z.string().nullable(),
      at: z.string(),
    })
    .default(() => ({
      state: 'registered' as const,
      resultId: null,
      at: new Date().toISOString(),
    })),
  materialPath: z.string().nullable(),
  workspaceCheck: z
    .object({ matches: z.boolean().nullable(), error: z.string().nullable() })
    .nullable(),
  authorPause: actionProgressSchema,
  create: actionProgressSchema,
  start: actionProgressSchema,
  notifications: z.array(
    z.object({
      targetSessionId: z.uuid(),
      messageId: z.uuid(),
      content: z.string().default(''),
      progress: actionProgressSchema,
    }),
  ),
  reason: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CompletionRecord = z.infer<typeof completionSchema>;
export type ReviewRecord = z.infer<typeof reviewSchema>;
export type ActionProgress = z.infer<typeof actionProgressSchema>;
