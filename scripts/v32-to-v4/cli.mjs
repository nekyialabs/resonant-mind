#!/usr/bin/env node

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertNodeVersion } from './lib/runtime.mjs';
import { humanInspectReport, inspectSource, parseInspectSourceArgs } from './commands/inspect-source.mjs';
import { exportCommand, humanExportResult, parseExportArgs } from './commands/export.mjs';
import { humanVerifyResult, parseVerifyBundleArgs, verifyBundleCommand } from './commands/verify-bundle.mjs';
import {
  maybeInjectCheckpointFault,
} from './lib/checkpoints.mjs';
import { canonicalJson } from './lib/canonical-json.mjs';
import { compilePolicyCommand, humanCompilePolicyResult, parseCompilePolicyArgs } from './commands/compile-policy.mjs';
import { targetCommand, humanTargetResult } from './commands/target.mjs';
import { parsePlanImagesArgs, planImagesCommand, humanPlanImagesResult } from './commands/plan-images.mjs';
import { parseCopyImagesArgs, copyImagesCommand, humanCopyImagesResult } from './commands/copy-images.mjs';
import { parsePlanReembedArgs, planReembedCommand, humanPlanReembedResult } from './commands/plan-reembed.mjs';
import { parseValidateArgs, validateCommand, humanValidateResult } from './commands/validate.mjs';
import { parseStatusArgs, statusCommand, statusExitCode, humanStatusResult } from './commands/status.mjs';
import { draftDecisionsCommand, humanDraftDecisionsResult, parseDraftDecisionsArgs } from './commands/draft-decisions.mjs';
import { humanReviewDecisionsResult, jsonReviewDecisionsResult, parseReviewDecisionsArgs, reviewDecisionsCommand } from './commands/review-decisions.mjs';
import { applyDecisionsCommand, humanApplyDecisionsResult, parseApplyDecisionsArgs } from './commands/apply-decisions.mjs';
import { humanPlanRelationalResult, parsePlanRelationalArgs, planRelationalCommand } from './commands/plan-relational.mjs';
import { COMMANDS, fullHelp, usageFor } from './commands/usage.mjs';
import {
  exitCodeFor,
  isMigrationRefusal,
  MigrationRefusal,
  serializeRefusal,
} from './lib/refusal.mjs';

const commands = COMMANDS;
const help = fullHelp();

function stripCheckpointOptions(argv) {
  const checkpointOption = argv.find((value) => ['--checkpoint-dir', '--checkpoint-migration-id', '--checkpoint-artifact-sha256'].includes(value));
  if (checkpointOption !== undefined) throw new MigrationRefusal({ code: 'RMIG-E-CHECKPOINT', phase: 'runtime', summary: 'Checkpoint/resume is not a supported success path. Interrupted pre-commit runs must restart against a fresh target; do not reuse a partial target.', safe_details: { option: checkpointOption }, report_path: null });
  return { clean: argv, values: {} };
}
function recordCheckpoint(result) { return result; }
function applyCheckpointInputs(_command, args) { return args; }

function reportFailure(error, { json, writeStdout, writeStderr }) {
  if (isMigrationRefusal(error)) {
    const serialized = serializeRefusal(error, { json });
    (json ? writeStdout : writeStderr)(serialized);
    return exitCodeFor(error);
  }
  const summary = 'Unexpected internal migration error.';
  if (json) {
    writeStdout(canonicalJson({ code: 'RMIG-E-INTERNAL', summary }));
  } else {
    writeStderr(`RMIG-E-INTERNAL: ${summary}\n`);
  }
  return exitCodeFor(error);
}

// A refusal or failure from a command that runs asynchronously is reported the same way as one thrown
// synchronously: structured, on stdout as JSON when --json is set, otherwise on stderr.
export function main(options = {}) {
  const {
    argv = process.argv.slice(2),
    writeStdout = (value) => process.stdout.write(value),
    writeStderr = (value) => process.stderr.write(value),
  } = options;
  const outcome = runMain(options);
  if (!(outcome instanceof Promise)) return outcome;
  return outcome.catch((error) => reportFailure(error, { json: argv.includes('--json'), writeStdout, writeStderr }));
}

