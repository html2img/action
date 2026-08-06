/**
 * Reading and validating the action inputs.
 *
 * Anything invalid is caught here, before a request is sent, so a mistake in
 * a workflow file never costs a credit. Options the API would ignore are
 * dropped rather than merely warned about, which keeps the request body and
 * the cache digest in step: an option that cannot change the output cannot
 * force a re-render either.
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

/**
 * Render options, in the action's own naming.
 *
 * Every key is optional: an option that is left out is omitted from the
 * request so the API applies its own default.
 */
export interface RenderOptions {
  css?: string;
  width?: number;
  height?: number;
  fullpage?: boolean;
  dpi?: number;
  selector?: string;
  waitForSelector?: string;
  msDelay?: number;
  format?: Format;
  scaleToFit?: boolean;
}

/** The fully resolved inputs for one render. */
export interface Inputs {
  apiKey: string;
  source: Source;
  options: RenderOptions;
  outputPath: string | undefined;
  skipUnchanged: boolean;
}

const SOURCE_INPUTS = ['html', 'html-file', 'url', 'template'] as const;
const FORMATS: readonly string[] = ['png', 'pdf'];

/** The API's documented ranges, checked here to fail fast and free. */
const DIMENSION_RANGE = { min: 1, max: 5000 } as const;
const DPI_RANGE = { min: 1, max: 4 } as const;
const MS_DELAY_RANGE = { min: 1, max: 5000 } as const;

/** The input name behind each option, for messages. */
const INPUT_NAMES: Record<keyof RenderOptions, string> = {
  css: 'css',
  width: 'width',
  height: 'height',
  fullpage: 'full-page',
  dpi: 'dpi',
  selector: 'selector',
  waitForSelector: 'wait-for-selector',
  msDelay: 'ms-delay',
  format: 'format',
  scaleToFit: 'scale-to-fit',
};

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

  const outputPath = optional('output-path');
  const source = await readSource();
  const options = normalise(source, readOptions());

  warnAboutExtension(outputPath, options.format);

  return {
    apiKey,
    source,
    options,
    outputPath,
    skipUnchanged: readSkipUnchanged(),
  };
}

/** Read the render options as written, before any normalisation. */
function readOptions(): RenderOptions {
  return {
    css: optional('css'),
    width: readInteger('width', DIMENSION_RANGE),
    height: readInteger('height', DIMENSION_RANGE),
    fullpage: readBoolean('full-page'),
    dpi: readInteger('dpi', DPI_RANGE),
    selector: optional('selector')?.trim(),
    waitForSelector: optional('wait-for-selector')?.trim(),
    msDelay: readInteger('ms-delay', MS_DELAY_RANGE),
    format: readFormat(),
    scaleToFit: readBoolean('scale-to-fit'),
  };
}

/**
 * Discard options the API documents as having no effect for this render.
 *
 * The rules come from the parameter reference at https://html2img.com/docs.
 */
function normalise(source: Source, options: RenderOptions): RenderOptions {
  if (options.selector !== undefined && source.kind !== 'url') {
    throw new ActionError(
      'The selector input only applies to a url screenshot: it crops the capture to one element of a page being visited. Remove it, or render with url instead.',
    );
  }

  if (source.kind === 'template') {
    // A template's own inputs travel as top-level keys of the request body, so
    // sending render options alongside them risks colliding with an input of
    // the same name. Only format is a documented override.
    return drop(
      options,
      ['css', 'width', 'height', 'fullpage', 'dpi', 'waitForSelector', 'msDelay', 'scaleToFit'],
      'for a template render',
      'A template renders at its own size from its own inputs.',
    );
  }

  let result = options;

  if (result.format !== 'pdf') {
    // scale_to_fit only decides how a document is fitted to the A4 page.
    result = drop(
      result,
      ['scaleToFit'],
      'unless format is pdf',
      'It fits a wide layout to the A4 page width; an image is sized by width and height instead.',
    );
  }

  if (result.format === 'pdf') {
    // PDF output is A4 portrait and vector, so sizing and cropping do not
    // apply. css and wait-for-selector still affect what gets rendered.
    result = drop(
      result,
      ['width', 'height', 'fullpage', 'dpi', 'selector'],
      'when format is pdf',
      'PDF output is A4 portrait and paginates long content automatically.',
    );
  }

  if (result.fullpage === true) {
    result = drop(
      result,
      ['height'],
      'when full-page is true',
      'The image takes the height of the content.',
    );

    if (result.dpi !== undefined && result.dpi > 1) {
      result = drop(
        result,
        ['dpi'],
        'when full-page is true',
        'The API forces dpi to 1 for a full-page capture; raise width instead for a larger image.',
      );
    }
  }

  return result;
}

/** Drop options that have no effect, naming them once in a single warning. */
function drop(
  options: RenderOptions,
  keys: readonly (keyof RenderOptions)[],
  reason: string,
  explanation: string,
): RenderOptions {
  const dropped = keys.filter((key) => options[key] !== undefined);

  if (dropped.length === 0) {
    return options;
  }

  const names = sentenceList(dropped.map((key) => INPUT_NAMES[key]));
  const one = dropped.length === 1;

  core.warning(
    `${names} ${one ? 'has' : 'have'} no effect ${reason}, so ${one ? 'it is' : 'they are'} ignored. ${explanation}`,
  );

  const result = { ...options };

  for (const key of dropped) {
    delete result[key];
  }

  return result;
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

function readInteger(
  name: 'width' | 'height' | 'dpi' | 'ms-delay',
  range: { min: number; max: number },
): number | undefined {
  const value = optional(name);

  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);

  if (!Number.isInteger(parsed) || parsed < range.min || parsed > range.max) {
    throw new ActionError(
      `The ${name} input must be a whole number between ${range.min} and ${range.max}, but it is ${value}.`,
    );
  }

  return parsed;
}

function readBoolean(name: string): boolean | undefined {
  return optional(name) === undefined ? undefined : core.getBooleanInput(name);
}

/** Read skip-unchanged, treating an absent value as the documented default. */
function readSkipUnchanged(): boolean {
  return optional('skip-unchanged') === undefined ? true : core.getBooleanInput('skip-unchanged');
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

function sentenceList(items: readonly string[]): string {
  if (items.length <= 1) {
    return items[0] ?? '';
  }

  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  return Array.isArray(value) ? 'an array' : `a ${typeof value}`;
}
