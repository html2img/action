/**
 * Reading and validating the action inputs.
 *
 * Anything invalid is caught here, before a request is sent, so a mistake in
 * a workflow file never costs a credit.
 */

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

import * as core from '@actions/core';

import { ActionError } from './errors';

/** Output format, matching the API's own `format` parameter. */
export type Format = 'png' | 'pdf';

/** The single render source, resolved from the mutually exclusive inputs. */
export type Source =
  | { kind: 'html'; html: string }
  | { kind: 'url'; url: string }
  | { kind: 'template'; slug: string; variables: Record<string, unknown> };

/** The fully resolved inputs for one render. */
export interface Inputs {
  apiKey: string;
  source: Source;
  /** Omitted when unset, so the API applies its own default of 1440. */
  width: number | undefined;
  /** Omitted when unset, so the API applies its own default of 900. */
  height: number | undefined;
  /** Omitted when unset, so the API applies its own default of png. */
  format: Format | undefined;
  outputPath: string | undefined;
  skipUnchanged: boolean;
}

const SOURCE_INPUTS = ['html', 'html-file', 'url', 'template'] as const;
const FORMATS: readonly string[] = ['png', 'pdf'];

/** The API's documented limits, checked here to fail fast and free. */
const MIN_DIMENSION = 1;
const MAX_DIMENSION = 5000;

/** Read every input, mask the key, and validate the combination. */
export async function resolveInputs(): Promise<Inputs> {
  // Not read with `required`, because the toolkit's own message for a missing
  // input does not explain the two reasons this is nearly always empty.
  const apiKey = core.getInput('api-key').trim();

  if (apiKey === '') {
    throw new ActionError(
      'The api-key input is empty. A secret that is not defined expands to an empty string, so check the name matches the repository secret exactly. Note that secrets are unavailable to workflows triggered by a pull request from a fork.',
    );
  }

  // Masked before anything else runs, so no later log line can reveal it even
  // if the key reaches an error message by accident.
  core.setSecret(apiKey);

  const format = readFormat();
  const outputPath = optional('output-path');
  const source = await readSource();
  const dimensions = readDimensions(source, format);

  warnAboutExtension(outputPath, format);

  return {
    apiKey,
    source,
    width: dimensions.width,
    height: dimensions.height,
    format,
    outputPath,
    skipUnchanged: readSkipUnchanged(),
  };
}

/** Read skip-unchanged, treating an absent value as the documented default. */
function readSkipUnchanged(): boolean {
  return optional('skip-unchanged') === undefined ? true : core.getBooleanInput('skip-unchanged');
}

/**
 * Read width and height, discarding them where the API ignores them.
 *
 * Discarding rather than merely warning keeps the request body and the cache
 * key in step, so a dimension that cannot change the output cannot force a
 * re-render either.
 */
function readDimensions(
  source: Source,
  format: Format | undefined,
): { width: number | undefined; height: number | undefined } {
  const width = readDimension('width');
  const height = readDimension('height');

  if (width === undefined && height === undefined) {
    return { width, height };
  }

  if (format === 'pdf') {
    core.warning(
      'PDF output is A4 portrait, so width and height are ignored. Drop them, or use format: png.',
    );

    return { width: undefined, height: undefined };
  }

  if (source.kind === 'template') {
    core.warning(
      'A template renders at its own size, so width and height are ignored. Each template documents the dimensions it produces.',
    );

    return { width: undefined, height: undefined };
  }

  return { width, height };
}

