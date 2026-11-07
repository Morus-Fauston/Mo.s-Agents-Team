import { z } from 'zod';
import { actionProgressSchema, reviewSchema } from './completion.ts';
import { authorSchema } from './workbench.ts';

export const fixedMaterialReferenceSchema = z.object({
  absolute: z.string(),
  rootIndex: z.number().int().nonnegative().nullable(),
  path: z.string().nullable(),
  available: z.boolean(),
});
export const ticketDeliverySchema = z.object({
  ticketId: z.uuid(),
  executionId: z.uuid(),
  completionId: z.uuid(),
  versionId: z.uuid(),
  reviewId: z.uuid(),
  sourceSessionId: z.uuid(),
  sequence: z.number().int().nonnegative(),
  summary: z.string(),
  scope: z.string(),
  createdAt: z.string(),
  author: authorSchema,
  reviewStatus: reviewSchema.shape.status,
  reviewSessionId: z.uuid().nullable(),
  reports: z.array(fixedMaterialReferenceSchema),
  evidence: z.array(fixedMaterialReferenceSchema),
  checklistItemIds: z.array(z.string()),
  result: z
    .object({
      id: z.uuid(),
      previousResultId: z.uuid().nullable(),
      verdict: z.enum(['pass', 'return']),
      progress: actionProgressSchema,
      authorAction: actionProgressSchema,
      author: authorSchema,
    })
    .nullable(),
});
export type TicketDelivery = z.infer<typeof ticketDeliverySchema>;
export const ticketDeliveriesSchema = z.object({
  currentDelivery: ticketDeliverySchema.nullable(),
  deliveries: z.array(ticketDeliverySchema),
});
export const materialReferenceSchema = z.object({
  reference: z.string(),
  path: z.string().nullable(),
});
export const historyTargetSchema = z.object({
  kind: z.enum([
    'ticket',
    'log',
    'delivery',
    'decision',
    'phase',
    'acceptance',
    'history',
    'unavailable',
  ]),
  reference: z.string(),
  ticketId: z.uuid().nullable(),
  recordId: z.string(),
  label: z.string(),
});
