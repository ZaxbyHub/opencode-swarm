/**
 * Hive promoter for opencode-swarm v6.17 two-tier knowledge system.
 *
 * #1847 (transactional hive promotion): every hive write is routed through ONE
 * global cross-process transaction (`transactHiveStore` in `./hive-transaction`).
 * The transaction holds the hive directory lock across read → normalize →
 * eligibility → canonical-cohort counting → dedup/merge → append/update →
 * source confirmation → cap → staged audit → atomic persist. No caller reads
 * the hive, makes a promotion decision, and later calls a separate unlocked
 * write API.
 *
 * Canonical project identity (#1846): cross-project confirmations key on the
 * canonical `cohort_id` from `resolveCohortId`, not the worktree `project_name`.
 * Sibling worktrees and remote aliases of one repository count as one project.
 *
 * Lineage (#1847 §3): promoted entries retain source entry id, source cohort,
 * promotion event id, and actor. Manual promotion that fails policy proceeds
 * only with an explicit `--force` override that records a durable audit entry;
 * an exact entry id alone is never authorization to bypass policy.
 *
 * This module is NOT imported on the plugin-init path (invariant 1): promotion
 * runs only on the lazy `/swarm promote`, close, curate, and postmortem paths.
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import { WRITE_TOOL_NAMES } from '../config/constants.js';
import { KnowledgeConfigSchema } from '../config/schema.js';
import type { CohortIdentity } from '../knowledge/cohort-identity.js';
import { resolveCohortId } from '../knowledge/cohort-identity.js';
import { authorizeCuration } from '../knowledge/curation-policy.js';
import { resolveHiveDataDir } from '../knowledge/hive-paths.js';
import { canonicalRootKey } from '../utils/canonical-root.js';
import { ensureCohortIdCached } from './cohort-cache.js';
import { appendCuratorRecommendation, readCuratorSummary } from './curator.js';
import {
	describeEligibilityRoute,
	evaluatePromotionPolicy,
	failedGateNames,
} from './hive-policy.js';
import { type HiveAuditEntry, transactHiveStore } from './hive-transaction.js';
import {
	dedupeCapped,
	findNearDuplicate,
	jaccardBigram,
	readKnowledge,
	resolveSwarmKnowledgePath,
	wordBigrams,
} from './knowledge-store.js';
import type {
	HiveKnowledgeEntry,
	KnowledgeCategory,
	KnowledgeConfig,
	ProjectConfirmationRecord,
	PromotionActor,
	PromotionEvidenceRecord,
	PromotionLineage,
	RejectedLesson,
	SwarmKnowledgeEntry,
} from './knowledge-types.js';
import { isActiveStatus, KNOWLEDGE_SCHEMA_VERSION } from './knowledge-types.js';
import { validateLesson } from './knowledge-validator.js';
import { loadPromotionEvidenceByEntry } from './promotion-evidence-store.js';
import { safeHook } from './utils.js';

/** Carry a swarm entry's actionable-directive metadata onto a promoted hive
 *  entry (Phase 4 review, MEDIUM finding). Dropping these fields on promotion
 *  would strip predicates/scope from cross-project knowledge. */
function carryActionableFields(
	source: SwarmKnowledgeEntry,
): Partial<HiveKnowledgeEntry> {
	const out: Partial<HiveKnowledgeEntry> = {};
	if (source.triggers?.length) out.triggers = [...source.triggers];
	if (source.required_actions?.length)
		out.required_actions = [...source.required_actions];
	if (source.forbidden_actions?.length)
		out.forbidden_actions = [...source.forbidden_actions];
	if (source.verification_checks?.length)
		out.verification_checks = [...source.verification_checks];
	if (source.verification_predicate)
		out.verification_predicate = source.verification_predicate;
	if (source.applies_to_agents?.length)
		out.applies_to_agents = [...source.applies_to_agents];
	if (source.applies_to_tools?.length)
		out.applies_to_tools = [...source.applies_to_tools];
	if (source.directive_priority)
		out.directive_priority = source.directive_priority;
	return out;
}

/** Hive promotion summary for curator state. */
export interface HivePromotionSummary {
	timestamp: string;
	new_promotions: number;
	encounters_incremented: number;
	advancements: number;
	total_hive_entries: number;
	/** #1847: per-entry policy diagnostics for operator visibility. */
	diagnostics?: string[];
}

/**
 * Check whether a swarm entry is eligible for hive promotion via the historical
 * 3 routes. Kept as a thin wrapper delegating to the canonical policy route
 * description (M1 fix, #1847) so existing test consumers
 * (`hive-promoter-inactive.test.ts`, `close.test.ts` mock) keep working.
 *
 * This is ONE of the gates inside {@link evaluatePromotionPolicy}; it is not
 * the whole policy. New callers should use `evaluatePromotionPolicy`.
 */
export function isHiveEligible(
	entry: SwarmKnowledgeEntry,
	autoPromoteDays: number,
): boolean {
	return describeEligibilityRoute(entry, autoPromoteDays).passed;
}

/**
 * Count distinct projects/cohort identities in a hive entry's confirmed_by.
 *
 * #1847: dedup by canonical `cohort_id` (sibling worktrees + remote aliases of
 * one repo count as one project). Legacy records written before #1847 lack
 * `cohort_id`; for those, fall back to `project_name` — but two records sharing
 * a `cohort_id` are NEVER counted as distinct. This means AC3 ("sibling
 * worktrees count as one project") is enforced for confirmations written from
 * this PR forward; legacy confirmations remain `project_name`-keyed and are NOT
 * retroactively re-counted (consistent with the no-broad-rewrite non-goal).
 */
export function countDistinctProjects(
	confirmedBy: ProjectConfirmationRecord[],
): number {
	const cohortIds = new Set<string>();
	const legacyProjectNames = new Set<string>();
	for (const record of confirmedBy) {
		if (typeof record.cohort_id === 'string' && record.cohort_id.length > 0) {
			cohortIds.add(record.cohort_id);
		} else {
			// Legacy record without cohort_id — fall back to project_name.
			legacyProjectNames.add(record.project_name);
		}
	}
	return cohortIds.size + legacyProjectNames.size;
}

/** Check if a project/cohort confirmation already exists. Prefers cohort_id. */
function hasProjectConfirmation(
	hiveEntry: HiveKnowledgeEntry,
	projectName: string,
	cohortId?: string,
): boolean {
	return hiveEntry.confirmed_by.some((record) => {
		if (cohortId && record.cohort_id) {
			return record.cohort_id === cohortId;
		}
		return record.project_name === projectName;
	});
}

/** Calculate the new encounter score after a confirmation (weighted scoring). */
function calculateEncounterScore(
	currentScore: number,
	isSameProject: boolean,
	config: KnowledgeConfig,
): number {
	const weight = isSameProject
		? config.same_project_weight
		: config.cross_project_weight;
	const increment = config.encounter_increment * weight;
	const newScore = currentScore + increment;
	return Math.min(
		Math.max(newScore, config.min_encounter_score),
		config.max_encounter_score,
	);
}

