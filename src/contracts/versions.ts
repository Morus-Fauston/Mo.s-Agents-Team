import { z } from 'zod';
import { authorSchema, ticketSchema, researchAnswerSchema } from './workbench.ts';
export const snapshotFileSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
  mode: z.enum(['100644', '100755']),
  objectId: z.string().nullable(),
});
export const snapshotRootSchema = z.object({
  root: z.string(),
  kind: z.enum(['git', 'files']),
  commonDir: z.string().nullable().default(null),
  head: z.string().nullable(),
  tree: z.string().nullable(),
  ref: z.string().nullable(),
  indexState: z
    .object({
      head: z.string(),
      mergeHeads: z.array(z.string()),
      indexFingerprint: z.string(),
    })
    .optional(),
  files: z.array(snapshotFileSchema),
});
export const workspaceSnapshotSchema = z.object({
  id: z.uuid(),
  createdAt: z.string(),
  fingerprint: z.string(),
  roots: z.array(snapshotRootSchema),
  excluded: z.array(z.string()),
});
export type SnapshotFile = z.infer<typeof snapshotFileSchema>;
export type SnapshotRoot = z.infer<typeof snapshotRootSchema>;
export type WorkspaceSnapshot = z.infer<typeof workspaceSnapshotSchema>;
export interface SnapshotInput {
  cwd: string;
  storage: string;
  additionalRepositories?: string[];
  materialRoots?: string[];
  excluded?: string[];
  maxFiles?: number;
  maxBytes?: number;
  /** Internal capability supplied from an explicitly linked merge-repair execution. */
  mergeRepair?:
    | {
        repository: string;
        expectedHead: string;
        expectedMergeHeads: string[];
        expectedIndexFingerprint: string;
      }
    | undefined;
}
export interface WorkspaceDiff {
  changes: {
    root: string;
    path: string;
    status: 'added' | 'deleted' | 'modified';
    before: string | null;
    after: string | null;
  }[];
  patch: string;
}
export const deliveryVersionInputSchema = z
  .object({
    operationId: z.uuid(),
    summary: z.string().trim().min(1).max(32768),
    scope: z.string().trim().min(1).max(32768),
    evidencePaths: z.array(z.string().min(1)).max(1000).default([]),
    checklistItemIds: z.array(z.string().min(1)).max(1000).default([]),
    reportPaths: z.array(z.string().min(1)).max(128).default([]),
  })
  .strict();
export const deliveryVersionSchema = z.object({
  id: z.uuid(),
  operationId: z.uuid(),
  executionId: z.uuid(),
  kind: z.enum(['baseline', 'delivery']),
  worktreeId: z.uuid().nullable().default(null),
  sequence: z.number().int().nonnegative(),
  actor: authorSchema,
  ticket: ticketSchema,
  summary: z.string(),
  scope: z.string(),
  evidencePaths: z.array(z.string()),
  checklistItemIds: z.array(z.string().min(1)),
  reportPaths: z.array(z.string()).default([]),
  researchAnswers: z.array(researchAnswerSchema).default([]),
  snapshot: workspaceSnapshotSchema,
  createdAt: z.string(),
});
export type DeliveryVersion = z.infer<typeof deliveryVersionSchema>;
export const versionHeaderSchema = deliveryVersionSchema
  .pick({
    id: true,
    executionId: true,
    kind: true,
    worktreeId: true,
    sequence: true,
    summary: true,
    scope: true,
    createdAt: true,
  })
  .extend({
    fingerprint: z.string(),
    ticketKind: z.enum(['development', 'research']).default('development'),
    roots: z.array(
      snapshotRootSchema
        .omit({ files: true })
        .extend({ fileCount: z.number().int().nonnegative() }),
    ),
  });
