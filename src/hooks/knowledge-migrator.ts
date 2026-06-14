/** One-time migration from .swarm/context.md → .swarm/knowledge.jsonl for existing projects. */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import * as logger from '../utils/logger';
import {
	appendKnowledge,
	findNearDuplicate,
	inferTags,
	normalize,
	readKnowledge,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
	rewriteKnowledge,
} from './knowledge-store.js';
import type {
	HiveKnowledgeEntry,
	KnowledgeCategory,
	KnowledgeConfig,
	SwarmKnowledgeEntry,
} from './knowledge-types.js';
import { KNOWLEDGE_SCHEMA_VERSION } from './knowledge-types.js';
import { validateLesson } from './knowledge-validator.js';

// ============================================================================
// Exported Types
// ============================================================================

export interface MigrationResult {
	migrated: boolean;
	entriesMigrated: number;
	entriesDropped: number;
	entriesTotal: number;
	entryErrors?: string[];
	skippedReason?:
		| 'sentinel-exists'
		| 'no-context-file'
		| 'empty-context'
		| 'external-sentinel-exists';
}

// Stub for external migration (not yet implemented)
export async function migrateKnowledgeToExternal(
	_directory: string,
	_config: KnowledgeConfig,
): Promise<MigrationResult> {
	return {
		migrated: false,
		entriesMigrated: 0,
		entriesDropped: 0,
		entriesTotal: 0,
		skippedReason: 'no-context-file',
	};
}

// ============================================================================
// Internal Types
// ============================================================================

interface RawMigrationEntry {
	text: string;
	sourceSection: 'lessons-learned' | 'patterns' | 'sme-cache' | 'decisions';
	categoryHint: KnowledgeCategory | null;
}

interface Section {
	heading: string;
	body: string;
}

// ============================================================================
// DI Seam — _internals (declared before functions that use it to avoid TDZ)
// ============================================================================

export const _internals = {
	appendKnowledge,
	migrateContextToKnowledge,
	migrateKnowledgeToExternal,
	migrateHiveKnowledgeLegacy,
	parseContextMd,
	splitIntoSections,
	extractBullets,
	inferCategoryFromText,
	truncateLesson,
	inferProjectName,
	writeSentinel,
	resolveLegacyHiveKnowledgePath,
};

// ============================================================================
// Main Export
// ============================================================================

export async function migrateContextToKnowledge(
	directory: string,
	config: KnowledgeConfig,
): Promise<MigrationResult> {
	// Compute paths
	const sentinelPath = path.join(directory, '.swarm', '.knowledge-migrated');
	const contextPath = path.join(directory, '.swarm', 'context.md');
	const knowledgePath = resolveSwarmKnowledgePath(directory);

	// Gate 1: Check if migration already happened
	if (existsSync(sentinelPath)) {
		return {
			migrated: false,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
			skippedReason: 'sentinel-exists',
		};
	}

	// Gate 2: Check if context.md exists
	if (!existsSync(contextPath)) {
		return {
			migrated: false,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
			skippedReason: 'no-context-file',
		};
	}

	// Read context.md
	const contextContent = await readFile(contextPath, 'utf-8');
	if (contextContent.trim().length === 0) {
		return {
			migrated: false,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
			skippedReason: 'empty-context',
		};
	}

	// Parse context.md into raw entries
	const rawEntries = _internals.parseContextMd(contextContent);

	// If no entries, write sentinel and return
	if (rawEntries.length === 0) {
		await _internals.writeSentinel(sentinelPath, 0, 0);
		return {
			migrated: true,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
		};
	}

	// Load existing knowledge entries
	const existing = await readKnowledge<SwarmKnowledgeEntry>(knowledgePath);

	let migrated = 0;
	let dropped = 0;

	const projectName = _internals.inferProjectName(directory);

	// Process each raw entry
	for (const raw of rawEntries) {
		// Validate if enabled
		if (config.validation_enabled !== false) {
			const category =
				raw.categoryHint ?? _internals.inferCategoryFromText(raw.text);
			const result = validateLesson(
				raw.text,
				existing.map((e) => e.lesson),
				{
					category,
					scope: 'global',
					confidence: 0.3,
				},
			);
			if (!result.valid) {
				dropped++;
				continue;
			}
		}

		// Check for duplicates
		const dup = findNearDuplicate(
			raw.text,
			existing,
			config.dedup_threshold ?? 0.6,
		);
		if (dup) {
			dropped++;
			continue;
		}

		// Build the entry
		const inferredTags = inferTags(raw.text);
		const entry: SwarmKnowledgeEntry = {
			id: randomUUID(),
			tier: 'swarm',
			lesson: _internals.truncateLesson(raw.text),
			category: raw.categoryHint ?? _internals.inferCategoryFromText(raw.text),
			tags: [...inferredTags, `migration:${raw.sourceSection}`],
			scope: 'global',
			confidence: 0.3,
			status: 'candidate',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: config.schema_version ?? KNOWLEDGE_SCHEMA_VERSION,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			project_name: projectName,
			auto_generated: true,
		};

		existing.push(entry);
		migrated++;
	}

	// Rewrite knowledge file if any entries were migrated
	if (migrated > 0) {
		await rewriteKnowledge(knowledgePath, existing);
	}

	// Write sentinel file
	await _internals.writeSentinel(sentinelPath, migrated, dropped);

	// Log migration result
	logger.log(
		`[knowledge-migrator] Migrated ${migrated} entries, dropped ${dropped}`,
	);

	return {
		migrated: true,
		entriesMigrated: migrated,
		entriesDropped: dropped,
		entriesTotal: rawEntries.length,
	};
}

