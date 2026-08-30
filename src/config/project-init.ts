import * as fs from 'node:fs';
import * as path from 'node:path';
import packageJson from '../../package.json' with { type: 'json' };
import { DEFAULT_MODELS } from './constants';

/**
 * Absolute `$schema` reference written into config files this plugin authors
 * (issue #1663) so editors get validation/autocomplete from the shipped
 * opencode-swarm.schema.json. Version-pinned on purpose: the schema validating
 * a config file should be the one shipped by the plugin version that authored
 * it, and unpkg serves every published version. A relative path is unusable
 * because these config files live in the user's project/home directory,
 * outside the installed package. This is a DIFFERENT convention from the
 * unversioned canonical URL (CONFIG_SCHEMA_CANONICAL_URL in
 * scripts/generate-config-schema.ts) used as the artifact's `$id` and in
 * docs — both resolve to the same file in every published package.
 */
export const CONFIG_SCHEMA_REF = `https://unpkg.com/opencode-swarm@${packageJson.version}/opencode-swarm.schema.json`;

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
			$schema: CONFIG_SCHEMA_REF,
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
