import type { ExecutionConfiguration } from '../contracts/project.ts';
import type { NativeGoalView } from '../contracts/execution.ts';
export interface NativeMessage {
  id: string;
  role: string;
  content: { type: string; text?: string }[];
  source: Record<string, unknown>;
}
export interface NativeEvent {
  type: string;
  seq: number;
  data: Record<string, unknown>;
  surfaceOp?: unknown;
}
export interface NativeJobView {
  id: string;
  owner?: string;
  kind: string;
  label: string;
  status: string;
  startedAt: number;
  finishedAt?: number;
  detail?: string;
}
export interface NativeAgent {
  id: string;
  ctx: NativeContext;
  status: string;
  model: {
    current(): ExecutionConfiguration | undefined;
    select(configuration: ExecutionConfiguration): unknown;
  };
  cancel(cause: { kind: 'user' }, options?: { keepInbox?: boolean }): unknown;
  steer(message: NativeMessage): void;
  inject(message: NativeMessage): void;
  whenIdle(): Promise<void>;
  session: {
    deriveMessages(): NativeMessage[];
    requestHeader(): { config: Record<string, unknown>; tools?: { name: string }[] } | undefined;
    eventAt(seq: number): NativeEvent | undefined;
    snapshotEvents(): NativeEvent[];
  };
  inbox: { nextStep: NativeMessage[]; remove(id: string): unknown };
}
export interface ToolDefinition {
  name: string;
  execute(args: unknown, exec: { agent?: NativeAgent; signal: AbortSignal }): Promise<unknown>;
}
export interface StepInput {
  agent: NativeAgent;
  messages: NativeMessage[];
  signal: AbortSignal;
  turn: number;
  step: number;
}
export type StepDecision =
  { kind: 'enter'; messages: NativeMessage[] } | { kind: 'reject'; reason?: unknown };
