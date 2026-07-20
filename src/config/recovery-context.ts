import type { RecoveryInfo } from './loader';

/**
 * Format a one-line `Config recovery applied: <recovery> — <section name>`
 * string for command-return output. Returns empty string when no recovery
 * happened, so callers can append the result directly to their user-facing
 * message without conditional checks.
 *
 * Designed for the FR-004 (issue #1690) surgical command-return contract:
 * `/swarm turbo on`, `/swarm full-auto on`, `/swarm close`, etc. should
 * surface affected section names when the loader had to fall back from the
 * user's config. NOT YET WIRED INTO ANY CALL SITE — `turbo.ts`, `full-auto.ts`,
 * and `close.ts` currently destructure only `{ config }` from
 * `loadPluginConfigWithMeta`/`Async` and discard `recovery`/`removedKeys`/
 * `warnings`. `doctor.ts` is the only current consumer of that metadata and
 * renders it inline rather than through this helper. Tracked as a follow-up;
 * do not assume this function runs anywhere until a caller is added.
 */
export function formatRecoveryContext(
	meta:
		| {
				recovery: RecoveryInfo['recovery'];
				removedKeys: string[];
				warnings: string[];
		  }
		| null
		| undefined,
): string {
	if (!meta || meta.recovery === 'none') return '';
	if (meta.recovery === 'user_only') {
		return 'Config recovery applied: project config ignored; falling back to user config.';
	}
	if (meta.recovery === 'guardrails_defaults') {
		return 'Config recovery applied: guardrails ENABLED; project config was unreadable. Fix the config file to restore custom configuration.';
	}
	// stripped_keys: name the affected sections from removedKeys (top-level)
	const sections = new Set<string>();
	for (const k of meta.removedKeys) {
		const top = k.split('.')[0];
		if (top) sections.add(top);
	}
	const sectionList = Array.from(sections).join(', ');
	return sectionList
		? `Config recovery applied: ${sectionList} — unrecognized keys were stripped.`
		: 'Config recovery applied: unrecognized keys were stripped.';
}
