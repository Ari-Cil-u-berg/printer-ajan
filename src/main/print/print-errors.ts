/**
 * A print that must NOT be retried: bytes may already be on paper.
 *
 * The queue retries a failing job up to 20 times, which is right when nothing
 * reached the printer (it was off, the cable was out) and wrong the moment it
 * did — every retry is another copy of the same ticket in the kitchen. Hatay
 * Sofrası, 20.10.2026: a network printer in "E) Görüntü" mode printed each
 * ticket, closed its connection late, and got the ticket again and again.
 *
 * Thrown only once the printer has accepted a connection and the write has
 * started. The job is acked as failed straight away; the kasa can reprint it
 * by hand, which is one deliberate copy instead of twenty accidental ones.
 */
export class NotRetryablePrintError extends Error {
  readonly retryable = false;
}

export function isRetryable(err: unknown): boolean {
  return !(err && typeof err === 'object' && (err as { retryable?: unknown }).retryable === false);
}
