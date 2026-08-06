/**
 * The html2img API client.
 *
 * Mirrors the endpoints and parameter names in the reference at
 * https://html2img.com/docs. Unset options are omitted from the body so the
 * API applies its own documented defaults.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

import * as core from '@actions/core';

import { ActionError, apiError, connectionError } from './errors';
import type { Inputs, RenderOptions } from './inputs';

const BASE_URL = 'https://app.html2img.com';

/** Just over the API's 30 second synchronous render budget. */
const TIMEOUT_MS = 35_000;

/** The useful fields of a successful render response. */
export interface Render {
  url: string;
  id: string | null;
  creditsRemaining: number | null;
}

/** Render the resolved inputs, returning the hosted image URL. */
export async function render(inputs: Inputs): Promise<Render> {
  const { endpoint, body } = requestFor(inputs);

  // Keys only: the body holds the document, which is never logged.
  core.debug(`POST ${endpoint} with fields: ${Object.keys(body).sort().join(', ')}`);

  const payload = await post(endpoint, body, inputs.apiKey);
  const url = asString(payload['url']);

  if (url === null) {
    throw new ActionError(
      `The html2img API accepted the request but returned no image URL${
        asString(payload['status']) === null ? '' : ` (status ${asString(payload['status'])})`
      }. Re-run the job; if it keeps happening, contact support.`,
    );
  }

  return {
    url,
    id: asString(payload['id']),
    creditsRemaining: asInteger(payload['credits_remaining']),
  };
}

/** Build the endpoint and JSON body for a render. */
function requestFor(inputs: Inputs): { endpoint: string; body: Record<string, unknown> } {
  const { source, options } = inputs;

  if (source.kind === 'template') {
    // A template's inputs are top-level keys of the body. `format` is the one
    // documented override, so it is applied last and wins.
    return {
      endpoint: `/api/v1/templates/${encodeURIComponent(source.slug)}`,
      body: compact({ ...source.variables, format: options.format }),
    };
  }

  if (source.kind === 'url') {
    return {
      endpoint: '/api/screenshot',
      body: compact({ url: source.url, ...parameters(options) }),
    };
  }

  return { endpoint: '/api/html', body: compact({ html: source.html, ...parameters(options) }) };
}

/** Map the render options onto the API's own parameter names. */
function parameters(options: RenderOptions): Record<string, unknown> {
  return {
    css: options.css,
    width: options.width,
    height: options.height,
    fullpage: options.fullpage,
    dpi: options.dpi,
    selector: options.selector,
    wait_for_selector: options.waitForSelector,
    format: options.format,
  };
}

/** POST a JSON body and decode the response, mapping every failure. */
async function post(
  endpoint: string,
  body: Record<string, unknown>,
  apiKey: string,
): Promise<Record<string, unknown>> {
  let response: Response;

  try {
    response = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'X-API-Key': apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (cause) {
    throw connectionError(cause, TIMEOUT_MS);
  }

  const payload = await decode(response);

  if (!response.ok) {
    throw apiError(response.status, payload);
  }

  return payload;
}

/** Download a rendered file into the workspace, creating parent directories. */
export async function download(url: string, outputPath: string): Promise<void> {
  const resolved = path.resolve(outputPath);

  let response: Response;

  try {
    // The rendered file is served publicly, so this carries no credentials.
    response = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (cause) {
    throw connectionError(cause, TIMEOUT_MS);
  }

  if (!response.ok) {
    throw new ActionError(
      `The render succeeded but downloading it returned HTTP ${response.status}. On the free plan renders are kept for 7 days, so a URL from an earlier run may have expired.`,
    );
  }

  const body = Buffer.from(await response.arrayBuffer());

  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, body);

  core.info(`Wrote ${outputPath} (${body.byteLength} bytes)`);
}

/** Decode a JSON body, tolerating a non-JSON error page. */
async function decode(response: Response): Promise<Record<string, unknown>> {
  let text: string;

  try {
    text = await response.text();
  } catch {
    return {};
  }

  if (text.trim() === '') {
    return {};
  }

  try {
    const parsed: unknown = JSON.parse(text);

    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Drop null and undefined values, as the API treats absence as its default. */
function compact(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body).filter(([, value]) => value != null));
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}