/** Is the source cohort the same as the hive entry's origin cohort? */
function isSameOrigin(
	hiveEntry: HiveKnowledgeEntry,
	sourceCohortId: string,
): boolean {
	// Prefer lineage source_cohort_id; fall back to comparing the first
	// confirmation's cohort_id; lastly compare source_project as a legacy guard.
	if (hiveEntry.lineage?.source_cohort_id) {
		return hiveEntry.lineage.source_cohort_id === sourceCohortId;
	}
	const firstWithCohort = hiveEntry.confirmed_by.find((c) => c.cohort_id);
	if (firstWithCohort) {
		return firstWithCohort.cohort_id === sourceCohortId;
	}
	return false;
}

/** Sanitize a free-text reason so it cannot carry control chars / be
 *  unbounded when stored in lineage + the audit log (F-007). Truncates to a
 *  reasonable audit length and strips control characters (incl. newlines,
 *  which could break the JSONL line format if naively embedded). */
const MAX_OVERRIDE_REASON_LEN = 280;
function sanitizeReason(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	// Strip C0/C1 control chars (keep tab/newline as spaces). Built char-by-char
	// to avoid control-character literals in a regex (Biome lint).
	let cleaned = '';
	for (const ch of raw) {
		const code = ch.codePointAt(0) ?? 0;
		// Allow tab (0x09) and newline (0x0A) → space; strip other C0/C1 control.
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			cleaned += ' ';
		} else {
			cleaned += ch;
		}
	}
	const trimmed = cleaned.trim();
	if (trimmed.length === 0) return undefined;
	return trimmed.slice(0, MAX_OVERRIDE_REASON_LEN);
}

/** Build a PromotionLineage block for a newly promoted hive entry. Wires the
 *  provenance fields #1847 requires (F-001): source revision, prior
 *  confidence/phases snapshot, and merged_from for dedup merges. */
function buildLineage(args: {
	actor: PromotionActor;
	sourceEntryId?: string;
	sourceCohortId?: string;
	sourceRevision?: string;
	priorConfidence?: number;
	priorPhasesAlive?: number;
	mergedFrom?: string[];
	promotionEventId: string;
	reason?: string;
	overrideFailedGates?: string[];
}): PromotionLineage {
	const lineage: PromotionLineage = {
		actor: args.actor,
		source_entry_id: args.sourceEntryId,
		source_cohort_id: args.sourceCohortId,
		source_revision: args.sourceRevision,
		prior_confidence: args.priorConfidence,
		prior_phases_alive: args.priorPhasesAlive,
		merged_from: args.mergedFrom,
		promotion_event_id: args.promotionEventId,
		reason: args.reason,
		override_failed_gates: args.overrideFailedGates,
	};
	return lineage;
}

/** A content hash for source-revision provenance (F-001). Lightweight SHA-256
 *  prefix over the lesson text — enough to detect drift, not a security hash. */
function lessonRevision(lesson: string): string {
	return createHash('sha256').update(lesson).digest('hex').slice(0, 12);
}

/**
 * Main promotion logic: checks swarm entries and promotes eligible ones to hive
 * inside ONE cross-process transaction. Also updates existing hive entries with
 * new canonical-cohort confirmations. Returns a summary for curator state.
 *
 * `directory` is required (#1847) to resolve the canonical cohort identity
 * (#1846) for cross-project distinctness. `sessionID` (#2472 W2) is optional:
 * when present, cohort resolution reuses the session's cached cohort id (see
 * the `_internals.resolveCohortId` default).
 *
 * @note The 'hive-fast-track' tag is privileged — it bypasses the 3-phase
 *   confirmation requirement inside the eligibility_route gate. It should only
 *   be set by authorized tooling (inferTags() never produces it automatically).
 */
