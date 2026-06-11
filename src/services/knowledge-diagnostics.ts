/**
 * Knowledge-system diagnostics: a reusable debug-metadata helper that any
 * knowledge tool can surface, plus a `/swarm diagnose` health summary.
 *
 * Path/version drift is a documented diagnostic concern (a stale plugin cache or
 * a mismatched resolved directory can make the knowledge store look broken).
 * This module reports the exact resolved paths, raw-vs-normalized entry counts,
 * status breakdown, event volume, and cache freshness so those issues surface.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import packageJson from '../../package.json' with { type: 'json' };
import {
	readKnowledgeEvents,
	resolveKnowledgeEventsPath,
} from '../hooks/knowledge-events.js';
import {
	readKnowledge,
	readRejectedLessons,
	resolveHiveKnowledgePath,
	resolveSwarmKnowledgePath,
} from '../hooks/knowledge-store.js';
import type {
	HiveKnowledgeEntry,
	SwarmKnowledgeEntry,
} from '../hooks/knowledge-types.js';
import { resolveUnactionablePath } from '../hooks/knowledge-validator.js';
import { resolveInsightCandidatesPath } from '../hooks/micro-reflector.js';
import { readSynonymMap } from './synonym-map.js';
import { compareVersions, readVersionCache } from './version-check.js';

const { version } = packageJson;

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// Backlog thresholds above which a curation queue is flagged as not draining.
// Set high enough that normal per-phase churn (a handful of entries) never trips
// the warning — only a genuine, accumulating stall does.
const UNACTIONABLE_BACKLOG_WARN = 100;
const INSIGHT_BACKLOG_WARN = 50;

export interface KnowledgeDebugMeta {
	plugin_version: string;
	directory: string;
	swarm_path: string;
	hive_path: string;
	events_path: string;
	raw_entry_count: number;
	normalized_entry_count: number;
	corrupt_line_count: number;
	schema_versions: Record<string, number>;
	entries_missing_v2_counters: number;
	status_breakdown: {
		active: number;
		archived: number;
		quarantined: number;
		rejected: number;
	};
	event_count: number;
	retrieval_events_7d: number;
	cache_status: 'fresh' | 'stale' | 'unknown';
	/**
	 * Learning-loop telemetry (Changes 1–6). Surfaces the health of the
	 * self-improvement pipeline: directives awaiting curation, reflection
	 * candidates not yet folded in, learned synonyms, and enforcement posture.
	 */
	learning: {
		/** Lessons withheld from the active store pending actionability (Change 4). */
		unactionable_queue_depth: number;
		/** Micro-reflection insight candidates not yet consumed by the curator (Change 6). */
		insight_candidates_pending: number;
		/** Learned tag co-occurrence synonym pairs on disk (Change 5). */
		synonym_pairs: number;
		/** Active directives in `enforce` posture (Change 3). */
		enforced_directives: number;
		/** Active directives that have been auto-escalated at least once (Change 3). */
		escalated_directives: number;
		/** Knowledge-event volume bucketed by type (applied/ignored/violated/...). */
		events_by_type: Record<string, number>;
	};
}

/** Parse JSONL lines without normalization. Returns parsed objects + corrupt count. */
async function readRawLines(
	filePath: string,
): Promise<{ entries: Record<string, unknown>[]; corrupt: number }> {
	if (!existsSync(filePath)) return { entries: [], corrupt: 0 };
	const content = await readFile(filePath, 'utf-8');
	const entries: Record<string, unknown>[] = [];
	let corrupt = 0;
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed) as Record<string, unknown>);
		} catch {
			corrupt++;
		}
	}
	return { entries, corrupt };
}

function hasV2Counters(entry: Record<string, unknown>): boolean {
	const ro = entry.retrieval_outcomes as Record<string, unknown> | undefined;
	if (!ro || typeof ro !== 'object') return false;
	return (
		typeof ro.shown_count === 'number' &&
		typeof ro.applied_explicit_count === 'number' &&
		typeof ro.ignored_count === 'number'
	);
}

