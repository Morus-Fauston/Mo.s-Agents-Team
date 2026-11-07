import type { ContextSource } from '../services/context.ts';
export interface RequestRecord {
  collaborationId?: string;
  reviewResultId?: string | null;
  executionId?: string | null;
  executionContextVersion?: string | null;
  reviewId?: string | null;
  reviewVersionId?: string | null;
  reviewContextVersion?: string | null;
  id: string;
  sessionId: string;
  nativeAttemptId: string;
  turn: number;
  step: number;
  contextVersion: string;
  sources: ContextSource[];
  skillManifestVersion: string;
  skillCatalogVersion: string;
  loadedSkills: { name: string; path: string; sha256: string }[];
  requestConfiguration: Record<string, unknown>;
  tools: string[];
  reportedModel: string | null;
  usage: Record<string, number> | null;
  status: 'started' | 'completed' | 'failed' | 'interrupted';
  error: string | null;
  startedAt: string;
}