/** Resolve exactly one of html, html-file, url or template. */
async function readSource(): Promise<Source> {
  const provided = SOURCE_INPUTS.filter((name) => optional(name) !== undefined);

  if (provided.length === 0) {
    throw new ActionError(
      `No render source was given. Set exactly one of ${SOURCE_INPUTS.join(', ')}.`,
    );
  }

  if (provided.length > 1) {
    throw new ActionError(
      `The inputs ${provided.join(' and ')} are mutually exclusive. Set exactly one of ${SOURCE_INPUTS.join(', ')}.`,
    );
  }

  const variables = optional('variables');
  const chosen = provided[0];

  if (chosen !== 'template' && variables !== undefined) {
    throw new ActionError(
      'The variables input only applies to a template render. Set the template input as well, or drop variables.',
    );
  }

  switch (chosen) {
    case 'html':
      return { kind: 'html', html: core.getInput('html') };

    case 'html-file':
      return { kind: 'html', html: await readHtmlFile(core.getInput('html-file')) };

    case 'url':
      return { kind: 'url', url: readUrl(core.getInput('url')) };

    default:
      return {
        kind: 'template',
        slug: core.getInput('template').trim(),
        variables: parseVariables(variables),
      };
  }
}

/** Read the HTML document from a path in the workspace. */
async function readHtmlFile(file: string): Promise<string> {
  const resolved = path.resolve(file.trim());

  let contents: string;

  try {
    contents = await readFile(resolved, 'utf8');
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);

    throw new ActionError(
      `Could not read the html-file at ${resolved}: ${reason}. The path is resolved relative to the workspace, so check the step runs after the one that writes the file.`,
    );
  }

  if (contents.trim() === '') {
    throw new ActionError(`The html-file at ${resolved} is empty, so there is nothing to render.`);
  }

  return contents;
}

/** Require an absolute http(s) URL, which is what the API accepts. */
function readUrl(value: string): string {
  const trimmed = value.trim();

  let parsed: URL;

  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ActionError(
      `The url input is not a valid absolute URL: ${trimmed}. Include the scheme, for example https://example.com.`,
    );
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ActionError(
      `The url input must use http or https, but it uses ${parsed.protocol}. The API captures publicly reachable pages only.`,
    );
  }

  return trimmed;
}

/**
 * Parse the variables input into the template's own inputs.
 *
 * The templates endpoint takes those inputs as top-level keys of the request
 * body, so this must be a JSON object rather than an array or a scalar.
 */
function parseVariables(value: string | undefined): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);

    throw new ActionError(
      `The variables input is not valid JSON: ${reason}. Pass a JSON object, and prefer a block scalar (variables: |) so quotes survive YAML.`,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ActionError(
      `The variables input must be a JSON object of the template's inputs, but it is ${describe(parsed)}.`,
    );
  }

  return parsed as Record<string, unknown>;
}

function readFormat(): Format | undefined {
  const value = optional('format')?.toLowerCase();

  if (value === undefined) {
    return undefined;
  }

  if (!FORMATS.includes(value)) {
    throw new ActionError(
      `The format input must be png or pdf, but it is ${value}. The API does not produce JPEG.`,
    );
  }

  return value as Format;
}

function readDimension(name: 'width' | 'height'): number | undefined {
  const value = optional(name);

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < MIN_DIMENSION || parsed > MAX_DIMENSION) {
    throw new ActionError(
      `The ${name} input must be a whole number between ${MIN_DIMENSION} and ${MAX_DIMENSION}, but it is ${value}.`,
    );
  }

  return parsed;
}

/** Warn when output-path implies a different file type from the render. */
function warnAboutExtension(outputPath: string | undefined, format: Format | undefined): void {
  if (outputPath === undefined) {
    return;
  }

  const extension = path.extname(outputPath).toLowerCase();
  const effective = format ?? 'png';

  if (extension === '.jpg' || extension === '.jpeg') {
    core.warning(
      `output-path ends in ${extension}, but the API returns ${effective.toUpperCase()}. The file will be a ${effective.toUpperCase()} under a misleading name.`,
    );

    return;
  }

  if (extension !== '' && extension !== `.${effective}`) {
    core.warning(
      `output-path ends in ${extension}, but the render is ${effective.toUpperCase()}. Rename it to .${effective} to keep the file type honest.`,
    );
  }
}

/** An input that was left out entirely, as distinct from one set to "". */
function optional(name: string): string | undefined {
  const value = core.getInput(name);

  return value === '' ? undefined : value;
}

function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}