function runMain({
  argv = process.argv.slice(2),
  nodeMajor,
  writeStdout = (value) => process.stdout.write(value),
  writeStderr = (value) => process.stderr.write(value),
  runCommand,
} = {}) {
  let json = false;
  try {
    json = argv.includes('--json');
    const positionalArgv = argv.filter((argument) => argument !== '--json');
    assertNodeVersion(nodeMajor);
    const [command, ...rawCommandArgs] = positionalArgv;
    if (command === undefined || command === '--help') {
      writeStdout(help);
      return 0;
    }

    if (!commands.includes(command)) {
      throw new MigrationRefusal({
        code: 'RMIG-E-COMMAND-UNKNOWN',
        phase: 'runtime',
        summary: 'Unknown migration command. Run with --help to list commands.',
        safe_details: {},
        report_path: null,
      });
    }

    if (rawCommandArgs.includes('--help')) {
      writeStdout(usageFor(command));
      return 0;
    }
    const { clean: commandArgs } = stripCheckpointOptions(rawCommandArgs);
    maybeInjectCheckpointFault('__command-start__');
    if (runCommand !== undefined) return runCommand(command, commandArgs);
    if (command === 'normalise-source') {
      // loaded on demand: reading SQLite makes Node print its experimental-feature warning on stderr
      return import('./commands/normalise-source.mjs').then((module) => {
        const result = module.normaliseSourceCommand(module.parseNormaliseSourceArgs(commandArgs));
        writeStdout(json ? `${canonicalJson(result)}\n` : module.humanNormaliseSourceResult(result));
        return 0;
      });
    }
    if (command === 'export') {
      const parsed = parseExportArgs(commandArgs);
      return exportCommand(parsed).then((result) => {
        const checked = recordCheckpoint(result, 'bundle-finalized');
        if (json) writeStdout(`${canonicalJson(checked.manifest)}\n`);
        else writeStdout(humanExportResult(checked));
        return 0;
      });
    }
    if (command === 'verify-bundle') {
      const parsed = parseVerifyBundleArgs(commandArgs);
      return Promise.resolve(verifyBundleCommand(parsed)).then((result) => {
        if (json) writeStdout(`${canonicalJson(result.manifest)}\n`);
        else writeStdout(humanVerifyResult(result));
        return 0;
      });
    }
    if (command === 'draft-decisions') {
      const result = draftDecisionsCommand(parseDraftDecisionsArgs(commandArgs));
      writeStdout(json ? `${canonicalJson(result)}\n` : humanDraftDecisionsResult(result));
      return 0;
    }
    if (command === 'review-decisions') {
      const parsed = parseReviewDecisionsArgs(commandArgs);
      // the structured result never carries memory content, so --json would show the reader nothing: it needs the file to show it in
      if (json && parsed.htmlPath === undefined) throw new MigrationRefusal({ code: 'RMIG-E-SOURCE-ARG', phase: 'review-decisions', summary: 'review-decisions shows memory content and never puts it in JSON; use --html <file> with --json, or leave --json off to read it in the terminal.', safe_details: {}, report_path: null });
      const result = reviewDecisionsCommand(parsed);
      writeStdout(json ? `${canonicalJson(jsonReviewDecisionsResult(result))}\n` : humanReviewDecisionsResult(result));
      return 0;
    }
    if (command === 'apply-decisions') {
      const result = applyDecisionsCommand(parseApplyDecisionsArgs(commandArgs));
      writeStdout(json ? `${canonicalJson(result)}\n` : humanApplyDecisionsResult(result));
      return 0;
    }
    if (command === 'plan-relational') {
      const result = planRelationalCommand(parsePlanRelationalArgs(commandArgs));
      writeStdout(json ? `${canonicalJson(result)}\n` : humanPlanRelationalResult(result));
      return 0;
    }
    if (command === 'compile-policy') {
      const parsed = parseCompilePolicyArgs(commandArgs);
      const result = compilePolicyCommand(parsed);
      const checked = recordCheckpoint(result, 'policy-compiled');
      writeStdout(json ? `${canonicalJson(checked)}\n` : humanCompilePolicyResult(checked));
      return 0;
    }
    if (['inspect-target', 'prepare-target', 'dry-run', 'import'].includes(command)) {
      return targetCommand(command, applyCheckpointInputs(command, commandArgs)).then((result) => {
        const checkpointName = command === 'prepare-target' ? 'target-prepared' : command === 'dry-run' ? 'dry-run-accepted' : command === 'import' ? 'import-committed' : 'source-inspected';
        const checked = recordCheckpoint(result, checkpointName);
        writeStdout(json ? `${canonicalJson(checked)}\n` : humanTargetResult(checked));
        return 0;
      });
    }
    if (command === 'plan-images') return planImagesCommand(parsePlanImagesArgs(commandArgs)).then((result) => { const checked = recordCheckpoint(result, 'source-inspected'); writeStdout(json ? `${canonicalJson(checked)}\n` : humanPlanImagesResult(checked)); return 0; });
    if (command === 'copy-images') return copyImagesCommand(parseCopyImagesArgs(commandArgs)).then((result) => { const checked = recordCheckpoint(result, 'images-complete'); writeStdout(json ? `${canonicalJson(checked)}\n` : humanCopyImagesResult(checked)); return 0; });
    if (command === 'plan-reembed') return Promise.resolve(planReembedCommand(parsePlanReembedArgs(commandArgs))).then((result) => { const checked = recordCheckpoint(result, 'reembed-complete'); writeStdout(json ? `${canonicalJson(checked)}\n` : humanPlanReembedResult(checked)); return 0; });
    if (command === 'validate') return Promise.resolve(validateCommand(parseValidateArgs(commandArgs))).then((result) => { const checked = recordCheckpoint(result, 'validation-complete'); writeStdout(json ? `${canonicalJson(checked)}\n` : humanValidateResult(checked)); return 0; });
    if (command === 'status') return Promise.resolve(statusCommand({ ...parseStatusArgs(commandArgs), operatorCutoverAcknowledged: commandArgs.includes('--operator-cutover-ack') })).then((result) => { writeStdout(json ? `${canonicalJson(result)}\n` : humanStatusResult(result)); return statusExitCode(result); });
    if (command !== 'inspect-source') {
      throw new MigrationRefusal({
        code: 'RMIG-E-COMMAND-NOT-IMPLEMENTED',
        phase: command,
        summary: `Migration command "${command}" is not implemented yet.`,
        safe_details: {},
        report_path: null,
      });
    }
    const parsed = parseInspectSourceArgs(commandArgs);
    return inspectSource(parsed).then((report) => {
      const checked = recordCheckpoint(report, 'source-inspected');
      if (json) writeStdout(`${canonicalJson(checked)}\n`);
      else writeStdout(humanInspectReport(checked, parsed.reportPath));
      return 0;
    });
  } catch (error) {
    return reportFailure(error, { json, writeStdout, writeStderr });
  }
}

const isDirectInvocation =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirectInvocation) {
  const result = main();
  process.exitCode = result instanceof Promise
    ? await result.catch((error) => {
      if (isMigrationRefusal(error)) {
        process.stderr.write(serializeRefusal(error));
        return exitCodeFor(error);
      }
      process.stderr.write('RMIG-E-INTERNAL: Unexpected internal migration error.\n');
      return 1;
    })
    : result;
}
