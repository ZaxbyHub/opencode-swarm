/**
 * Knowledge-system diagnostics: a reusable debug-metadata helper that any
 * knowledge tool can surface, plus a `/swarm diagnose` health summary.
 *
 * Path/version drift is a documented diagnostic concern (a stale plugin cache or
 * a mismatched resolved directory can make the knowledge store look broken).
 * This module reports the exact resolved paths, raw-vs-normalized entry counts,
 * status breakdown, event volume, and cache freshness so those issues surface.
 */

import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import packageJson from '../../package.json' with { type: 'json' };
import {
	readKnowledgeEvents,
	resolveKnowledgeEventsPath,
} from '../hooks/knowledge-events.js';
import {
	getLinkedLocalKnowledgeStatus,
	readLinkPointer,
	resolveKnowledgeStoreDir,
	resolveLinkDir,
} from '../hooks/knowledge-link.js';
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
import { readMemoryLinkPointer } from '../memory/memory-link.js';
import {
	buildMemoryCohortFingerprintInput,
	classifyStoredFingerprintAlgorithmVersion,
	computeMemoryCohortFingerprint,
} from '../memory/redaction.js';
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
		/**
		 * (#1849) Shown vs explicitly-applied accountability (never conflated) +
		 * empty-trace terminals, so the retrieval loop's accounting is visible.
		 */
		shown_vs_applied: {
			shown: number;
			applied_explicit: number;
			ignored: number;
			contradicted: number;
			violated: number;
			no_relevant: number;
			/** Shown to a delegate, no ack filed — audit-only delivery signal. */
			unacknowledged: number;
		};
	};
	/**
	 * Cohort/link health (issue #1846). Makes the linked store and its health
	 * obvious to an operator/architect. `null` when link state cannot be read.
	 */
	cohort: {
		/** True when this worktree redirects its knowledge family to a shared store. */
		linked: boolean;
		/** Pointer schema version (1 = legacy, 2 = cohort-aware). */
		pointer_version: 1 | 2 | null;
		/** Link id (shared store directory segment). */
		link_id: string | null;
		/** Canonical cohort id (issue #1846 W1), when known. */
		cohort_id: string | null;
		/** How the cohort id was derived. */
		identity_source: 'remote' | 'git-common-dir' | 'path' | null;
		/** True when the cohort id is machine-local (not portable). */
		degraded: boolean;
		/** Resolved shared root, when linked. */
		shared_root: string | null;
		/** Pointer generation (bumped on each link/unlink), when known. */
		generation: number | null;
		/**
		 * True when a local knowledge.jsonl coexists with an active link (the
		 * pre-link local store was retained). Benign but worth surfacing.
		 */
		local_orphaned: boolean;
	};
	/**
	 * Hive promotion health (issue #1847). Surfaces lineage presence and any
	 * manual-override promotions so an operator can audit forced entries.
	 */
	hive: {
		/** Hive entries carrying a #1847 lineage block. */
		entries_with_lineage: number;
		/** Hive entries promoted via an audited --force override (AC9 visibility). */
		override_promotions: number;
		/** Up to 20 most-recent override entries (id, failed gates, reason). */
		override_entries: Array<{
			id: string;
			lesson_excerpt: string;
			override_failed_gates?: string[];
			reason?: string;
			promotion_event_id?: string;
		}>;
	};
	/**
	 * Cohort-safe curation health (issue #1848). Surfaces the fair scan
	 * cursor progress and cohort config-fingerprint agreement so an operator
	 * knows whether entries are being starved and whether cohort members
	 * share curation semantics.
	 */
	curation: {
		/** Fair scan generation (monotonic sweep counter). 0 = no cursor yet. */
		scan_generation: number;
		/** True when the last sweep completed (next sweep starts fresh). */
		scan_completed: boolean;
		/** Approximate count of entries still eligible to visit this generation. */
		scan_remaining_estimate: number;
		/** True when this worktree's config fingerprint matches the cohort's.
		 * `null` when unlinked or no cohort fingerprint is stored. */
		config_fingerprint_match: boolean | null;
		/** Count of entries with producer provenance (v3+). */
		entries_with_provenance: number;
		/** Count of legacy entries without provenance (protected by default). */
		entries_unknown_owner: number;
		/**
		 * Pending curation proposals persisted to `curation-proposals.jsonl`
		 * (PRR-008): destructive actions that were blocked (unknown-owner,
		 * config-mismatch, insufficient evidence) and recorded for a cohort
		 * member to later confirm. Never surfaced before; operators need to see
		 * that blocked destructive intent is queued.
		 */
		pending_proposals: number;
	};
	/**
	 * #1850: memory cohort link health. Distinct from the knowledge `cohort`
	 * block so diagnostics can report knowledge-link and memory-link
	 * independently. Carries provider/config fingerprint agreement so an
	 * operator can detect cohort divergence. No record text is emitted here
	 * (diagnostics-no-leakage discipline, acceptance #13).
	 */
	memory: {
		linked: boolean;
		pointer_version: 1 | 2 | null;
		link_id: string | null;
		cohort_id: string | null;
		identity_source: 'remote' | 'git-common-dir' | 'path' | null;
		degraded: boolean;
		shared_root: string | null;
		generation: number | null;
		/** Provider name from config ('sqlite' | 'local-jsonl'). */
		provider: string | null;
		/**
		 * #1850 (KC-002): config fingerprint agreement — true when this
		 * worktree's config matches the cohort's stored fingerprint, false on
		 * mismatch, null when not checked (unlinked or file absent).
		 */
		config_fingerprint_match: boolean | null;
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

	// Cohort/link health (issue #1846). Best-effort: any failure degrades to the
	// "not linked" shape so a corrupt pointer never breaks diagnostics.
	let cohortLinked = false;
	let cohortPointerVersion: 1 | 2 | null = null;
	let cohortLinkId: string | null = null;
	let cohortId: string | null = null;
	let cohortIdentitySource: 'remote' | 'git-common-dir' | 'path' | null = null;
	let cohortDegraded = false;
	let cohortSharedRoot: string | null = null;
	let cohortGeneration: number | null = null;
	let cohortLocalOrphaned = false;
	try {
		const pointer = readLinkPointer(directory);
		if (pointer) {
			cohortLinked = true;
			cohortPointerVersion = pointer.version;
			cohortLinkId = pointer.linkId;
			cohortId = pointer.cohortId ?? null;
			cohortIdentitySource = pointer.identitySource ?? null;
			cohortDegraded = pointer.degraded ?? false;
			cohortSharedRoot = resolveLinkDir(pointer.linkId);
			cohortGeneration = pointer.generation ?? null;
			cohortLocalOrphaned = getLinkedLocalKnowledgeStatus(directory).orphaned;
		}
	} catch {
		// leave defaults (not linked)
	}

	// Hive promotion lineage + override audit (issue #1847, AC9 visibility).
	// Best-effort: any failure degrades to zero. Reuses the hive entries already
	// read above; no new I/O, and never on the plugin-init path.
	let hiveEntriesWithLineage = 0;
	let hiveOverridePromotions = 0;
	const hiveOverrideEntries: KnowledgeDebugMeta['hive']['override_entries'] =
		[];
	try {
		const hive = await readKnowledge<HiveKnowledgeEntry>(hivePath);
		for (const e of hive) {
			if (e.lineage) {
				hiveEntriesWithLineage++;
				if (e.lineage.actor === 'manual-override') {
					hiveOverridePromotions++;
					if (hiveOverrideEntries.length < 20) {
						hiveOverrideEntries.push({
							id: e.id,
							lesson_excerpt: e.lesson.slice(0, 80),
							override_failed_gates: e.lineage.override_failed_gates,
							reason: e.lineage.reason,
							promotion_event_id: e.lineage.promotion_event_id,
						});
					}
				}
			}
		}
	} catch {
		// leave defaults
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
			// (#1849) Shown vs explicitly-applied (never conflated) + empty-trace
			// terminals, so the retrieval loop's accountability is visible.
			shown_vs_applied: {
				shown: eventsByType.retrieved ?? 0,
				applied_explicit: eventsByType.applied ?? 0,
				ignored: eventsByType.ignored ?? 0,
				contradicted: eventsByType.contradicted ?? 0,
				violated: eventsByType.violated ?? 0,
				no_relevant: eventsByType.no_relevant ?? 0,
				// Audit-only delivery signal (shown to a delegate, no ack filed) —
				// the "where did the rest of the deliveries go" column this surface
				// exists to answer. Never negative evidence.
				unacknowledged: eventsByType.unacknowledged ?? 0,
			},
		},
		cohort: {
			linked: cohortLinked,
			pointer_version: cohortPointerVersion,
			link_id: cohortLinkId,
			cohort_id: cohortId,
			identity_source: cohortIdentitySource,
			degraded: cohortDegraded,
			shared_root: cohortSharedRoot,
			generation: cohortGeneration,
			local_orphaned: cohortLocalOrphaned,
		},
		hive: {
			entries_with_lineage: hiveEntriesWithLineage,
			override_promotions: hiveOverridePromotions,
			override_entries: hiveOverrideEntries,
		},
		// KC-03: provenance coverage is a swarm/cohort-tier concept — `producer`
		// provenance is only ever written to swarm entries. Hive entries never
		// carry it (by design), so merging them in would miscount every hive
		// entry as "unknown owner". Pass SWARM raw entries only.
		curation: await computeCurationDiagnostics(directory, swarmRaw.entries),
		// #1850: memory cohort link health (distinct from knowledge link).
		memory: computeMemoryCohortDiagnostics(directory),
	};
}

