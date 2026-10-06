/**
 * Epic Mode config master gates.
 *
 * `epic.mode.enabled` and `epic.cochange.enabled` are documented as opt-in
 * master gates (both default `false`). This module is the single source of
 * truth for reading them so every Epic entry point (slash commands, architect
 * tools, agent tool maps, the hot-path seams, phase-complete readiness)
 * agrees. Both read the effective Epic block via `resolveEpicConfig`
 * (`./config.ts`: top-level `epic`, legacy `turbo.epic` fallback).
 *
 * Pure predicates take an already-loaded `PluginConfig`; callers that only
 * have a directory use the `*ForDirectory` variants, which load config via
 * `loadPluginConfigWithMeta` and fail closed (return `false`) if loading
 * throws.
 */

import { loadPluginConfigWithMeta } from '../config/loader.js';
import { isEpicModeConfigEnabled } from './config.js';

/** The pure gates live in `./config.ts`; re-exported here for gate callers. */
export {
	isEpicCochangeConfigEnabled,
	isEpicModeConfigEnabled,
} from './config.js';

/** Remediation text shown when Epic Mode is used without the config opt-in. */
export const EPIC_MODE_CONFIG_DISABLED_MESSAGE =
	'Epic Mode is disabled by config. Set `epic.mode.enabled: true` in ' +
	'.opencode/opencode-swarm.json (or your user config) to opt in, then retry. ' +
	'Example: `{ "epic": { "mode": { "enabled": true } } }` (no `turbo` block ' +
	'is needed).';

export const _internals = {
	loadPluginConfigWithMeta,
};

/** Directory-keyed variant of {@link isEpicModeConfigEnabled}; fails closed. */
export function isEpicModeConfigEnabledForDirectory(
	directory: string,
): boolean {
	try {
		return isEpicModeConfigEnabled(
			_internals.loadPluginConfigWithMeta(directory).config,
		);
	} catch {
		return false;
	}
}