export async function checkHivePromotions(
	swarmEntries: SwarmKnowledgeEntry[],
	config: KnowledgeConfig,
	directory: string,
	sessionID?: string,
): Promise<HivePromotionSummary> {
	const empty: HivePromotionSummary = {
		timestamp: new Date().toISOString(),
		new_promotions: 0,
		encounters_incremented: 0,
		advancements: 0,
		total_hive_entries: 0,
	};

	if (config.hive_enabled === false) {
		return empty;
	}

	// #2472 W2: zero ACTIVE swarm entries ⇒ this pass is provably a no-op —
	// every eligibility route includes the active-status gate, cross-cohort
	// confirmations only pair against ACTIVE entries, and staged rejects
	// require an eligible candidate first. Return BEFORE cohort resolution,
	// evidence loading, and the hive transaction so an empty store costs one
	// swarm-store read instead of a git spawn + lock acquire.
	const activeSwarm = swarmEntries.filter((e) => isActiveStatus(e.status));
	if (activeSwarm.length === 0) {
		return empty;
	}

	// Resolve the source cohort ONCE, OUTSIDE the transaction. The default
	// resolver routes through the shared cohort cache (#2472 W2 — see
	// `_internals.resolveCohortId`), so a cached session id costs no git
	// subprocesses; a cold resolve may issue up to 2 sequential git calls
	// (~3s worst case) and doing that under the directory lock would risk
	// exceeding the 5s stale window. It never throws (path fallback always
	// succeeds).
	const sourceCohort = await _internals.resolveCohortId(directory, sessionID);

	// Authoritative terminal-application evidence comes from receipt-ledger
	// history. The bounded promotion-evidence JSONL remains a rebuildable
	// diagnostic projection only. Loaded outside the hive lock.
	// Legacy entries and unavailable history receive no synthetic credit.
	const evidence = await _internals.loadPromotionEvidence(
		directory,
		sourceCohort.cohortId,
	);

	const diagnostics: string[] = [];

	// === F-003: pre-decision work OUTSIDE the lock ===
	// Compute swarm bigrams, eligibility, and validation for every swarm entry
	// BEFORE acquiring the directory lock. The held closure then only does a
	// fast O(candidates × hive) dedup-recheck against the locked-current hive
	// (candidates is typically << swarmEntries because ineligible entries are
	// filtered), plus append/confirm/cap/persist. This keeps the closure well
	// under the 5s stale window for default caps (100/200); admin-raised caps
	// remain bounded by the candidate count, not the raw swarm×hive product.
	// (`activeSwarm` was hoisted above the cohort/evidence work for the #2472
	// W2 empty-candidates early return.)
	const activeSwarmBigrams = activeSwarm.map((e) =>
		typeof e.lesson === 'string' ? wordBigrams(e.lesson) : new Set<string>(),
	);

	interface PromotionCandidate {
		swarmEntry: SwarmKnowledgeEntry;
		swarmBigram: Set<string>;
		promotionEventId: string;
	}
	const candidates: PromotionCandidate[] = [];
	const rejectsOutside: RejectedLesson[] = [];

	for (const swarmEntry of swarmEntries) {
		if (
			typeof swarmEntry.lesson !== 'string' ||
			swarmEntry.lesson.length === 0
		) {
			continue;
		}
		const swarmBigram = wordBigrams(swarmEntry.lesson);

		const decision = evaluatePromotionPolicy({
			entry: swarmEntry,
			config,
			evidence: evidence[swarmEntry.id] ?? [],
		});
		if (!decision.eligible) {
			diagnostics.push(
				`skip promote '${swarmEntry.lesson.slice(0, 40)}…': ${decision.reason}`,
			);
			continue;
		}

		// Re-validate before promotion (against an empty existing-lessons list
		// here; the in-lock dedup-recheck catches near-duplicates against the
		// current hive). Validation is pure CPU — safe outside the lock.
		const validationResult = _internals.validateLesson(swarmEntry.lesson, [], {
			category: swarmEntry.category,
			scope: swarmEntry.scope,
			confidence: swarmEntry.confidence,
		});
		if (validationResult.severity === 'error') {
			rejectsOutside.push({
				id: crypto.randomUUID(),
				lesson: swarmEntry.lesson,
				rejection_reason:
					validationResult.reason || 'validation failed for hive promotion',
				rejected_at: new Date().toISOString(),
				rejection_layer: validationResult.layer || 2,
			});
			continue;
		}

		candidates.push({
			swarmEntry,
			swarmBigram,
			promotionEventId: crypto.randomUUID(),
		});
	}

	// PRR-007: the global hive data dir — passed to `authorizeCuration` for the
	// dedup-merge pass-through. It is unlinked (the global hive has no link
	// pointer), so authorization resolves to `config-skipped-unlinked` without a
	// lock acquire or event read (no deadlock against the held hive lock).
	// Resolved OUTSIDE the transaction; the resolver only reads env, no lock.
	const hiveDir = resolveHiveDataDir();

	const result = await _internals.transactHiveStore<{
		newPromotions: number;
		encounters: number;
		advancements: number;
		total: number;
	}>(async (ctx) => {
		let newPromotions = 0;
		let encounters = 0;
		let advancements = 0;
		let merges = 0;
		const audit: HiveAuditEntry[] = [];
		const rejects: RejectedLesson[] = [...rejectsOutside];
		const entries = [...ctx.entries];

		// Precompute hive bigrams ONCE under the lock (O(n)) so the per-candidate
		// dedup-recheck is O(candidates × n) — not O(candidates × n²).
		const hiveBigrams = entries.map((e) =>
			typeof e.lesson === 'string' ? wordBigrams(e.lesson) : new Set<string>(),
		);
		// Track bigrams of entries added within this run so same-run double-
		// promotion of near-duplicate lessons is also prevented.
		const addedBigrams: Set<string>[] = [];
		const findExistingDuplicate = (
			lessonBigram: Set<string>,
			threshold: number,
		): HiveKnowledgeEntry | undefined => {
			for (let i = 0; i < entries.length; i++) {
				if (jaccardBigram(lessonBigram, hiveBigrams[i]) >= threshold) {
					return entries[i];
				}
			}
			return undefined;
		};
		const isDuplicateOfAdded = (
			lessonBigram: Set<string>,
			threshold: number,
		): boolean => {
			for (const ab of addedBigrams) {
				if (jaccardBigram(lessonBigram, ab) >= threshold) return true;
			}
			return false;
		};

		// 1. New promotions: eligible candidates → lineage-bearing hive entries.
		for (const { swarmEntry, swarmBigram, promotionEventId } of candidates) {
			// Dedup-recheck against the CURRENT (locked) hive entries. F-001: if a
			// near-duplicate already exists, MERGE provenance (record the losing
			// source id in merged_from) rather than silently discarding it.
			const existingDup = findExistingDuplicate(
				swarmBigram,
				config.dedup_threshold,
			);
			if (existingDup) {
				// F-001: preserve provenance — record that this swarm entry was a
				// near-duplicate of an existing hive entry. Do not auto-collapse
				// conflicting lessons; just record the link for audit.
				// PRR-007: route this lineage mutation through the ONE shared
				// curation policy (audited pass-through) and stage an audit line so
				// the merge is no longer a silent, unaudited bypass of that policy.
				if (existingDup.lineage) {
					const mergeAudit = await authorizeAndRecordHiveMerge({
						survivingEntry: existingDup,
						losingSourceId: swarmEntry.id,
						config,
						hiveDir,
					});
					if (mergeAudit) {
						merges++;
						audit.push(mergeAudit);
					}
				}
				continue;
			}
			if (isDuplicateOfAdded(swarmBigram, config.dedup_threshold)) {
				// Same-run duplicate of a just-promoted entry — record on the
				// most-recently-added entry's lineage if possible. PRR-007: same
				// audited pass-through as the existing-hive merge above.
				const lastAdded = entries[entries.length - 1];
				if (lastAdded?.lineage) {
					const mergeAudit = await authorizeAndRecordHiveMerge({
						survivingEntry: lastAdded,
						losingSourceId: swarmEntry.id,
						config,
						hiveDir,
					});
					if (mergeAudit) {
						merges++;
						audit.push(mergeAudit);
					}
				}
				continue;
			}

			const newHiveEntry: HiveKnowledgeEntry = {
				id: crypto.randomUUID(),
				tier: 'hive',
				lesson: swarmEntry.lesson,
				category: swarmEntry.category,
				tags: swarmEntry.tags,
				scope: swarmEntry.scope,
				confidence: 0.5, // starts at 0.5 in hive
				status: 'candidate', // ALWAYS candidate on entry
				confirmed_by: [], // empty — no project confirmations yet
				retrieval_outcomes: {
					applied_count: 0,
					succeeded_after_count: 0,
					failed_after_count: 0,
				},
				schema_version: config.schema_version || KNOWLEDGE_SCHEMA_VERSION,
				created_at: new Date().toISOString(),
				updated_at: new Date().toISOString(),
				source_project: swarmEntry.project_name,
				encounter_score: config.initial_encounter_score,
				lineage: buildLineage({
					actor: 'auto',
					sourceEntryId: swarmEntry.id,
					sourceCohortId: sourceCohort.cohortId,
					sourceRevision: lessonRevision(swarmEntry.lesson),
					priorConfidence: swarmEntry.confidence,
					priorPhasesAlive: swarmEntry.phases_alive,
					promotionEventId,
				}),
				...carryActionableFields(swarmEntry),
			};

			entries.push(newHiveEntry);
			addedBigrams.push(swarmBigram);
			hiveBigrams.push(swarmBigram);
			newPromotions++;
			audit.push(
				stagePromotionAudit({
					entryId: newHiveEntry.id,
					lesson: newHiveEntry.lesson,
					actor: 'auto',
					sourceEntryId: swarmEntry.id,
					sourceCohortId: sourceCohort.cohortId,
					promotionEventId,
				}),
			);
		}

		// 2. Existing hive entries: add cross-cohort confirmations. Uses the
		// precomputed activeSwarmBigrams (computed OUTSIDE the lock). The
		// inner loop breaks on first match, so average cost is << hive×swarm.
		for (const hiveEntry of entries) {
			// PRR-2: defensively treat a malformed legacy record whose
			// confirmed_by is missing as an empty array.
			if (!Array.isArray(hiveEntry.confirmed_by)) {
				hiveEntry.confirmed_by = [];
			}
			const hiveBigram =
				typeof hiveEntry.lesson === 'string'
					? wordBigrams(hiveEntry.lesson)
					: new Set<string>();
			let nearDuplicate: SwarmKnowledgeEntry | undefined;
			for (let i = 0; i < activeSwarm.length; i++) {
				if (
					jaccardBigram(hiveBigram, activeSwarmBigrams[i]) >=
					config.dedup_threshold
				) {
					nearDuplicate = activeSwarm[i];
					break;
				}
			}
			if (!nearDuplicate) continue;

			// Do not self-confirm: if this hive entry was just promoted from this
			// very swarm entry in this run, its origin cohort is already implied.
			if (
				hiveEntry.lineage?.source_entry_id &&
				hiveEntry.lineage.source_entry_id === nearDuplicate.id
			) {
				continue;
			}

			const sameProject = isSameOrigin(hiveEntry, sourceCohort.cohortId);
			if (
				hasProjectConfirmation(
					hiveEntry,
					nearDuplicate.project_name,
					sourceCohort.cohortId,
				)
			) {
				continue;
			}

			const newConfirmation: ProjectConfirmationRecord = {
				project_name: nearDuplicate.project_name,
				cohort_id: sourceCohort.cohortId,
				confirmed_at: new Date().toISOString(),
			};
			hiveEntry.confirmed_by.push(newConfirmation);

			const currentScore = hiveEntry.encounter_score ?? 1.0;
			hiveEntry.encounter_score = calculateEncounterScore(
				currentScore,
				sameProject,
				config,
			);
			encounters++;
			hiveEntry.updated_at = new Date().toISOString();

			if (
				hiveEntry.status === 'candidate' &&
				countDistinctProjects(hiveEntry.confirmed_by) >= 3
			) {
				hiveEntry.status = 'established';
				advancements++;
			}
		}

		const modified =
			newPromotions > 0 || encounters > 0 || advancements > 0 || merges > 0;
		// Rejects must be persisted even when nothing else changed — otherwise a
		// batch where every eligible entry failed validation would silently drop
		// the rejection records. Committing rewrites the hive (unchanged content,
		// an atomic no-op write) and appends the staged rejects under the lock.
		if (!modified && rejects.length === 0) {
			return {
				kind: 'noop',
				return: {
					newPromotions,
					encounters,
					advancements,
					total: entries.length,
				},
			};
		}

		return {
			kind: 'commit',
			entries,
			maxEntries: config.hive_max_entries,
			rejects: rejects.length > 0 ? rejects : undefined,
			audit: audit.length > 0 ? audit : undefined,
			return: {
				newPromotions,
				encounters,
				advancements,
				total: entries.length,
			},
		};
	});

	// F-004/PRR-1/PRR-3: fail-safe contract. On lock/mkdir/validation failure
	// transactHiveStore returns committed:false with a zeroed return + the
	// diagnostic reason. Never dereference result.return blindly; surface the
	// diagnostics so the failure is visible instead of silently dropped.
	if (!result.committed) {
		return {
			timestamp: new Date().toISOString(),
			new_promotions: 0,
			encounters_incremented: 0,
			advancements: 0,
			total_hive_entries: 0,
			diagnostics: [
				...diagnostics,
				...result.diagnostics,
				'hive promotion transaction did not commit (see prior diagnostics)',
			],
		};
	}

	const ret = result.return;
	return {
		timestamp: new Date().toISOString(),
		new_promotions: ret?.newPromotions ?? 0,
		encounters_incremented: ret?.encounters ?? 0,
		advancements: ret?.advancements ?? 0,
		total_hive_entries: ret?.total ?? 0,
		diagnostics: [...diagnostics, ...result.diagnostics],
	};
}