/**
 * #1850: best-effort memory cohort diagnostics. Reads the memory-link pointer
 * and config to surface link state + provider. Fail-open to the unlinked shape.
 * Does NOT read memory record contents (no-leakage discipline, acceptance #13).
 */
function computeMemoryCohortDiagnostics(directory: string): {
	linked: boolean;
	pointer_version: 1 | 2 | null;
	link_id: string | null;
	cohort_id: string | null;
	identity_source: 'remote' | 'git-common-dir' | 'path' | null;
	degraded: boolean;
	shared_root: string | null;
	generation: number | null;
	provider: string | null;
	config_fingerprint_match: boolean | null;
} {
	try {
		const pointer = readMemoryLinkPointer(directory);
		let provider: string | null = null;
		let configFingerprintMatch: boolean | null = null;
		try {
			const { loadPluginConfig } = require('../config/loader.js') as {
				loadPluginConfig: (dir: string) => {
					memory?: {
						provider?: string;
						redaction?: { rejectDurableSecrets?: boolean };
						embeddings?: {
							model?: string;
							dimension?: number;
							version?: string;
						};
					};
				};
			};
			const cfg = loadPluginConfig(directory);
			provider = cfg.memory?.provider ?? null;
			// #1850 (KC-002): compute config fingerprint match when linked.
			if (pointer && cfg.memory) {
				const cohortConfigPath = join(
					resolveLinkDir(pointer.linkId),
					'memory',
					'memory-cohort-config.json',
				);
				if (existsSync(cohortConfigPath)) {
					const stored = JSON.parse(
						readFileSync(cohortConfigPath, 'utf-8'),
					) as { fingerprint?: unknown; algorithm_version?: unknown };
					// #2062 F-012 (R3 fix): mirror the provider version-aware pattern.
					// An ABSENT `algorithm_version` means the file predates the field,
					// i.e. algorithm version 1 — not "the current version", which would
					// make legacy files silently byte-compare across algorithms after a
					// bump. When the stored version is not comparable (a different
					// version, or present but non-numeric) leave the field null
					// (unknown) rather than reporting a false mismatch. This is a
					// read-only reporting surface, so stay silent rather than warn.
					const versionCheck = classifyStoredFingerprintAlgorithmVersion(
						stored.algorithm_version,
					);
					if (
						versionCheck.status === 'comparable' &&
						typeof stored.fingerprint === 'string'
					) {
						const expected = computeMemoryCohortFingerprint(
							buildMemoryCohortFingerprintInput({
								provider: cfg.memory.provider ?? 'sqlite',
								redaction: {
									rejectDurableSecrets:
										cfg.memory.redaction?.rejectDurableSecrets ?? true,
								},
								embeddings: {
									model:
										cfg.memory.embeddings?.model ?? 'Xenova/all-MiniLM-L6-v2',
									dimension: cfg.memory.embeddings?.dimension ?? 384,
									version: cfg.memory.embeddings?.version,
								},
							}),
						);
						configFingerprintMatch = stored.fingerprint === expected;
					}
				}
			}
		} catch {
			/* best-effort */
		}
		if (pointer) {
			return {
				linked: true,
				pointer_version: pointer.version,
				link_id: pointer.linkId,
				cohort_id: pointer.cohortId ?? null,
				identity_source: pointer.identitySource ?? null,
				degraded: pointer.degraded ?? false,
				shared_root: pointer.linkId ? resolveLinkDir(pointer.linkId) : null,
				generation: pointer.generation ?? null,
				provider,
				config_fingerprint_match: configFingerprintMatch,
			};
		}
		return {
			linked: false,
			pointer_version: null,
			link_id: null,
			cohort_id: null,
			identity_source: null,
			degraded: false,
			shared_root: null,
			generation: null,
			provider,
			config_fingerprint_match: null,
		};
	} catch {
		return {
			linked: false,
			pointer_version: null,
			link_id: null,
			cohort_id: null,
			identity_source: null,
			degraded: false,
			shared_root: null,
			generation: null,
			provider: null,
			config_fingerprint_match: null,
		};
	}
}