/**
 * Migrate legacy hive knowledge from {platform-data-dir}/hive-knowledge.jsonl
 * to {platform-data-dir}/shared-learnings.jsonl with HiveKnowledgeEntry schema.
 *
 * This handles data that was created before the dual-hive-promoter consolidation (v7.63.0).
 * Legacy entries were in a flat schema; this converts them to the current HiveKnowledgeEntry format
 * and deduplicates against existing hive entries.
 *
 * @param config - Knowledge configuration
 * @returns Migration result with counts and status
 */
export async function migrateHiveKnowledgeLegacy(
	config: KnowledgeConfig,
): Promise<MigrationResult> {
	// Compute paths
	const legacyHivePath = _internals.resolveLegacyHiveKnowledgePath();
	const canonicalHivePath = resolveHiveKnowledgePath();
	const sentinelPath = path.join(
		path.dirname(canonicalHivePath),
		'.hive-knowledge-migrated',
	);

	// Gate 1: Check if migration already happened
	if (existsSync(sentinelPath)) {
		return {
			migrated: false,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
			skippedReason: 'sentinel-exists',
		};
	}

	// Gate 2: Check if legacy file exists
	if (!existsSync(legacyHivePath)) {
		return {
			migrated: false,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
			skippedReason: 'no-context-file',
		};
	}

	// Read legacy entries
	const legacyEntries =
		await readKnowledge<Record<string, unknown>>(legacyHivePath);

	if (legacyEntries.length === 0) {
		await _internals.writeSentinel(sentinelPath, 0, 0);
		return {
			migrated: true,
			entriesMigrated: 0,
			entriesDropped: 0,
			entriesTotal: 0,
		};
	}

	// Read existing canonical hive entries for deduplication
	const existingHiveEntries =
		await readKnowledge<HiveKnowledgeEntry>(canonicalHivePath);

	let migrated = 0;
	let dropped = 0;
	const entryErrors: string[] = [];

	// Process each legacy entry
	for (const legacyEntry of legacyEntries) {
		try {
			const lesson = (legacyEntry as Record<string, unknown>).lesson as string;
			if (!lesson || typeof lesson !== 'string' || lesson.length < 15) {
				dropped++;
				continue;
			}

			// Check for near-duplicate against existing hive entries
			const dup = findNearDuplicate(
				lesson,
				existingHiveEntries,
				config.dedup_threshold ?? 0.6,
			);
			if (dup) {
				dropped++;
				continue;
			}

			// Validate lesson
			const category =
				((legacyEntry as Record<string, unknown>).category as string) ||
				'process';
			const validationResult = validateLesson(
				lesson,
				existingHiveEntries.map((e) => e.lesson),
				{
					category: category as KnowledgeCategory,
					scope: 'global',
					confidence: 0.3,
				},
			);
			if (!validationResult.valid) {
				const errorMsg = `Validation failed for legacy entry: ${validationResult.reason}`;
				entryErrors.push(errorMsg);
				logger.warn(`[knowledge-migrator] ${errorMsg}`);
				dropped++;
				continue;
			}

			// Convert legacy entry to HiveKnowledgeEntry format
			const confidence =
				((legacyEntry as Record<string, unknown>).confidence as
					| number
					| null
					| undefined) ?? 0.8;
			const scopeTag =
				((legacyEntry as Record<string, unknown>).scope_tag as string) ||
				'global';

			// ID collision check: if legacy ID already exists in canonical store, generate new UUID
			const legacyId = (legacyEntry as Record<string, unknown>).id as
				| string
				| undefined;
			const existingIds = new Set(existingHiveEntries.map((e) => e.id));
			const resolvedId =
				legacyId && existingIds.has(legacyId)
					? randomUUID()
					: legacyId || randomUUID();
			if (legacyId && existingIds.has(legacyId)) {
				logger.warn(
					`[knowledge-migrator] Legacy entry ID collision for "${legacyId}", generating new UUID`,
				);
			}

			const newHiveEntry: HiveKnowledgeEntry = {
				id: resolvedId,
				tier: 'hive',
				lesson: _internals.truncateLesson(lesson),
				category: category as KnowledgeCategory,
				tags: ['migration:legacy-hive'],
				scope: scopeTag,
				confidence: Math.min(Math.max(confidence, 0), 1),
				status: 'established',
				confirmed_by: [],
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: KNOWLEDGE_SCHEMA_VERSION,
				created_at:
					((legacyEntry as Record<string, unknown>).created_at as string) ||
					new Date().toISOString(),
				updated_at:
					((legacyEntry as Record<string, unknown>).updated_at as string) ||
					new Date().toISOString(),
				source_project: 'legacy-promotion',
				encounter_score: 1.0,
			};

			try {
				await _internals.appendKnowledge(canonicalHivePath, newHiveEntry);
				existingHiveEntries.push(newHiveEntry);
				migrated++;
			} catch (appendError) {
				const errorMsg = `Failed to append entry: ${appendError instanceof Error ? appendError.message : String(appendError)}`;
				entryErrors.push(errorMsg);
				logger.warn(`[knowledge-migrator] ${errorMsg}`);
				dropped++;
			}
		} catch (entryError) {
			const errorMsg = `Unexpected error processing legacy entry: ${entryError instanceof Error ? entryError.message : String(entryError)}`;
			entryErrors.push(errorMsg);
			logger.warn(`[knowledge-migrator] ${errorMsg}`);
			dropped++;
		}
	}

	// Write sentinel file
	await _internals.writeSentinel(sentinelPath, migrated, dropped);

	// Log migration result
	logger.log(
		`[knowledge-migrator] Migrated ${migrated} legacy hive entries, dropped ${dropped}`,
	);

	return {
		migrated: true,
		entriesMigrated: migrated,
		entriesDropped: dropped,
		entriesTotal: legacyEntries.length,
		...(entryErrors.length > 0 && { entryErrors }),
	};
}