/** Build a staged promotion audit line (pre-serialized JSON). */
function stagePromotionAudit(args: {
	entryId: string;
	lesson: string;
	actor: PromotionActor;
	sourceEntryId?: string;
	sourceCohortId?: string;
	promotionEventId: string;
	reason?: string;
	overrideFailedGates?: string[];
}): HiveAuditEntry {
	// Audit-only knowledge event tombstone (AC9 visibility). Shape mirrors the
	// ArchivedEvent family but is a distinct promotion marker. Stored under the
	// hive events log via the transaction's staged audit append.
	const event = {
		type: 'promotion',
		schema_version: 1,
		event_id: args.promotionEventId,
		timestamp: new Date().toISOString(),
		entry_id: args.entryId,
		actor: args.actor,
		reason: args.reason,
		source_entry_id: args.sourceEntryId,
		source_cohort_id: args.sourceCohortId,
		override_failed_gates: args.overrideFailedGates,
		lesson_excerpt: args.lesson.slice(0, 80),
	};
	return { line: JSON.stringify(event) };
}

/** Build a staged dedup-merge audit line (pre-serialized JSON). PRR-007: the
 *  hive dedup-merge appends the losing swarm source id to the surviving hive
 *  entry's `lineage.merged_from`; this records that mutation so it is no longer
 *  silent/unaudited. Uses a distinct `type:'merge'` marker: `recomputeCounters`
 *  and `learning-metrics` only consume retrieval/receipt/outcome types, so this
 *  never inflates any retrieval/contradiction/receipt counter — and the hive
 *  events log is a separate file from the per-project counter baseline. */
function stageMergeAudit(args: {
	survivingEntryId: string;
	mergedFromId: string;
	authorized: boolean;
	authorizationBasis: string;
}): HiveAuditEntry {
	const event = {
		type: 'merge',
		schema_version: 1,
		event_id: crypto.randomUUID(),
		timestamp: new Date().toISOString(),
		entry_id: args.survivingEntryId,
		action: 'merge',
		merged_from: args.mergedFromId,
		authorized: args.authorized,
		authorization_basis: args.authorizationBasis,
	};
	return { line: JSON.stringify(event) };
}

