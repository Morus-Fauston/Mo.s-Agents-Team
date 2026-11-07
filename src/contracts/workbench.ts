import { z } from 'zod';
export const ticketStates = [
  'todo',
  'in-progress',
  'blocked',
  'awaiting-review',
  'review-passed',
  'awaiting-acceptance',
  'completed',
  'archived',
] as const;
export const ticketStateSchema = z.enum(ticketStates);
export const verificationSchema = z.enum(['automated', 'manual', 'review']);
export const logTypeSchema = z.enum([
  'progress',
  'discovery',
  'judgment',
  'verification',
  'problem',
  'continuation',
]);
export const importanceSchema = z.enum(['normal', 'important', 'critical']);
export const operationSchema = z.object({ operationId: z.uuid() });
const text = z.string().refine((value) => value.trim().length > 0, '内容不能为空');
const title = z.string().trim().min(1).max(160);
export const conditionInputSchema = z
  .object({ condition: text, verification: verificationSchema })
  .strict();
export const phaseInputSchema = operationSchema
  .extend({
    name: title,
    goal: text,
    basis: text,
    note: z.string().default(''),
    parentId: z.uuid().optional(),
    checklist: z.array(conditionInputSchema).default([]),
  })
  .strict();
export const categoryInputSchema = operationSchema
  .extend({ code: z.string().regex(/^[A-Z]{1,16}$/), name: title })
  .strict();
export const researchQuestionFieldsSchema = z.object({
  title,
  question: z.string().trim().min(1).max(16000),
  condition: z.string().trim().min(1).max(16000),
  sources: z.array(z.string().min(1).max(4000)).max(128).optional(),
  order: z.number().int().nonnegative().optional(),
});
export const researchQuestionInputSchema = researchQuestionFieldsSchema
  .extend({ operationId: z.uuid() })
  .strict();
export const researchQuestionUpdateSchema = researchQuestionFieldsSchema
  .partial()
  .extend({ operationId: z.uuid(), expectedRevision: z.number().int().positive(), reason: text })
  .strict();
export const researchQuestionSchema = researchQuestionFieldsSchema.extend({
  id: z.string().regex(/^Q\d{2,}$/),
  revision: z.number().int().positive(),
  definitionRevision: z.number().int().positive(),
  sources: z.array(z.string()),
  order: z.number().int().nonnegative(),
});
export const researchDefinitionSchema = z.object({
  body: z.string(),
  questions: z.array(researchQuestionSchema),
});
export const researchAnswerBodySchema = z
  .object({
    expectedQuestionRevision: z.number().int().positive(),
    expectedAnswerRevision: z.number().int().nonnegative(),
    status: z.enum(['answered', 'unconfirmed', 'gap']),
    content: z.string().trim().min(1).max(48000),
    evidence: z.array(z.string().min(1).max(4000)).max(256).default([]),
    unconfirmed: z.string().max(16000).default(''),
  })
  .strict();
export const researchAnswerInputSchema = researchAnswerBodySchema
  .extend({ operationId: z.uuid() })
  .superRefine((v, ctx) => {
    if (v.status !== 'answered' && !v.unconfirmed.trim())
      ctx.addIssue({ code: 'custom', message: '未确认或缺口须说明具体边界' });
  });
export const ticketInputSchema = operationSchema
  .extend({
    planId: z.uuid().optional(),
    kind: z.enum(['development', 'research']).default('development'),
    researchBody: z.string().max(128000).default(''),
    phaseId: z.uuid(),
    categoryId: z.uuid(),
    title,
    goal: text,
    included: text,
    excluded: z.string(),
    dependencies: z.array(z.uuid()).default([]),
    conditions: z.array(conditionInputSchema).min(1),
    supplementOf: z.uuid().optional(),
  })
  .strict();
export const ticketUpdateSchema = operationSchema
  .extend({
    expectedRevision: z.number().int().positive(),
    reason: text,
    researchBody: z.string().max(128000).optional(),
    phaseId: z.uuid().optional(),
    categoryId: z.uuid().optional(),
    title: title.optional(),
    goal: text.optional(),
    included: text.optional(),
    excluded: z.string().optional(),
    dependencies: z.array(z.uuid()).optional(),
  })
  .strict();
export const logInputSchema = z
  .object({
    title,
    content: text,
    type: logTypeSchema.default('progress'),
    importance: importanceSchema.default('normal'),
    references: z.array(z.string().min(1)).default([]),
    corrects: z
      .string()
      .regex(/^L\d{3,}$/)
      .optional(),
  })
  .strict();
export const appendLogSchema = operationSchema.extend(logInputSchema.shape).strict();
export const logUpdateSchema = operationSchema
  .extend({
    reason: text,
    type: logTypeSchema.optional(),
    importance: importanceSchema.optional(),
    archived: z.boolean().optional(),
  })
  .strict();
export const checklistUpdateSchema = operationSchema
  .extend({
    updates: z
      .array(
        z
          .object({
            id: z.string().regex(/^C\d{3,}$/),
            expectedRevision: z.number().int().positive(),
            checked: z.boolean(),
            result: text,
          })
          .strict(),
      )
      .min(1),
    logId: z
      .string()
      .regex(/^L\d{3,}$/)
      .optional(),
    newLog: logInputSchema.optional(),
  })
  .strict();
export const conditionUpdateSchema = operationSchema
  .extend(conditionInputSchema.shape)
  .extend({ expectedRevision: z.number().int().positive(), reason: text })
  .strict();
export const feedbackInputSchema = operationSchema
  .extend({
    title,
    content: text,
    scenario: z.string().optional(),
    expected: z.string().optional(),
    references: z.array(z.string().min(1)).default([]),
  })
  .strict();
