import { z } from 'zod';
import { executionConfigurationSchema } from './project.ts';
import { authorSchema } from './workbench.ts';
import { localCommitNativeSchema, localCommitQuiescenceSchema } from './local-commits.ts';
export const scopeAdjustmentBodySchema = z
  .object({
    executionId: z.uuid(),
    expectedControlRevision: z.number().int().positive(),
    expectedScopeRevision: z.number().int().nonnegative(),
    writeScopes: z.array(z.string().min(1)).max(128),
    reason: z.string().trim().min(1).max(10000),
    decisionRequestId: z.uuid().optional(),
  })
  .strict();
export const scopeAdjustmentInputSchema = scopeAdjustmentBodySchema.extend({
  operationId: z.uuid(),
});
export const dispatchBodySchema = z
  .object({
    ticket: z.string().min(1),
    roleId: z.string().min(1).optional(),
    sessionId: z.uuid().optional(),
    reuseClosedExecutionId: z.uuid().optional(),
    name: z.string().trim().min(1).max(160),
    cwd: z.string().min(1).optional(),
    writeScopes: z.array(z.string().min(1)).optional(),
    additionalRepositories: z.array(z.string().min(1)).max(16).default([]),
    worktreeId: z.uuid().optional(),
    mergeId: z.uuid().optional(),
    requirements: z.string().default(''),
    configuration: executionConfigurationSchema.optional(),
    notifySessionId: z.uuid().optional(),
    maxGoalRounds: z.number().int().positive().optional(),
  })
  .strict();
export const dispatchInputSchema = dispatchBodySchema
  .extend({ operationId: z.uuid() })
  .superRefine((input, ctx) => {
    if ((input.roleId === undefined) === (input.sessionId === undefined))
      ctx.addIssue({ code: 'custom', message: '每次选择一个新开角色或一个明确已有会话' });
    if (input.roleId && !input.cwd && !input.worktreeId)
      ctx.addIssue({ code: 'custom', message: '新会话须明确源码工作目录' });
    if (input.reuseClosedExecutionId && !input.sessionId)
      ctx.addIssue({ code: 'custom', message: '顺序承票须明确指定已收尾的原会话' });
  });
export const nativeGoalSchema = z.object({
  id: z.string(),
  revision: z.number().int().positive(),
  objective: z.string(),
  phase: z.enum(['active', 'paused', 'blocked', 'complete']),
  activation: z.enum(['armed', 'disarmed']),
  roundsStarted: z.number().int().nonnegative(),
  maxGoalRounds: z.number().int().positive(),
});
export type NativeGoalView = z.infer<typeof nativeGoalSchema>;
export const executionFailureSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  message: z.string(),
  phase: z.enum(['startup', 'runtime']),
  unknown: z.boolean(),
  at: z.string(),
});
export const executionSchema = z.object({
  id: z.uuid(),
  dispatchId: z.uuid(),
  operationId: z.uuid(),
  actor: authorSchema,
  managerSessionIds: z.array(z.uuid()),
  ticketId: z.uuid(),
  ticketCode: z.string(),
  ticketRevision: z.number(),
  dependencyEvidence: z
    .array(
      z.object({
        ticketId: z.uuid(),
        deliveryId: z.string().min(1),
        reviewId: z.string().min(1),
        scope: z.string().min(1),
      }),
    )
    .default([]),
  roleId: z.string(),
  roleType: z.enum(['supervisor', 'developer', 'investigator', 'reviewer', 'committer']),
  name: z.string(),
  requirements: z.string(),
  cwd: z.string(),
  worktreeId: z.uuid().nullable().default(null),
  mergeId: z.uuid().nullable().default(null),
  cwdMode: z.enum(['explicit', 'preserve-current']),
  writeScopes: z.array(z.string()),
  scopeAdjustments: z
    .array(
      z.object({
        operationId: z.uuid(),
        requestHash: z.string(),
        revision: z.number().int().positive(),
        stoppedControlId: z.uuid(),
        controlRevision: z.number().int().positive(),
        before: z.array(z.string()),
        after: z.array(z.string()),
        actor: authorSchema,
        reason: z.string(),
        decisionRequestId: z.uuid().nullable(),
        at: z.string(),
      }),
    )
    .default([]),
  additionalRepositories: z.array(z.string()).default([]),
  writeScopesDefaulted: z.boolean(),
  requestedConfiguration: executionConfigurationSchema.nullable(),
  resolvedConfiguration: executionConfigurationSchema.nullable(),
  configurationBasis: z.enum(['dispatch-override', 'role-default', 'preserve-native']),
  maxGoalRounds: z.number().int().positive().nullable(),
  sessionId: z.uuid().nullable(),
  nativeSessionId: z.string().nullable(),
  startupState: z.enum([
    'registered',
    'creating-session',
    'session-prepared',
    'starting',
    'confirmed',
    'error',
    'unknown',
  ]),
  lifecycleState: z.enum(['active', 'waiting', 'paused', 'error', 'terminated', 'closed']),
  waitingReviewId: z.uuid().nullable().default(null),
  reviewResultId: z.uuid().nullable().default(null),
  sessionReuse: z
    .object({
      previousExecutionId: z.uuid(),
      previousResultId: z.uuid(),
      observation: localCommitNativeSchema.extend(localCommitQuiescenceSchema.shape),
    })
    .nullable()
    .default(null),
  writeOccupancy: z.enum(['held', 'pending-release', 'released', 'unknown']),
  goalId: z.string().nullable(),
  goalObjective: z.string().nullable(),
  goalSnapshot: nativeGoalSchema.nullable(),
  goalDurableAt: z.string().nullable(),
  startBoundarySeq: z.number().int().nullable(),
  firstRequestId: z.uuid().nullable(),
  firstStartedAt: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  completedSteps: z.number().int().nonnegative(),
  failure: executionFailureSchema.nullable(),
  notifications: z.array(
    z.object({
      targetSessionId: z.uuid(),
      messageId: z.uuid(),
      content: z.string(),
      state: z.enum(['pending', 'saved', 'unavailable']),
      error: z.string().nullable(),
    }),
  ),
  hostEpoch: z.string(),
  detachedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ExecutionRecord = z.infer<typeof executionSchema>;
export const executionStepSchema = z.object({
  turn: z.number().int(),
  step: z.number().int(),
  startSeq: z.number().int(),
  endSeq: z.number().int().nullable(),
  requestIds: z.array(z.string()),
  lastRequestStatus: z.enum(['started', 'completed', 'failed', 'interrupted']).nullable(),
  settled: z.boolean(),
  failed: z.boolean(),
});
export type ExecutionStep = z.infer<typeof executionStepSchema>;
export interface DependencyEvidence {
  ticketId: string;
  deliveryId: string;
  reviewId: string;
  scope: string;
}