/**
 * Audited pass-through for the non-destructive hive dedup-merge (PRR-007 /
 * #1848 criterion #8). Records the losing swarm source id on the surviving hive
 * entry's `lineage.merged_from` and returns a staged audit line documenting it.
 *
 * Routes the merge through the ONE shared curation policy (`authorizeCuration`,
 * `action:'merge'`) so it genuinely "shares the policy" — but it is a
 * PASS-THROUGH, not a gate. The global hive is unlinked and cross-project, its
 * entries carry no `producer`/`cohort_id` owner, and the merge is
 * non-destructive (it only APPENDS a source id; it never deletes or overwrites a
 * lesson). For the unlinked hive dir `authorizeCuration` returns
 * `authorized:true` with basis `config-skipped-unlinked` — a real authorization,
 * not a block. A merge is therefore NEVER aborted on a policy decision (aborting
 * would regress hive dedup); if the decision is ever unexpectedly not-authorized,
 * the merge still proceeds and the anomaly is captured in the audit basis so it
 * is visible.
 *
 * Returns the staged audit entry to append, or `undefined` when the source id is
 * already recorded (idempotent no-op → no duplicate merge/audit).
 *
 * #1821 A3 — OUT OF SCOPE FOR THE ACTIONABILITY FLOOR, DELIBERATELY. This
 * function mutates hive `lineage.merged_from` outside `evaluatePromotionPolicy`,
 * so it is worth naming rather than silently ignoring: it is a MERGE, not a
 * promotion. It creates no hive entry and changes no lesson, predicate, or
 * scope — it only appends a losing source id for provenance onto an entry that
 * already cleared the policy when it was promoted. Gating a provenance append on
 * the promotion actionability floor would drop audit trail, not enforce quality.
 * The candidate whose id is recorded here was already refused promotion by the
 * dedup branch above, independent of any gate.
 */
async function authorizeAndRecordHiveMerge(args: {
	survivingEntry: HiveKnowledgeEntry;
	losingSourceId: string;
	config: KnowledgeConfig;
	hiveDir: string;
}): Promise<HiveAuditEntry | undefined> {
	const { survivingEntry, losingSourceId, config, hiveDir } = args;
	const mergedFrom = survivingEntry.lineage?.merged_from ?? [];
	if (mergedFrom.includes(losingSourceId)) return undefined; // idempotent

	// Share the ONE curation policy. Pass-through (not a gate): see docstring for
	// why an unlinked, owner-less, non-destructive hive merge is authorized rather
	// than blocked. Fail-open: if authorization itself throws, still merge (the
	// finding's core is the SILENT bypass — the audit record below resolves it).
	let authorized = true;
	let basis = 'config-skipped-unlinked';
	try {
		const decision = await _internals.authorizeCuration(
			{
				directory: hiveDir,
				action: 'merge',
				entryId: survivingEntry.id,
				reason: `hive dedup-merge: near-duplicate source ${losingSourceId}`,
				// Hive dedup is inherently a cross-project consolidation decision.
				evidenceScope: 'cohort-wide',
			},
			{
				config,
				entry: {
					id: survivingEntry.id,
					// Hive entries have no producer provenance (cross-project,
					// owner-less) — this is why the merge is pass-through, not gated.
					producer: null,
					status: survivingEntry.status,
				},
			},
		);
		authorized = decision.authorized;
		basis = decision.basis;
	} catch (err) {
		authorized = false;
		basis = `authorize-error:${err instanceof Error ? err.message : String(err)}`;
	}

	// Perform the merge REGARDLESS of the decision (non-destructive; never abort).
	survivingEntry.lineage = survivingEntry.lineage ?? { actor: 'auto' };
	survivingEntry.lineage.merged_from = [...mergedFrom, losingSourceId];
	survivingEntry.updated_at = new Date().toISOString();

	return stageMergeAudit({
		survivingEntryId: survivingEntry.id,
		mergedFromId: losingSourceId,
		authorized,
		authorizationBasis: basis,
	});
}

/**
 * #2472 W2 gate 1 — write-class tool names that may trigger promotion.
 *
 * Source of truth: `WRITE_TOOL_NAMES` in `src/config/constants.ts` — the same
 * canonical write-tool set used by scope-guard, guardrails, and the repo-graph
 * builder. Copied into a Set for O(1) membership on the tool.execute.after hot
 * path. Do NOT add names here — extend `WRITE_TOOL_NAMES` there.
 */
const PROMOTER_WRITE_TOOL_NAMES: ReadonlySet<string> = new Set(
	WRITE_TOOL_NAMES,
);

/**
 * #2472 W2 gate 3 — minimum wall-clock spacing (ms) between promotion bodies
 * per directory. A second qualifying write-tool invocation inside this window
 * returns before the promotion body, so a multi-file edit burst runs the body
 * at most once per window (frozen check C3 Phase B pins transactHiveStore ≤ 1).
 */
const PROMOTION_CADENCE_FLOOR_MS = 60_000;

/**
 * #2472 W2 — bound for `lastPromotionRunAt` (AGENTS.md invariant 8: module
 * state must be keyed and explicitly bounded). 64 distinct project directories
 * is far beyond any real process's working set.
 */
const MAX_PROMOTER_TRACKED_DIRECTORIES = 64;

/** Last time the promotion body ran, per directory (insertion-ordered; the
 *  oldest key is evicted past the cap). */
const lastPromotionRunAt = new Map<string, number>();

/**
 * #2472 W2 (critic Round 2 item 1) — directories whose one-time legacy
 * curator-summary migration check has already run in this process. Keeps the
 * `readCuratorSummary` migration reachable on an empty store while bounding it
 * to at most once per directory per process. Bounded by the set of distinct
 * directories seen (add-only).
 */
const curatorMigrationCheckedDirectories = new Set<string>();

/**
 * PRR-023 — one canonical gating key per directory. `path.resolve` collapses
 * alternate spellings of the same directory (trailing separators, `.`/`..`
 * segments, forward/back-slash mixes on Windows), so the cadence floor and the
 * curator-migration once-guard are shared across every hook closure spelling
 * of one project: a differently-spelled invocation can neither bypass the
 * cadence floor nor re-trigger the one-time migration.
 */
function promoterGatingKey(directory: string): string {
	return canonicalRootKey(directory);
}

/** Record a promotion-body run for `directory`, refreshing recency and evicting
 *  the oldest key past the cap (invariant 8). Keyed on the resolved spelling
 *  (PRR-023). */
function markPromotionRunAt(directory: string, now: number): void {
	const key = promoterGatingKey(directory);
	lastPromotionRunAt.delete(key);
	lastPromotionRunAt.set(key, now);
	if (lastPromotionRunAt.size > MAX_PROMOTER_TRACKED_DIRECTORIES) {
		const oldest = lastPromotionRunAt.keys().next().value;
		if (oldest !== undefined && oldest !== key) {
			lastPromotionRunAt.delete(oldest);
		}
	}
}