export const authorSchema = z.object({
  kind: z.enum(['user', 'session', 'system']),
  sessionId: z.string().nullable(),
  roleId: z.string().nullable(),
  roleCode: z.string().nullable(),
  roleType: z.string().nullable(),
  address: z.string().nullable(),
});
export const researchAnswerSchema = z.object({
  id: z.uuid(),
  questionId: z.string().regex(/^Q\d{2,}$/),
  questionRevision: z.number().int().positive(),
  revision: z.number().int().positive(),
  status: z.enum(['answered', 'unconfirmed', 'gap']),
  content: z.string(),
  evidence: z.array(z.string()),
  unconfirmed: z.string(),
  executionId: z.uuid(),
  author: authorSchema,
  createdAt: z.string(),
  previousAnswerId: z.uuid().nullable(),
});
export type ResearchQuestion = z.infer<typeof researchQuestionSchema>;
export type ResearchAnswer = z.infer<typeof researchAnswerSchema>;
export const planInputSchema = operationSchema
  .extend({
    phaseId: z.uuid(),
    goal: text,
    included: text,
    excluded: z.string(),
    content: text,
    basis: text,
  })
  .strict();
export const planSchema = z.object({
  id: z.uuid(),
  phaseId: z.uuid(),
  goal: text,
  included: text,
  excluded: z.string(),
  content: text,
  basis: text,
  author: authorSchema,
  createdAt: z.string(),
  revision: z.number().int().positive(),
  confirmation: z.object({ author: authorSchema, at: z.string(), reason: text }).nullable(),
});
export type PlanRecord = z.infer<typeof planSchema>;
export type WorkbenchActor = { kind: 'user' } | { kind: 'session'; sessionId: string };
export type RecordAuthor = z.infer<typeof authorSchema>;
export const checklistItemSchema = conditionInputSchema.extend({
  id: z.string(),
  revision: z.number(),
  checked: z.boolean(),
  result: z.string(),
  logId: z.string().nullable(),
  author: authorSchema.nullable(),
  updatedAt: z.string().nullable(),
});
export const phaseSchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  goal: z.string(),
  basis: z.string(),
  note: z.string(),
  parentId: z.string().nullable(),
  state: z.enum(['unopened', 'opened', 'closing', 'closed']),
  checklist: z.array(checklistItemSchema),
  author: authorSchema,
  createdAt: z.string(),
  revision: z.number(),
});
export const categorySchema = z.object({
  id: z.uuid(),
  code: z.string(),
  name: z.string(),
  author: authorSchema,
  createdAt: z.string(),
});
export const ticketSchema = z.object({
  planId: z.uuid().nullable().default(null),
  kind: z.enum(['development', 'research']).default('development'),
  research: researchDefinitionSchema.nullable().default(null),
  id: z.uuid(),
  code: z.string(),
  phaseId: z.uuid(),
  categoryId: z.uuid(),
  title: z.string(),
  goal: z.string(),
  included: z.string(),
  excluded: z.string(),
  dependencies: z.array(z.string()),
  supplementOf: z.string().nullable(),
  state: ticketStateSchema,
  revision: z.number(),
  checklist: z.array(checklistItemSchema),
  author: authorSchema,
  createdAt: z.string(),
  currentExecution: z.string().nullable(),
  materialRoot: z.string(),
});
export const logSchema = logInputSchema.omit({ corrects: true }).extend({
  id: z.string(),
  ticketId: z.uuid(),
  corrects: z.string().nullable(),
  archived: z.boolean(),
  archiveReason: z.string().nullable(),
  author: authorSchema,
  createdAt: z.string(),
  executionId: z.string().nullable(),
  collaborationId: z.uuid().nullable().default(null),
});
export const feedbackSchema = feedbackInputSchema.omit({ operationId: true }).extend({
  id: z.string(),
  author: authorSchema,
  createdAt: z.string(),
  executionId: z.string().nullable(),
  background: z.object({
    configuration: z.record(z.string(), z.unknown()).nullable(),
    requestId: z.string().nullable(),
    nativeSessionId: z.string().nullable(),
  }),
});
export const historyEntrySchema = z.object({
  id: z.string(),
  kind: z.string(),
  objectId: z.string(),
  actor: authorSchema,
  at: z.string(),
  reason: z.string(),
  references: z.array(z.string()),
  corrects: z.string().nullable(),
});
export const supervisorTaskSchema = z.object({
  id: z.uuid(),
  level: z.enum(['long', 'short']),
  title: z.string(),
  parentId: z.string().nullable(),
  state: z.enum(['unchecked', 'held', 'checked']),
  basis: z.string(),
  ticketIds: z.array(z.string()),
  author: authorSchema,
  createdAt: z.string(),
  revision: z.number(),
  business: z
    .object({ kind: z.enum(['local-commit', 'worktree-merge']), id: z.uuid() })
    .nullable()
    .optional(),
});
export type PhaseRecord = z.infer<typeof phaseSchema>;
export type TicketRecord = z.infer<typeof ticketSchema>;
export type LogRecord = z.infer<typeof logSchema>;
export type ChecklistItem = z.infer<typeof checklistItemSchema>;
export type HistoryEntry = z.infer<typeof historyEntrySchema>;
export type SupervisorTask = z.infer<typeof supervisorTaskSchema>;
export const materialDomainSchema = z.object({
  id: z.uuid(),
  ticketId: z.uuid(),
  sessionId: z.uuid(),
  roleId: z.string(),
  roleCode: z.string(),
  address: z.string(),
  kind: z.enum(['main', 'assistant', 'review']),
  referenceId: z.string(),
  relativePath: z.string(),
  path: z.string(),
  available: z.boolean(),
  error: z.string().nullable(),
});
export type MaterialDomain = z.infer<typeof materialDomainSchema>;
