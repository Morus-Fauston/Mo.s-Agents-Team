import { z } from 'zod';
import { authorSchema } from './workbench.ts';
import { stoppedObservationSchema } from './controls.ts';
export const collaborationReportSchema = z
  .object({
    operationId: z.uuid(),
    action: z.enum(['complete', 'hangup']),
    content: z.string().default(''),
    evidencePaths: z.array(z.string().min(1)).default([]),
    dependencies: z.array(z.uuid()).default([]),
    resumeCondition: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.action === 'hangup' && !v.content.trim())
      ctx.addIssue({ code: 'custom', message: '挂起原因不能为空' });
    if (v.action === 'hangup' && !v.dependencies.length && !v.resumeCondition)
      ctx.addIssue({ code: 'custom', message: '挂起须保留已有等待对象或明确恢复条件' });
    if (v.action === 'complete' && (v.dependencies.length || v.resumeCondition))
      ctx.addIssue({ code: 'custom', message: '完成不能混入等待条件' });
  });
export const collaborationResultSchema = z.object({
  id: z.uuid(),
  operationId: z.uuid(),
  collaborationId: z.uuid(),
  executionId: z.uuid(),
  ticketId: z.uuid(),
  sessionId: z.uuid(),
  parentSessionId: z.uuid(),
  author: authorSchema,
  action: z.enum(['complete', 'hangup']),
  content: z.string(),
  evidencePaths: z.array(z.string()),
  dependencies: z.array(z.uuid()),
  resumeCondition: z.string().nullable(),
  previousResultId: z.uuid().nullable(),
  progress: z.enum(['saved', 'unknown', 'confirmed']),
  observation: stoppedObservationSchema.nullable(),
  observations: z.array(stoppedObservationSchema).default([]),
  error: z.string().nullable(),
  deliveryError: z.string().nullable().default(null),
  notices: z
    .array(
      z.object({
        id: z.uuid(),
        progress: z.enum(['unknown', 'confirmed']),
        targetSessionId: z.uuid(),
        content: z.string(),
      }),
    )
    .default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export const collaborationWaitInputSchema = z
  .object({
    operationId: z.uuid(),
    reason: z.string().trim().min(1),
    dependencies: z.array(z.uuid()).default([]),
    requestIds: z.array(z.uuid()).default([]),
    resumeCondition: z.string().trim().min(1).optional(),
  })
  .strict();
export const collaborationWaitSchema = z.object({
  id: z.uuid(),
  operationId: z.uuid(),
  executionId: z.uuid(),
  sessionId: z.uuid(),
  dependencies: z.array(z.uuid()),
  requestIds: z.array(z.uuid()).default([]),
  reason: z.string(),
  resumeCondition: z.string().nullable(),
  state: z.enum(['waiting', 'ready', 'signalled', 'unknown', 'controlled']),
  supersededByControlId: z.uuid().nullable().default(null),
  goalId: z.string().nullable(),
  controlRevision: z.number().int().nonnegative(),
  error: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CollaborationResult = z.infer<typeof collaborationResultSchema>;
export type CollaborationWait = z.infer<typeof collaborationWaitSchema>;
