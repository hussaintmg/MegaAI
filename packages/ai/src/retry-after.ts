/**
 * How long a rate-limited provider wants us to wait.
 *
 * A 429 is the normal state of a free-tier key, not a failure — and every one
 * of them arrives carrying the answer to "when may I try again?". Discarding
 * that turned one rate limit into a whole run served by the offline mock.
 *
 * Two dialects:
 *   - `Retry-After` header, in seconds or as an HTTP date (OpenAI, Groq,
 *     OpenRouter, and anything else that follows RFC 9110)
 *   - Google's `RetryInfo` in the error body: `{"retryDelay": "27s"}`
 */

/** Nothing sensible is longer than this; a huge value is a bug or a ban. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

function clamp(ms: number): number | undefined {
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(Math.round(ms), MAX_RETRY_AFTER_MS);
}

/** Parse an RFC 9110 `Retry-After` value: delta-seconds or an HTTP date. */
export function parseRetryAfterHeader(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return clamp(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? undefined : clamp(at - now);
}

/**
 * Pull a delay out of a JSON error body. Google returns
 * `error.details[].retryDelay: "27s"`; some gateways use `retry_after`.
 */
export function parseRetryAfterBody(body: string): number | undefined {
  if (!body) return undefined;
  // A regex rather than a parse: the body may be truncated, HTML, or a shape
  // no one documented, and all we need is the number.
  const google = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  if (google?.[1]) return clamp(Number(google[1]) * 1000);
  const seconds = /"retry_after(?:_seconds)?"\s*:\s*(\d+(?:\.\d+)?)/.exec(body);
  if (seconds?.[1]) return clamp(Number(seconds[1]) * 1000);
  const ms = /"retry_after_ms"\s*:\s*(\d+(?:\.\d+)?)/.exec(body);
  if (ms?.[1]) return clamp(Number(ms[1]));
  return undefined;
}

/** The provider's own answer, from wherever it put it. */
export function retryAfterFrom(headers: Headers, body: string, now = Date.now()): number | undefined {
  return parseRetryAfterHeader(headers.get('retry-after'), now) ?? parseRetryAfterBody(body);
}
