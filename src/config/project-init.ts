import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_MODELS } from './constants';

/**
 * Intentionally a no-op.
 *
 * Issue #2420: the plugin no longer auto-creates project-level
 * `.opencode/opencode-swarm.json` overrides because empty starter files are
 * frequently mistaken for active overrides.
 */
export function writeProjectConfigIfNew(
	_directory: string,
	_quiet = false,
): void {
	// No-op by design: do not auto-create project override files.
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