export const _internals = {
	readSwarmEntries: (directory: string) =>
		readKnowledge<SwarmKnowledgeEntry>(resolveSwarmKnowledgePath(directory)),
	checkHivePromotions,
	readCuratorSummary,
	appendCuratorRecommendation,
	// #1847 DI seams (invariant 7) — tests inject these rather than mock.module.
	//
	// #2472 W2: the DEFAULT cohort resolver routes through the shared cohort
	// cache (`ensureCohortIdCached`, ./cohort-cache.ts) instead of the raw
	// per-call git spawn — a qualifying promoter run reuses the cohort id
	// cached at `chat.message` turn 1, and `ensureCohortIdCached` resolves once
	// and caches on a miss, so at most one resolution happens per session
	// either way. Falls back to the raw resolver when there is no sessionID
	// (manual `/swarm promote` paths) or the cached resolve failed. The
	// promoter consumes only `.cohortId`; on a cache hit the identity's
	// provenance fields are inert placeholders — the cached id was already
	// canonicalized by `resolveCohortId` before it was cached.
	resolveCohortId: async (
		directory: string,
		sessionID?: string,
	): Promise<CohortIdentity> => {
		const cached = await ensureCohortIdCached(directory, sessionID);
		if (cached) {
			return { cohortId: cached, source: 'path', degraded: true };
		}
		return resolveCohortId(directory);
	},
	transactHiveStore,
	validateLesson,
	// PRR-007: the shared curation policy the dedup-merge routes through (as an
	// audited pass-through). DI seam so tests can assert the merge shares it.
	authorizeCuration,
	/** Loads authoritative terminal-application evidence per swarm entry id.
	 *  Empty on receipt-ledger uncertainty (conservative: no synthetic credit). */
	loadPromotionEvidence: async (
		directory: string,
		canonicalCohortId?: string,
	): Promise<Record<string, PromotionEvidenceRecord[]>> =>
		loadPromotionEvidenceByEntry(directory, canonicalCohortId),
	/** Loads the default KnowledgeConfig (schema defaults) for manual promotion
	 *  paths when the command did not load one. */
	loadDefaultKnowledgeConfig: () => KnowledgeConfigSchema.parse({}),
	/** #2472 W2 cadence clock (PRR-021 DI seam, invariant 7): the promotion
	 *  cadence floor reads time through this seam so tests can advance the
	 *  60s floor deterministically without real sleeping or raw wall-clock
	 *  polling. Everything else (entry timestamps, audit timestamps) stays on
	 *  `new Date().toISOString()` — only the cadence decision is time-driven
	 *  control flow. */
	now: (): number => Date.now(),
	/** Test-only: clears the #2472 W2 hook-gating state (per-directory cadence
	 *  map + curator-migration guard). Production code never calls this; it
	 *  exists so test files sharing one Bun process start from a clean slate. */
	resetPromoterGatingState: () => {
		lastPromotionRunAt.clear();
		curatorMigrationCheckedDirectories.clear();
	},
};

/**
 * Create a hook that promotes swarm entries to the hive.
 *
 * #2472 W2 gating — the hook self-gates instead of running unconditionally:
 *  1. Write-class tools only (`PROMOTER_WRITE_TOOL_NAMES`): a read-only tool
 *     call returns before even the swarm-store read.
 *  2. Empty-candidates gate: when no swarm entry has ACTIVE status the hook
 *     returns BEFORE cohort resolution, evidence loading, the hive
 *     transaction, and the curator-summary read. The one-time legacy
 *     curator-summary migration read stays reachable — at most once per
 *     directory per process (critic Round 2 item 1).
 *  3. Cadence floor: a second qualifying invocation inside
 *     `PROMOTION_CADENCE_FLOOR_MS` returns before the promotion body.
 */
export function createHivePromoterHook(
	directory: string,
	config: KnowledgeConfig,
): (input: unknown, output: unknown) => Promise<void> {
	const hook = async (input: unknown, _output: unknown): Promise<void> => {
		// Gate 1 — tool class. `tool.execute.after` fires for EVERY tool; only
		// workspace-modifying tools can move promotion state.
		const tool = (input as { tool?: unknown } | null | undefined)?.tool;
		if (typeof tool !== 'string' || !PROMOTER_WRITE_TOOL_NAMES.has(tool)) {
			return;
		}
		const sessionID = (input as { sessionID?: unknown } | null | undefined)
			?.sessionID;

		// Gate 2 — promotion candidates. Read the swarm store first; with no
		// ACTIVE entry there is nothing to promote or confirm.
		const swarmEntries = await _internals.readSwarmEntries(directory);
		const hasActiveCandidates = swarmEntries.some((e) =>
			isActiveStatus(e.status),
		);
		if (!hasActiveCandidates) {
			// Critic requirement: preserve the one-time legacy curator-summary
			// migration (the pre-W2 code read the summary "first even on a
			// no-op"). On an empty store the migration check runs at most once
			// per directory per process; subsequent empty-store calls return
			// without reading it. Keyed on the resolved spelling (PRR-023) so
			// alternate spellings of one directory share the guard.
			if (
				!curatorMigrationCheckedDirectories.has(promoterGatingKey(directory))
			) {
				curatorMigrationCheckedDirectories.add(promoterGatingKey(directory));
				await _internals.readCuratorSummary(directory);
			}
			return;
		}

		// Gate 3 — cadence floor (see PROMOTION_CADENCE_FLOOR_MS). The clock is
		// the `_internals.now` seam (PRR-021) and the map key is the resolved
		// spelling (PRR-023), so the floor is deterministic in tests and shared
		// across directory spellings.
		const now = _internals.now();
		const lastRunAt = lastPromotionRunAt.get(promoterGatingKey(directory));
		if (
			lastRunAt !== undefined &&
			now - lastRunAt < PROMOTION_CADENCE_FLOOR_MS
		) {
			return;
		}
		markPromotionRunAt(directory, now);

		const promotionSummary = await _internals.checkHivePromotions(
			swarmEntries,
			config,
			directory,
			typeof sessionID === 'string' ? sessionID : undefined,
		);

		// Read first even on a no-op: this is the one-time migration path for
		// legacy bloated curator summaries when a project is reopened. On a
		// non-empty store today's ordering is kept — this read runs on every
		// qualifying promotion body.
		const curatorSummary = await _internals.readCuratorSummary(directory);
		if (!curatorSummary) return;

		const hasActivity =
			promotionSummary.new_promotions > 0 ||
			promotionSummary.encounters_incremented > 0 ||
			promotionSummary.advancements > 0;
		if (!hasActivity) return;

		await _internals.appendCuratorRecommendation(directory, {
			action: 'promote',
			lesson: `Hive promotion: ${promotionSummary.new_promotions} new, ${promotionSummary.encounters_incremented} encounters, ${promotionSummary.advancements} advancements, ${promotionSummary.total_hive_entries} total entries`,
			reason: JSON.stringify({
				timestamp: promotionSummary.timestamp,
				new_promotions: promotionSummary.new_promotions,
				encounters_incremented: promotionSummary.encounters_incremented,
				advancements: promotionSummary.advancements,
				total_hive_entries: promotionSummary.total_hive_entries,
			}),
		});
	};

	return safeHook(hook);
}

/** Options for manual promotion (override semantics, #1847 §4). */
export interface ManualPromotionOptions {
	force?: boolean;
	reason?: string;
}

