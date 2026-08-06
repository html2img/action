/**
 * Skipping renders whose inputs have not changed.
 *
 * The resolved inputs are hashed and stored beside the downloaded file. When
 * the file and a matching hash are both present, the render is a no-op and
 * costs no credit. The API key is never part of the hash, so rotating a key
 * does not invalidate committed output.
 */

import { createHash } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';

import type { Inputs, Source } from './inputs';

/** The sidecar recorded next to a downloaded render. */
export interface Sidecar {
  hash: string;
  /** The hosted URL, replayed as the url output on a skip. */
  url?: string;
}

/** The suffix appended to output-path to locate the sidecar. */
const SIDECAR_SUFFIX = '.html2img-hash';

/**
 * Hash everything that affects the rendered bytes.
 *
 * Object keys are emitted in a stable order so that reordering `variables` in
 * a workflow file does not force a re-render.
 */
export function inputHash(inputs: Inputs): string {
  const canonical = stringify({
    source: describeSource(inputs.source),
    width: inputs.width ?? null,
    height: inputs.height ?? null,
    format: inputs.format ?? null,
  });

  return createHash('sha256').update(canonical).digest('hex');
}

export function sidecarPath(outputPath: string): string {
  return `${outputPath}${SIDECAR_SUFFIX}`;
}

/** Read the sidecar, returning null when it is absent or unreadable. */
export async function readSidecar(outputPath: string): Promise<Sidecar | null> {
  let contents: string;

  try {
    contents = await readFile(sidecarPath(outputPath), 'utf8');
  } catch {
    return null;
  }

  const trimmed = contents.trim();

  if (trimmed === '') {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(trimmed);

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }

    const record = parsed as Record<string, unknown>;
    const hash = record['hash'];
    const url = record['url'];

    if (typeof hash !== 'string' || hash === '') {
      return null;
    }

    return typeof url === 'string' && url !== '' ? { hash, url } : { hash };
  } catch {
    // A hand-written or hand-edited sidecar holding only the digest.
    return /^[0-9a-f]{64}$/.test(trimmed) ? { hash: trimmed } : null;
  }
}

export async function writeSidecar(outputPath: string, sidecar: Sidecar): Promise<void> {
  await writeFile(sidecarPath(outputPath), `${stringify(sidecar)}\n`, 'utf8');
}

export async function exists(target: string): Promise<boolean> {
  try {
    await access(target);

    return true;
  } catch {
    return false;
  }
}

/**
 * Reduce a source to what changes the output.
 *
 * An html-file is hashed by its contents, not its path, so moving a file does
 * not trigger a re-render and editing one does.
 */
function describeSource(source: Source): Record<string, unknown> {
  switch (source.kind) {
    case 'html':
      return { kind: 'html', html: source.html };

    case 'url':
      return { kind: 'url', url: source.url };

    default:
      return { kind: 'template', slug: source.slug, variables: source.variables };
  }
}

/** JSON with object keys sorted at every depth, for a stable digest. */
function stringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  return Object.fromEntries(entries.map(([key, nested]) => [key, sortKeys(nested)]));
}
