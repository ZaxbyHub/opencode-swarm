/**
 * Cohort-safe curation authorization policy (issue #1848 §2).
 *
 * THE single shared policy every destructive knowledge lifecycle action routes
 * through. Replaces the previous design where archive/purge/remove/quarantine/
 * retraction/merge/retire each implemented their own ad-hoc inline ownership
 * check.
 *
 * Decision ladder (fail-closed default):
 *  1. Config-mismatch guard: cohort members must share curation-relevant
 *     config. A fingerprint mismatch → fail closed with an actionable
 *     diagnostic (the worktrees will curate with different semantics).
 *  2. Owner path: the acting worktree IS the proven producer and the action
 *     relies on its own validated evidence → authorized.
 *  3. Unknown-owner legacy protection: entry has no `producer` (legacy) →
 *     fail closed → record a non-destructive proposal. Never guess an owner
 *     heuristically from the current worktree.
 *  4. Not-owner + local-only evidence: a different worktree owns the entry and
 *     the actor only has LOCAL session evidence → fail closed → proposal.
 *     Absence of local evidence is NOT negative evidence.
 *  5. Cohort quorum: cohort-wide evidence (read via the link-aware event
 *     resolver) satisfies a configured quorum → authorized.
 *  6. Override: an explicit, audited operator override → authorized + recorded.
 *
 * This module is never imported on the plugin-init path. It is called lazily by
 * the destructive callers (Layer 4 routing).
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { readKnowledgeEvents } from '../hooks/knowledge-events.js';
import {
	isLinked,
	readLinkPointer,
	resolveKnowledgeStoreDir,
	resolveLinkDir,
} from '../hooks/knowledge-link.js';
import type {
	CurationAction,
	CurationEvidenceScope,
	CurationProposal,
	KnowledgeConfig,
} from '../hooks/knowledge-types.js';
import {
	type CohortConfigFingerprintInput,
	cohortConfigFingerprint,
} from './config-fingerprint.js';
import { resolveWorktreeId } from './worktree-identity.js';

/** Entry shape the policy needs to inspect for ownership decisions. */
export interface CurationTargetEntry {
	id: string;
	producer?: { worktree_id: string; cohort_id: string } | null;
	revision?: number;
	content_hash?: string;
	status?: string;
}

/** Input describing the destructive intent. */
export interface CurationAuthorizationInput {
	directory: string;
	action: CurationAction;
	entryId: string;
	reason?: string;
	/** CAS token from the snapshot the plan was built on. */
	expectedRevision?: number;
	expectedContentHash?: string;
	/** Declared by the caller: which evidence scope was used to decide. */
	evidenceScope: CurationEvidenceScope;
	/** Resolved worktree id of the actor (injected for testability). If
	 * omitted, resolved lazily via `resolveWorktreeId`. */
	actorWorktreeId?: string;
	actorRole?: string;
	/** Explicit audited operator override. */
	override?: { actor: 'manual-override'; reason: string };
}

/** Result: either authorized (with basis) or unauthorized (with proposal). */
export type CurationAuthorizationResult =
	| {
			authorized: true;
			basis: 'owner' | 'quorum' | 'override' | 'config-skipped-unlinked';
			detail: string;
			expectedRevision?: number;
			expectedContentHash?: string;
	  }
	| {
			authorized: false;
			basis:
				| 'protected-unknown-owner'
				| 'not-owner-local-evidence'
				| 'config-mismatch'
				| 'quorum-insufficient'
				| 'entry-not-found';
			detail: string;
			proposal: CurationProposal;
	  };

/** Context carrying config + the target entry (caller pre-fetches once). */
export interface CurationContext {
	config: KnowledgeConfig;
	entry: CurationTargetEntry | null;
}

/** Quorum configuration for cohort-wide decisions. */
export interface CohortQuorumConfig {
	/** Minimum distinct cohort events (e.g. violations) required to authorize. */
	minCohortEvidence: number;
}

const DEFAULT_QUORUM: CohortQuorumConfig = { minCohortEvidence: 3 };

/**
 * Authorize a destructive curation action against a single entry.
 *
 * The caller MUST pre-fetch the entry (so ownership is decided against the
 * freshest snapshot, not a stale plan) and pass it via `context.entry`.
 */
