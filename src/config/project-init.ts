import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_MODELS } from './constants';

const STARTER_CONTENT = '{}\n';

/**
 * Creates .opencode/opencode-swarm.json in the given directory if it does not
 * already exist. Uses an atomic exclusive write (flag 'wx') so concurrent
 * plugin loads never double-write or corrupt the file.
 *
 * Non-fatal: any fs error (permissions, disk full, etc.) is swallowed so the
 * plugin continues with its default or global config.
 */
export function writeProjectConfigIfNew(
	directory: string,
	quiet = false,
): void {
	try {
		const opencodeDir = path.join(directory, '.opencode');
		const dest = path.join(opencodeDir, 'opencode-swarm.json');

		// Defense in depth: refuse to write through a symlinked .opencode directory.
		// Matches the guard pattern in graph-store.ts.
		try {
			const stat = fs.lstatSync(opencodeDir);
			if (stat.isSymbolicLink()) return;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return;
			// ENOENT: directory doesn't exist yet — proceed to create it below.
		}

		if (!fs.existsSync(opencodeDir)) {
			fs.mkdirSync(opencodeDir, { recursive: true });
		}

		try {
			fs.writeFileSync(dest, STARTER_CONTENT, {
				encoding: 'utf-8',
				flag: 'wx',
			});
			if (!quiet) {
				console.warn(
					'[opencode-swarm] Created .opencode/opencode-swarm.json — ' +
						'edit it to customize agent LLMs for this project, or commit it to share settings with your team',
				);
			}
		} catch (_writeErr) {
			// EEXIST means the file already exists — skip silently.
			// All other write errors (EACCES, ENOSPC, etc.) are also non-fatal.
		}
	} catch {
		// mkdirSync failure or any other unexpected error — non-fatal.
	}
}

/**
 * Writes .swarm/config.example.json on first plugin init for a given project.
 * Creates .swarm/ if it does not yet exist. Non-fatal: all errors are silently
 * ignored.
 */
export function writeSwarmConfigExampleIfNew(projectDirectory: string): void {
	try {
		const swarmDir = path.join(projectDirectory, '.swarm');
		const dest = path.join(swarmDir, 'config.example.json');
		if (fs.existsSync(dest)) return;
		if (!fs.existsSync(swarmDir)) {
			fs.mkdirSync(swarmDir, { recursive: true });
		}
		const example = {
			agents: Object.fromEntries(
				Object.entries(DEFAULT_MODELS)
					.filter(([name]) => name !== 'default')
					.map(([name, model]) => [
						name,
						{
							model,
							fallback_models: ['opencode/gpt-5-nano', 'opencode/big-pickle'],
						},
					]),
			),
			max_iterations: 5,
		};
		fs.writeFileSync(dest, `${JSON.stringify(example, null, 2)}\n`, 'utf-8');
	} catch {
		// Non-fatal
	}
}