/**
 * Actionability fields supplied on the DIRECT-TEXT promote path (#1821 A3).
 *
 * `/swarm promote "<text>"` has no swarm entry to inherit predicates/scope
 * from, so the command passes them explicitly. Without this parameter the
 * default-on `actionability_floor` gate would be permanently unsatisfiable on
 * that path: every direct-text promotion would return "Promotion blocked by
 * policy" and operators would be pushed into `--force`, poisoning the
 * override-audit signal that #1847 exists to keep honest.
 *
 * `promoteFromSwarm` does NOT take these — it inherits the source swarm entry's
 * own actionable-directive fields via `carryActionableFields`.
 */
export interface ManualActionabilityFields {
	applies_to_tools?: string[];
	applies_to_agents?: string[];
	required_actions?: string[];
	forbidden_actions?: string[];
	verification_checks?: string[];
}

/** Cap applied to each manually-supplied actionability list. Mirrors the store
 *  write-boundary cap (`WRITE_FIELD_CAP` in knowledge-store.ts, #1821 Lane 0b)
 *  so the command cannot author a list the store would silently truncate. */
const MANUAL_ACTIONABILITY_CAP = 20;

const MANUAL_ACTIONABILITY_KEYS = [
	'applies_to_tools',
	'applies_to_agents',
	'required_actions',
	'forbidden_actions',
	'verification_checks',
] as const satisfies readonly (keyof ManualActionabilityFields)[];

/**
 * Normalize caller-supplied actionability lists: drop non-strings, dedupe
 * case-insensitively, cap at 20, and OMIT empty fields entirely.
 *
 * Omission matters: `validateActionability` and `carryActionableFields` both
 * test `.length`, and an empty array persisted on the entry is noise that an
 * absent field is not. Normalizing here (not only in the command) keeps the
 * exported `promoteToHive` API safe for any other caller.
 */
function normalizeManualActionability(
	fields: ManualActionabilityFields | undefined,
): ManualActionabilityFields {
	if (!fields) return {};
	const out: ManualActionabilityFields = {};
	for (const key of MANUAL_ACTIONABILITY_KEYS) {
		const normalized = dedupeCapped(fields[key], {
			cap: MANUAL_ACTIONABILITY_CAP,
		});
		if (normalized.length > 0) out[key] = normalized;
	}
	return out;
}

/**
 * Promote a lesson directly to the hive (manual promotion).
 *
 * Runs the one policy evaluator. On a policy FAIL:
 *   - without `force` → returns a diagnostic string listing the failed gates
 *     (does NOT promote);
 *   - with `force` + `reason` → promotes and writes a durable override audit
 *     record (actor='manual-override', failed gates recorded) inside the
 *     transaction.
 * On a policy PASS → promotes with actor='manual'.
 *
 * An exact entry id / direct text alone is NEVER authorization to bypass policy.
 *
 * `actionable` (#1821 A3) carries the predicate/scope fields the direct-text
 * path has no swarm entry to inherit from. They land on the synthetic stand-in
 * (so the `actionability_floor` gate can see them) AND on the written hive
 * entry (so a correctly-supplied field is not dropped on write).
 */
export async function promoteToHive(
	directory: string,
	lesson: string,
	category?: string,
	options?: ManualPromotionOptions,
	config?: KnowledgeConfig,
	actionable?: ManualActionabilityFields,
): Promise<string> {
	const trimmedLesson = lesson.trim();
	const actionableFields = normalizeManualActionability(actionable);
	const sourceCohort = await _internals.resolveCohortId(directory);
	// Use the real project config so manual promotion honors the same
	// application-evidence / cohort thresholds as automatic promotion (AC9).
	// Default to schema defaults when the command did not load one.
	const policyConfig = config ?? _internals.loadDefaultKnowledgeConfig();

	const result = await _internals.transactHiveStore<string>(async (ctx) => {
		// Dedup against the locked entries.
		if (
			findNearDuplicate(
				trimmedLesson,
				ctx.entries,
				policyConfig.dedup_threshold,
			)
		) {
			return {
				kind: 'noop' as const,
				return: `Lesson already exists in hive (near-duplicate).`,
			};
		}

		// Validate before writing (throws on error severity — propagate).
		const validationResult = _internals.validateLesson(
			trimmedLesson,
			ctx.entries.map((e) => e.lesson),
			{
				category: (category as KnowledgeCategory) || 'process',
				scope: 'global',
				confidence: 1.0,
			},
		);
		if (validationResult.severity === 'error') {
			return {
				kind: 'noop' as const,
				return: `Lesson rejected by validator: ${validationResult.reason}`,
			};
		}

		// Evaluate the one policy. The direct-text path has no swarm entry, so
		// we synthesize a minimal stand-in. Per #1847 §4, a human explicitly
		// authoring a hive lesson IS the authorization for the eligibility_route
		// (route 2 fast-track) — this is recorded as actor:'manual' (NOT
		// 'manual-override'). The active_status + confidence_floor +
		// application-evidence gates still apply honestly. --force is required
		// only when THOSE gates fail, recording actor:'manual-override' + the
		// failed gates. (F-006: the fast-track tag here is the explicit manual
		// authorization, not a silent self-satisfaction — it is documented and
		// the actor field distinguishes authorized-manual from forced-override.)
		//
		// #1821 A3: the fast-track tag authorizes the eligibility_route gate ONLY.
		// It does NOT bypass `actionability_floor` — the stand-in carries exactly
		// the predicate/scope fields the caller supplied, so a bare
		// `/swarm promote "<prose>"` is blocked like any other non-actionable
		// candidate.
		const swarmStandIn: SwarmKnowledgeEntry = {
			id: 'manual-direct',
			tier: 'swarm',
			lesson: trimmedLesson,
			category: (category as KnowledgeCategory) || 'process',
			tags: ['hive-fast-track'], // route 2: explicit manual authorization
			scope: 'global',
			confidence: 1.0,
			status: 'promoted',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: KNOWLEDGE_SCHEMA_VERSION,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			project_name: path.basename(directory) || 'unknown',
			...actionableFields,
		};
		const decision = evaluatePromotionPolicy({
			entry: swarmStandIn,
			config: policyConfig,
			evidence: [],
		});

		const force = options?.force === true;
		// F-007: sanitize the free-text reason before it is stored in lineage
		// and the audit log (which is readable via knowledge_recall debug).
		const reason = sanitizeReason(options?.reason);

		let actor: PromotionActor;
		let overrideFailedGates: string[] | undefined;
		if (decision.eligible) {
			actor = 'manual';
		} else if (force && reason && reason.length > 0) {
			actor = 'manual-override';
			overrideFailedGates = failedGateNames(decision);
		} else {
			// Policy failed and no valid override → block, return diagnostics.
			return {
				kind: 'noop' as const,
				return: `Promotion blocked by policy: ${decision.reason}. Use --force --reason "<why>" to record an audited override.`,
			};
		}

		const promotionEventId = crypto.randomUUID();
		const newHiveEntry: HiveKnowledgeEntry = {
			id: crypto.randomUUID(),
			tier: 'hive',
			lesson: trimmedLesson,
			category: (category as KnowledgeCategory) || 'process',
			tags: [],
			scope: 'global',
			confidence: 1.0,
			status: 'promoted',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: KNOWLEDGE_SCHEMA_VERSION,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			source_project: path.basename(directory) || 'unknown',
			encounter_score: 1.0,
			lineage: buildLineage({
				actor,
				sourceCohortId: sourceCohort.cohortId,
				promotionEventId,
				reason: reason || undefined,
				overrideFailedGates,
			}),
			// #1821 A3 BUG FIX: this write path was the ONLY one of the three
			// promote paths missing the carry-over spread that
			// `checkHivePromotions` and `promoteFromSwarm` already have. Without
			// it, actionability fields that satisfied the policy gate were
			// silently dropped on write — the promoted hive entry would come back
			// non-actionable and be unusable by every directive consumer.
			...carryActionableFields(swarmStandIn),
		};

		const entries = [...ctx.entries, newHiveEntry];
		const audit = [
			stagePromotionAudit({
				entryId: newHiveEntry.id,
				lesson: newHiveEntry.lesson,
				actor,
				sourceCohortId: sourceCohort.cohortId,
				promotionEventId,
				reason: reason || undefined,
				overrideFailedGates,
			}),
		];

		return {
			kind: 'commit' as const,
			entries,
			audit,
			return: `Promoted to hive: "${trimmedLesson.slice(0, 50)}${trimmedLesson.length > 50 ? '...' : ''}" (confidence: 1.0, source: manual${actor === 'manual-override' ? '-override' : ''})`,
		};
	});

	// The promotion audit is already staged inside the transaction (the durable
	// override record). No extra post-transaction event is needed — emitting one
	// here would re-enter the directory lock's file (deadlock risk) and the
	// ReceiptEvent 'override' shape requires receipt-only fields we do not have.

	// PRR-4: on transaction failure, surface the diagnostic reason instead of
	// returning undefined (which would give the user an empty reply).
	if (result.return !== undefined) return result.return;
	return `Promotion failed: ${result.diagnostics.join('; ') || 'transaction did not commit'}`;
}

