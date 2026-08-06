/**
 * Failure reporting for the action.
 *
 * Every message here is written to be acted on from a workflow log: it says
 * what the API refused and what to change. Neither the API key nor the
 * rendered HTML is ever included in a message.
 */

const DASHBOARD_URL = 'https://app.html2img.com/dashboard';
const PRICING_URL = 'https://html2img.com/pricing';
const DOCS_URL = 'https://html2img.com/docs';

/** An error whose message is already suitable for `core.setFailed`. */
export class ActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionError';
  }
}

/** The decoded JSON body of an API error response. */
type ErrorPayload = Record<string, unknown>;

/**
 * Turn an API error response into an `ActionError` that explains the fix.
 *
 * Status codes and `code` values follow the API reference at
 * https://html2img.com/docs.
 */
export function apiError(status: number, payload: ErrorPayload): ActionError {
  const code = asString(payload['code']);
  const reference = asString(payload['id']);

  switch (status) {
    case 401:
      return new ActionError(
        code === 'missing_api_key'
          ? `The html2img API received no API key (HTTP 401). Pass one as the api-key input, for example api-key: \${{ secrets.HTML2IMG_API_KEY }}. Create a key at ${DASHBOARD_URL} and add it to the repository secrets.`
          : `The html2img API rejected the API key as invalid (HTTP 401). Check that the secret holds a current key with no leading or trailing whitespace. You can view and create keys at ${DASHBOARD_URL}.`,
      );

    case 402:
      return new ActionError(
        `Your html2img account is out of credits (HTTP 402), so this render was not performed. Credits reset at the start of each billing period, or you can raise your limit: ${PRICING_URL}.`,
      );

    case 403:
      return new ActionError(
        `The html2img API key is valid but the account has no active subscription (HTTP 403). Choose a plan at ${PRICING_URL}, then re-run this job.`,
      );

    case 404:
      return new ActionError(
        `The html2img API could not find that template (HTTP 404). Check the template input against the slugs listed at https://html2img.com/templates.`,
      );

    case 400:
    case 422:
      return new ActionError(
        `The html2img API rejected the request as invalid (HTTP ${status}).${formatDetails(payload)} See the parameter reference at ${DOCS_URL}.`,
      );

    case 429:
      return new ActionError(
        'The html2img API rate limit was exceeded (HTTP 429). Re-run this job in a moment, or spread renders across steps rather than issuing them at once.',
      );

    case 504:
      return new ActionError(
        `The render did not finish inside the html2img synchronous budget (HTTP 504)${suffix(reference)}. Remote fonts, large images and requests made by the page all count towards that budget: simplify the document, reduce the dimensions, or set wait-for-selector so the capture waits for the element you need rather than for everything.`,
      );

    default:
      if (status >= 500) {
        return new ActionError(
          `The html2img API returned a server error (HTTP ${status})${suffix(reference)}. Re-run the job; if it keeps failing, contact support and quote that reference.`,
        );
      }

      return new ActionError(
        `The html2img API returned an unexpected HTTP ${status}${suffix(reference)}. See ${DOCS_URL}.`,
      );
  }
}

/** Wrap a transport-level failure, where no response was ever received. */
export function connectionError(cause: unknown, timeoutMs: number): ActionError {
  const name = cause instanceof Error ? cause.name : null;

  if (name === 'TimeoutError' || name === 'AbortError') {
    return new ActionError(
      `The request to the html2img API timed out after ${timeoutMs}ms. This is usually a slow render rather than a network fault: simplify the document, or reduce the dimensions.`,
    );
  }

  return new ActionError(
    `Could not reach the html2img API: ${cause instanceof Error ? cause.message : String(cause)}. Check that the runner has outbound network access to app.html2img.com.`,
  );
}

/**
 * Render the per-field validation messages from a 422 body.
 *
 * Only the API's own messages are echoed, and the result is capped, so a
 * large document is never reproduced in the log.
 */
function formatDetails(payload: ErrorPayload): string {
  const details = payload['details'];

  if (details === null || typeof details !== 'object') {
    const message = asString(payload['error']) ?? asString(payload['message']);

    return message === null ? '' : ` ${message}.`;
  }

  const lines = Object.entries(details as Record<string, unknown>).map(([field, messages]) => {
    const text = Array.isArray(messages) ? messages.filter(isString).join(' ') : String(messages);

    return `${field}: ${text}`;
  });

  if (lines.length === 0) {
    return '';
  }

  return ` ${truncate(lines.join('; '), 500)}.`;
}

function suffix(reference: string | null): string {
  return reference === null ? '' : ` (reference ${reference})`;
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}
