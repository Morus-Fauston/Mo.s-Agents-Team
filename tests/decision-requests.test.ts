import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { completionFixture } from './completion-fixture.ts';
import { AssistantService } from '../src/services/assistant-service.ts';
import { DecisionRequestService } from '../src/services/decision-requests.ts';
import { CommunicationService } from '../src/services/chat-service.ts';
import type {
  NativeAgent,
  NativeMessage,
  NativeContext,
  NativeModules,
} from '../src/host/native.ts';
import { installDecisionRequestTools } from '../src/host/decision-request-tools.ts';
import { presentMessage } from '../src/services/message-presentation.ts';

async function fixture() {
  const f = completionFixture(),
    c = f.connection;
  const service = new AssistantService(f.projects, {
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
  const helper = await service.create(c.snapshot().id, f.session.id, {
    operationId: randomUUID(),
    roleId: f.role.id,
    name: '澄清辅助',
    purpose: '核实原范围',
    writeScopes: [],
  });
  return {
    ...f,
    helper,
    helperActor: { kind: 'session' as const, sessionId: helper.sessionId! },
    mainActor: { kind: 'session' as const, sessionId: f.session.id },
    managerActor: { kind: 'session' as const, sessionId: f.manager.id },
  };
}
const question = () => ({
  operationId: randomUUID(),
  subject: '原范围的取值',
  question: '取值是否含边界？',
  impact: '只影响当前辅助核对',
  reason: 'clarification' as const,
  references: [],
});
test('辅助澄清先交原主；等待和暂停不视为不可用，显式扩围升级保留原请求', async () => {
  const f = await fixture();
  try {
    const c = f.connection,
      requests = c.decisionRequests();
    c.executions().waitForCollaborations(f.execution.id);
    const request = requests.create(f.helperActor, question());
    expect(request).toMatchObject({
      ticketId: f.ticket.id,
      executionId: f.execution.id,
      collaborationId: f.helper.id,
      requester: { sessionId: f.helper.sessionId },
      assignee: { kind: 'session', sessionId: f.session.id },
      state: 'pending',
    });
    expect(() =>
      requests.escalate(f.helperActor, request.id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        reason: 'parent-unavailable',
        basis: '等待很久',
      }),
    ).toThrow('不可用');
    c.setCommunicationState(f.session.id, 'paused');
    expect(() =>
      requests.escalate(f.helperActor, request.id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        reason: 'parent-unavailable',
        basis: '暂停',
      }),
    ).toThrow('不可用');
    c.setCommunicationState(f.session.id, 'active');
    const elevated = requests.escalate(f.helperActor, request.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      reason: 'scope-change',
      basis: '需要修改票据排除的持久化格式',
    });
    expect(elevated).toMatchObject({
      id: request.id,
      revision: 2,
      assignee: { sessionId: f.manager.id },
    });
    expect(() =>
      requests.reply(f.mainActor, request.id, {
        operationId: randomUUID(),
        expectedRevision: 2,
        choice: 'accept',
        answer: '冒充批准',
        restrictions: '',
      }),
    ).toThrow('责任');
    const answered = requests.reply(f.managerActor, request.id, {
      operationId: randomUUID(),
      expectedRevision: 2,
      choice: 'answer',
      answer: '当前只核边界，不修改格式',
      restrictions: '不改变票据或精确文件权限',
    });
    expect(answered.state).toBe('answered');
    expect(c.collaborations().get(f.helper.id).writeScopes).toEqual([]);
    expect(c.workbench().getTicket(f.ticket.id).revision).toBe(f.ticket.revision);
  } finally {
    f.close();
  }
});

