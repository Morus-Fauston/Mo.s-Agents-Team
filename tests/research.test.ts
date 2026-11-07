import { expect, test } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { researchFixture } from './research-fixture.ts';
import { installWorkbenchTools } from '../src/host/workbench-tools.ts';
import { versionReports } from '../src/services/version-reports.ts';
import type { NativeAgent, NativeContext, NativeModules } from '../src/host/native.ts';
const question = (title: string, order: number) => ({
  operationId: randomUUID(),
  title,
  question: '当前材料能证明什么？',
  condition: '区分材料事实、推断和未确认项',
  sources: ['原始材料:1'],
  order,
});
test('研究派工拒绝非调查角色；原生工具保留实际身份与幂等回答，固定读取不跟随当前回答', async () => {
  const f = researchFixture();
  try {
    const c = f.connection,
      wb = c.workbench(),
      dev = c.roles().find((r) => r.type === 'developer')!;
    const extra = wb.createTicket(
      { kind: 'user' },
      {
        operationId: randomUUID(),
        phaseId: f.ticket.phaseId,
        categoryId: f.ticket.categoryId,
        kind: 'research',
        title: '未派工研究',
        goal: '角色边界',
        included: '材料',
        excluded: '产品写入',
        conditions: [{ condition: '来源可核', verification: 'review' }],
      },
    );
    expect(() =>
      c.executions().register(
        { kind: 'session', sessionId: f.manager.id },
        {
          operationId: randomUUID(),
          ticket: extra.id,
          roleId: dev.id,
          name: '错误研究角色',
          cwd: f.root,
          writeScopes: [],
        },
        'unit',
      ),
    ).toThrow('调查角色');
    const q = wb.addResearchQuestion(
      { kind: 'session', sessionId: f.manager.id },
      f.ticket.id,
      question('原生回答', 1),
    );
    const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<string> }>();
    let events: unknown[] = [],
      seq = 0;
    const agent = {
      id: 'unit-research',
      session: { snapshotEvents: () => events },
    } as unknown as NativeAgent;
    installWorkbenchTools(
      {
        tools: { register: (tool: { name: string; execute: never }) => tools.set(tool.name, tool) },
      } as unknown as NativeContext,
      agent,
      { defineTool: (v: unknown) => v } as NativeModules,
      'investigator',
      () => ({ connection: c, sessionId: f.session.id }),
    );
    const invoke = async (name: string, args: unknown, n = ++seq) => {
      const callId = 'research-' + n;
      events = [{ seq: n, type: 'tool/call', data: { name, callId } }];
      return JSON.parse(
        await tools
          .get(name)!
          .execute(args, { agent, callId, signal: new AbortController().signal }),
      );
    };
    await expect(
      invoke('mat_research', {
        ticket: f.ticket.code,
        action: 'question-add',
        entry: { title: '自改', question: '条件', condition: '通过' },
      }),
    ).rejects.toThrow('主管');
    await expect(
      invoke('mat_research', {
        ticket: f.ticket.code,
        action: 'answer',
        questionId: q.id,
        answer: {
          expectedQuestionRevision: 1,
          expectedAnswerRevision: 0,
          status: 'gap',
          content: '缺少运行',
        },
      }),
    ).rejects.toThrow('边界');
    const answer = {
      expectedQuestionRevision: 1,
      expectedAnswerRevision: 0,
      status: 'unconfirmed',
      content: '仅有材料',
      unconfirmed: '没有运行证据',
    };
    const first = await invoke('mat_research', {
      ticket: f.ticket.code,
      action: 'answer',
      questionId: q.id,
      answer,
    });
    expect(
      await invoke(
        'mat_research',
        { ticket: f.ticket.code, action: 'answer', questionId: q.id, answer },
        seq,
      ),
    ).toEqual(first);
    expect(wb.researchAnswerHistory(f.ticket.id, q.id)[0]!.author.sessionId).toBe(f.session.id);
    const report = join(f.material.path, 'native.md');
    writeFileSync(report, '旧报告');
    const v = c.versions().delivery({ kind: 'session', sessionId: f.session.id }, f.execution.id, {
      operationId: randomUUID(),
      summary: '材料研究',
      scope: 'Q01',
      reportPaths: [report],
    });
    await invoke('mat_research', {
      ticket: f.ticket.code,
      action: 'answer',
      questionId: q.id,
      answer: { ...answer, expectedAnswerRevision: 1, content: '新的材料' },
    });
    const read = await invoke('mat_ticket', {
      ticket: f.ticket.code,
      section: 'research',
      questionId: q.id,
      versionId: v.id,
    });
    expect(JSON.parse(read.content).entries[0].answer.content).toBe('仅有材料');
    await expect(
      tools
        .get('mat_research')!
        .execute(
          { ticket: f.ticket.code, action: 'answer', questionId: q.id, answer },
          { agent: {}, callId: 'forged', signal: new AbortController().signal },
        ),
    ).rejects.toThrow('实际调用');
  } finally {
    f.close();
  }
});
test('QXX不随排序改变；定义与回答修订分开，调查者不能修改问题条件', () => {
  const f = researchFixture();
  try {
    const wb = f.connection.workbench(),
      user = { kind: 'user' as const },
      actor = { kind: 'session' as const, sessionId: f.session.id };
    const a = wb.addResearchQuestion(user, f.ticket.id, question('来源', 2)),
      b = wb.addResearchQuestion(user, f.ticket.id, question('边界', 1));
    expect([a.id, b.id]).toEqual(['Q01', 'Q02']);
    expect(wb.research(f.ticket.id).entries.map((e) => e.question.id)).toEqual(['Q02', 'Q01']);
    expect(() =>
      wb.updateResearchQuestion(actor, f.ticket.id, a.id, {
        operationId: randomUUID(),
        expectedRevision: 1,
        reason: '自改条件',
        condition: '改成必然成立',
      }),
    ).toThrow('主管');
    const input = {
      operationId: randomUUID(),
      expectedQuestionRevision: 1,
      expectedAnswerRevision: 0,
      status: 'unconfirmed',
      content: '已核材料，但没有运行证据',
      evidence: ['原始材料:1'],
      unconfirmed: '真实运行无法确认',
    };
    const answer = wb.answerResearchQuestion(actor, f.ticket.id, a.id, input);
    expect(answer.questionRevision).toBe(1);
    expect(wb.answerResearchQuestion(actor, f.ticket.id, a.id, input)).toEqual(answer);
    wb.updateResearchQuestion(user, f.ticket.id, a.id, {
      operationId: randomUUID(),
      expectedRevision: 1,
      reason: '仅调整排序',
      order: 0,
    });
    expect(wb.research(f.ticket.id, a.id).entries[0]!.coverage).toBe('current');
    const changed = wb.updateResearchQuestion(user, f.ticket.id, a.id, {
      operationId: randomUUID(),
      expectedRevision: 2,
      reason: '明确新的证明条件',
      condition: '另核版本与边界',
    });
    expect(changed).toMatchObject({ id: 'Q01', revision: 3, definitionRevision: 2 });
    expect(wb.research(f.ticket.id, a.id).entries[0]!.coverage).toBe('outdated');
    expect(() =>
      wb.answerResearchQuestion(actor, f.ticket.id, a.id, {
        ...input,
        operationId: randomUUID(),
        expectedAnswerRevision: 1,
      }),
    ).toThrow('问题');
    wb.answerResearchQuestion(actor, f.ticket.id, a.id, {
      ...input,
      operationId: randomUUID(),
      expectedQuestionRevision: 2,
      expectedAnswerRevision: 1,
      status: 'gap',
      content: '新条件缺少证据',
      unconfirmed: '保留缺口',
    });
    expect(wb.researchAnswerHistory(f.ticket.id, a.id)).toHaveLength(2);
    expect(wb.research(f.ticket.id, b.id).entries[0]!.coverage).toBe('unanswered');
    expect(() =>
      wb.answerResearchQuestion(user, f.ticket.id, b.id, { ...input, operationId: randomUUID() }),
    ).toThrow('调查主执行');
  } finally {
    f.close();
  }
});
test('研究报告必须来自本次材料域，固定版本保留问题、回答和旧报告原件，不自动采纳', () => {
  const f = researchFixture();
  try {
    const c = f.connection,
      wb = c.workbench(),
      actor = { kind: 'session' as const, sessionId: f.session.id },
      initialState = wb.getTicket(f.ticket.id).state;
    const q = wb.addResearchQuestion({ kind: 'user' }, f.ticket.id, question('来源强度', 1));
    const answer = wb.answerResearchQuestion(actor, f.ticket.id, q.id, {
      operationId: randomUUID(),
      expectedQuestionRevision: 1,
      expectedAnswerRevision: 0,
      status: 'unconfirmed',
      content: '材料显示成立，运行未证实',
      evidence: ['原始材料:1'],
      unconfirmed: '未运行',
    });
    const input = { operationId: randomUUID(), summary: '完成研究材料', scope: 'Q01与报告' };
    expect(() => c.versions().delivery(actor, f.execution.id, input)).toThrow('研究报告');
    const outside = join(f.root, 'outside.md');
    writeFileSync(outside, '不在本次材料域');
    expect(() =>
      c.versions().delivery(actor, f.execution.id, {
        ...input,
        operationId: randomUUID(),
        reportPaths: [outside],
      }),
    ).toThrow('材料域');
    const report = join(f.material.path, 'report.md');
    writeFileSync(report, '# 报告v1\nQ01材料结论；运行未证实。');
    const v1 = c.versions().delivery(actor, f.execution.id, {
      ...input,
      operationId: randomUUID(),
      reportPaths: [report],
    });
    expect(v1.researchAnswers[0]!.id).toBe(answer.id);
    expect(v1.ticket.research!.questions[0]!.id).toBe('Q01');
    expect(v1.reportPaths).toEqual([report]);
    const materialRoot = v1.snapshot.roots.findIndex((r) =>
      r.files.some((f) => f.path === 'report.md'),
    );
    expect(versionReports(v1)).toEqual([
      { absolute: report, rootIndex: materialRoot, path: 'report.md', available: true },
    ]);
    writeFileSync(report, '# 报告v2\nQ01新增边界，仍未确认运行。');
    wb.answerResearchQuestion(actor, f.ticket.id, q.id, {
      operationId: randomUUID(),
      expectedQuestionRevision: 1,
      expectedAnswerRevision: 1,
      status: 'unconfirmed',
      content: '新增边界',
      evidence: ['新增材料:2'],
      unconfirmed: '仍未运行',
    });
    const v2 = c.versions().delivery(actor, f.execution.id, {
      ...input,
      operationId: randomUUID(),
      reportPaths: [report],
    });
    expect(c.versions().file(v1.id, materialRoot, 'report.md').toString()).toContain('报告v1');
    expect(v2.researchAnswers[0]!.revision).toBe(2);
    expect(c.versions().get(v1.id).researchAnswers[0]!.content).toBe('材料显示成立，运行未证实');
    expect(wb.getTicket(f.ticket.id).state).toBe(initialState);
  } finally {
    f.close();
  }
});
