/**
 * Entry point for the HTML to Image action.
 *
 * Resolves the inputs, skips the render when nothing has changed, and sets the
 * url, path and skipped outputs.
 */

import * as core from '@actions/core';

import { download, render } from './api';
import { exists, inputHash, readSidecar, sidecarPath, writeSidecar } from './cache';
import { resolveInputs } from './inputs';

async function run(): Promise<void> {
  const inputs = await resolveInputs();
  const hash = inputHash(inputs);

  if (inputs.outputPath !== undefined && inputs.skipUnchanged) {
    const cached = await readSidecar(inputs.outputPath);

    if (cached?.hash === hash && (await exists(inputs.outputPath))) {
      core.info(
        `Skipping the render: ${inputs.outputPath} is already up to date with ${sidecarPath(inputs.outputPath)}.`,
      );
      setOutputs({ url: cached.url ?? '', path: inputs.outputPath, skipped: true });

      return;
    }
  }

  const result = await render(inputs);

  core.info(`Rendered ${result.url}`);

  if (result.creditsRemaining !== null) {
    core.info(`Credits remaining: ${result.creditsRemaining}`);
  }

  if (inputs.outputPath === undefined) {
    setOutputs({ url: result.url, path: '', skipped: false });

    return;
  }

  await download(result.url, inputs.outputPath);
  await writeSidecar(inputs.outputPath, { hash, url: result.url });

  setOutputs({ url: result.url, path: inputs.outputPath, skipped: false });
}

function setOutputs(outputs: { url: string; path: string; skipped: boolean }): void {
  core.setOutput('url', outputs.url);
  core.setOutput('path', outputs.path);
  core.setOutput('skipped', String(outputs.skipped));
}

void run().catch((error: unknown) => {
  // An ActionError already reads as advice; anything else is unexpected, so
  // its message is passed through as-is.
  core.setFailed(error instanceof Error ? error.message : String(error));
});
