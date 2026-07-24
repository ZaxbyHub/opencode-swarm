/**
 * Handles the /swarm promote command.
 * Manually promotes lessons to hive knowledge.
 *
 * Usage:
 * - /swarm promote "<lesson text>" — Promote direct text
 * - /swarm promote --category <category> "<lesson text>" — Promote with category
 * - /swarm promote --from-swarm <lesson-id> — Promote from existing swarm lesson
 * - /swarm promote --force --reason "<why>" ... — Override failed policy gates
 *   with a durable, audited override record (issue #1847 §4). An exact entry id
 *   alone is NEVER authorization to bypass policy; an explicit override is.
 * - /swarm promote --applies-to-tools <a,b> --required-actions <a,b> "<text>"
 *   — Supply the actionability fields the default-on `actionability_floor`
 *   policy gate requires (issue #1821 A3). Without these the direct-text path
 *   has no swarm entry to inherit a predicate/scope from and every promotion
 *   would be blocked, forcing operators into `--force` and poisoning the
 *   override-audit signal. Ignored on `--from-swarm`, which inherits the source
 *   entry's own actionable-directive fields.
 */

import { loadPluginConfigWithMeta } from '../config';
import { KnowledgeConfigSchema } from '../config/schema';
import {
	type ManualActionabilityFields,
	type ManualPromotionOptions,
	promoteFromSwarm,
	promoteToHive,
} from '../hooks/hive-promoter';
import { dedupeCapped } from '../hooks/knowledge-store';
import type { KnowledgeConfig } from '../hooks/knowledge-types';

/**
 * Comma-separated list flags → the actionability field they populate.
 * Repeating a flag accumulates (the merged list is deduped and capped).
 */
const ACTIONABILITY_LIST_FLAGS: Partial<
	Record<string, keyof ManualActionabilityFields>
> = {
	'--applies-to-tools': 'applies_to_tools',
	'--applies-to-agents': 'applies_to_agents',
	'--required-actions': 'required_actions',
	'--forbidden-actions': 'forbidden_actions',
	'--verification-checks': 'verification_checks',
};

/** Same cap the knowledge store applies at its write boundary (#1821 Lane 0b). */
const ACTIONABILITY_FIELD_CAP = 20;

export async function handlePromoteCommand(
	directory: string,
	args: string[],
): Promise<string> {
	// Parse arguments
	let category: string | undefined;
	let lessonId: string | undefined;
	let lessonText: string | undefined;
	let force = false;
	let reason: string | undefined;
	const actionable: ManualActionabilityFields = {};

	// Simple argument parsing
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const actionabilityField = ACTIONABILITY_LIST_FLAGS[arg];

		if (arg === '--category' && i + 1 < args.length) {
			category = args[i + 1];
			i++; // Skip next arg
		} else if (arg === '--from-swarm' && i + 1 < args.length) {
			lessonId = args[i + 1];
			i++; // Skip next arg
		} else if (arg === '--force') {
			force = true;
		} else if (arg === '--reason' && i + 1 < args.length) {
			// Take the NEXT arg as the reason (quote multi-word reasons).
			// Mirrors --category / --from-swarm single-arg convention so the
			// lesson text is not swallowed by the reason.
			reason = args[i + 1];
			i++; // Skip next arg
		} else if (actionabilityField !== undefined && i + 1 < args.length) {
			// Comma-separated list; blank items dropped. Merge-then-normalize so a
			// repeated flag accumulates instead of overwriting, and the final list
			// is deduped (case-insensitively) and capped exactly once.
			const supplied = args[i + 1]
				.split(',')
				.map((v) => v.trim())
				.filter((v) => v.length > 0);
			actionable[actionabilityField] = dedupeCapped(
				[...(actionable[actionabilityField] ?? []), ...supplied],
				{ cap: ACTIONABILITY_FIELD_CAP },
			);
			i++; // Skip next arg
		} else if (!arg.startsWith('--')) {
			// Treat as lesson text (take the rest of the args as text)
			lessonText = args.slice(i).join(' ');
			break;
		}
	}

	// Validate input - check for empty lesson text or lesson ID
	if (!lessonText && !lessonId) {
		return `Usage: /swarm promote "<lesson text>" or /swarm promote --from-swarm <id>\nOptions: --category <cat>, --force --reason "<why>" (audited policy override)\nActionability (direct text only; required unless knowledge.promotion_require_actionable=false):\n  --applies-to-tools <a,b>, --applies-to-agents <a,b>,\n  --required-actions <a,b>, --forbidden-actions <a,b>, --verification-checks <a,b>`;
	}

	// --force requires --reason (an override without a reason is not auditable).
	if (force && (!reason || reason.length === 0)) {
		return `--force requires --reason "<why>" so the override is auditable.`;
	}

	const options: ManualPromotionOptions | undefined =
		force || reason ? { force, reason } : undefined;

	// Load the REAL user knowledge config (from opencode.json) so manual
	// promotion honors the same policy thresholds (dedup, application evidence,
	// cohort) as automatic promotion (AC9). Mirrors how close.ts loads its
	// config. Best-effort: fall back to schema defaults on any load/parse error.
	let config: KnowledgeConfig | undefined;
	try {
		const { config: loadedConfig } = loadPluginConfigWithMeta(directory);
		config = KnowledgeConfigSchema.parse(loadedConfig.knowledge ?? {});
	} catch {
		config = undefined; // promoter falls back to schema defaults internally
	}

	// Note: validateLesson is not needed here because promoteToHive and promoteFromSwarm
	// (imported from hooks/hive-promoter.ts) both validate internally inside the
	// transaction and return a diagnostic string on failure.

	// Handle --from-swarm case
	if (lessonId) {
		try {
			return await promoteFromSwarm(directory, lessonId, options, config);
		} catch (error) {
			if (error instanceof Error) {
				return error.message;
			}
			return `Failed to promote lesson: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	// Handle direct text promotion
	try {
		return await promoteToHive(
			directory,
			lessonText!,
			category,
			options,
			config,
			actionable,
		);
	} catch (error) {
		if (error instanceof Error) {
			return error.message;
		}
		return `Failed to promote lesson: ${error instanceof Error ? error.message : String(error)}`;
	}
}