export async function authorizeCuration(
	input: CurationAuthorizationInput,
	context: CurationContext,
	quorum: CohortQuorumConfig = DEFAULT_QUORUM,
): Promise<CurationAuthorizationResult> {
	const { directory, action, entryId } = input;
	const proposal: CurationProposal = {
		entryId,
		action,
		reason: input.reason,
		evidenceScope: input.evidenceScope,
		proposedAt: new Date().toISOString(),
		status: 'pending',
	};

	// N1 fix (criterion #11): persist unauthorized proposals to a cohort-scoped
	// proposals file so other cohort members may later confirm them, and so
	// operators can see blocked destructive intent. Best-effort (fail-open).
	const persistProposal = (p: CurationProposal) => {
		queueMicrotask(async () => {
			try {
				const storeDir = _internals.resolveKnowledgeStoreDir(directory);
				await mkdir(storeDir, { recursive: true });
				await appendFile(
					path.join(storeDir, 'curation-proposals.jsonl'),
					`${JSON.stringify(p)}\n`,
					'utf-8',
				);
			} catch {
				/* best-effort: proposal persistence must not block curation */
			}
		});
	};

	// --- Step 1: config-mismatch guard (only when cohort-linked) ---
	const linked = _internals.isLinked(directory);
	if (linked) {
		const currentFp = _internals.cohortConfigFingerprint(
			buildConfigFingerprintInput(context.config),
		);
		const cohortFp = await _internals.readCohortConfigFingerprint(directory);
		if (cohortFp !== null && currentFp !== cohortFp) {
			persistProposal(proposal);
			return {
				authorized: false,
				basis: 'config-mismatch',
				detail:
					`Cohort config fingerprint mismatch: this worktree (${currentFp}) differs ` +
					`from the cohort (${cohortFp}). Cohort members will curate with different ` +
					`semantics. Align knowledge config across linked worktrees before destructive ` +
					`curation.`,
				proposal,
			};
		}
	}

	// Entry must exist for an ownership decision.
	const entry = context.entry;
	if (!entry) {
		persistProposal(proposal);
		return {
			authorized: false,
			basis: 'entry-not-found',
			detail: `Entry ${entryId} not found in the store.`,
			proposal,
		};
	}

	// --- Step 6: explicit audited override (checked early; highest authority) ---
	if (input.override?.actor === 'manual-override' && input.override.reason) {
		return {
			authorized: true,
			basis: 'override',
			detail: `Operator override: ${input.override.reason}`,
			expectedRevision: entry.revision,
			expectedContentHash: entry.content_hash,
		};
	}

	// #1848 design note: the cohort-safety ownership protections (unknown-owner
	// and not-owner-local-evidence) apply ONLY when the worktree is cohort-
	// linked, because the hazard they prevent is cross-worktree damage to a
	// shared store. An unlinked single-worktree store has no sibling to damage;
	// the local operator is the sole owner of every entry and may curate freely.
	// This preserves backward compatibility with pre-provenance entries in
	// unlinked stores while enforcing full cohort safety when linked.
	if (!linked) {
		return {
			authorized: true,
			basis: 'config-skipped-unlinked',
			detail:
				`Worktree is not cohort-linked; local curation is permitted ` +
				`(no cross-worktree safety concern).`,
			expectedRevision: entry.revision,
			expectedContentHash: entry.content_hash,
		};
	}

	// --- Step 3: unknown-owner legacy protection ---
	if (entry.producer == null) {
		persistProposal(proposal);
		return {
			authorized: false,
			basis: 'protected-unknown-owner',
			detail:
				`Entry ${entryId} has no producer provenance (legacy). Destructive ` +
				`action is protected by default; recorded as a proposal. An audited ` +
				`override is required to force it.`,
			proposal,
		};
	}

	// Resolve the acting worktree id.
	const actorWorktreeId =
		input.actorWorktreeId ?? (await _internals.resolveWorktreeId(directory));

	// --- Step 2: owner path ---
	if (entry.producer.worktree_id === actorWorktreeId) {
		return {
			authorized: true,
			basis: 'owner',
			detail:
				`Acting worktree is the proven producer of entry ${entryId}; ` +
				`owner-scoped ${input.evidenceScope} evidence authorized.`,
			expectedRevision: entry.revision,
			expectedContentHash: entry.content_hash,
		};
	}

	// --- Step 4: not-owner + local-only evidence → protected ---
	if (input.evidenceScope === 'local-session') {
		persistProposal(proposal);
		return {
			authorized: false,
			basis: 'not-owner-local-evidence',
			detail:
				`Entry ${entryId} is owned by worktree ${entry.producer.worktree_id}; ` +
				`the acting worktree (${actorWorktreeId}) has only local-session ` +
				`evidence. Absence of local evidence is not negative evidence; ` +
				`recorded as a proposal. Use cohort-wide evidence or an override.`,
			proposal,
		};
	}

	// --- Step 5: cohort quorum ---
	if (input.evidenceScope === 'cohort-wide') {
		const events = await _internals.readKnowledgeEvents(directory);
		// IR-1 fix: count only NEGATIVE-outcome events (violated/contradicted)
		// toward the destructive quorum. Positive evidence (applied/shown/
		// acknowledged) must NOT authorize a destructive action — an entry that
		// was successfully applied 3 times should not become archivable by a
		// sibling worktree. Only negative cohort-wide evidence justifies a
		// shared destructive decision (criterion #4).
		const NEGATIVE_EVENT_TYPES = new Set(['violated', 'contradicted']);
		const entryEvents = events.filter(
			(e) =>
				'type' in e &&
				NEGATIVE_EVENT_TYPES.has((e as { type?: string }).type ?? '') &&
				'knowledge_id' in e &&
				(e as { knowledge_id?: string }).knowledge_id === entryId,
		);
		const cohortEvidence = entryEvents.length;
		if (cohortEvidence >= quorum.minCohortEvidence) {
			return {
				authorized: true,
				basis: 'quorum',
				detail:
					`Cohort quorum met for entry ${entryId}: ${cohortEvidence} ` +
					`cohort-wide evidence events (≥ ${quorum.minCohortEvidence} required).`,
				expectedRevision: entry.revision,
				expectedContentHash: entry.content_hash,
			};
		}
		persistProposal(proposal);
		return {
			authorized: false,
			basis: 'quorum-insufficient',
			detail:
				`Cohort quorum NOT met for entry ${entryId}: ${cohortEvidence} ` +
				`cohort-wide evidence events (< ${quorum.minCohortEvidence} required).`,
			proposal,
		};
	}

	// producer evidence scope but different owner → not authorized via owner path,
	// fall through to proposal (owner path already failed).
	persistProposal(proposal);
	return {
		authorized: false,
		basis: 'not-owner-local-evidence',
		detail:
			`Entry ${entryId} is owned by worktree ${entry.producer.worktree_id}; ` +
			`the acting worktree (${actorWorktreeId}) is not the producer and ` +
			`has not supplied cohort-wide quorum evidence.`,
		proposal,
	};
}

