import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export const cliPath = resolve(repositoryRoot, 'scripts/v32-to-v4/cli.mjs');

/** Runs the migrator as a separate process, exactly as an operator (or an agent) would. */
export function runCli(args, env = {}) {
  const result = spawnSync(process.execPath, [cliPath, ...args], { cwd: repositoryRoot, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}\n${result.stderr}` };
}

/** Every file under a directory, as { path, text } (binary members are read as latin1 text). */
export function readTree(root) {
  const files = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory)) {
      const full = join(directory, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.push({ path: full, text: readFileSync(full, 'latin1') });
    }
  };
  walk(root);
  return files;
}

/** Fails if any secret string appears in any of the outputs or in any file under `root`. */
export function assertNoSecrets({ outputs, root, secrets, expect }) {
  for (const secret of secrets.filter(Boolean)) {
    for (const [index, text] of outputs.entries()) expect(text.includes(secret), `command output ${index}`).toBe(false);
    for (const file of readTree(root)) expect(file.text.includes(secret), `artifact ${file.path.slice(root.length)}`).toBe(false);
  }
}
