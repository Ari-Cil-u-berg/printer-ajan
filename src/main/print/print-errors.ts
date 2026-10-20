/**
 * A print that must NOT be retried: part of the job is already on paper.
 *
 * The queue retries a failing job up to 20 times, which is right when nothing
 * reached the printer and wrong once something did — every retry repeats the
 * whole job. Today the one such case is a job of several copies whose later
 * copy fails: retrying would print the earlier copies again.
 *
 * The job is acked as failed straight away; the kasa can reprint it by hand.
 */
export class NotRetryablePrintError extends Error {
  readonly retryable = false;
}

export function isRetryable(err: unknown): boolean {
  return !(err && typeof err === 'object' && (err as { retryable?: unknown }).retryable === false);
}