function cacheStatus(): 'fresh' | 'stale' | 'unknown' {
	const cache = readVersionCache();
	if (!cache?.npmLatest) return 'unknown';
	return compareVersions(cache.npmLatest, version) > 0 ? 'stale' : 'fresh';
}

/**
 * Compute the debug-metadata block for the knowledge system. Best-effort: never
 * throws (each I/O step degrades to zero/empty). Aggregates swarm + hive tiers.
 */
export async function computeKnowledgeDebug(
	directory: string,
): Promise<KnowledgeDebugMeta> {
	const swarmPath = resolveSwarmKnowledgePath(directory);
	const hivePath = resolveHiveKnowledgePath();
	const eventsPath = resolveKnowledgeEventsPath(directory);

	const [swarmRaw, hiveRaw] = await Promise.all([
		readRawLines(swarmPath),
		readRawLines(hivePath),
	]);
	const rawEntries = [...swarmRaw.entries, ...hiveRaw.entries];
	const corrupt = swarmRaw.corrupt + hiveRaw.corrupt;

	const schemaVersions: Record<string, number> = {};
	let missingV2 = 0;
	for (const e of rawEntries) {
		const sv = String(
			typeof e.schema_version === 'number' ? e.schema_version : 'unknown',
		);
		schemaVersions[sv] = (schemaVersions[sv] ?? 0) + 1;
		if (!hasV2Counters(e)) missingV2++;
	}

	let normalizedCount = 0;
	let active = 0;
	let archived = 0;
	let quarantined = 0;
	let enforcedDirectives = 0;
	let escalatedDirectives = 0;
	try {
		const swarm = await readKnowledge<SwarmKnowledgeEntry>(swarmPath);
		const hive = await readKnowledge<HiveKnowledgeEntry>(hivePath);
		for (const e of [...swarm, ...hive]) {
			normalizedCount++;
			if (e.status === 'archived') archived++;
			else if (e.status === 'quarantined') quarantined++;
			else active++;
			// Enforcement posture only counts for non-archived/quarantined directives
			// (an archived directive enforces nothing).
			if (e.status !== 'archived' && e.status !== 'quarantined') {
				if (e.enforcement_mode === 'enforce') enforcedDirectives++;
				if (
					Array.isArray(e.escalation_history) &&
					e.escalation_history.length > 0
				)
					escalatedDirectives++;
			}
		}
	} catch {
		// leave counts at best-effort values
	}

	let rejected = 0;
	try {
		rejected = (await readRejectedLessons(directory)).length;
	} catch {
		// ignore
	}

	let eventCount = 0;
	let retrieval7d = 0;
	const eventsByType: Record<string, number> = {};
	try {
		const events = await readKnowledgeEvents(directory);
		eventCount = events.length;
		const cutoff = Date.now() - SEVEN_DAYS_MS;
		for (const ev of events) {
			eventsByType[ev.type] = (eventsByType[ev.type] ?? 0) + 1;
			if (ev.type !== 'retrieved') continue;
			const t = Date.parse(ev.timestamp);
			if (!Number.isNaN(t) && t >= cutoff) retrieval7d++;
		}
	} catch {
		// ignore
	}

	// Learning-loop queue depths (Changes 4–6). Each is best-effort and degrades
	// to 0 when the file is absent, malformed, or out of bounds.
	const unactionableQueueDepth = await safeJsonlCount(
		resolveUnactionablePathSafe(directory),
	);
	const insightCandidatesPending = await safeJsonlCount(
		resolveInsightCandidatesPathSafe(directory),
	);
	let synonymPairs = 0;
	try {
		synonymPairs = Object.keys((await readSynonymMap(directory)).pairs).length;
	} catch {
		// ignore — no/!corrupt synonym map
	}

	return {
		plugin_version: version,
		directory,
		swarm_path: swarmPath,
		hive_path: hivePath,
		events_path: eventsPath,
		raw_entry_count: rawEntries.length,
		normalized_entry_count: normalizedCount,
		corrupt_line_count: corrupt,
		schema_versions: schemaVersions,
		entries_missing_v2_counters: missingV2,
		status_breakdown: { active, archived, quarantined, rejected },
		event_count: eventCount,
		retrieval_events_7d: retrieval7d,
		cache_status: cacheStatus(),
		learning: {
			unactionable_queue_depth: unactionableQueueDepth,
			insight_candidates_pending: insightCandidatesPending,
			synonym_pairs: synonymPairs,
			enforced_directives: enforcedDirectives,
			escalated_directives: escalatedDirectives,
			events_by_type: eventsByType,
		},
	};
}

