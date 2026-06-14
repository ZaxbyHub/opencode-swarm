import { join } from 'node:path';
import { KnowledgeConfigSchema } from '../config/schema.js';
import {
	migrateContextToKnowledge,
	migrateHiveKnowledgeLegacy,
} from '../hooks/knowledge-migrator.js';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
	transactKnowledge,
} from '../hooks/knowledge-store.js';
import type {
	KnowledgeEntryBase,
	SwarmKnowledgeEntry,
} from '../hooks/knowledge-types.js';
import {
	quarantineEntry,
	resolveUnactionablePath,
	restoreEntry,
} from '../hooks/knowledge-validator.js';
import type { HardenableRecord } from '../services/unactionable-hardening.js';

/**
 * Resolves a user-supplied ID or prefix against a list of entries.
 * Tries exact match first, then prefix match.
 * Returns the matched entry or an error message for zero or ambiguous matches.
 */
function resolveEntryByPrefix<T extends { id: string }>(
	entries: T[],
	inputId: string,
): { entry: T } | { error: string } {
	const exact = entries.find((e) => e.id === inputId);
	if (exact) return { entry: exact };

	const matches = entries.filter((e) => e.id.startsWith(inputId));
	if (matches.length === 0) {
		return { error: `No entry found matching '${inputId}'.` };
	}
	if (matches.length === 1) {
		return { entry: matches[0] };
	}
	const candidates = matches.map((e) => e.id).join('\n  ');
	return {
		error: `Ambiguous prefix '${inputId}' matches ${matches.length} entries:\n  ${candidates}`,
	};
}

/**
 * Handles /swarm knowledge quarantine <id> [reason] command.
 * Moves a knowledge entry to quarantine with optional reason.
 * Accepts a full ID or a unique prefix.
 */
export async function handleKnowledgeQuarantineCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const inputId = args[0];
	if (!inputId) {
		return 'Usage: /swarm knowledge quarantine <id> [reason]';
	}

	if (!/^[a-zA-Z0-9_-]{1,64}$/.test(inputId)) {
		return 'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.';
	}

	const reason =
		args.slice(1).join(' ') ||
		'Quarantined via /swarm knowledge quarantine command';

	try {
		const entries = await readKnowledge<KnowledgeEntryBase>(
			resolveSwarmKnowledgePath(directory),
		);
		const resolved = resolveEntryByPrefix(entries, inputId);
		if ('error' in resolved) {
			return `❌ ${resolved.error}`;
		}
		const fullId = resolved.entry.id;
		await quarantineEntry(directory, fullId, reason, 'user');
		return `✅ Entry ${fullId} quarantined successfully.`;
	} catch (error) {
		console.warn(
			'[knowledge-command] quarantineEntry error:',
			error instanceof Error ? error.message : String(error),
		);
		return `❌ Failed to quarantine entry. Check the entry ID and try again.`;
	}
}

/**
 * Handles /swarm knowledge restore <id> command.
 * Restores a quarantined knowledge entry.
 * Accepts a full ID or a unique prefix.
 */
export async function handleKnowledgeRestoreCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const inputId = args[0];
	if (!inputId) {
		return 'Usage: /swarm knowledge restore <id>';
	}

	if (!/^[a-zA-Z0-9_-]{1,64}$/.test(inputId)) {
		return 'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.';
	}

	try {
		const quarantinePath = join(
			directory,
			'.swarm',
			'knowledge-quarantined.jsonl',
		);
		const entries = await readKnowledge<KnowledgeEntryBase>(quarantinePath);
		const resolved = resolveEntryByPrefix(entries, inputId);
		if ('error' in resolved) {
			return `❌ ${resolved.error}`;
		}
		const fullId = resolved.entry.id;
		await restoreEntry(directory, fullId);
		return `✅ Entry ${fullId} restored successfully.`;
	} catch (error) {
		console.warn(
			'[knowledge-command] restoreEntry error:',
			error instanceof Error ? error.message : String(error),
		);
		return `❌ Failed to restore entry. Check the entry ID and try again.`;
	}
}

