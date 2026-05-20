import { join } from 'node:path';
import { KnowledgeConfigSchema } from '../config/schema.js';
import { migrateContextToKnowledge } from '../hooks/knowledge-migrator.js';
import {
	readKnowledge,
	resolveSwarmKnowledgePath,
} from '../hooks/knowledge-store.js';
import type {
	KnowledgeEntryBase,
	SwarmKnowledgeEntry,
} from '../hooks/knowledge-types.js';
import { quarantineEntry, restoreEntry } from '../hooks/knowledge-validator.js';

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

	try {
		const result = await migrateContextToKnowledge(
			targetDir,
			KnowledgeConfigSchema.parse({}),
		);

		if (result.skippedReason) {
			switch (result.skippedReason) {
				case 'sentinel-exists':
					return '⏭ Migration already completed for this project. Delete .swarm/.knowledge-migrated to re-run.';
				case 'no-context-file':
					return 'ℹ️ No .swarm/context.md found — nothing to migrate.';
				case 'empty-context':
					return 'ℹ️ .swarm/context.md is empty — nothing to migrate.';
				default:
					return '⚠️ Migration skipped for an unknown reason.';
			}
		}

		return `✅ Migration complete: ${result.entriesMigrated} entries added, ${result.entriesDropped} dropped (validation/dedup), ${result.entriesTotal} total processed.`;
	} catch (error) {
		console.warn(
			'[knowledge-command] migrateContextToKnowledge error:',
			error instanceof Error ? error.message : String(error),
		);
		return '❌ Migration failed. Check .swarm/context.md is readable.';
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