test('答复精确绑定修订，重送只回读；补充留原ID，已处理不能撤回', async () => {
  const f = await fixture();
  try {
    const requests = f.connection.decisionRequests(),
      input = question();
    const r = requests.create(f.helperActor, input);
    const reply = {
      operationId: randomUUID(),
      expectedRevision: 1,
      choice: 'need-info' as const,
      answer: '需要说明边界输入',
      restrictions: '',
    };
    const asked = requests.reply(f.mainActor, r.id, reply);
    expect(asked.state).toBe('needs-info');
    expect(requests.reply(f.mainActor, r.id, reply).revision).toBe(2);
    expect(() => requests.reply(f.mainActor, r.id, { ...reply, answer: '改写旧答复' })).toThrow(
      '冲突',
    );
    expect(() =>
      requests.withdraw(f.helperActor, r.id, {
        operationId: randomUUID(),
        expectedRevision: 2,
        basis: '撤回',
      }),
    ).toThrow('已处理');
    const supplemented = requests.supplement(f.helperActor, r.id, {
      operationId: randomUUID(),
      expectedRevision: 2,
      question: '输入为0和上限，是否均包含？',
      impact: '仍限当前核对',
      references: [],
      basis: '补齐所需输入',
    });
    expect(supplemented).toMatchObject({ id: r.id, revision: 3, state: 'pending' });
    expect(() =>
      requests.reply(f.mainActor, r.id, { ...reply, operationId: randomUUID() }),
    ).toThrow('修订');
    requests.reply(f.mainActor, r.id, {
      ...reply,
      operationId: randomUUID(),
      expectedRevision: 3,
      choice: 'answer',
      answer: '均包含',
    });
    expect(requests.get(f.helperActor, r.id).history).toHaveLength(4);
    const untouched = requests.create(f.helperActor, question());
    expect(() =>
      requests.withdraw(f.mainActor, untouched.id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        basis: '代撤回',
      }),
    ).toThrow('提出者');
    const withdrawn = requests.withdraw(f.helperActor, untouched.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      basis: '已不需要',
    });
    expect(withdrawn.state).toBe('withdrawn');
    expect(requests.pending(f.mainActor).map((r) => r.id)).not.toContain(untouched.id);
    expect(() =>
      requests.reply(f.mainActor, untouched.id, {
        ...reply,
        operationId: randomUUID(),
        expectedRevision: 2,
      }),
    ).toThrow('待答复');
  } finally {
    f.close();
  }
});

test('主执行管理请求由主管承接；升级同一请求交用户，普通Chat不代答复', async () => {
  const f = await fixture();
  try {
    const c = f.connection,
      requests = c.decisionRequests();
    const r = requests.create(f.mainActor, { ...question(), reason: 'scope-change' });
    expect(r.assignee.sessionId).toBe(f.manager.id);
    expect(() =>
      requests.reply({ kind: 'user' }, r.id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        choice: 'accept',
        answer: '未被交给用户',
        restrictions: '',
      }),
    ).toThrow('责任');
    const escalated = requests.escalate(f.managerActor, r.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      reason: 'human-decision',
      basis: '已超出主管当前授权',
    });
    expect(escalated.assignee.kind).toBe('user');
    expect(requests.pending({ kind: 'user' }).map((r) => r.id)).toContain(r.id);
    const reply = requests.reply({ kind: 'user' }, r.id, {
      operationId: randomUUID(),
      expectedRevision: 2,
      choice: 'accept',
      answer: '同意本次核对',
      restrictions: '不要改持久化格式',
    });
    expect(reply).toMatchObject({
      state: 'answered',
      reply: { answer: '同意本次核对', restrictions: '不要改持久化格式' },
    });
    expect(c.executions().get(f.execution.id).lifecycleState).toBe('active');
  } finally {
    f.close();
  }
});

test('原等待明确关联请求，答复与请求中断都先持久入原主上下文；其他协作依赖保留', async () => {
  const f = await fixture();
  try {
    const c = f.connection,
      requests = c.decisionRequests(),
      results = c.collaborationResults();
    const r = requests.create(f.mainActor, { ...question(), reason: 'scope-change' });
    const w = results.wait(f.session.id, {
      operationId: randomUUID(),
      reason: '无其他可做部分，等待原请求',
      dependencies: [],
      requestIds: [r.id],
    });
    expect(results.readiness(w.id).ready).toBe(false);
    requests.reply(f.managerActor, r.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      choice: 'answer',
      answer: '保持原范围继续',
      restrictions: '不改格式',
    });
    expect(results.readiness(w.id).ready).toBe(false);
    const notice = requests.notices(r.id).at(-1)!;
    c.messages().saveDecisionNotice(notice.id);
    c.messages().recordMemoryAccepted(notice.id);
    expect(results.readiness(w.id).ready).toBe(false);
    c.messages().recordDurableAccepted(notice.id);
    expect(results.canWake(w.id)).toBe(true);
    results.signalled(w.id);
    const awaiting = results.wait(f.session.id, {
      operationId: randomUUID(),
      reason: '继续等待辅助',
      dependencies: [f.helper.id],
    });
    const clarification = requests.create(f.helperActor, question());
    expect(results.canWake(awaiting.id)).toBe(false);
    const questionNotice = requests.notices(clarification.id)[0]!;
    c.messages().saveDecisionNotice(questionNotice.id);
    c.messages().recordDurableAccepted(questionNotice.id);
    expect(results.canWake(awaiting.id)).toBe(true);
    expect(results.getWait(awaiting.id).dependencies).toEqual([f.helper.id]);
    expect(c.collaborations().get(f.helper.id).state).toBe('active');
    const stop = c.controls().request(
      { kind: 'user' },
      {
        operationId: randomUUID(),
        executionId: f.execution.id,
        action: 'hard-stop',
        expectedRevision: 0,
        reason: '更高控制',
      },
      'unit',
    );
    expect(results.getWait(awaiting.id).supersededByControlId).toBe(stop.id);
    expect(results.canWake(awaiting.id)).toBe(false);
  } finally {
    f.close();
  }
});

