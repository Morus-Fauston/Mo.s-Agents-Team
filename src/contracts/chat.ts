import { z } from 'zod';
export const fileReferenceSchema = z
  .object({
    kind: z.literal('file'),
    path: z.string().min(1),
    startLine: z.number().int().positive().optional(),
    endLine: z.number().int().positive().optional(),
    snippet: z.string().optional(),
  })
  .strict();
export const chatInputSchema = z
  .object({
    id: z.uuid().transform((id) => id.toLowerCase()),
    target: z.string().min(1),
    content: z.string().refine((value) => value.trim().length > 0, '消息正文不能为空'),
    replyTo: z.uuid().optional(),
    references: z.array(fileReferenceSchema).default([]),
  })
  .strict();
export type ChatInput = z.input<typeof chatInputSchema>;
export type ChatActor = { kind: 'user' } | { kind: 'session'; sessionId: string };
const participantSchema = z.object({
  kind: z.enum(['user', 'session', 'system']),
  sessionId: z.string().nullable(),
  roleId: z.string().nullable(),
  roleCode: z.string().nullable(),
});
export const chatMessageSchema = z.object({
  id: z.uuid(),
  projectId: z.string(),
  conversationId: z.uuid(),
  ordinal: z.number().int().positive(),
  sender: participantSchema,
  recipient: participantSchema,
  content: z.string(),
  replyTo: z.string().nullable(),
  references: z.array(fileReferenceSchema),
  savedAt: z.string(),
});
export const conversationSchema = z.object({
  id: z.uuid(),
  participants: z.tuple([z.string(), z.string()]),
  openedByUser: z.boolean(),
});
export const deliverySchema = z.object({
  messageId: z.uuid(),
  targetSessionId: z.string().nullable(),
  transport: z.enum(['mat-steer', 'native-user', 'ui-only']),
  nativeMessageId: z.string().nullable(),
  state: z.enum(['pending', 'held', 'sending', 'accepted', 'failed', 'unknown', 'none']),
  memoryAcceptedAt: z.string().nullable(),
  durableAcceptedAt: z.string().nullable(),
  enteredAt: z.string().nullable(),
  nativeAttemptId: z.string().nullable(),
  modelRequestId: z.uuid().nullable().default(null),
  handledRecord: z.string().nullable(),
  error: z.string().nullable(),
});
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatConversation = z.infer<typeof conversationSchema>;
export type DeliveryRecord = z.infer<typeof deliverySchema>;
export interface SavedMessage {
  message: ChatMessage;
  receipt: DeliveryRecord;
}
export const savedMessageSchema = z.object({ message: chatMessageSchema, receipt: deliverySchema });
