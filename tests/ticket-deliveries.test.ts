import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApplication } from '../src/api/application.ts';
import { completionFixture } from './completion-fixture.ts';
import { reviewResultFixture } from './review-result-fixture.ts';

test('材料投影只跟正式交回，缺失实时目录仍回读固定交付字节且不创建目录', async () => {
  const f = completionFixture();
  try {
    const c = f.connection,
      app = createApplication(f.projects),
      project = c.snapshot().id;
    const base = `http://localhost/api/projects/${project}`;
    const materials = async () =>
      (await app.request(base + `/tickets/${f.ticket.id}/materials`)).json();
    const report = join(f.material.path, 'report.md');
    writeFileSync(report, '# 固定原报告\n');
    c.versions().delivery({ kind: 'session', sessionId: f.session.id }, f.execution.id, {
      operationId: randomUUID(),
      summary: '尚无正式交回的版本',
      scope: '只验证孤立版本不构成交付',
      reportPaths: [report],
    });
    expect((await materials()).currentDelivery).toBeNull();
    const completion = c.reviews().complete(f.session.id, {
      operationId: randomUUID(),
      summary: '正式报告',
      scope: '报告和验证依据',
      reportPaths: [report],
      evidencePaths: [report],
    });
    const delivery = (await materials()).currentDelivery;
    expect(delivery).toMatchObject({
      completionId: completion.id,
      reviewId: completion.reviewId,
      versionId: completion.versionId,
      executionId: f.execution.id,
    });
    expect(delivery.reports[0]).toMatchObject({ path: 'report.md', available: true });
    writeFileSync(report, '修改后的实时文件');
    renameSync(f.ticket.materialRoot, f.ticket.materialRoot + '-missing-fixture');
    const missing = await materials();
    expect(missing.currentDelivery.versionId).toBe(completion.versionId);
    expect(missing.materialError).toContain('不可访问');
    expect(existsSync(f.ticket.materialRoot)).toBe(false);
    const original = await app.request(
      base +
        `/executions/${f.execution.id}/versions/${completion.versionId}/file?root=${delivery.reports[0].rootIndex}&path=report.md`,
    );
    expect(await original.text()).toBe('# 固定原报告\n');
  } finally {
    f.close();
  }
});

test('返修保留退回版本、固定原件及归档Log导航，不把旧意见投影到新版本', async () => {
  const f = reviewResultFixture();
  try {
    const c = f.connection,
      wb = c.workbench(),
      app = createApplication(f.projects),
      base = `http://localhost/api/projects/${c.snapshot().id}`;
    const get = async (suffix: string) => (await app.request(base + suffix)).json();
    const result = c.reviewResults().submit(
      { kind: 'session', sessionId: f.reviewer.id },
      {
        operationId: randomUUID(),
        reviewId: f.review.id,
        versionId: f.review.versionId,
        verdict: 'return',
        scope: '首个固定版本',
        basis: '核对原件后要求修改',
        issues: ['补正确内容'],
      },
    );
    c.executions().returnFromReview(f.execution.id, f.review.id, result.id, 'unit');
    const author = { kind: 'session' as const, sessionId: f.session.id };
    const log = wb.appendLog(author, f.ticket.id, {
      operationId: randomUUID(),
      title: '返修核对',
      content: '原件不同于新版本',
      type: 'verification',
      references: [],
    });
    wb.updateLog({ kind: 'user' }, f.ticket.id, log.id, {
      operationId: randomUUID(),
      reason: '保留历史原依据',
      archived: true,
    });
    writeFileSync(join(f.root, '成果.txt'), '已修正');
    const next = c.reviews().complete(f.session.id, {
      operationId: randomUUID(),
      summary: '固定修正版',
      scope: '同次尝试',
      evidencePaths: ['成果.txt', '不存在.md'],
    });
    const projected = await get(`/tickets/${f.ticket.id}/deliveries`);
    expect(projected.deliveries.map((v: { versionId: string }) => v.versionId)).toEqual([
      f.review.versionId,
      next.versionId,
    ]);
    expect(projected.currentDelivery).toMatchObject({
      versionId: next.versionId,
      result: null,
      evidence: [{ available: true }, { available: false }],
    });
    expect(projected.deliveries[0].result).toMatchObject({ id: result.id, verdict: 'return' });
    const old = await app.request(
      base +
        `/executions/${f.execution.id}/versions/${f.review.versionId}/file?root=0&path=${encodeURIComponent('成果.txt')}&preview=text`,
    );
    expect((await old.json()).content).toBe('交付成果');
    const oldOpinion = await get(`/tickets/${f.ticket.id}/deliveries/opinion/${result.id}`);
    expect(oldOpinion.result).toMatchObject({ versionId: f.review.versionId, id: result.id });
    const entry = wb
      .projectHistory()
      .find(
        (item) =>
          item.kind === 'log-created' && item.references.includes(`${f.ticket.id}:${log.id}`),
      )!;
    const links = await get(`/history/${entry.id}/targets`);
    expect(links).toContainEqual({
      kind: 'log',
      reference: `${f.ticket.id}:${log.id}`,
      ticketId: f.ticket.id,
      recordId: log.id,
      label: `${log.id} · ${log.title} · 已归档`,
    });
    const revision = wb
      .projectHistory()
      .find((item) => item.kind === 'review-return' && item.references.includes(result.id))!;
    expect(await get(`/history/${revision.id}/targets`)).toContainEqual(
      expect.objectContaining({
        kind: 'delivery',
        reference: result.id,
        recordId: f.review.versionId,
      }),
    );
  } finally {
    f.close();
  }
});