/**
 * #1848: compute the cohort-safe curation diagnostics block — fair scan cursor
 * progress, config fingerprint agreement, and provenance coverage. All
 * best-effort (fail-open to zeros/nulls).
 */
async function computeCurationDiagnostics(
	directory: string,
	entries: Array<{ producer?: unknown }>,
): Promise<KnowledgeDebugMeta['curation']> {
	// Scan cursor status (best-effort).
	let scanGeneration = 0;
	let scanCompleted = false;
	let scanRemaining = 0;
	try {
		const { getScanStatus } = await import('../knowledge/scan-cursor.js');
		const status = await getScanStatus(directory);
		scanGeneration = status.generation;
		scanCompleted = status.completed;
		scanRemaining = status.remaining_estimate;
	} catch {
		/* best-effort */
	}

	// Config fingerprint agreement (best-effort).
	let configMatch: boolean | null = null;
	try {
		const { isLinked } = await import('../hooks/knowledge-link.js');
		if (isLinked(directory)) {
			const { KnowledgeConfigSchema } = await import('../config/schema.js');
			// F-06: fingerprint agreement must be computed against this worktree's
			// REAL knowledge config, not schema defaults — otherwise every operator
			// who tuned any knowledge setting is reported as a false "mismatch".
			// Best-effort: fall back to defaults if the config can't be loaded.
			let config: ReturnType<typeof KnowledgeConfigSchema.parse>;
			try {
				const { loadPluginConfigWithMeta } = await import('../config/index.js');
				const loaded = loadPluginConfigWithMeta(directory);
				config = KnowledgeConfigSchema.parse(loaded.config.knowledge ?? {});
			} catch {
				config = KnowledgeConfigSchema.parse({});
			}
			const { cohortConfigFingerprint } = await import(
				'../knowledge/config-fingerprint.js'
			);
			const { buildConfigFingerprintInput, readCohortConfigFingerprint } =
				await import('../knowledge/curation-policy.js');
			const currentFp = cohortConfigFingerprint(
				buildConfigFingerprintInput(config),
			);
			const cohortFp = await readCohortConfigFingerprint(directory);
			configMatch = cohortFp === null ? null : currentFp === cohortFp;
		}
	} catch {
		/* best-effort */
	}

	// Provenance coverage. KC-03: `entries` is the SWARM-only set (hive entries
	// never carry `producer`, so counting them would inflate unknown-owner).
	let withProvenance = 0;
	let unknownOwner = 0;
	for (const e of entries) {
		if (e.producer != null) withProvenance++;
		else unknownOwner++;
	}

	// PRR-008: count pending curation proposals persisted by authorizeCuration to
	// the cohort-scoped `curation-proposals.jsonl`. These represent blocked
	// destructive intent awaiting confirmation and were never surfaced anywhere.
	const pendingProposals = await countPendingProposals(directory);

	return {
		scan_generation: scanGeneration,
		scan_completed: scanCompleted,
		scan_remaining_estimate: scanRemaining,
		config_fingerprint_match: configMatch,
		entries_with_provenance: withProvenance,
		entries_unknown_owner: unknownOwner,
		pending_proposals: pendingProposals,
	};
}

