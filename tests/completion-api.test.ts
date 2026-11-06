import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { completionFixture } from './completion-fixture.ts';
import { createApplication } from '../src/api/application.ts';
test('HTTP审阅配置及固定交付回读同源；读取不增加版本或伪造意见，未接宿主不能重试', async () => {
  const f = completionFixture();
  try {
    const app = createApplication(f.projects),
      base = 'http://localhost/api/projects/' + f.connection.snapshot().id;
    const put = await app.request(base + '/review-settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: randomUUID(), reviewerRoleId: f.reviewer.id }),
    });
    expect(put.status).toBe(200);
    expect(
      await (await app.request(base + '/review-settings?ticketId=' + f.ticket.id)).json(),
    ).toMatchObject({ reviewerRoleId: f.reviewer.id, inherit: true });
    const saved = f.connection.reviews().complete(f.session.id, {
      operationId: randomUUID(),
      summary: 'API交回原始简报',
      scope: '成果.txt',
    });
    const detail = await app.request(base + '/reviews/' + saved.reviewId);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({
      completion: { id: saved.id },
      review: { id: saved.reviewId, versionId: saved.versionId },
      native: { loaded: false },
    });
    expect(
      await (await app.request(base + '/reviews?executionId=' + f.execution.id)).json(),
    ).toHaveLength(1);
    const retry = await app.request(base + '/reviews/' + saved.reviewId + '/retry', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ operationId: randomUUID(), reason: '原审核核对' }),
    });
    expect(retry.status).toBe(409);
    expect(f.connection.versions().list(f.execution.id)).toHaveLength(2);
    expect(f.connection.workbench().getTicket(f.ticket.id).state).toBe('awaiting-review');
  } finally {
    f.close();
  }
});
