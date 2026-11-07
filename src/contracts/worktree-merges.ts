import { z } from 'zod';
import { authorSchema } from './workbench.ts';
import { worktreeSourceSchema } from './worktrees.ts';
import { workspaceSnapshotSchema } from './versions.ts';
import {
  localCommitNativeSchema,
  localCommitQuiescenceSchema,
  localCommitNoticeSchema,
} from './local-commits.ts';
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const gitMergePlanSchema = z.object({
  target: worktreeSourceSchema,
  source: worktreeSourceSchema,
  sourceCommit: oid,
  baseCommit: oid,
  mode: z.enum(['already-contained', 'fast-forward', 'merge']),
  mergeTree: oid,
  conflictPaths: z.array(z.string()),
  changedPaths: z.array(z.string()),
  objectDirectory: z.string(),
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  capturedAt: z.string(),
});
export const gitMergeProofSchema = z.object({
  state: z.enum(['not-observed', 'verified', 'conflict', 'mismatch']),
  resultHead: oid,
  currentHead: oid,
  resultTree: oid,
  parents: z.array(oid),
  mergeHeads: z.array(oid),
  conflictPaths: z.array(z.string()),
  indexPaths: z.array(z.string()),
  indexFingerprint: z.string(),
  receiptIds: z.array(z.uuid()).optional(),
  containsSource: z.boolean(),
  reason: z.string(),
  observedAt: z.string(),
});
export type GitMergePlan = z.infer<typeof gitMergePlanSchema>;
export type GitMergeProof = z.infer<typeof gitMergeProofSchema>;
export const mergePreviewInputSchema = z
  .object({
    targetRepository: z.string().min(1),
    sourceWorktreeId: z.uuid(),
    sourceVersionId: z.uuid(),
    sourceResultId: z.uuid(),
    sourceCommit: oid,
  })
  .strict();
export const mergeArrangeInputSchema = mergePreviewInputSchema
  .extend({
    operationId: z.uuid(),
    sessionId: z.uuid(),
    expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    combinationTicketId: z.uuid(),
    basis: z.string().trim().min(1).max(16000),
  })
  .strict();
export const mergeInspectInputSchema = z
  .object({ operationId: z.uuid(), expectedRevision: z.number().int().positive() })
  .strict();
export const mergeReportInputSchema = mergeInspectInputSchema
  .extend({
    state: z.enum(['merged', 'conflict', 'blocked', 'unknown']),
    content: z.string().trim().min(1).max(16000),
  })
  .strict();
export const mergeReconcileInputSchema = mergeInspectInputSchema
  .extend({ reason: z.string().trim().min(1).max(8000) })
  .strict();
export const mergeRepairInputSchema = mergeInspectInputSchema
  .extend({
    ticketId: z.uuid(),
    writeScopes: z.array(z.string().min(1)).min(1).max(64),
    basis: z.string().trim().min(1).max(16000),
  })
  .strict();
export const mergeReviewLinkInputSchema = mergeInspectInputSchema
  .extend({ versionId: z.uuid(), resultId: z.uuid(), basis: z.string().trim().min(1).max(16000) })
  .strict();
export const mergeSourceEvidenceSchema = z.object({
  ticketId: z.uuid(),
  executionId: z.uuid(),
  versionId: z.uuid(),
  resultId: z.uuid(),
  versionFingerprint: z.string(),
  rootIndex: z.number().int().nonnegative(),
  receiptId: z.uuid().nullable(),
  receiptIds: z.array(z.uuid()).default([]),
  rawFingerprint: z.string(),
});
export const mergePreviewSchema = z.object({
  plan: gitMergePlanSchema,
  sourceWorktreeId: z.uuid(),
  source: mergeSourceEvidenceSchema,
  fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});
const reviewed = z.object({
  executionId: z.uuid(),
  versionId: z.uuid(),
  resultId: z.uuid(),
  head: oid,
  tree: oid,
  rawFingerprint: z.string(),
  author: authorSchema,
  at: z.string(),
});
export const worktreeMergeSchema = z.object({
  id: z.uuid(),
  operationId: z.uuid(),
  author: authorSchema,
  managerSessionId: z.uuid(),
  committerSessionId: z.uuid(),
  committerRoleId: z.string(),
  basis: z.string(),
  taskId: z.uuid(),
  materialPath: z.string(),
  preview: mergePreviewSchema,
  combinationTicketId: z.uuid(),
  status: z.enum([
    'arranged',
    'ready',
    'unknown',
    'conflict',
    'repairing',
    'awaiting-verification',
    'completed',
    'blocked',
    'cancelled',
  ]),
  revision: z.number().int().positive(),
  native: localCommitNativeSchema,
  lastInspection: z
    .object({
      ready: z.boolean(),
      mode: z.enum(['merge', 'continue-stage', 'continue-commit', 'already-contained']),
      fingerprint: z.string().nullable(),
      note: z.string(),
      observedAt: z.string(),
    })
    .nullable(),
  lastProof: gitMergeProofSchema.nullable(),
  integrated: z
    .object({ head: oid, tree: oid, parents: z.array(oid), observedAt: z.string() })
    .nullable()
    .default(null),
  correctionReceiptIds: z.array(z.uuid()).default([]),
  combinationAttempts: z
    .array(
      z.object({
        versionId: z.uuid(),
        resultId: z.uuid(),
        executionId: z.uuid(),
        state: z.enum(['passed', 'needs-correction', 'returned']),
        basis: z.string(),
        reason: z.string(),
        issues: z.array(z.string()),
        author: authorSchema,
        at: z.string(),
      }),
    )
    .default([]),
  conflictSnapshot: workspaceSnapshotSchema.nullable().default(null),
  lastQuiescence: localCommitQuiescenceSchema.nullable(),
  report: z
    .object({ author: authorSchema, state: z.string(), content: z.string(), at: z.string() })
    .nullable(),
  repair: z
    .object({
      operationId: z.uuid(),
      ticketId: z.uuid(),
      author: authorSchema,
      basis: z.string(),
      writeScopes: z.array(z.string()),
      executionId: z.uuid().nullable(),
      version: reviewed.nullable(),
      expectedTree: oid.nullable(),
      paths: z.array(z.string()),
      indexFingerprint: z.string(),
      stagedIndexFingerprint: z.string().nullable().default(null),
      at: z.string(),
    })
    .nullable(),
  combination: reviewed.nullable(),
  notices: z.array(localCommitNoticeSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type MergePreview = z.infer<typeof mergePreviewSchema>;
export type WorktreeMergeRecord = z.infer<typeof worktreeMergeSchema>;