/**
 * Promote a lesson from swarm knowledge to hive.
 *
 * Snapshots the swarm read OUTSIDE the hive transaction (the swarm store is
 * read-only here — no two-phase locking needed). Then runs the one policy
 * evaluator + override semantics inside the hive transaction.
 */
export async function promoteFromSwarm(
	directory: string,
	lessonId: string,
	options?: ManualPromotionOptions,
	config?: KnowledgeConfig,
): Promise<string> {
	// Snapshot the swarm entry outside the hive transaction.
	const swarmEntries = await readKnowledge<SwarmKnowledgeEntry>(
		resolveSwarmKnowledgePath(directory),
	);
	const swarmEntry = swarmEntries.find((e) => e.id === lessonId);
	if (!swarmEntry) {
		throw new Error(`Lesson ${lessonId} not found in .swarm/knowledge.jsonl`);
	}

	const sourceCohort = await _internals.resolveCohortId(directory);
	// Use the real project config so manual promotion honors the same policy
	// thresholds as automatic promotion (AC9). Default to schema defaults.
	const policyConfig = config ?? _internals.loadDefaultKnowledgeConfig();

	const result = await _internals.transactHiveStore<string>(async (ctx) => {
		if (
			findNearDuplicate(
				swarmEntry.lesson,
				ctx.entries,
				policyConfig.dedup_threshold,
			)
		) {
			return {
				kind: 'noop' as const,
				return: `Lesson already exists in hive (near-duplicate).`,
			};
		}

		const validationResult = _internals.validateLesson(
			swarmEntry.lesson,
			ctx.entries.map((e) => e.lesson),
			{
				category: swarmEntry.category,
				scope: swarmEntry.scope,
				confidence: swarmEntry.confidence,
			},
		);
		if (validationResult.severity === 'error') {
			return {
				kind: 'noop' as const,
				return: `Lesson rejected by validator: ${validationResult.reason}`,
			};
		}

		// One policy evaluator (M1: same gates as auto promotion). An exact id
		// alone is NEVER authorization to bypass policy.
		const decision = evaluatePromotionPolicy({
			entry: swarmEntry,
			config: policyConfig,
			evidence: [],
		});

		const force = options?.force === true;
		// F-007: sanitize the free-text reason before it is stored in lineage
		// and the audit log (which is readable via knowledge_recall debug).
		const reason = sanitizeReason(options?.reason);

		let actor: PromotionActor;
		let overrideFailedGates: string[] | undefined;
		if (decision.eligible) {
			actor = 'manual';
		} else if (force && reason && reason.length > 0) {
			actor = 'manual-override';
			overrideFailedGates = failedGateNames(decision);
		} else {
			return {
				kind: 'noop' as const,
				return: `Promotion blocked by policy: ${decision.reason}. Use --force --reason "<why>" to record an audited override.`,
			};
		}

		const promotionEventId = crypto.randomUUID();
		const newHiveEntry: HiveKnowledgeEntry = {
			id: crypto.randomUUID(),
			tier: 'hive',
			lesson: swarmEntry.lesson,
			category: swarmEntry.category,
			tags: swarmEntry.tags,
			scope: swarmEntry.scope,
			confidence: 1.0,
			status: 'promoted',
			confirmed_by: [],
			retrieval_outcomes: {
				applied_count: 0,
				succeeded_after_count: 0,
				failed_after_count: 0,
			},
			schema_version: swarmEntry.schema_version || KNOWLEDGE_SCHEMA_VERSION,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
			source_project: swarmEntry.project_name,
			encounter_score: 1.0,
			lineage: buildLineage({
				actor,
				sourceEntryId: swarmEntry.id,
				sourceCohortId: sourceCohort.cohortId,
				promotionEventId,
				reason: reason || undefined,
				overrideFailedGates,
			}),
			...carryActionableFields(swarmEntry),
		};

		const entries = [...ctx.entries, newHiveEntry];
		const audit = [
			stagePromotionAudit({
				entryId: newHiveEntry.id,
				lesson: newHiveEntry.lesson,
				actor,
				sourceEntryId: swarmEntry.id,
				sourceCohortId: sourceCohort.cohortId,
				promotionEventId,
				reason: reason || undefined,
				overrideFailedGates,
			}),
		];

		return {
			kind: 'commit' as const,
			entries,
			audit,
			return: `Promoted lesson ${lessonId} from swarm to hive: "${swarmEntry.lesson.slice(0, 50)}${swarmEntry.lesson.length > 50 ? '...' : ''}"`,
		};
	});

	// PRR-4: surface the diagnostic reason on transaction failure.
	if (result.return !== undefined) return result.return;
	return `Promotion failed: ${result.diagnostics.join('; ') || 'transaction did not commit'}`;
}

// Resolve hive knowledge path re-exported for any external consumer that still
// imports it from this module (historical surface).
export { resolveHiveKnowledgePath } from './knowledge-store.js';