test('通知与办结分开；flush未知不唤醒原等待，暂停辅助答复只保存，不创建Goal或替代入口', async () => {
  const f = await fixture(),
    c = f.connection,
    project = c.snapshot().id;
  const inboxes = new Map<string, NativeMessage[]>(),
    agents = new Map<string, NativeAgent>();
  for (const s of c.sessions()) {
    const inbox: NativeMessage[] = [];
    inboxes.set(s.id, inbox);
    agents.set(s.id, {
      id: s.nativeSessionId!,
      status: 'idle',
      session: { deriveMessages: () => [], snapshotEvents: () => [] },
      inbox: { nextStep: inbox },
      inject: (m: NativeMessage) => inbox.push(m),
      steer: (m: NativeMessage) => inbox.push(m),
    } as unknown as NativeAgent);
  }
  let durable = false,
    wakes = 0;
  const communication = new CommunicationService(f.projects, {
    peek: (_p, id) => agents.get(id),
    open: async (_p, id) => agents.get(id)!,
    flush: async () => durable,
  });
  const service = new DecisionRequestService(f.projects, communication, {
    async reconcileExecution(_p, id) {
      wakes++;
      const w = c
        .collaborationResults()
        .waits(id)
        .find((w) => w.state === 'waiting');
      if (w && c.collaborationResults().canWake(w.id)) c.collaborationResults().signalled(w.id);
    },
  });
  try {
    const w = c.collaborationResults().wait(f.session.id, {
      operationId: randomUUID(),
      reason: '等待辅助',
      dependencies: [f.helper.id],
    });
    const r = await service.act(project, f.helperActor, 'create', undefined, question());
    expect(wakes).toBe(0);
    expect(c.collaborationResults().canWake(w.id)).toBe(false);
    const notice = c.decisionRequests().notices(r.id)[0]!;
    expect(notice.delivery).toBe('held');
    expect(c.messages().get(notice.id).receipt.durableAcceptedAt).toBeNull();
    durable = true;
    await service.retry(project, f.helperActor, r.id);
    expect(wakes).toBe(1);
    expect(c.collaborationResults().getWait(w.id).state).toBe('signalled');
    expect(inboxes.get(f.session.id)!.filter((m) => m.id === notice.id)).toHaveLength(1);
    c.setCommunicationState(f.helper.sessionId!, 'paused');
    const reply = await service.act(project, f.mainActor, 'reply', r.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      choice: 'answer',
      answer: '包含边界',
      restrictions: '原范围内',
    });
    expect(reply.state).toBe('answered');
    expect(inboxes.get(f.helper.sessionId!)).toHaveLength(0);
    expect(c.session(f.helper.sessionId!).communicationState).toBe('paused');
    expect(c.decisionRequests().notices(r.id).at(-1)!.delivery).toBe('held');
    expect(() => c.messages().saveDecisionNotice(randomUUID())).toThrow('同事务');
  } finally {
    await service.close();
    await communication.close();
    f.close();
  }
});