/**
 * Build a config-fingerprint input from a loaded KnowledgeConfig (issue #1848
 * §3 / C-8 fix). Projects the config through its field set so two worktrees
 * with equivalent effective config produce the same fingerprint regardless of
 * whether a value was set explicitly or resolved to a default (the caller is
 * responsible for passing the *resolved* config — defaults are already baked
 * in by the time KnowledgeConfig reaches this layer).
 */
export function buildConfigFingerprintInput(
	config: KnowledgeConfig,
): CohortConfigFingerprintInput {
	return {
		dedup_threshold: config.dedup_threshold,
		scope_filter: config.scope_filter,
		validation_enabled: config.validation_enabled,
		evergreen_confidence: config.evergreen_confidence,
		evergreen_utility: config.evergreen_utility,
		low_utility_threshold: config.low_utility_threshold,
		default_max_phases: config.default_max_phases,
		todo_max_phases: config.todo_max_phases,
		confidence_floor_action: config.confidence_floor_action,
		contradiction_threshold_action: config.contradiction_threshold_action,
		contradiction_quarantine_threshold:
			config.contradiction_quarantine_threshold,
		schema_version: config.schema_version,
		swarm_max_entries: config.swarm_max_entries,
		retrieval: {
			mmr_lambda: config.retrieval?.mmr_lambda,
			cold_start_bonus: config.retrieval?.cold_start_bonus,
			synonym_min_cooccurrence: config.retrieval?.synonym_min_cooccurrence,
		},
	};
}

/**
 * Read the cohort's stored config fingerprint from the cohort link dir
 * (issue #1848 §3). Returns null when no cohort fingerprint is stored yet
 * (first member) or when unlinked.
 */
export async function readCohortConfigFingerprint(
	directory: string,
): Promise<string | null> {
	if (!_internals.isLinked(directory)) return null;
	const pointer = _internals.readLinkPointer(directory);
	if (!pointer?.linkId) return null;
	const linkDir = _internals.resolveLinkDir(pointer.linkId);
	const cohortConfigPath = path.join(linkDir, 'cohort-config.json');
	try {
		const raw = await _internals.readFile(cohortConfigPath, 'utf-8');
		const parsed = JSON.parse(raw) as { fingerprint?: string };
		return typeof parsed.fingerprint === 'string' ? parsed.fingerprint : null;
	} catch {
		return null;
	}
}

/**
 * DI seam for tests. Tests override these to avoid git subprocesses and real
 * filesystem access (per the `_internals` pattern in AGENTS.md invariant 7).
 */
export const _internals = {
	resolveWorktreeId,
	readKnowledgeEvents,
	cohortConfigFingerprint,
	readCohortConfigFingerprint,
	readFile,
	isLinked,
	readLinkPointer,
	resolveLinkDir,
	resolveKnowledgeStoreDir,
};
