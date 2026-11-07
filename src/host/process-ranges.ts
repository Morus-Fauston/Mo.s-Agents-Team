import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NativeAgent, NativeContext, ToolDefinition } from './native.ts';
import { ProjectError } from '../services/errors.ts';
export interface RangeFact {
  id: string;
  projectId: string;
  sessionId: string;
  nativeOwner: string;
  callId: string;
  state: 'pending' | 'gone' | 'unknown';
  at: string;
  note: string;
}
interface RangeScope {
  projectId: string;
  sessionId: string;
  nativeOwner: string;
  callId: string;
}
/** Passive adapter: native tools keep their implementation and return values. Only scoped MAT calls are observed. */
export class NativeProcessRanges {
  private readonly storage = new AsyncLocalStorage<RangeScope>();
  private readonly facts = new Map<string, RangeFact>();
  private readonly changed: (fact: RangeFact) => void;
  private readonly restore: () => void;
  private closed = false;
  readonly available: boolean;
  constructor(ctx: NativeContext, changed: (fact: RangeFact) => void) {
    this.changed = changed;
    const service = ctx.subprocess;
    if (!service) {
      this.available = false;
      this.restore = () => {};
      return;
    }
    const originalDescriptor = Object.getOwnPropertyDescriptor(service, 'spawn'),
      original = service.spawn,
      currentScope = () => (this.closed ? undefined : this.storage.getStore()),
      commit = (fact: RangeFact) => this.commit(fact);
    const wrapped = function (this: unknown, spec: unknown) {
      const handle = Reflect.apply(original, this, [spec]) as {
          waitForExit?: () => Promise<unknown>;
        },
        scope = currentScope();
      if (scope) {
        const fact: RangeFact = {
          ...scope,
          id: randomUUID(),
          state: 'pending',
          at: new Date().toISOString(),
          note: '已取得实际工具调用的原生受管进程范围；终态和文件稳定另验',
        };
        commit(fact);
        if (typeof handle.waitForExit === 'function') {
          void Promise.resolve()
            .then(() => handle.waitForExit!())
            .then(
              (confirmed) =>
                commit({
                  ...fact,
                  state: confirmed === true ? 'gone' : 'unknown',
                  at: new Date().toISOString(),
                  note:
                    confirmed === true
                      ? '原生提供器明确返回true，确认该受管范围退出；不是job终态推断'
                      : '原生提供器未明确返回true，保留未知',
                }),
              () =>
                commit({
                  ...fact,
                  state: 'unknown',
                  at: new Date().toISOString(),
                  note: '原生进程提供器不能证明受管范围已退出',
                }),
            );
        } else commit({ ...fact, state: 'unknown', note: '此提供器没有范围退出观察接口' });
      }
      return handle;
    };
    try {
      // Cordis returns a fresh method proxy on every read. Compare the installed
      // own descriptor, not the contextual method returned by its get trap.
      Object.defineProperty(service, 'spawn', {
        configurable: true,
        writable: true,
        enumerable: originalDescriptor?.enumerable ?? false,
        value: wrapped,
      });
      this.available = Object.getOwnPropertyDescriptor(service, 'spawn')?.value === wrapped;
      this.restore = () => {
        if (Object.getOwnPropertyDescriptor(service, 'spawn')?.value !== wrapped) return;
        if (originalDescriptor) Object.defineProperty(service, 'spawn', originalDescriptor);
        else Reflect.deleteProperty(service, 'spawn');
      };
    } catch {
      this.available = false;
      this.restore = () => {};
    }
  }
  private commit(fact: RangeFact): void {
    if (this.closed) return;
    this.facts.set(fact.id, fact);
    try {
      this.changed(fact);
    } catch {
      /* Durable job reconciliation will retain unknown if the database is unavailable. */
    }
  }
  wrap(
    definition: ToolDefinition,
    owner: NativeAgent,
    projectId: string,
    sessionId: string,
    validate: (agent: NativeAgent, toolName: string) => void,
  ): ToolDefinition {
    if (!this.available) return definition;
    return {
      ...definition,
      execute: (args, exec) => {
        if (exec.agent !== owner)
          throw new ProjectError('TOOL_CALLER_MISMATCH', '原生工具不属于实际MAT调用会话');
        validate(owner, definition.name);
        if (!exec.callId) return definition.execute(args, exec);
        return this.storage.run(
          { projectId, sessionId, nativeOwner: owner.id, callId: exec.callId },
          () => definition.execute(args, exec),
        );
      },
    };
  }
  install(
    ctx: NativeContext,
    owner: NativeAgent,
    projectId: string,
    sessionId: string,
    validate: (agent: NativeAgent, toolName: string) => void,
  ): void {
    if (!this.available) return;
    for (const definition of ctx.tools.definitions(owner)) {
      // Native command tools are inherited. MAT tools are wrapped before their first scoped registration.
      if (!['pwsh', 'bash'].includes(definition.name) || typeof definition.execute !== 'function')
        continue;
      ctx.tools.register(this.wrap(definition, owner, projectId, sessionId, validate));
    }
  }
  forSession(sessionId: string): RangeFact[] {
    return [...this.facts.values()].filter((fact) => fact.sessionId === sessionId);
  }
  close(): void {
    this.closed = true;
    this.restore();
    this.storage.disable();
  }
}