/**
 * Count pending proposals in the store-scoped `curation-proposals.jsonl`
 * (PRR-008). Best-effort: returns 0 on any error, missing file, or unresolvable
 * store dir. Counts records whose `status` is `pending` (the only status
 * authorizeCuration writes); non-JSON lines are ignored defensively.
 */
async function countPendingProposals(directory: string): Promise<number> {
	let proposalsPath: string;
	try {
		proposalsPath = join(
			resolveKnowledgeStoreDir(directory),
			'curation-proposals.jsonl',
		);
	} catch {
		return 0;
	}
	if (!existsSync(proposalsPath)) return 0;
	try {
		const content = await readFile(proposalsPath, 'utf-8');
		let n = 0;
		for (const line of content.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			try {
				const parsed = JSON.parse(trimmed) as { status?: unknown };
				if (parsed.status === 'pending') n++;
			} catch {
				/* ignore corrupt line */
			}
		}
		return n;
	} catch {
		return 0;
	}
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
	const co = debug.cohort;
	const hv = debug.hive;
	const cu = debug.curation;
	const cohortTag = co.linked
		? ` | cohort[linked id=${co.link_id}${
				co.cohort_id ? ` cohort=${co.cohort_id}` : ''
			}${co.identity_source ? ` via=${co.identity_source}` : ''}${
				co.degraded ? ' DEGRADED' : ''
			}${co.local_orphaned ? ' local-orphan' : ''}${
				co.generation !== null ? ` gen=${co.generation}` : ''
			}]`
		: ' | cohort[local]';
	const hiveTag =
		hv.entries_with_lineage > 0 || hv.override_promotions > 0
			? ` | hive[lineage=${hv.entries_with_lineage} overrides=${hv.override_promotions}]`
			: ' | hive[local]';
	// O-007 (F-08/F-16/PRR-008): surface the curation diagnostics computed by
	// computeCurationDiagnostics — previously computed but never rendered, so the
	// entire feature was invisible to operators. Shows fair-scan cursor progress,
	// config-fingerprint agreement, provenance coverage, and pending proposals.
	const scanPart = cu.scan_completed
		? `scan[gen=${cu.scan_generation} complete]`
		: `scan[gen=${cu.scan_generation} remaining=${cu.scan_remaining_estimate}]`;
	const fpPart =
		cu.config_fingerprint_match === null
			? 'fp=n/a'
			: cu.config_fingerprint_match
				? 'fp=match'
				: 'fp=MISMATCH';
	const provenanceTotal = cu.entries_with_provenance + cu.entries_unknown_owner;
	const curationTag =
		` | curation[${scanPart} ${fpPart} ` +
		`provenance=${cu.entries_with_provenance}/${provenanceTotal} ` +
		`proposals=${cu.pending_proposals}]`;
	const summary =
		`active=${sb.active} archived=${sb.archived} quarantined=${sb.quarantined} ` +
		`rejected=${sb.rejected} | events=${debug.event_count} (retrieved/7d=${debug.retrieval_events_7d}) | ` +
		`learning[enforce=${lr.enforced_directives} escalated=${lr.escalated_directives} ` +
		`synonyms=${lr.synonym_pairs} unactionable=${lr.unactionable_queue_depth} ` +
		`insights_pending=${lr.insight_candidates_pending}] | ` +
		`schema=${JSON.stringify(debug.schema_versions)}` +
		cohortTag +
		hiveTag +
		curationTag;

	const warnings: string[] = [];
	// A degraded cohort identity (machine-local, not portable) must be visible —
	// the linked store will only be cohesive for sibling worktrees on THIS
	// machine (issue #1846 §1.3).
	if (co.linked && co.degraded) {
		warnings.push(
			`cohort identity is degraded (via ${co.identity_source}): shared store is machine-local, not portable across machines`,
		);
	}
	if (co.linked && co.local_orphaned) {
		warnings.push(
			'local .swarm/knowledge.jsonl is orphaned by the link store (benign; resolver ignores it)',
		);
	}
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
	// #1847 F-002: surface manual-override promotions so operators can audit
	// force-promoted entries (AC9 visibility). Each override records the failed
	// gates + reason in debug.hive.override_entries.
	if (hv.override_promotions > 0) {
		const sample = hv.override_entries[0];
		const gates = sample?.override_failed_gates?.join(',') ?? '?';
		warnings.push(
			`${hv.override_promotions} hive entr(y/ies) promoted via --force override (failed gates: ${gates}${
				sample?.reason ? `; reason: "${sample.reason.slice(0, 60)}"` : ''
			})`,
		);
	}
	// O-007 F-16: a config-fingerprint MISMATCH means linked cohort members will
	// curate with different semantics — a genuine cross-worktree hazard the
	// operator must reconcile before destructive curation.
	if (cu.config_fingerprint_match === false) {
		warnings.push(
			'cohort config fingerprint mismatch: this worktree curates with different knowledge semantics than the cohort — align knowledge config across linked worktrees',
		);
	}
	// PRR-008: pending proposals are blocked destructive actions awaiting cohort
	// confirmation. They were persisted but never surfaced — an operator needs to
	// see that curation intent is queued and unresolved.
	if (cu.pending_proposals > 0) {
		warnings.push(
			`${cu.pending_proposals} pending curation proposal(s) awaiting confirmation (blocked destructive actions recorded in curation-proposals.jsonl)`,
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
