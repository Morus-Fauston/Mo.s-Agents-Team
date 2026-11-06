import { z } from 'zod';
import { authorSchema } from './workbench.ts';
import { actionProgressSchema } from './completion.ts';
import { stoppedObservationSchema } from './controls.ts';
export const reviewResultRetrySchema = z
  .object({
    operationId: z.uuid(),
    reason: z.string().trim().min(1).max(8000),
    expectedControlRevision: z.number().int().nonnegative().optional(),
  })
  .strict();
const opinionFields = {
  reviewId: z.uuid(),
  versionId: z.uuid(),
  verdict: z.enum(['pass', 'return']),
  scope: z.string().trim().min(1).max(16000),
  basis: z.string().trim().min(1).max(32000),
  issues: z.array(z.string().trim().min(1).max(16000)).max(100).default([]),
  evidencePaths: z.array(z.string().trim().min(1).max(4000)).max(100).default([]),
};
export const reviewOpinionBodySchema = z.object(opinionFields).strict();
export const reviewOpinionSchema = z
  .object({ operationId: z.uuid(), ...opinionFields })
  .strict()
  .superRefine((value, ctx) => {
    if (value.verdict === 'return' && !value.issues.length)
      ctx.addIssue({ code: 'custom', path: ['issues'], message: '退回必须给出问题依据和修正要求' });
  });
export const reviewResultSchema = z.object({
  id: z.uuid(),
  operationId: z.uuid(),
  reviewId: z.uuid(),
  completionId: z.uuid(),
  executionId: z.uuid(),
  ticketId: z.uuid(),
  versionId: z.uuid(),
  previousResultId: z.uuid().nullable(),
  author: authorSchema,
  nativeSessionId: z.string(),
  verdict: z.enum(['pass', 'return']),
  scope: z.string(),
  basis: z.string(),
  issues: z.array(z.string()),
  evidencePaths: z.array(z.string()),
  progress: actionProgressSchema,
  reviewCleanup: actionProgressSchema,
  authorAction: actionProgressSchema,
  authorGoalClear: actionProgressSchema.nullable(),
  authorObservation: stoppedObservationSchema.nullable(),
  notifications: z.array(
    z.object({
      messageId: z.uuid(),
      targetSessionId: z.uuid(),
      content: z.string(),
      progress: actionProgressSchema,
    }),
  ),
  createdAt: z.string(),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;
