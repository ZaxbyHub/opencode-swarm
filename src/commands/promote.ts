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
 */

import {
	type ManualPromotionOptions,
	promoteFromSwarm,
	promoteToHive,
} from '../hooks/hive-promoter';
import { KnowledgeConfigSchema } from '../config/schema';
import { loadPluginConfigWithMeta } from '../config';
import type { KnowledgeConfig } from '../hooks/knowledge-types';

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

	// Simple argument parsing
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === '--category' && i + 1 < args.length) {
			category = args[i + 1];
			i++; // Skip next arg
		} else if (arg === '--from-swarm' && i + 1 < args.length) {
			lessonId = args[i + 1];
			i++; // Skip next arg
		} else if (arg === '--force') {
			force = true;
		} else if (arg === '--reason' && i + 1 < args.length) {
			// Join the remainder of the args until the next flag as the reason.
			const reasonParts: string[] = [];
			let j = i + 1;
			while (j < args.length && !args[j].startsWith('--')) {
				reasonParts.push(args[j]);
				j++;
			}
			reason = reasonParts.join(' ').trim();
			i = j - 1;
		} else if (!arg.startsWith('--')) {
			// Treat as lesson text (take the rest of the args as text)
			lessonText = args.slice(i).join(' ');
			break;
		}
	}

	// Validate input - check for empty lesson text or lesson ID
	if (!lessonText && !lessonId) {
		return `Usage: /swarm promote "<lesson text>" or /swarm promote --from-swarm <id>\nOptions: --category <cat>, --force --reason "<why>" (audited policy override)`;
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
		return await promoteToHive(directory, lessonText!, category, options, config);
	} catch (error) {
		if (error instanceof Error) {
			return error.message;
		}
		return `Failed to promote lesson: ${error instanceof Error ? error.message : String(error)}`;
	}
}