/**
 * Handles /swarm knowledge migrate [directory] command.
 * Triggers one-time migration from .swarm/context.md to .swarm/knowledge.jsonl.
 */
export async function handleKnowledgeMigrateCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const targetDir = args[0] || directory;
	const config = KnowledgeConfigSchema.parse({});

	try {
		// Run context.md → knowledge.jsonl migration
		const contextResult = await migrateContextToKnowledge(targetDir, config);

		// Run legacy hive-knowledge.jsonl → shared-learnings.jsonl migration
		const hiveResult = await migrateHiveKnowledgeLegacy(config);

		const messages: string[] = [];

		// Handle context migration result
		if (contextResult.skippedReason) {
			switch (contextResult.skippedReason) {
				case 'sentinel-exists':
					messages.push(
						'⏭ Context migration already completed. Delete .swarm/.knowledge-migrated to re-run.',
					);
					break;
				case 'no-context-file':
					messages.push('ℹ️ No .swarm/context.md found — nothing to migrate.');
					break;
				case 'empty-context':
					messages.push('ℹ️ .swarm/context.md is empty — nothing to migrate.');
					break;
			}
		} else {
			messages.push(
				`✅ Context migration: ${contextResult.entriesMigrated} entries added, ${contextResult.entriesDropped} dropped`,
			);
		}

		// Handle hive migration result
		if (hiveResult.skippedReason) {
			switch (hiveResult.skippedReason) {
				case 'sentinel-exists':
					messages.push(
						'⏭ Hive legacy migration already completed. Delete the sentinel in the hive data dir to re-run.',
					);
					break;
				case 'no-context-file':
					messages.push(
						'ℹ️ No legacy hive-knowledge.jsonl found — nothing to migrate.',
					);
					break;
			}
		} else if (hiveResult.migrated) {
			messages.push(
				`✅ Hive legacy migration: ${hiveResult.entriesMigrated} entries added, ${hiveResult.entriesDropped} dropped`,
			);
		}

		return messages.join('\n');
	} catch (error) {
		console.warn(
			'[knowledge-command] migration error:',
			error instanceof Error ? error.message : String(error),
		);
		return '❌ Migration failed. Check that knowledge source files are readable.';
	}
}

/**
 * Handles /swarm knowledge command (no subcommand) - lists knowledge entries.
 * Lists entries from .swarm/knowledge.jsonl with id, category, confidence, truncated text.
 */
export async function handleKnowledgeListCommand(
	directory: string,
	_args: string[],
): Promise<string> {
	try {
		const knowledgePath = resolveSwarmKnowledgePath(directory);
		const entries = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);

		if (entries.length === 0) {
			return 'ℹ️ No knowledge entries found in .swarm/knowledge.jsonl';
		}

		const lines: string[] = [
			`## Knowledge Entries (${entries.length} total)`,
			'',
			'| ID (prefix) | Category | Confidence | Lesson (truncated) |',
			'|--------------|----------|------------|---------------------|',
		];

		for (const entry of entries) {
			const truncatedLesson =
				entry.lesson.length > 60
					? `${entry.lesson.slice(0, 57)}...`
					: entry.lesson;
			const confidencePct = Math.round(entry.confidence * 100);
			lines.push(
				`| ${entry.id.slice(0, 12)}… | ${entry.category} | ${confidencePct}% | ${truncatedLesson} |`,
			);
		}

		lines.push('');
		lines.push(
			'Use `/swarm knowledge quarantine <id-prefix>` to hide an entry. Prefix matching is supported — the 12-character prefix shown is unique in most stores.',
		);

		return lines.join('\n');
	} catch (error) {
		console.warn(
			'[knowledge-command] list error:',
			error instanceof Error ? error.message : String(error),
		);
		return '❌ Failed to list knowledge entries. Ensure .swarm/knowledge.jsonl exists.';
	}
}