test('辅助普通等待先持久接纳答复再激活；路由升级没有答复仍可按最新修订撤回', async () => {
  const f = await fixture(),
    c = f.connection,
    project = c.snapshot().id,
    inbox: NativeMessage[] = [];
  let durable = false;
  const helper = {
    id: f.helper.nativeSessionId!,
    status: 'idle',
    session: { deriveMessages: () => [], snapshotEvents: () => [] },
    inbox: { nextStep: inbox },
    inject: (m: NativeMessage) => inbox.push(m),
    steer: (m: NativeMessage) => inbox.push(m),
  } as unknown as NativeAgent;
  const communication = new CommunicationService(f.projects, {
    peek: (_p, id) => (id === f.helper.sessionId ? helper : undefined),
    open: async () => helper,
    flush: async () => durable,
  });
  const service = new DecisionRequestService(f.projects, communication, {
    async reconcileExecution() {},
  });
  try {
    const r = c.decisionRequests().create(f.helperActor, question());
    const result = c.collaborationResults().report(f.helper.sessionId!, {
      operationId: randomUUID(),
      action: 'hangup',
      content: '仅单元夹具：等原请求答复',
      resumeCondition: '收到原请求明确答复',
      evidencePaths: [],
    });
    c.collaborations().reportObserved(f.helper.id, result.id, 'waiting');
    await service.act(project, f.mainActor, 'reply', r.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      choice: 'answer',
      answer: '原范围内答复',
      restrictions: '',
    });
    expect(c.collaborations().get(f.helper.id).state).toBe('waiting');
    expect(c.collaborations().resumeForDecision(r.id)).toBe(false);
    durable = true;
    await service.retry(project, f.helperActor, r.id);
    expect(c.collaborations().get(f.helper.id).state).toBe('active');
    const notice = c.decisionRequests().notices(r.id).at(-1)!;
    expect(inbox.filter((m) => m.id === notice.id)).toHaveLength(1);
    const next = c.decisionRequests().create(f.helperActor, question());
    const escalated = c.decisionRequests().escalate(f.helperActor, next.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      reason: 'scope-change',
      basis: '仅路由升级，没有实际答复',
    });
    expect(escalated.state).toBe('pending');
    const withdrawn = c.decisionRequests().withdraw(f.helperActor, next.id, {
      operationId: randomUUID(),
      expectedRevision: 2,
      basis: '尚无答复，原提出者撤回',
    });
    expect(withdrawn.state).toBe('withdrawn');
    expect(() =>
      c.decisionRequests().reply(f.managerActor, next.id, {
        operationId: randomUUID(),
        expectedRevision: 2,
        choice: 'accept',
        answer: '迟到批准',
        restrictions: '',
      }),
    ).toThrow('修订');
  } finally {
    await service.close();
    await communication.close();
    f.close();
  }
});

test('异步持久化期间撤回请求，旧通知只保留接纳历史，不继续发送或解除等待', async () => {
  const f = await fixture(),
    c = f.connection,
    project = c.snapshot().id,
    sent: string[] = [];
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  let first = true;
  const communication = {
    async stageDecisionNotice(_project: string, id: string) {
      const saved = c.messages().saveDecisionNotice(id);
      c.messages().recordMemoryAccepted(id);
      if (first) {
        first = false;
        entered();
        await barrier;
      }
      c.messages().recordDurableAccepted(id);
      return c.messages().get(saved.message.id);
    },
    async sendDecisionNotice(_project: string, id: string) {
      sent.push(id);
      return c.messages().get(id);
    },
  } as unknown as CommunicationService;
  const service = new DecisionRequestService(f.projects, communication, {
    async reconcileExecution() {},
  });
  try {
    const creating = service.act(project, f.helperActor, 'create', undefined, question());
    await started;
    const original = c.decisionRequests().pending(f.mainActor)[0]!,
      oldNotice = c.decisionRequests().notices(original.id)[0]!;
    const withdrawing = service.act(project, f.helperActor, 'withdraw', original.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      basis: '持久化期间原提出者明确撤回',
    });
    expect(c.decisionRequests().record(original.id).state).toBe('withdrawn');
    release();
    await Promise.all([creating, withdrawing]);
    expect(sent).not.toContain(oldNotice.id);
    expect(c.messages().get(oldNotice.id).receipt.durableAcceptedAt).not.toBeNull();
    expect(c.decisionRequests().pending(f.mainActor)).toHaveLength(0);
  } finally {
    release();
    await service.close();
    f.close();
  }
});

