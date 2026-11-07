import type { ProjectService } from './project-service.ts';
import type { SessionInput, SessionRecord } from '../contracts/sessions.ts';
import type { AssistantRecord } from '../contracts/collaboration.ts';
import { ProjectError } from './errors.ts';
import { canonicalDirectory } from './write-scopes.ts';
import { relative } from 'node:path';
export interface AssistantHost {
  failed?(project: string, assistant: AssistantRecord): void;
  create(
    project: string,
    input: SessionInput,
    reserved: (session: SessionRecord) => void,
  ): Promise<SessionRecord>;
  reuse(
    project: string,
    session: string,
    claim: (prepared: SessionRecord) => void,
  ): Promise<SessionRecord>;
}
export class AssistantService {
  private readonly runs = new Map<string, Promise<AssistantRecord>>();
  private readonly projects: ProjectService;
  private readonly host: AssistantHost;
  constructor(projects: ProjectService, host: AssistantHost) {
    this.projects = projects;
    this.host = host;
  }
  async create(project: string, session: string, raw: unknown): Promise<AssistantRecord> {
    const connection = this.projects.forProject(project),
      catalog = connection.collaborations();
    const { record, isNew } = catalog.register(session, raw);
    const pending = this.runs.get(record.id);
    if (pending) return pending;
    if (!isNew) return record;
    const running = (async () => {
      try {
        const prepared = record.reused
          ? await this.host.reuse(project, record.requestedSessionId!, (prepared) => {
              if (relative(canonicalDirectory(record.cwd), canonicalDirectory(prepared.cwd)) !== '')
                throw new ProjectError(
                  'ASSISTANT_CWD_MISMATCH',
                  '原生工作目录与主票不同，未接管会话',
                );
              catalog.reserved(record.id, prepared.id);
            })
          : await this.host.create(
              project,
              {
                roleId: record.roleId,
                name: record.name,
                purpose: record.purpose,
                cwd: record.cwd,
                ...(record.configuration ? { configuration: record.configuration } : {}),
              },
              (prepared) => {
                catalog.requireMain(session);
                catalog.reserved(record.id, prepared.id);
              },
            );
        catalog.requireMain(session);
        if (relative(canonicalDirectory(record.cwd), canonicalDirectory(prepared.cwd)) !== '')
          throw new ProjectError(
            'ASSISTANT_CWD_MISMATCH',
            '续用会话工作目录与主票不符，不静默换目录',
          );
        const saved = catalog.active(record.id);
        connection.workbench().allocateCurrentMaterial(prepared.id);
        return saved;
      } catch (error) {
        const message = error instanceof Error ? error.message : '辅助准备失败，核对原会话';
        const failed = catalog.problem(
          record.id,
          message,
          catalog.get(record.id).sessionId !== null,
        );
        this.host.failed?.(project, failed);
        return failed;
      }
    })();
    this.runs.set(record.id, running);
    try {
      return await running;
    } finally {
      this.runs.delete(record.id);
    }
  }
  async close(): Promise<void> {
    await Promise.allSettled(this.runs.values());
  }
}
