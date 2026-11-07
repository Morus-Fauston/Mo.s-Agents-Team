import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { completionFixture } from './completion-fixture.ts';
import { AssistantService } from '../src/services/assistant-service.ts';
import { CollaborationResultsService } from '../src/services/collaboration-results-service.ts';
import type { NativeAgent } from '../src/host/native.ts';
import { CommunicationService } from '../src/services/chat-service.ts';
import type { NativeMessage } from '../src/host/native.ts';

test('正式故障通知只注入已加载原主会话，flush失败不假称持久，重试不重复注入或steer', async () => {
  const f = completionFixture();
  let communication: CommunicationService | undefined;
  try {
    const c = f.connection,
      project = c.snapshot().id;
    const creators = new AssistantService(f.projects, {
      async create(_p, input, reserved) {
        const s = c.reserveSession(input);
        reserved(s);
        return c.bindSession(s.id, 'unit-' + s.id);
      },
      async reuse(_p, id, claim) {
        const s = c.session(id);
        claim(s);
        return s;
      },
    });
    const a = await creators.create(project, f.session.id, {
      operationId: randomUUID(),
      roleId: f.role.id,
      name: '故障辅助',
      purpose: '核对投递边界',
      writeScopes: [],
    });
    const fault = c.collaborations().problem(a.id, '实际辅助故障').faultId!;
    const inbox: NativeMessage[] = [];
    let flush = false,
      injections = 0;
    const parent = {
      id: c.session(f.session.id).nativeSessionId!,
      session: { deriveMessages: () => [] },
      inbox: { nextStep: inbox },
      inject(message: NativeMessage) {
        injections++;
        inbox.push(message);
      },
      steer() {
        throw new Error('不得提前steer');
      },
    } as unknown as NativeAgent;
    communication = new CommunicationService(f.projects, {
      peek: () => parent,
      open: async () => {
        throw new Error('不得另开会话');
      },
      flush: async () => flush,
    });
    const initial = await communication.stageCollaborationFault(project, fault);
    expect(initial.receipt.memoryAcceptedAt).not.toBeNull();
    expect(initial.receipt.durableAcceptedAt).toBeNull();
    expect(c.collaborationResults().deliveryReady(a.id)).toBe(false);
    const resultsService = new CollaborationResultsService(f.projects, communication, {
      peek: () => parent,
      pause: async () => {},
      resume: async () => {
        expect(c.collaborationResults().deliveryReady(a.id)).toBe(true);
      },
      inspect: async () => {
        throw new Error('故障补投不重新执行辅助');
      },
    });
    const wait = await resultsService.wait(project, f.session.id, parent, {
      operationId: randomUUID(),
      reason: '等辅助',
      dependencies: [a.id],
    });
    expect(wait.state).toBe('unknown');
    flush = true;
    const retried = await resultsService.retryWait(project, f.session.id, parent, wait.id);
    expect(retried.id).toBe(wait.id);
    expect(retried.state).toBe('signalled');
    expect(c.messages().get(fault).receipt.durableAcceptedAt).not.toBeNull();
    expect(c.collaborationResults().deliveryReady(a.id)).toBe(true);
    expect(injections).toBe(1);
    await resultsService.close();
  } finally {
    await communication?.close();
    f.close();
  }
});
test('正式辅助结果先持久化再投递，主Goal只在两个结果到齐后接续一次', async () => {
  const f = completionFixture();
  try {
    const c = f.connection,
      project = c.snapshot().id,
      agents = new Map<string, NativeAgent>();
    const agent = (id: string) => ({ id, status: 'idle', whenIdle: async () => {} }) as NativeAgent;
    agents.set(f.session.id, agent(c.session(f.session.id).nativeSessionId!));
    const creators = new AssistantService(f.projects, {
      async create(_p, input, reserved) {
        const s = c.reserveSession(input);
        reserved(s);
        const bound = c.bindSession(s.id, 'unit-' + s.id);
        agents.set(s.id, agent(bound.nativeSessionId!));
        return bound;
      },
      async reuse(_p, id, claim) {
        const s = c.session(id);
        claim(s);
        return s;
      },
    });
    const a = await creators.create(project, f.session.id, {
      operationId: randomUUID(),
      roleId: f.role.id,
      name: '辅助A',
      purpose: '结果',
      writeScopes: [],
    });
    const b = await creators.create(project, f.session.id, {
      operationId: randomUUID(),
      roleId: f.role.id,
      name: '辅助B',
      purpose: '结果',
      writeScopes: [],
    });
    let pauses = 0,
      resumes = 0,
      notices = 0;
    let releasePause!: () => void;
    const pauseReceipt = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    const service = new CollaborationResultsService(
      f.projects,
      {
        async stageCollaborationResult(_p: string, id: string) {
          const notice = c.collaborationResults().prepareNotice(id);
          c.messages().saveCollaborationResult(id, notice.id);
          c.messages().recordMemoryAccepted(notice.id);
          c.messages().recordDurableAccepted(notice.id);
          return c.messages().get(notice.id);
        },
        async sendCollaborationResult(_p: string, id: string) {
          expect(c.collaborationResults().get(id).progress).not.toBe('saved');
          notices++;
        },
      } as unknown as CommunicationService,
      {
        peek: (_p, id) => agents.get(id),
        async pause() {
          pauses++;
          if (pauses === 1) throw new Error('原Goal暂停flush暂未确认');
          await pauseReceipt;
        },
        async resume() {
          expect(
            c
              .collaborationResults()
              .results()
              .every((v) =>
                v.notices.some((n) => c.messages().get(n.id).receipt.durableAcceptedAt !== null),
              ),
          ).toBe(true);
          resumes++;
        },
        async inspect() {
          return {
            agentIdle: true,
            inFlightTools: false,
            filesStable: true,
            fileFingerprint: 'unit',
            processesComplete: true,
            jobObservations: [],
            note: '原生边界替身',
          };
        },
      },
    );
    const firstWait = await service.wait(project, f.session.id, agents.get(f.session.id)!, {
      operationId: randomUUID(),
      reason: '没有其他工作，等待A和B',
      dependencies: [a.id, b.id],
    });
    expect(pauses).toBe(1);
    expect(firstWait.state).toBe('unknown');
    const waitPromise = service.retryWait(
      project,
      f.session.id,
      agents.get(f.session.id)!,
      firstWait.id,
    );
    expect(pauses).toBe(2);
    await expect(service.reconcileWait(project, firstWait.id)).rejects.toThrow('正在核对');
    const first = service.report(project, a.sessionId!, agents.get(a.sessionId!)!, {
      operationId: randomUUID(),
      action: 'complete',
    });
    expect(c.collaborationResults().get(first.id).progress).toBe('saved');
    await expect.poll(() => c.collaborationResults().get(first.id).progress).toBe('confirmed');
    expect(resumes).toBe(0);
    const second = service.report(project, b.sessionId!, agents.get(b.sessionId!)!, {
      operationId: randomUUID(),
      action: 'complete',
      content: 'B核对结果',
    });
    await expect.poll(() => c.collaborationResults().get(second.id).progress).toBe('confirmed');
    expect(resumes).toBe(0);
    releasePause();
    const wait = await waitPromise;
    expect(wait.id).toBe(firstWait.id);
    await expect.poll(() => c.collaborationResults().getWait(wait.id).state).toBe('signalled');
    expect(resumes).toBe(1);
    await expect.poll(() => notices).toBe(2);
    expect(c.collaborationResults().get(second.id).progress).toBe('confirmed');
    await service.close();
  } finally {
    f.close();
  }
});