test('目标消息队列等待期间撤回，实际投递和模型准入均拒绝旧请求提示', async () => {
  const f = await fixture(),
    c = f.connection,
    project = c.snapshot().id,
    inbox: NativeMessage[] = [];
  let release!: () => void,
    entered!: () => void,
    first = true;
  const barrier = new Promise<void>((r) => {
      release = r;
    }),
    started = new Promise<void>((r) => {
      entered = r;
    });
  const agent = {
    id: f.session.nativeSessionId ?? 'unit-executor',
    status: 'idle',
    session: { deriveMessages: () => [], snapshotEvents: () => [] },
    inbox: { nextStep: inbox },
    inject: (m: NativeMessage) => inbox.push(m),
    steer: (m: NativeMessage) => inbox.push(m),
  } as unknown as NativeAgent;
  const communication = new CommunicationService(f.projects, {
    peek: () => agent,
    open: async () => agent,
    flush: async () => {
      if (first) {
        first = false;
        entered();
        await barrier;
      }
      return true;
    },
  });
  try {
    const firstMessage = communication.send(
      project,
      { kind: 'user' },
      { id: randomUUID(), target: f.session.id, content: '占据原目标队列的普通消息' },
    );
    await started;
    const r = c.decisionRequests().create(f.helperActor, question()),
      n = c.decisionRequests().notices(r.id)[0]!;
    const queued = communication.sendDecisionNotice(project, n.id);
    c.decisionRequests().withdraw(f.helperActor, r.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      basis: '原提示排队期间撤回',
    });
    release();
    await firstMessage;
    const receipt = (await queued).receipt;
    expect(inbox.some((m) => m.id === n.id)).toBe(false);
    expect(receipt.state).toBe('held');
    const admitted = await communication.admit(project, f.session.id, agent, 1, [
      presentMessage(c.messages().get(n.id)),
    ]);
    expect(admitted.messages).toHaveLength(0);
  } finally {
    release();
    await communication.close();
    f.close();
  }
});

test('真实工具入口不把create的默认引用带入escalate/retry，仍核实际调用事件和来源', async () => {
  type TestTool = {
    parameters: Record<string, unknown>;
    execute(args: unknown, exec: unknown): Promise<string>;
  };
  const f = await fixture(),
    c = f.connection,
    definitions = new Map<string, TestTool>();
  const owner = {
    id: 'unit-executor',
    session: {
      snapshotEvents: () => [
        { type: 'tool/call', seq: 7, data: { name: 'mat_decision_request', callId: 'unit-call' } },
      ],
    },
  } as unknown as NativeAgent;
  const ctx = {
    tools: {
      register: (d: TestTool & { name: string }) => {
        definitions.set(d.name, d);
        return () => {};
      },
    },
  } as unknown as NativeContext;
  const service = {
    async act(
      _project: string,
      actor: typeof f.mainActor,
      action: 'create' | 'escalate',
      id: string | undefined,
      input: unknown,
    ) {
      return action === 'create'
        ? c.decisionRequests().create(actor, input)
        : c.decisionRequests().escalate(actor, id!, input);
    },
    async retry(_project: string, actor: typeof f.mainActor, id: string) {
      return c.decisionRequests().get(actor, id);
    },
  } as unknown as DecisionRequestService;
  try {
    installDecisionRequestTools(
      ctx,
      owner,
      { defineTool: (d: unknown) => d } as NativeModules,
      () => ({ connection: c, sessionId: f.session.id }),
      service,
    );
    const tool = definitions.get('mat_decision_request')!,
      r = c.decisionRequests().create(f.helperActor, question());
    const result = JSON.parse(
      await tool.execute(
        {
          action: 'escalate',
          requestId: r.id,
          expectedRevision: 1,
          reason: 'scope-change',
          basis: '原范围只读，需要管理决定',
        },
        { agent: owner, callId: 'unit-call' },
      ),
    );
    expect(result).toMatchObject({
      requestId: r.id,
      revision: 2,
      assignee: { sessionId: f.manager.id },
    });
    expect(tool.parameters.references).not.toHaveProperty('default');
    expect(
      JSON.parse(
        await tool.execute(
          { action: 'retry', requestId: r.id },
          { agent: owner, callId: 'unit-call' },
        ),
      ),
    ).toMatchObject({ requestId: r.id, revision: 2 });
    await expect(
      tool.execute(
        {
          action: 'create',
          subject: '主请求',
          question: '原范围说明',
          impact: '仅本票',
          reason: 'clarification',
        },
        { agent: {} as NativeAgent, callId: 'unit-call' },
      ),
    ).rejects.toMatchObject({ code: 'TOOL_CALLER_MISMATCH' });
  } finally {
    f.close();
  }
});
