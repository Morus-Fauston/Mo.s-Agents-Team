import { z } from 'zod';
import { authorSchema } from './workbench.ts';
import { deliverySchema } from './chat.ts';
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
export const localGitFileSchema = z.object({
  path: z.string(),
  workingSha256: z.string().nullable(),
  blob: oid.nullable(),
  mode: z.enum(['100644', '100755']).nullable(),
});
export const localGitPlanSchema = z.object({
  repository: z.string(),
  gitDir: z.string(),
  commonDir: z.string(),
  head: oid.nullable(),
  branch: z.string().nullable(),
  kind: z.enum(['baseline', 'commit']),
  files: z.array(localGitFileSchema),
  fingerprint: z.string(),
  capturedAt: z.string(),
  worktreeChanges: z
    .array(
      z.object({
        path: z.string(),
        x: z.string(),
        y: z.string(),
        originalPath: z.string().optional(),
      }),
    )
    .default([]),
});
export const localGitProofSchema = z.object({
  state: z.enum(['not-observed', 'verified', 'mismatch']),
  commit: oid.nullable(),
  parents: z.array(oid),
  paths: z.array(z.string()),
  currentHead: oid.nullable(),
  indexPaths: z.array(z.string()),
  message: z.string().nullable(),
  reason: z.string(),
  observedAt: z.string(),
  tree: oid.nullable().optional(),
});
export type LocalGitPlan = z.infer<typeof localGitPlanSchema>;
export type LocalGitProof = z.infer<typeof localGitProofSchema>;
export const localCommitQuiescenceSchema = z.object({
  state: z.enum(['confirmed', 'unknown']),
  note: z.string(),
  observedAt: z.string(),
});
export type LocalCommitQuiescence = z.infer<typeof localCommitQuiescenceSchema>;
export const localCommitNativeSchema = z.object({
  nativeSessionId: z.string(),
  epoch: z.string(),
  boundary: z.number().int(),
  ranges: z.array(
    z.object({
      id: z.string(),
      callId: z.string(),
      nativeOwner: z.string(),
      state: z.enum(['pending', 'gone', 'unknown']),
      at: z.string(),
      note: z.string(),
    }),
  ),
});
const relativeFile = z.string().min(1).max(4000);
export const localCommitArrangeSchema = z
  .object({
    operationId: z.uuid(),
    sessionId: z.uuid(),
    repository: z.string().min(1),
    kind: z.enum(['baseline', 'commit']),
    files: z.array(relativeFile).min(1).max(512),
    expectedFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    basis: z.string().trim().min(1).max(16000),
    commitMessage: z.string().trim().min(1).max(4000),
    ticketIds: z.array(z.uuid()).max(64).default([]),
    versionIds: z.array(z.uuid()).max(64).default([]),
    mergeId: z.uuid().optional(),
  })
  .strict();
export const localCommitInspectSchema = z
  .object({ operationId: z.uuid(), expectedRevision: z.number().int().positive() })
  .strict();
export const localCommitReportSchema = localCommitInspectSchema
  .extend({
    state: z.enum(['committed', 'blocked', 'unknown']),
    content: z.string().trim().min(1).max(16000),
    commit: oid.optional(),
  })
  .strict();
export const localCommitReconcileSchema = localCommitInspectSchema
  .extend({ reason: z.string().trim().min(1).max(4000) })
  .strict();
export const localCommitNoticeSchema = z.object({
  id: z.uuid(),
  kind: z.enum(['arrangement', 'result']),
  targetSessionId: z.uuid(),
  revision: z.number().int().positive(),
  state: z.enum(['pending', 'confirmed', 'unknown']),
  receipt: deliverySchema.nullable(),
  error: z.string().nullable(),
});
export const localCommitSchema = z.object({
  id: z.uuid(),
  operationId: z.uuid(),
  author: authorSchema,
  managerSessionId: z.uuid(),
  committerSessionId: z.uuid(),
  committerRoleId: z.string(),
  kind: z.enum(['baseline', 'commit']),
  basis: z.string(),
  commitMessage: z.string(),
  ticketIds: z.array(z.uuid()),
  versionIds: z.array(z.uuid()),
  mergeId: z.uuid().nullable().default(null),
  taskId: z.uuid(),
  materialPath: z.string(),
  plan: localGitPlanSchema,
  native: localCommitNativeSchema.nullable().default(null),
  status: z.enum(['arranged', 'ready', 'blocked', 'unknown', 'completed', 'cancelled']),
  revision: z.number().int().positive(),
  lastInspection: z
    .object({
      ready: z.boolean(),
      fingerprint: z.string().nullable(),
      note: z.string(),
      observedAt: z.string(),
    })
    .nullable(),
  lastProof: localGitProofSchema.nullable(),
  lastQuiescence: localCommitQuiescenceSchema.nullable().default(null),
  report: z
    .object({ author: authorSchema, state: z.string(), content: z.string(), at: z.string() })
    .nullable(),
  notices: z.array(localCommitNoticeSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LocalCommitRecord = z.infer<typeof localCommitSchema>;