// ============================================================================
// Internal Helper Functions
// ============================================================================

/**
 * Parse context.md content into raw migration entries.
 * Extracts bullets from sections matching: lessons-learned, patterns, sme-cache, decisions.
 */
function parseContextMd(content: string): RawMigrationEntry[] {
	const sections = _internals.splitIntoSections(content);
	const entries: RawMigrationEntry[] = [];
	const seen = new Set<string>();

	// Section name patterns
	const sectionPatterns: Array<{
		pattern: RegExp;
		sourceSection: RawMigrationEntry['sourceSection'];
	}> = [
		{
			pattern: /^#{1,3}\s+lessons?\s+learned/i,
			sourceSection: 'lessons-learned',
		},
		{ pattern: /^#{1,3}\s+patterns?/i, sourceSection: 'patterns' },
		{ pattern: /^#{1,3}\s+sme\s+cache/i, sourceSection: 'sme-cache' },
		{ pattern: /^#{1,3}\s+decisions?/i, sourceSection: 'decisions' },
	];

	for (const section of sections) {
		// Find matching section type
		const match = sectionPatterns.find((sp) =>
			sp.pattern.test(section.heading),
		);
		if (!match) continue;

		// Extract bullets from section body
		const bullets = _internals.extractBullets(section.body);

		for (const bullet of bullets) {
			// Filter by length
			if (bullet.length < 15) continue;

			// Deduplicate by normalized text
			const normalized = normalize(bullet);
			if (seen.has(normalized)) continue;
			seen.add(normalized);

			entries.push({
				text: _internals.truncateLesson(bullet),
				sourceSection: match.sourceSection,
				categoryHint: _internals.inferCategoryFromText(bullet),
			});
		}
	}

	return entries;
}

/**
 * Split markdown content into sections based on headings (h1-h3).
 */
function splitIntoSections(content: string): Section[] {
	const sections: Section[] = [];
	const headingRegex = /^(#{1,3})\s+(.+)/gm;

	const matches: Array<{ index: number; heading: string }> = [];
	let match: RegExpExecArray | null = headingRegex.exec(content);
	while (match !== null) {
		matches.push({
			index: match.index,
			heading: match[0],
		});
		match = headingRegex.exec(content);
	}

	for (let i = 0; i < matches.length; i++) {
		const current = matches[i];
		const next = matches[i + 1];
		const bodyStart = current.index + current.heading.length;
		const bodyEnd = next ? next.index : content.length;
		const body = content.slice(bodyStart, bodyEnd).trim();

		sections.push({
			heading: current.heading,
			body,
		});
	}

	return sections;
}

/**
 * Extract bullet points from markdown body text.
 * Matches lines starting with - or * followed by content.
 */
function extractBullets(body: string): string[] {
	const bullets: string[] = [];
	const bulletRegex = /^\s*[-*]\s+(.+)/;
	for (const line of body.split('\n')) {
		const match = line.match(bulletRegex);
		if (match) {
			bullets.push(match[1].trim());
		}
	}
	return bullets;
}

/**
 * Infer knowledge category from text using keyword matching.
 */
function inferCategoryFromText(text: string): KnowledgeCategory {
	const lower = text.toLowerCase();

	if (/\b(?:test|spec|vitest|jest)\b/.test(lower)) return 'testing';
	if (/\b(?:security|auth|token|password|encrypt)\b/.test(lower))
		return 'security';
	if (/\b(?:performance|latency|cache|throughput)\b/.test(lower))
		return 'performance';
	if (/\b(?:architecture|design|pattern|structure)\b/.test(lower))
		return 'architecture';
	if (/\b(?:debug|error|fix|bug|issue)\b/.test(lower)) return 'debugging';
	if (/\b(?:tool|config|setup|install|build)\b/.test(lower)) return 'tooling';
	if (/\b(?:integrate|api|hook|connect)\b/.test(lower)) return 'integration';
	if (/\b(?:process|workflow|step|approach)\b/.test(lower)) return 'process';

	return 'other';
}

/**
 * Truncate lesson text to maximum 280 characters.
 */
function truncateLesson(text: string): string {
	if (text.length <= 280) return text;
	return `${text.slice(0, 277)}...`;
}

/**
 * Infer project name from package.json or directory basename.
 */
function inferProjectName(directory: string): string {
	const packageJsonPath = path.join(directory, 'package.json');

	if (existsSync(packageJsonPath)) {
		try {
			const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
			if (pkg.name && typeof pkg.name === 'string') {
				return pkg.name;
			}
		} catch {
			// Fall through to basename
		}
	}

	return path.basename(directory);
}

/**
 * Write sentinel file to track migration status.
 */
async function writeSentinel(
	sentinelPath: string,
	migrated: number,
	dropped: number,
): Promise<void> {
	const sentinel = {
		migrated_at: new Date().toISOString(),
		source_version: '6.16',
		target_version: '6.17',
		entries_migrated: migrated,
		entries_dropped: dropped,
		schema_version: 1,
		migration_tool: 'knowledge-migrator.ts',
	};

	await mkdir(path.dirname(sentinelPath), { recursive: true });
	await writeFile(sentinelPath, JSON.stringify(sentinel, null, 2), 'utf-8');
}

/**
 * Resolve the legacy hive knowledge file path.
 * Legacy data was stored in {platform-data-dir}/hive-knowledge.jsonl before consolidation.
 * This matches the resolveHiveKnowledgePath() pattern but returns the old path.
 */
function resolveLegacyHiveKnowledgePath(): string {
	const platform = process.platform;
	const home = process.env.HOME || os.homedir();
	let dataDir: string;

	if (platform === 'win32') {
		dataDir = path.join(
			process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
			'opencode-swarm',
			'Data',
		);
	} else if (platform === 'darwin') {
		dataDir = path.join(
			home,
			'Library',
			'Application Support',
			'opencode-swarm',
		);
	} else {
		dataDir = path.join(
			process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'),
			'opencode-swarm',
		);
	}

	return path.join(dataDir, 'hive-knowledge.jsonl');
}
