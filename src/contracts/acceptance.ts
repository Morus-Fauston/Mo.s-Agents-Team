import { z } from 'zod';
import { authorSchema } from './workbench.ts';
import { dispatchBodySchema } from './execution.ts';
export const supplementInputSchema = z
  .object({
    operationId: z.uuid(),
    ticketId: z.uuid(),
    versionId: z.uuid(),
    resultId: z.uuid(),
    reason: z.string().trim().min(1).max(16000),
    dispatch: dispatchBodySchema.omit({
      ticket: true,
      sessionId: true,
      reuseClosedExecutionId: true,
    }),
  })
  .strict();
export const escalationInputSchema = z
  .object({
    operationId: z.uuid(),
    resultId: z.uuid(),
    kind: z.enum(['dispute', 'scope', 'no-path']),
    basis: z.string().trim().min(1).max(16000),
    evidencePaths: z.array(z.string().min(1)).max(100).default([]),
  })
  .strict();
export const supplementSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  previousExecutionId: z.uuid(),
  executionId: z.uuid(),
  versionId: z.uuid(),
  resultId: z.uuid(),
  reason: z.string(),
  author: authorSchema,
  createdAt: z.string(),
});
export const escalationSchema = z.object({
  id: z.uuid(),
  resultId: z.uuid(),
  executionId: z.uuid(),
  ticketId: z.uuid(),
  versionId: z.uuid(),
  kind: z.enum(['dispute', 'scope', 'no-path']),
  basis: z.string(),
  evidencePaths: z.array(z.string()),
  author: authorSchema,
  taskId: z.uuid(),
  createdAt: z.string(),
});
export const acceptanceNoticeSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  referenceId: z.uuid(),
  targetSessionId: z.uuid(),
  content: z.string(),
  state: z.enum(['pending', 'saved', 'unavailable']),
  error: z.string().nullable(),
});
export const acceptanceOwnerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user') }).strict(),
  z.object({ kind: z.literal('session'), sessionId: z.uuid() }).strict(),
]);
export const acceptanceAssignmentInputSchema = z
  .object({
    operationId: z.uuid(),
    ticketId: z.uuid(),
    versionId: z.uuid(),
    resultId: z.uuid(),
    conditionId: z.string().optional(),
    criterion: z.string().trim().min(1).max(16000).optional(),
    owner: acceptanceOwnerSchema,
    required: z.boolean().default(true),
    reason: z.string().trim().min(1).max(16000),
  })
  .strict();
export const acceptanceRecordInputSchema = z
  .object({
    operationId: z.uuid(),
    assignmentId: z.uuid(),
    decision: z.enum(['accept', 'return']),
    basis: z.string().trim().min(1).max(32000),
    evidencePaths: z.array(z.string().trim().min(1).max(4000)).max(100).default([]),
    checkCondition: z.boolean().default(true),
  })
  .strict();
export const ticketAcceptanceInputSchema = z
  .object({
    operationId: z.uuid(),
    ticketId: z.uuid(),
    versionId: z.uuid(),
    resultId: z.uuid(),
    basis: z.string().trim().min(1).max(32000),
  })
  .strict();
export const acceptanceAssignmentSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  executionId: z.uuid(),
  versionId: z.uuid(),
  resultId: z.uuid(),
  conditionId: z.string().nullable(),
  conditionRevision: z.number().nullable(),
  criterion: z.string(),
  owner: acceptanceOwnerSchema,
  required: z.boolean(),
  active: z.boolean(),
  requirementsHash: z.string(),
  reason: z.string(),
  requester: authorSchema,
  createdAt: z.string(),
});
export const acceptanceRecordSchema = z.object({
  id: z.uuid(),
  assignmentId: z.uuid(),
  ticketId: z.uuid(),
  versionId: z.uuid(),
  decision: z.enum(['accept', 'return']),
  basis: z.string(),
  evidencePaths: z.array(z.string()),
  checkCondition: z.boolean(),
  logId: z.string().nullable(),
  author: authorSchema,
  sourceRequestId: z.string().nullable(),
  createdAt: z.string(),
});
export const ticketAcceptanceSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  executionId: z.uuid(),
  versionId: z.uuid(),
  resultId: z.uuid(),
  basis: z.string(),
  assignmentResultIds: z.array(z.uuid()),
  checklistLogs: z.array(z.string()),
  author: authorSchema,
  createdAt: z.string(),
});
export type AcceptanceAssignment = z.infer<typeof acceptanceAssignmentSchema>;
export type AcceptanceRecord = z.infer<typeof acceptanceRecordSchema>;
export type TicketAcceptance = z.infer<typeof ticketAcceptanceSchema>;