/**
 * Handles /swarm knowledge unactionable command.
 * Lists entries from the unactionable queue with retire_candidate status.
 */
export async function handleKnowledgeUnactionableCommand(
	directory: string,
	_args: string[],
): Promise<string> {
	try {
		const queuePath = resolveUnactionablePath(directory);
		const entries = await readKnowledge<HardenableRecord>(queuePath);

		if (entries.length === 0) {
			return 'No unactionable entries in the queue.';
		}

		const active = entries.filter((e) => !e.retire_candidate);
		const retired = entries.filter((e) => e.retire_candidate);

		const lines: string[] = [
			`## Unactionable Queue (${entries.length} total: ${active.length} pending, ${retired.length} retire candidates)`,
			'',
		];

		if (active.length > 0) {
			lines.push(
				'### Pending hardening',
				'',
				'| ID (prefix) | Lesson | Reason | Quarantined |',
				'|-------------|--------|--------|-------------|',
			);
			for (const entry of active) {
				const lesson =
					entry.lesson.length > 50
						? `${entry.lesson.slice(0, 47)}...`
						: entry.lesson;
				lines.push(
					`| ${entry.id.slice(0, 12)}… | ${lesson} | ${entry.unactionable_reason} | ${entry.quarantined_at?.slice(0, 10) ?? 'unknown'} |`,
				);
			}
			lines.push('');
		}

		if (retired.length > 0) {
			lines.push(
				'### Retire candidates (hardening failed)',
				'',
				'| ID (prefix) | Reason | Quarantined |',
				'|-------------|--------|-------------|',
			);
			for (const entry of retired) {
				lines.push(
					`| ${entry.id.slice(0, 12)}… | ${entry.unactionable_reason} | ${entry.quarantined_at?.slice(0, 10) ?? 'unknown'} |`,
				);
			}
			lines.push('');
		}

		lines.push(
			'Use `/swarm knowledge retry-hardening [id-prefix]` to reset retire candidates for re-processing on the next scheduled hardening pass.',
		);

		return lines.join('\n');
	} catch (error) {
		console.warn(
			'[knowledge-command] unactionable list error:',
			error instanceof Error ? error.message : String(error),
		);
		return 'Failed to list unactionable entries.';
	}
}

/**
 * Handles /swarm knowledge retry-hardening [id] command.
 * Resets retire_candidate flags so the next scheduled hardening pass re-attempts them.
 */
export async function handleKnowledgeRetryHardeningCommand(
	directory: string,
	args: string[],
): Promise<string> {
	const inputId = args[0];

	if (inputId && !/^[a-zA-Z0-9_-]{1,64}$/.test(inputId)) {
		return 'Invalid entry ID. IDs must be 1-64 characters: letters, digits, hyphens, underscores only.';
	}

	try {
		const queuePath = resolveUnactionablePath(directory);
		let resetCount = 0;

		await transactKnowledge<HardenableRecord>(queuePath, (current) => {
			let changed = false;
			const next: HardenableRecord[] = [];
			for (const rec of current) {
				if (!rec.retire_candidate) {
					next.push(rec);
					continue;
				}
				if (inputId) {
					if (rec.id === inputId || rec.id.startsWith(inputId)) {
						next.push({ ...rec, retire_candidate: undefined });
						resetCount++;
						changed = true;
					} else {
						next.push(rec);
					}
				} else {
					next.push({ ...rec, retire_candidate: undefined });
					resetCount++;
					changed = true;
				}
			}
			return changed ? next : null;
		});

		if (resetCount === 0) {
			return inputId
				? `No retire candidates found matching '${inputId}'.`
				: 'No retire candidates to reset.';
		}

		return `Reset ${resetCount} retire candidate(s). They will be re-processed on the next scheduled hardening pass.`;
	} catch (error) {
		console.warn(
			'[knowledge-command] retry-hardening error:',
			error instanceof Error ? error.message : String(error),
		);
		return 'Failed to reset retire candidates.';
	}
}
