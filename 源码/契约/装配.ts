import type { ContextSource } from '../业务/上下文.ts';
export interface RequestRecord {
  executionId?: string | null;
  executionContextVersion?: string | null;
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
