import * as fs from 'node:fs';
import * as path from 'node:path';
import { advisoryWarn } from '../services/warning-buffer.js';
import { DEFAULT_MODELS } from './constants';

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
	_quiet = false,
): void {
	void directory;
	void _quiet;
	advisoryWarn(
		'[opencode-swarm] Skipping creation of .opencode/opencode-swarm.json; ' +
			'create it manually if you need project-local overrides.',
	);
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
