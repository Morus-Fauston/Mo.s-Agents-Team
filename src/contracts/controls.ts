import { z } from 'zod';
/** Verified native registry terminal statuses; arbitrary or unknown values never prove settlement. */
export const nativeTerminalJobStatuses: readonly string[] = ['completed', 'killed', 'failed'];
import { authorSchema } from './workbench.ts';
export const controlBodySchema = z
  .object({
    executionId: z.uuid(),
    action: z.enum(['soft-stop', 'hard-stop', 'terminate', 'resume', 'reconcile']),
    reason: z.string().trim().min(1).max(10000),
    content: z.string().max(48000).default(''),
    expectedRevision: z.number().int().nonnegative(),
    stopMode: z.enum(['soft', 'hard']).default('hard'),
    reviewedRecoveryFingerprint: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();
export const controlInputSchema = controlBodySchema.extend({ operationId: z.uuid() });
export const receiptSchema = z.object({
  state: z.enum(['confirmed', 'requested', 'unknown', 'failed', 'unnecessary']),
  note: z.string(),
  at: z.string().optional(),
  goalId: z.string().optional(),
});
export type ControlReceipt = z.infer<typeof receiptSchema>;
const recoveryFileSchema = z.object({ path: z.string(), sha256: z.string().nullable() });
export const recoveryCheckpointSchema = z.object({
  files: z.array(recoveryFileSchema),
  norms: z.array(recoveryFileSchema),
  requirements: z.string(),
  writeScopes: z.array(z.string()),
  cwd: z.string(),
  dependencyVersionIds: z.array(z.string()),
});
export type RecoveryCheckpoint = z.infer<typeof recoveryCheckpointSchema>;
export const recoveryPreviewSchema = z.object({
  executionId: z.uuid(),
  expectedRevision: z.number().int().nonnegative(),
  stoppedControlId: z.uuid(),
  fingerprint: z.string(),
  hasChanges: z.boolean(),
  baselineMissing: z.boolean(),
  requirementsChanged: z.boolean(),
  scopeChanged: z.boolean(),
  dependencyChanged: z.boolean(),
  fileCount: z.number().int().nonnegative(),
  files: z.array(
    z.object({ path: z.string(), before: z.string().nullable(), after: z.string().nullable() }),
  ),
  norms: z.array(
    z.object({ path: z.string(), before: z.string().nullable(), after: z.string().nullable() }),
  ),
});
export type RecoveryPreview = z.infer<typeof recoveryPreviewSchema>;
export const stoppedObservationSchema = z.object({
  agentIdle: z.boolean().nullable(),
  inFlightTools: z.boolean().nullable(),
  filesStable: z.boolean().nullable(),
  fileFingerprint: z.string().nullable(),
  processesComplete: z.boolean(),
  jobObservations: z.array(
    z.object({
      jobId: z.string(),
      nativeStatus: z.string(),
      externalStatus: z.enum(['gone', 'running', 'unknown']),
    }),
  ),
  note: z.string(),
  observedAt: z.string().optional(),
  intervalMs: z.number().nonnegative().optional(),
  checkpoint: recoveryCheckpointSchema.optional(),
});
export type StoppedObservation = z.infer<typeof stoppedObservationSchema>;
export const controlSchema = z.object({
  id: z.uuid(),
  operationId: z.uuid(),
  executionId: z.uuid(),
  actor: authorSchema,
  action: controlBodySchema.shape.action,
  reason: z.string(),
  content: z.string(),
  stopMode: z.enum(['soft', 'hard']),
  revision: z.number().int().positive(),
  assistantTargetIds: z.array(z.uuid()).default([]),
  status: z.enum([
    'requested',
    'delivered',
    'handoff',
    'checking',
    'stopped',
    'unknown',
    'failed',
    'resumed',
    'terminated',
  ]),
  goal: receiptSchema.nullable(),
  cancel: receiptSchema.nullable(),
  jobKills: z.array(z.object({ jobId: z.string(), receipt: receiptSchema })),
  observation: stoppedObservationSchema.nullable(),
  report: z
    .object({
      content: z.string(),
      sessionId: z.uuid(),
      messageIds: z.array(z.uuid()),
      at: z.string(),
    })
    .nullable(),
  messageId: z.uuid(),
  resumeMessageId: z.uuid(),
  resumeSnapshot: z.unknown().nullable(),
  reviewedRecoveryFingerprint: z.string().nullable().default(null),
  epoch: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ControlRecord = z.infer<typeof controlSchema>;
export const ownedJobSchema = z.object({
  id: z.string(),
  executionId: z.uuid(),
  sessionId: z.uuid(),
  nativeOwner: z.string(),
  kind: z.string(),
  label: z.string(),
  startedAt: z.number(),
  registeredSeq: z.number().int().nullable(),
  settledSeq: z.number().int().nullable(),
  status: z.string(),
  producerReported: z.boolean().nullable(),
  settlement: z.unknown().nullable(),
  processWitness: z.unknown().nullable(),
  toolCallId: z.string().nullable().default(null),
  managedRanges: z
    .array(
      z.object({
        id: z.string(),
        state: z.enum(['pending', 'gone', 'unknown']),
        at: z.string(),
        note: z.string(),
      }),
    )
    .default([]),
  epoch: z.string(),
  updatedAt: z.string(),
});
export type OwnedJob = z.infer<typeof ownedJobSchema>;
export const projectRuntimeSchema = z.object({
  state: z.enum([
    'stopped',
    'starting',
    'running',
    'stopping',
    'unknown',
    'error',
    'forced-stopped',
  ]),
  managerSessionId: z.uuid().nullable(),
  epoch: z.string().nullable(),
  reason: z.string(),
  updatedAt: z.string(),
});
export type ProjectRuntime = z.infer<typeof projectRuntimeSchema>;
