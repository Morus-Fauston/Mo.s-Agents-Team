import type { ProjectConnection } from './project.ts';
import type { TicketDelivery } from '../contracts/ticket-deliveries.ts';
import { ProjectError } from './errors.ts';
import { versionFileReferences, versionReports } from './version-reports.ts';
import { isAbsolute, relative, resolve } from 'node:path';
import { withinPath } from './write-scopes.ts';
import type { MaterialDomain } from '../contracts/workbench.ts';

/** Read the formal completion chain. Neither a directory scan nor an isolated snapshot is a delivery. */
export function ticketDeliveries(
  connection: ProjectConnection,
  ticketId: string,
  includeHistory = true,
) {
  const ticket = connection.workbench().getTicket(ticketId),
    reviews = connection.reviews();
  const executions = includeHistory
    ? connection
        .executions()
        .list()
        .filter((item) => item.ticketId === ticket.id)
    : ticket.currentExecution
      ? [connection.executions().get(ticket.currentExecution)]
      : [];
  const deliveries: TicketDelivery[] = executions.flatMap((execution) => {
    if (execution.ticketId !== ticket.id)
      throw new ProjectError('DELIVERY_LINK_MISMATCH', '当前执行不属于本票，未显示错误交付');
    const results = connection.reviewResults().list(execution.id);
    const available = reviews.list(execution.id);
    return (includeHistory ? available : available.slice(-1)).map((review) => {
      const completion = reviews.completion(review.completionId),
        version = connection.versions().get(review.versionId),
        result = results.find((row) => row.reviewId === review.id);
      if (
        review.ticketId !== ticket.id ||
        completion.ticketId !== ticket.id ||
        version.ticket.id !== ticket.id ||
        version.kind !== 'delivery' ||
        review.executionId !== execution.id ||
        completion.executionId !== execution.id ||
        version.executionId !== execution.id ||
        completion.reviewId !== review.id ||
        completion.versionId !== version.id ||
        completion.sourceSessionId !== version.actor.sessionId ||
        (result &&
          (result.versionId !== version.id ||
            result.completionId !== completion.id ||
            result.ticketId !== ticket.id))
      )
        throw new ProjectError(
          'DELIVERY_LINK_MISMATCH',
          '固定版本、完成或审阅依据不属于同一次实际交付',
        );
      return {
        ticketId: ticket.id,
        executionId: execution.id,
        completionId: completion.id,
        versionId: version.id,
        reviewId: review.id,
        sourceSessionId: completion.sourceSessionId,
        sequence: version.sequence,
        summary: version.summary,
        scope: version.scope,
        createdAt: completion.createdAt,
        author: version.actor,
        reviewStatus: review.status,
        reviewSessionId: review.sessionId,
        reports: versionReports(version),
        evidence: versionFileReferences(version, version.evidencePaths),
        checklistItemIds: version.checklistItemIds,
        result: result
          ? {
              id: result.id,
              previousResultId: result.previousResultId,
              verdict: result.verdict,
              progress: result.progress,
              authorAction: result.authorAction,
              author: result.author,
            }
          : null,
      };
    });
  });
  const currentDelivery =
    deliveries.findLast((item) => item.executionId === ticket.currentExecution) ?? null;
  return { currentDelivery, deliveries };
}

export function liveEvidenceReferences(
  root: string,
  domain: MaterialDomain | undefined,
  references: string[],
) {
  return references.map((reference) => {
    const target = isAbsolute(reference) ? resolve(reference) : resolve(root, reference);
    return {
      reference,
      path:
        domain &&
        withinPath(root, target) &&
        withinPath(domain.path, target) &&
        target !== domain.path
          ? relative(root, target).replaceAll('\\', '/')
          : null,
    };
  });
}

export function ticketRelationships(connection: ProjectConnection, ticketId: string) {
  const wb = connection.workbench(),
    ticket = wb.getTicket(ticketId),
    domains = wb.materialDomains(ticket.id);
  const execution = ticket.currentExecution
    ? connection.executions().get(ticket.currentExecution)
    : undefined;
  const results = connection
      .collaborationResults()
      .results()
      .filter((row) => row.ticketId === ticket.id),
    logs = wb.logs(ticket.id, 'all');
  if (execution && execution.ticketId !== ticket.id)
    throw new ProjectError('DELIVERY_LINK_MISMATCH', '本票当前执行关联不一致');
  return {
    reviewedDependencies: execution?.dependencyEvidence ?? [],
    collaborations: connection
      .collaborations()
      .list()
      .filter((row) => row.ticketId === ticket.id)
      .map((row) => ({
        id: row.id,
        executionId: row.executionId,
        name: row.name,
        purpose: row.purpose,
        state: row.state,
        sessionId: row.sessionId,
        parentSessionId: row.parentSessionId,
        material:
          domains.find((domain) => domain.kind === 'assistant' && domain.referenceId === row.id) ??
          null,
        results: results
          .filter((result) => result.collaborationId === row.id)
          .map((result) => ({
            id: result.id,
            action: result.action,
            content: result.content,
            progress: result.progress,
            createdAt: result.createdAt,
            evidence: liveEvidenceReferences(
              ticket.materialRoot,
              domains.find(
                (domain) => domain.kind === 'assistant' && domain.referenceId === row.id,
              ),
              result.evidencePaths,
            ),
          })),
        logs: logs
          .filter((log) => log.collaborationId === row.id)
          .map(({ id, title, archived }) => ({ id, title, archived })),
      })),
    decisions: connection
      .decisionRequests()
      .list({ kind: 'user' })
      .filter((row) => row.ticketId === ticket.id)
      .map(({ id, subject, state }) => ({ id, subject, state })),
  };
}

export function deliveryOpinionEvidence(
  connection: ProjectConnection,
  ticketId: string,
  resultId: string,
) {
  const wb = connection.workbench(),
    ticket = wb.getTicket(ticketId),
    result = connection.reviewResults().get(resultId);
  if (result.ticketId !== ticket.id)
    throw new ProjectError('DELIVERY_LINK_MISMATCH', '该审阅结果不属于本票');
  const version = connection.versions().get(result.versionId),
    domain = wb
      .materialDomains(ticket.id)
      .find((value) => value.referenceId === result.reviewId && value.kind === 'review');
  const fixed = versionFileReferences(version, result.evidencePaths);
  const live = liveEvidenceReferences(ticket.materialRoot, domain, result.evidencePaths);
  return { result, fixed, live };
}