/** Count non-blank JSONL lines in a file. Returns 0 on any error or null path. */
async function safeJsonlCount(filePath: string | null): Promise<number> {
	if (!filePath || !existsSync(filePath)) return 0;
	try {
		const content = await readFile(filePath, 'utf-8');
		let n = 0;
		for (const line of content.split('\n')) {
			if (line.trim()) n++;
		}
		return n;
	} catch {
		return 0;
	}
}

function resolveUnactionablePathSafe(directory: string): string | null {
	try {
		return resolveUnactionablePath(directory);
	} catch {
		return null;
	}
}

function resolveInsightCandidatesPathSafe(directory: string): string | null {
	try {
		return resolveInsightCandidatesPath(directory);
	} catch {
		return null;
	}
}

export interface KnowledgeHealth {
	name: string;
	status: '✅' | '❌' | '⚠️' | '⬜';
	detail: string;
}

/**
 * Build the "Knowledge health" diagnose check from the debug metadata. Warns on
 * raw-vs-normalized mismatch (corrupt lines), entries missing v2 counters, or a
 * stale plugin cache; otherwise reports a healthy summary.
 */
export async function checkKnowledgeHealth(
	directory: string,
): Promise<KnowledgeHealth> {
	let debug: KnowledgeDebugMeta;
	try {
		debug = await computeKnowledgeDebug(directory);
	} catch {
		return {
			name: 'Knowledge health',
			status: '⚠️',
			detail: 'Could not compute knowledge diagnostics',
		};
	}

	const sb = debug.status_breakdown;
	const lr = debug.learning;
	const summary =
		`active=${sb.active} archived=${sb.archived} quarantined=${sb.quarantined} ` +
		`rejected=${sb.rejected} | events=${debug.event_count} (retrieved/7d=${debug.retrieval_events_7d}) | ` +
		`learning[enforce=${lr.enforced_directives} escalated=${lr.escalated_directives} ` +
		`synonyms=${lr.synonym_pairs} unactionable=${lr.unactionable_queue_depth} ` +
		`insights_pending=${lr.insight_candidates_pending}] | ` +
		`schema=${JSON.stringify(debug.schema_versions)}`;

	const warnings: string[] = [];
	// A persistent backlog in either curation queue means the curator is not
	// draining them (not running, erroring, or the gate is mis-tuned) — surface it
	// so the learning loop's stall is visible, not silent.
	if (lr.unactionable_queue_depth > UNACTIONABLE_BACKLOG_WARN) {
		warnings.push(
			`${lr.unactionable_queue_depth} lessons stuck in the unactionable queue (curator may not be draining)`,
		);
	}
	if (lr.insight_candidates_pending > INSIGHT_BACKLOG_WARN) {
		warnings.push(
			`${lr.insight_candidates_pending} micro-reflection insight candidates pending (curator may not be folding them in)`,
		);
	}
	if (debug.corrupt_line_count > 0) {
		warnings.push(
			`${debug.corrupt_line_count} corrupt JSONL line(s) (raw=${debug.raw_entry_count} vs normalized=${debug.normalized_entry_count})`,
		);
	}
	if (debug.entries_missing_v2_counters > 0) {
		warnings.push(
			`${debug.entries_missing_v2_counters} entr(y/ies) missing v2 counters (normalized on read)`,
		);
	}
	if (debug.cache_status === 'stale') {
		warnings.push(
			'stale plugin cache — run `bunx opencode-swarm update` (knowledge tools may be running old code)',
		);
	}

	if (warnings.length > 0) {
		return {
			name: 'Knowledge health',
			status: '⚠️',
			detail: `${summary} — ${warnings.join('; ')}`,
		};
	}
	return { name: 'Knowledge health', status: '✅', detail: summary };
}