export interface NativeContext {
  subprocess?: { spawn(spec: unknown): unknown };
  effect(
    callback: () => void | (() => void | Promise<void>) | Promise<() => void | Promise<void>>,
  ): unknown;
  on(
    event: 'agent/pre-step',
    callback: (input: StepInput, next: () => Promise<StepDecision>) => Promise<StepDecision>,
    options?: { prepend: boolean },
  ): () => void;
  on(
    event: 'agent/assistant-stream',
    callback: (input: {
      agent: NativeAgent;
      frame: {
        type: string;
        attemptId: string;
        turn: number;
        step: number;
        outcome?: { kind: string; seq?: number };
      };
    }) => void,
  ): () => void;
  on(
    event: 'session/event',
    callback: (session: { id: string }, event: NativeEvent) => void,
  ): () => void;
  on(
    event: 'agent/error',
    callback: (input: { agent: NativeAgent; turn?: number; step?: number; error: unknown }) => void,
  ): () => void;
  on(
    event: 'goal/changed' | 'goal/activation-changed',
    callback: (input: { agent: NativeAgent; change?: unknown }) => void,
  ): () => void;
  logger?: {
    info(message: string): void;
    warn(message: string): void;
    error?(message: string): void;
  };
  fiber: { entry: { parent: { tree: { import(name: string): Promise<unknown> } } } };
  tools: {
    register(definition: ToolDefinition): () => void;
    restrict(filter: { allow: string[] }): () => void;
    definitions(scope?: NativeAgent): ToolDefinition[];
  };
  workingDirectory: {
    get(session: NativeAgent['session']): string;
    set(agent: NativeAgent, cwd: string, signal?: AbortSignal): Promise<string>;
    ensure(agent: NativeAgent, signal?: AbortSignal): Promise<string>;
  };
  goals?: {
    get(agent: NativeAgent): NativeGoalView | undefined;
    disarm(agent: NativeAgent): NativeGoalView | undefined;
    edit(
      agent: NativeAgent,
      ref: { id: string; revision: number },
      input: { objective?: string; maxGoalRounds?: number },
    ): NativeGoalView;
    create(
      agent: NativeAgent,
      input: { objective: string; maxGoalRounds?: number },
    ): NativeGoalView;
    pause(agent: NativeAgent, ref: { id: string; revision: number }): NativeGoalView;
    resume(agent: NativeAgent, ref: { id: string; revision: number }): NativeGoalView;
    clear(agent: NativeAgent, ref: { id: string; revision: number }): unknown;
  };
  jobs?: {
    list(caller?: string): NativeJobView[];
    get(id: string, caller?: string): NativeJobView;
    kill(id: string, caller?: string, reason?: string): NativeJobView;
    wait(
      id: string,
      timeoutMs: number,
      caller?: string,
      signal?: AbortSignal,
    ): Promise<NativeJobView>;
  };
  sessions: { flush(session: NativeAgent['session']): Promise<boolean> };
  agentPresets?: {
    register(definition: {
      id: string;
      name: string;
      description: string;
      plugins: unknown[];
    }): Promise<() => Promise<void>>;
    mount(ctx: NativeContext, id: string): Promise<{ id: string }>;
    select(agent: NativeAgent, id: string): Promise<string>;
    composedPreset(ctx: NativeContext): string | undefined;
    inspectCompositions(ctx: NativeContext): unknown;
  };
  agents: {
    create(options: {
      sessionId: string;
      meta: { cwd: string };
      agentOptions: ExecutionConfiguration;
      setup: (ctx: NativeContext, agent: NativeAgent) => Promise<void>;
    }): Promise<{ agent: NativeAgent; dispose(): Promise<void> }>;
    resume(options: {
      resumeSessionId: string;
      setup: (ctx: NativeContext, agent: NativeAgent) => Promise<void>;
    }): Promise<{ agent: NativeAgent; dispose(): Promise<void> }>;
  };
}
export interface SkillCandidate {
  name: string;
  description: string;
  path: string;
  invocation: { modelInvocable: boolean; userInvocable: boolean };
}
export interface NativeSkill extends SkillCandidate {
  content: string;
  provider: string;
  resourceBase?: { kind: string; path?: string };
}
export interface NativeSkillProvider {
  list(options: {
    cwd: string;
    signal?: AbortSignal;
  }): Promise<SkillCandidate[] | { candidates: SkillCandidate[]; complete: boolean }>;
  get(
    candidate: SkillCandidate,
    options: { cwd: string; signal?: AbortSignal },
  ): Promise<NativeSkill | undefined>;
  dispose(): Promise<void>;
}
export interface NativeModules {
  setSandboxMode(session: NativeAgent['session'], mode: 'danger-full-access'): void;
  defineTool(options: unknown): ToolDefinition;
  FileSystemSkillProvider: new (
    ctx: NativeContext,
    control: { signal: AbortSignal; invalidate: () => void },
    config: {
      includeDefaultRoots: false;
      customSkillDirs: string[];
      watch: false;
      providerName: string;
    },
  ) => NativeSkillProvider;
  renderSkillContent(skill: NativeSkill): string;
}
export async function loadNativeModules(ctx: NativeContext): Promise<NativeModules> {
  const tree = ctx.fiber.entry.parent.tree;
  const results = await Promise.all([
    tree.import('@deepseek-ai/dsh-tools'),
    tree.import('@deepseek-ai/dsh-skill-filesystem'),
    tree.import('@deepseek-ai/dsh-skill'),
    tree.import('@deepseek-ai/dsh-sandbox-policy'),
  ]);
  const tools = results[0] as Pick<NativeModules, 'defineTool'>;
  const filesystem = results[1] as Pick<NativeModules, 'FileSystemSkillProvider'>;
  const skills = results[2] as Pick<NativeModules, 'renderSkillContent'>;
  const policy = results[3] as Pick<NativeModules, 'setSandboxMode'>;
  if (
    typeof tools.defineTool !== 'function' ||
    typeof filesystem.FileSystemSkillProvider !== 'function' ||
    typeof skills.renderSkillContent !== 'function' ||
    typeof policy.setSandboxMode !== 'function'
  )
    throw new Error('当前DSH缺少已核对的工具或Skill原生接口');
  return { ...tools, ...filesystem, ...skills, setSandboxMode: policy.setSandboxMode };
}
