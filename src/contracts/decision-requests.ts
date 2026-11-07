import { z } from 'zod';
import { authorSchema } from './workbench.ts';
const text = z.string().trim().min(1).max(16000);
export const decisionReasonSchema = z.enum([
  'clarification',
  'scope-change',
  'resource-conflict',
  'no-viable-path',
  'parent-unavailable',
  'human-decision',
]);
export const decisionCreateSchema = z
  .object({
    operationId: z.uuid(),
    subject: z.string().trim().min(1).max(300),
    question: text,
    impact: text,
    reason: decisionReasonSchema,
    references: z.array(z.string().min(1)).max(64).default([]),
    requestedWriteScopes: z.array(z.string().min(1)).min(1).max(128).optional(),
  })
  .strict();
export const decisionReplySchema = z
  .object({
    operationId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    choice: z.enum(['answer', 'accept', 'reject', 'need-info']),
    answer: text,
    restrictions: z.string().max(16000).default(''),
  })
  .strict();
export const decisionEscalateSchema = z
  .object({
    operationId: z.uuid(),
    expectedRevision: z.number().int().positive(),
    reason: decisionReasonSchema,
    basis: text,
  })
  .strict();
export const decisionWithdrawSchema = z
  .object({ operationId: z.uuid(), expectedRevision: z.number().int().positive(), basis: text })
  .strict();
export const decisionSupplementSchema = decisionWithdrawSchema
  .extend({
    question: text,
    impact: text,
    references: z.array(z.string().min(1)).max(64).default([]),
  })
  .strict();
export const decisionResponsibilitySchema = z.object({
  kind: z.enum(['user', 'session']),
  sessionId: z.uuid().nullable(),
});
export const decisionAnswerSchema = decisionReplySchema
  .omit({ operationId: true, expectedRevision: true })
  .extend({ author: authorSchema, requestRevision: z.number().int().positive(), at: z.string() });
export const decisionRequestSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  executionId: z.uuid(),
  collaborationId: z.uuid().nullable(),
  requester: authorSchema,
  managerSessionId: z.uuid(),
  parentSessionId: z.uuid(),
  assignee: decisionResponsibilitySchema,
  subject: z.string(),
  question: z.string(),
  impact: z.string(),
  reason: decisionReasonSchema,
  references: z.array(z.string()),
  scopeProposal: z
    .object({
      writeScopes: z.array(z.string()),
      scopeRevision: z.number().int().nonnegative(),
      cwd: z.string(),
    })
    .nullable()
    .default(null),
  revision: z.number().int().positive(),
  state: z.enum(['pending', 'needs-info', 'answered', 'rejected', 'withdrawn']),
  handled: z.boolean(),
  reply: decisionAnswerSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  history: z.array(
    z.object({
      revision: z.number().int().positive(),
      action: z.enum(['create', 'reply', 'escalate', 'supplement', 'withdraw']),
      actor: authorSchema,
      at: z.string(),
      data: z.record(z.string(), z.unknown()),
    }),
  ),
});
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;
export type DecisionResponsibility = z.infer<typeof decisionResponsibilitySchema>;
export const decisionNoticeSchema = z.object({
  id: z.uuid(),
  requestId: z.uuid(),
  revision: z.number().int().positive(),
  target: decisionResponsibilitySchema,
  kind: z.enum(['request', 'reply', 'withdrawal']),
  content: z.string(),
  delivery: z.enum(['pending', 'held', 'durable', 'ui-only', 'failed']).default('pending'),
  deliveryNote: z.string().nullable().default(null),
});
export type DecisionNotice = z.infer<typeof decisionNoticeSchema>;
