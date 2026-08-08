export interface SecretFinding {
	type: string;
	match: string;
}

interface SecretPattern {
	type: string;
	pattern: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
	{ type: 'openai_api_key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
	{
		type: 'github_token',
		pattern: /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g,
	},
	{ type: 'aws_access_key_id', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
	{
		type: 'private_key_block',
		pattern:
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
	},
	{
		type: 'authorization_bearer',
		pattern: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
	},
	{
		type: 'env_secret',
		pattern:
			/\b(?:[A-Z][A-Z0-9]+_)+(?:KEY|TOKEN|SECRET|PASSWORD)\b\s*=\s*["']?[^\s"'`]{8,}["']?/gi,
	},
	// FR-08 / DD-05: GitLab tokens. False-positive risk: short `glpat-` strings under 15 chars
	// are not real tokens; plain "glpat-" without suffix is ignored.
	{ type: 'gitlab_token', pattern: /\bgl(?:pat|ptt)-[A-Za-z0-9_-]{15,}\b/g },
	// FR-08 / DD-05: Slack tokens. False-positive risk: `xox-` with fewer than 10 chars after the
	// prefix is not a real Slack token; strings like "xoxb-test" are intentionally excluded.
	{ type: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
	// FR-08 / DD-05: JWT tokens. False-positive risk: a single JWT segment (e.g. `eyJonly`) or
	// strings with only one dot will not match; a full 3-segment base64url token is required.
	{
		type: 'jwt_token',
		pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
	},
	// FR-08 / DD-05: AWS secret access key. False-positive risk: keys shorter than 40 characters
	// are rejected; the `=`/`:` separator plus key name is required to avoid matching random strings.
	{
		type: 'aws_secret_access_key',
		pattern:
			/\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*[A-Za-z0-9/+=]{40}\b/g,
	},
	// FR-08 / DD-05: Stripe secret keys. False-positive risk: keys using prefixes other than
	// `sk_`/`rk_` or environments other than `live`/`test` are ignored; short strings are excluded.
	{
		type: 'stripe_secret_key',
		pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
	},
	// FR-08 / DD-05: Google API keys. False-positive risk: the `AIza` prefix plus 35 additional
	// chars is required; strings like "AIzaShort" are too short and will not match.
	{ type: 'google_api_key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
	// FR-08 / DD-05: OpenSSH private key blocks. False-positive risk: text that merely mentions
	// "openssh" without the full `-----BEGIN/END OPENSSH PRIVATE KEY-----` block delimiters
	// will not match; multiline content between delimiters is required.
	// Spaces use `[ ]` char class so secretscan does not flag this detection regex (the
	// pattern text would otherwise match the secret detector).
	{
		type: 'openssh_private_key_block',
		pattern:
			/-----BEGIN[ ]OPENSSH[ ]PRIVATE[ ]KEY-----[\s\S]*?-----END[ ]OPENSSH[ ]PRIVATE[ ]KEY-----/g,
	},
];

/**
 * #1850: Coarse redaction-policy fingerprint. Two cohort members with the same
 * count of secret-pattern families and the same `rejectDurableSecrets` setting
 * are considered policy-compatible; a mismatch fails closed at link time and on
 * cohort-root open. This is honest about what it measures (the regex pattern
 * count + the durable-rejection toggle) — it is NOT a content hash of stored
 * records. Bump the salt constant when the redaction contract changes
 * meaningfully (e.g. adding PII detection per #1466).
 */
export const REDACTION_POLICY_SALT = 1;
export function computeRedactionPolicyVersion(
	rejectDurableSecrets: boolean,
): number {
	return (
		REDACTION_POLICY_SALT * 1_000_000 +
		SECRET_PATTERNS.length * 2 +
		(rejectDurableSecrets ? 1 : 0)
	);
}

/**
 * #1850 (final-critic dedup): the single cohort-config fingerprint algorithm.
 * Consumed by the linker (writer), the SQLite provider (fail-closed check),
 * and the status service (health surface). Centralizing it here prevents the
 * triple-duplication the final critic flagged — any future edit to the input
 * shape or hash params changes all three sites consistently.
 *
 * Input shape mirrors what `handleMemoryLinkCommand` writes to
 * `memory-cohort-config.json`. Two cohort members with the same fingerprint
 * are considered config-compatible.
 */
import { createHash } from 'node:crypto';
import { stableCanonicalStringify } from '../utils/stable-stringify';

export interface MemoryCohortFingerprintInput {
	provider: string;
	redaction_policy_version: number;
	embedding_model: string;
	embedding_dimension: number;
	embedding_version: string;
}

/**
 * #2062 F-012: version of the cohort-fingerprint ALGORITHM (canonicalization +
 * hash + truncation), persisted alongside the fingerprint in
 * `memory-cohort-config.json` and read back by every consumer.
 *
 * Version 1 is the algorithm below (sorted-key canonical JSON -> sha256 -> first
 * 12 hex chars). Files written before this field existed are treated as
 * version 1, which is exactly correct: they were produced by this same
 * algorithm, so they keep validating with no forced re-link.
 *
 * BUMP THIS whenever a change would alter the digest for an unchanged input —
 * e.g. a different hash, a different truncation length, a change to
 * `stableCanonicalStringify`'s output for a reachable input, or a change to the
 * `MemoryCohortFingerprintInput` shape. Readers compare versions BEFORE
 * comparing fingerprints, so a bump surfaces as "re-run `/swarm memory link`"
 * instead of being misreported as a real provider/embedding config mismatch.
 */
export const FINGERPRINT_ALGORITHM_VERSION = 1;

/**
 * #2062 F-012 (R3 fix): the algorithm version implied by a persisted cohort
 * config that has NO `algorithm_version` field. Every file written before the
 * field existed was produced by algorithm version 1, so that is what an absent
 * field means — permanently, whatever `FINGERPRINT_ALGORITHM_VERSION` later
 * becomes.
 *
 * This MUST stay a standalone literal and must never be re-expressed in terms
 * of `FINGERPRINT_ALGORITHM_VERSION`. If it tracked the current version, then
 * the moment that constant is bumped every legacy file already on disk would
 * report itself as current, the version gate could never fire for the very
 * files it exists to protect, and a v1 digest would be byte-compared against a
 * v2 expected value — which `SQLiteMemoryProvider` turns into a hard
 * "config differs" throw. Defaulting to the current version is self-defeating
 * at exactly the moment the mechanism is supposed to help.
 *
 * The explicit `: 1` literal type is the enforcement, not decoration — and it
 * enforces only for as long as it is actually there. No runtime test can catch
 * the aliasing refactor today (while `FINGERPRINT_ALGORITHM_VERSION` is still
 * 1, an alias evaluates to 1 and every assertion passes), so the guard has to
 * fire at the only moment the mistake becomes real: the bump.
 *
 * Both halves of that were measured against this repo with the constant
 * temporarily set to 2, running `bunx tsc --noEmit`:
 *
 * - `LEGACY_…: 1 = FINGERPRINT_ALGORITHM_VERSION` (annotation KEPT)
 *   -> exit 2, `TS2322: Type '2' is not assignable to type '1'`. Guard fires.
 * - `LEGACY_… = FINGERPRINT_ALGORITHM_VERSION` (annotation DROPPED)
 *   -> exit 0. Guard does NOT fire, and every legacy cohort file is stranded
 *   silently.
 *
 * The second form is the one a refactorer actually types, so do NOT rely on
 * `tsc` to catch removal of this annotation — the annotation is the thing
 * being protected, not merely the mechanism. A legitimate bump that leaves
 * this literal alone typechecks cleanly.
 */
export const LEGACY_FINGERPRINT_ALGORITHM_VERSION: 1 = 1;

/**
 * DI seam for testability (repo convention, cf. `src/utils/logger.ts`). Lets a
 * test simulate a FUTURE bump of `FINGERPRINT_ALGORITHM_VERSION` without
 * hand-editing the constant — the only way to exercise the legacy-file version
 * gate before a real bump ever happens. Production code never mutates this.
 */
export const _internals: { currentAlgorithmVersion: number } = {
	currentAlgorithmVersion: FINGERPRINT_ALGORITHM_VERSION,
};

/**
 * Result of interpreting a persisted `algorithm_version` field:
 * - `comparable` — stored digest was produced by the current algorithm, so a
 *   byte comparison is meaningful.
 * - `mismatch` — a known but different algorithm produced it; the digests are
 *   not comparable, so callers skip the compare and fail OPEN with a re-link
 *   instruction rather than reporting a config difference that does not exist.
 * - `unknown` — the field is present but not a finite number, so the digest
 *   cannot be attributed to any algorithm. Callers skip the compare too, but
 *   must NOT assume it is current (that would byte-compare on a guess).
 */
export type StoredFingerprintAlgorithmVersion =
	| { status: 'comparable' }
	| { status: 'mismatch'; storedVersion: number; currentVersion: number }
	| { status: 'unknown' };

/**
 * Single source of truth for the version gate shared by all four readers
 * (SQLite provider, local-jsonl provider, status service, knowledge
 * diagnostics). Keeping it here means a future bump changes one file, and the
 * absent-field semantics cannot silently drift apart across call sites.
 */
export function classifyStoredFingerprintAlgorithmVersion(
	rawStoredVersion: unknown,
	currentVersion: number = _internals.currentAlgorithmVersion,
): StoredFingerprintAlgorithmVersion {
	// `JSON.parse` never yields `undefined` for a present key, so `undefined`
	// here means the key is genuinely ABSENT — a file predating the field. An
	// explicit JSON `null`, a string, or any other non-number is PRESENT but
	// uninterpretable, which is a different thing and must not collapse to the
	// legacy default.
	const storedVersion =
		rawStoredVersion === undefined
			? LEGACY_FINGERPRINT_ALGORITHM_VERSION
			: rawStoredVersion;
	if (typeof storedVersion !== 'number' || !Number.isFinite(storedVersion)) {
		return { status: 'unknown' };
	}
	return storedVersion === currentVersion
		? { status: 'comparable' }
		: { status: 'mismatch', storedVersion, currentVersion };
}

export function computeMemoryCohortFingerprint(
	input: MemoryCohortFingerprintInput,
): string {
	// `stableCanonicalStringify` sorts keys at every depth (the current input
	// is flat, so output is byte-identical to the prior
	// `JSON.stringify(input, Object.keys(input).sort())` — existing
	// fingerprints remain valid). It avoids the property-list-replacer
	// anti-pattern, which would silently drop nested keys if a nested field is
	// ever added to `MemoryCohortFingerprintInput`.
	//
	// #2062 F-013: this call is DELIBERATELY not wrapped in try/catch, unlike
	// the two spiral/repetition-detection call sites. This fingerprint is
	// compared bit-for-bit to decide whether cohort members are config-
	// compatible (fail-closed: sqlite-provider.ts, local-jsonl-provider.ts).
	// A catch returning a constant would collapse every failing input to one
	// fingerprint, so two incompatible members would silently compare equal and
	// defeat the check (#1850 acceptance #10). A failure here must propagate.
	// (It cannot throw today: the input is a flat, always-fully-populated
	// struct of primitives — no cycles, no BigInt.)
	const canonical = stableCanonicalStringify(input);
	return createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/** Convenience: build the fingerprint input from a memory config subset. */
export function buildMemoryCohortFingerprintInput(config: {
	provider: string;
	redaction: { rejectDurableSecrets: boolean };
	embeddings: { model: string; dimension: number; version?: string };
}): MemoryCohortFingerprintInput {
	return {
		provider: config.provider,
		redaction_policy_version: computeRedactionPolicyVersion(
			config.redaction.rejectDurableSecrets,
		),
		embedding_model: config.embeddings.model,
		embedding_dimension: config.embeddings.dimension,
		embedding_version: config.embeddings.version ?? 'default',
	};
}

export function findSecrets(text: string): SecretFinding[] {
	const findings: SecretFinding[] = [];
	for (const { type, pattern } of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		for (const match of text.matchAll(pattern)) {
			if (match[0]) findings.push({ type, match: match[0] });
		}
	}
	return findings;
}

export function containsSecret(text: string): boolean {
	return findSecrets(text).length > 0;
}

export function redactSecrets(text: string): string {
	let redacted = text;
	for (const { type, pattern } of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		redacted = redacted.replace(pattern, `[REDACTED:${type}]`);
	}
	return redacted;
}
