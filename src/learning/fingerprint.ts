/**
 * Stable recommendation fingerprints (issue #1821, Lane 0a).
 *
 * The curator sweep, the skill improver, and the consensus miner all emit
 * learning recommendations. Without a shared identity function the three
 * producers happily re-propose the same lesson under three different ids and
 * the knowledge store accumulates triplicates. `computeRecommendationFingerprint`
 * gives every producer one canonical id so downstream dedup/supersede logic can
 * compare recommendations across mechanisms.
 *
 * This module is intentionally pure: no filesystem, no network, no clock, no
 * `process.cwd()`, no module-level mutable state (AGENTS.md invariants 1 and 8).
 * The only dependency is the canonical JSON hasher shared with the evaluation
 * subsystem, so a fingerprint computed in a hook matches one computed in a tool.
 */

import { canonicalHash } from '../evaluation/hashing.js';

/** Which learning mechanism produced a recommendation. */
export type RecommendationKind = 'curator' | 'improver' | 'miner';

export interface RecommendationFingerprintInput {
	/** Producing mechanism. Two mechanisms proposing the same statement about the
	 * same target intentionally fingerprint differently — dedup across mechanisms
	 * is a policy decision made by the caller, not baked into the identity. */
	kind: RecommendationKind;
	/** What the recommendation is about (skill slug, knowledge id, file path, …). */
	target: string;
	/** The human-readable recommendation body. Normalized before hashing. */
	statement: string;
	/** Optional scope keys (e.g. `stableScopeKey` outputs). Order-insensitive. */
	scopeKeys?: string[];
}

/** Fingerprint prefix — mirrors the `lrec_` (learning recommendation) namespace. */
const FINGERPRINT_PREFIX = 'lrec_';

/** Hex characters retained from the sha256 digest. 16 hex chars = 64 bits. */
const FINGERPRINT_HEX_LENGTH = 16;

/**
 * Normalize a recommendation statement for identity purposes.
 *
 * Mirrors `normalizeMemoryText` in `src/memory/schema.ts` (whitespace-run
 * collapse + trim) and the `.toLowerCase()` that `computeMemoryContentHash`
 * applies on top of it, then additionally strips trailing sentence punctuation
 * so "Prefer DI over mock.module." and "prefer DI over mock.module" collapse to
 * one identity.
 */
export function normalizeRecommendationStatement(statement: string): string {
	return statement
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase()
		.replace(/[.!?]+$/, '')
		.trim();
}

/**
 * Deduplicate and sort scope keys so caller-side ordering can never change the
 * fingerprint. Empty/whitespace-only keys are dropped: they carry no scope
 * information and would otherwise split identity for two equivalent inputs.
 */
export function normalizeScopeKeys(scopeKeys?: string[]): string[] {
	if (!scopeKeys || scopeKeys.length === 0) return [];
	const deduped = new Set<string>();
	for (const key of scopeKeys) {
		const trimmed = key.trim();
		if (trimmed.length > 0) deduped.add(trimmed);
	}
	return [...deduped].sort();
}

/**
 * Compute the stable fingerprint for a learning recommendation.
 *
 * Returns `lrec_` followed by the first 16 hex characters of the canonical
 * sha256 of `{ kind, target, normalizedStatement, sortedScopeKeys }`. Because
 * `canonicalHash` sorts object keys, the shape of the input literal cannot
 * change the result.
 */
export function computeRecommendationFingerprint(
	input: RecommendationFingerprintInput,
): string {
	const digest = canonicalHash({
		kind: input.kind,
		target: input.target,
		normalizedStatement: normalizeRecommendationStatement(input.statement),
		sortedScopeKeys: normalizeScopeKeys(input.scopeKeys),
	});
	return `${FINGERPRINT_PREFIX}${digest.slice(0, FINGERPRINT_HEX_LENGTH)}`;
}

/** Shape check for a value that claims to be a recommendation fingerprint. */
export function isRecommendationFingerprint(value: string): boolean {
	return /^lrec_[a-f0-9]{16}$/.test(value);
}
