import type { VersionCatalog } from '../storage/version-catalog.ts';
import type { ExecutionCatalog } from '../storage/execution-catalog.ts';
import type { ReviewCatalog } from '../storage/review-catalog.ts';
import type { ReviewResultCatalog } from '../storage/review-results-catalog.ts';
import { ProjectError } from './errors.ts';
/** Current formal whole-ticket approval, including original author/reviewer closure. */
export function requireReviewedDelivery(
  c: {
    versions: VersionCatalog;
    executions: ExecutionCatalog;
    reviews: ReviewCatalog;
    reviewResults: ReviewResultCatalog;
  },
  versionId: string,
  resultId: string,
) {
  const version = c.versions.get(versionId),
    result = c.reviewResults.get(resultId),
    execution = c.executions.get(version.executionId),
    review = c.reviews.get(result.reviewId);
  if (
    version.kind !== 'delivery' ||
    result.versionId !== version.id ||
    result.executionId !== execution.id ||
    result.ticketId !== version.ticket.id ||
    result.verdict !== 'pass' ||
    result.progress.state !== 'confirmed' ||
    result.authorAction.state !== 'confirmed' ||
    result.authorGoalClear?.state !== 'confirmed' ||
    execution.reviewResultId !== result.id ||
    execution.lifecycleState !== 'closed' ||
    execution.writeOccupancy !== 'released' ||
    review.versionId !== version.id ||
    review.status !== 'decided' ||
    review.closure?.state !== 'confirmed' ||
    c.reviewResults.list(execution.id).at(-1)?.id !== result.id
  )
    throw new ProjectError(
      'MERGE_REVIEW_REQUIRED',
      '固定版本须有当前指定整票pass，原执行和独审须完成收尾',
    );
  return { version, result, execution };
}
