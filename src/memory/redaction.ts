export interface SecretFinding {
	type: string;
	match: string;
}

interface SecretPattern {
	type: string;
	pattern: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
	// #3382: the whole-token bearer arm runs FIRST so a compound span (e.g. an
	// AWS key embedded inside a bearer token) is redacted WHOLE. redactSecrets
	// applies patterns sequentially over the mutated string, and every
	// replacement placeholder contains `[`/`:` — outside the bearer token's
	// charset — so once this arm fires, no later arm can match inside the
	// token again (at the old position, a de-anchored earlier arm could split
	// the token and leave its tail in cleartext).
	{
		type: 'authorization_bearer',
		pattern: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
	},
	{ type: 'openai_api_key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
	// #3382: the two AWS-secret arms run BEFORE the bare access-key arm.
	// redactSecrets applies patterns sequentially over the mutated string, so
	// a bare `AKIA…` replacement would destroy the anchor the context arm
	// needs and leave the 40-char secret un-redacted (overlap masking —
	// pre-existing for exact-40 context secrets, closed with this reorder;
	// the reorder also makes the context arm LIVE — see its note below).
	// #3382: the credential arms below are deliberately NOT \b-anchored: a
	// credential embedded inside a longer charset-clean token loses both word
	// boundaries and passed through unredacted at the old anchored forms.
	// Anchors are KEPT where the short alnum-only prefix collides with
	// ordinary text: openai `sk-` ("task-", "disk-"), stripe `sk_`/`rk_`
	// ("risk_live_…"), and `jwt` (`eyJ` sits inside base64 blobs). The github
	// prefixes stay unanchored but their bodies are tightened to
	// `[A-Za-z0-9]` (no `_`): real classic tokens are base62, and the
	// underscore-free body is what keeps benign snake_case identifiers like
	// `load_ghs_metadata_from_cache_store` from matching (the `ghs_` subword
	// plus an underscore-free 20-char run cannot occur in snake_case).
	{
		type: 'github_token',
		pattern:
			/(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
	},
	{
		type: 'aws_secret_access_key',
		pattern:
			/\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|secret_access_key|SecretAccessKey)"?\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}/g,
	},
	// #3382: this arm is LIVE since the reorder (at base the bare `AKIA…` arm
	// always consumed the anchor first). Whole-match replacement redacts the
	// ENTIRE span — the AKIA id, up to 200 chars of interposed text, and the
	// 40-char value — so non-secret prose between an access-key id and a
	// 40-char token on one line is removed from redacted output. That is the
	// price of redacting the context secret (at base the same shape leaked
	// the actual 40-char value in cleartext). The 40-char window keeps its
	// word boundaries: a bare 40-char run inside longer filler never matches.
	{
		type: 'aws_secret_access_key_context',
		pattern: /AKIA[0-9A-Z]{16}[^\n]{0,200}?\b[A-Za-z0-9/+=]{40}\b/g,
	},
	{ type: 'aws_access_key_id', pattern: /AKIA[0-9A-Z]{16}/g },
	{
		// #3915 AC13 / F11 (PEM part): the END-delimited arm's body gap is
		// BOUNDED at 8192 chars (was a lazy `[\s\S]*?` — with no END delimiter
		// anywhere, that arm scanned unbounded to end-of-input). Byte-identical
		// for real blocks (a real PEM body is far below 8192 chars). The no-END
		// fallback arm near the end of this array (which MUST stay AFTER this
		// arm — sequential-priority semantics) catches malformed BEGIN-only
		// input. Spaces use `[ ]` char class so secretscan does not flag this
		// detection regex (the pattern text would otherwise match the secret
		// detector).
		type: 'private_key_block',
		pattern:
			/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,8192}-----END [A-Z ]*PRIVATE KEY-----/g,
	},
	{
		type: 'env_secret',
		pattern:
			/\b(?:[A-Z][A-Z0-9]+_)+(?:KEY|TOKEN|SECRET|PASSWORD)\b\s*=\s*["']?[^\s"'`]{8,}["']?/gi,
	},
	// FR-08 / DD-05: GitLab tokens. False-positive risk: short `glpat-` strings under 15 chars
	// are not real tokens; plain "glpat-" without suffix is ignored.
	// #3382: separator-bearing prefix, deliberately not \b-anchored (see the
	// github_token note).
	{ type: 'gitlab_token', pattern: /gl(?:pat|ptt)-[A-Za-z0-9_-]{15,}/g },
	// FR-08 / DD-05: Slack tokens. False-positive risk: `xox-` with fewer than 10 chars after the
	// prefix is not a real Slack token; strings like "xoxb-test" are intentionally excluded.
	// #3382: separator-bearing prefix, deliberately not \b-anchored.
	{ type: 'slack_token', pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
	// FR-08 / DD-05: JWT tokens. False-positive risk: a single JWT segment (e.g. `eyJonly`) or
	// strings with only one dot will not match; a full 3-segment base64url token is required.
	{
		type: 'jwt_token',
		pattern: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
	},
	// FR-08 / DD-05: Stripe secret keys. False-positive risk: keys using prefixes other than
	// `sk_`/`rk_` or environments other than `live`/`test` are ignored; short strings are excluded.
	// KEPT \b-anchored: the bare `sk_`/`rk_` prefix collides with English prose
	// ("risk_live_…" contains "sk_live_"), so de-anchoring would over-redact
	// ordinary text. Not one of the #3382-named families.
	{
		type: 'stripe_secret_key',
		pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
	},
	// FR-08 / DD-05: Google API keys. False-positive risk: the `AIza` prefix plus 35 additional
	// chars is required; strings like "AIzaShort" are too short and will not match.
	// #3382: fixed-length arm, deliberately not \b-anchored (see the AWS note above).
	{ type: 'google_api_key', pattern: /AIza[0-9A-Za-z_-]{35}/g },
	// FR-08 / DD-05: OpenSSH private key blocks. False-positive risk: text that merely mentions
	// "openssh" without the full `-----BEGIN/END OPENSSH PRIVATE KEY-----` block delimiters
	// will not match; multiline content between delimiters is required.
	// #3915 AC13 / F11 (PEM part): END gap bounded at 8192, same rationale as
	// the private_key_block arm above. (The generic arm runs first —
	// sequential-priority — so a complete OPENSSH block normally carries the
	// private_key_block placeholder; this arm stays for the OPENSSH-delimited
	// shapes the generic arm cannot span.)
	// Spaces use `[ ]` char class so secretscan does not flag this detection regex (the
	// pattern text would otherwise match the secret detector).
	{
		type: 'openssh_private_key_block',
		pattern:
			/-----BEGIN[ ]OPENSSH[ ]PRIVATE[ ]KEY-----[\s\S]{0,8192}-----END[ ]OPENSSH[ ]PRIVATE[ ]KEY-----/g,
	},
	{
		// #3915 AC13 / F11 (PEM part): no-END fallback — consumes the MAXIMAL
		// key-material run after a bare BEGIN marker (a linear character-class
		// scan: it stops at the first non-key character, e.g. prose; no output
		// cap, no unbounded scan). Runs LAST so a real END-delimited block is
		// redacted whole by the bounded arms above and this arm only ever sees
		// BEGIN-only residue. Over-redaction of a bare BEGIN marker is the
		// safe, fail-closed direction. Deliberately ONE generic arm: `[A-Z ]*`
		// covers both the RSA/EC/... and the OPENSSH delimiter spellings.
		type: 'private_key_block_nogap',
		pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[A-Za-z0-9+/=\s]*/g,
	},
];

/**
 * #1850: Coarse redaction-policy fingerprint. Two cohort members with the same
 * count of secret-pattern families and the same redaction toggles are
 * considered policy-compatible; a mismatch fails closed at link time and on
 * cohort-root open. This is honest about what it measures (the regex pattern
 * count + the durable-rejection toggles) — it is NOT a content hash of stored
 * records. Bump the salt constant when the redaction contract changes
 * meaningfully (done for #1466: PII detection settings joined the policy;
 * done for #3382: fixed-length credential families match embedded
 * (non-word-boundary) shapes and the AWS-secret arms now run before the bare
 * access-key arm, so durable-secret rejection decisions differ between
 * members on opposite sides of the change; done for #3743: Cf/DI fill
 * tolerance — findSecrets/containsSecret/redactSecrets now also match a
 * condensed (zero-width-byte-deleted) view, so a credential split by an
 * invisible byte is rejected/redacted the same as its plain form, changing
 * durable-secret rejection decisions across the change; done for
 * #3893/#3915: the PEM arms became END-bounded plus a no-END maximal-run
 * fallback (new private_key_block_nogap family), the fill classes extended
 * with \p{Mn} and U+2800, and the shared JWS scanner unioned into the scanner
 * as the jws_span family — all three widen what is detected/redacted, so
 * durable-secret rejection decisions differ between members on opposite sides
 * of the change).
 */
export const REDACTION_POLICY_SALT = 5;
/**
 * #1466: redaction-policy input. `detectPii`/`rejectDurablePii`/`piiDetector`
 * are optional so non-memory callers (e.g. the consensus miner, which applies
 * the default-off policy) keep a one-field call site. Absent PII fields are
 * treated as off/regex — the pre-#1466 behavior.
 */
export interface RedactionPolicyVersionInput {
	rejectDurableSecrets: boolean;
	detectPii?: boolean;
	rejectDurablePii?: boolean;
	piiDetector?: 'regex' | 'ner';
}
export function computeRedactionPolicyVersion(
	policy: RedactionPolicyVersionInput,
): number {
	return (
		REDACTION_POLICY_SALT * 1_000_000 +
		SECRET_PATTERNS.length * 2 +
		(policy.rejectDurableSecrets ? 1 : 0) +
		(policy.detectPii ? 4 : 0) +
		(policy.rejectDurablePii ? 8 : 0) +
		(policy.piiDetector === 'ner' ? 16 : 0)
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
// #3893 AC10 / F5: the shared whole-JWS scanner unions into this site's span
// selection (type 'jws_span') so the memory scanner reaches shell-scanner
// parity on widened shapes (dir-JWE, unsigned trailing-dot, e30-payload) its
// own eyJ-anchored jwt_token family cannot see.
import { findRedactableTokenSpans } from '../utils/jws-redaction.js';
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
 * 12 hex chars). Files written before the field existed are treated as
 * version 1, which is exactly correct: they were produced by this same
 * algorithm, so they keep validating with no forced re-link.
 *
 * Version 2 (#1466): no change to canonicalization, hashing, or truncation —
 * bumped because `redaction_policy_version` changed its value for unchanged
 * user config (REDACTION_POLICY_SALT 1→2 with the PII policy fields joining
 * the input, plus a new secret-pattern family). Per the rule below, a changed
 * digest for an unchanged input is a version bump so legacy files surface as
 * "re-run `/swarm memory link`" instead of a false config-mismatch throw.
 *
 * Version 3 (#3382): again no change to canonicalization, hashing, or
 * truncation — bumped because `redaction_policy_version` changed for
 * unchanged user config (REDACTION_POLICY_SALT 2→3 with the embedded-shape
 * detection and the AWS-secret arm reorder). Same remedy: legacy files
 * surface as "re-run `/swarm memory link`".
 *
 * Version 4 (#3743): again no change to canonicalization, hashing, or
 * truncation — bumped because `redaction_policy_version` changed for
 * unchanged user config (REDACTION_POLICY_SALT 3→4 with the Cf/DI fill
 * tolerance: secret detection/redaction now also matches the condensed
 * zero-width-deleted view). Same remedy: legacy files surface as
 * "re-run `/swarm memory link`".
 *
 * Version 5 (#3893/#3915): again no change to canonicalization, hashing, or
 * truncation — bumped because `redaction_policy_version` changed for
 * unchanged user config (REDACTION_POLICY_SALT 4→5 with the PEM bounded/
 * fallback arms, the Mn/U+2800 fill-class extension, and the jws_span
 * union). Same remedy: legacy files surface as
 * "re-run `/swarm memory link`".
 *
 * BUMP THIS whenever a change would alter the digest for an unchanged input —
 * e.g. a different hash, a different truncation length, a change to
 * `stableCanonicalStringify`'s output for a reachable input, or a change to the
 * `MemoryCohortFingerprintInput` shape. Readers compare versions BEFORE
 * comparing fingerprints, so a bump surfaces as "re-run `/swarm memory link`"
 * instead of being misreported as a real provider/embedding config mismatch.
 */
export const FINGERPRINT_ALGORITHM_VERSION = 5;

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
	redaction: {
		rejectDurableSecrets: boolean;
		/** #1466 PII policy fields (optional — pre-#1466 callers omit them). */
		detectPii?: boolean;
		rejectDurablePii?: boolean;
		piiDetector?: 'regex' | 'ner';
	};
	embeddings: { model: string; dimension: number; version?: string };
}): MemoryCohortFingerprintInput {
	return {
		provider: config.provider,
		redaction_policy_version: computeRedactionPolicyVersion({
			rejectDurableSecrets: config.redaction.rejectDurableSecrets,
			detectPii: config.redaction.detectPii,
			rejectDurablePii: config.redaction.rejectDurablePii,
			piiDetector: config.redaction.piiDetector,
		}),
		embedding_model: config.embeddings.model,
		embedding_dimension: config.embeddings.dimension,
		embedding_version: config.embeddings.version ?? 'default',
	};
}

export function findSecrets(text: string): SecretFinding[] {
	const findings: SecretFinding[] = [];
	// #3882 perf: build the fill-class condensed view ONCE per call (this
	// function never mutates `text`, so all patterns plus the JWS sweep share
	// it), and skip it entirely when the text has no fill-class byte — the
	// common case.
	const condensed = SECRET_ZERO_WIDTH_FILL_RE.test(text)
		? condenseSecretView(text)
		: null;
	for (const { type, pattern } of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		for (const span of selectedSecretSpans(text, pattern, condensed)) {
			findings.push({ type, match: text.slice(span.start, span.end) });
		}
	}
	// #3893 AC10 / F5: union the shared JWS scanner's spans (raw + condensed
	// views, same machinery as the patterns) as type 'jws_span' — appended
	// after the family findings.
	for (const span of jwsSpanSelection(text, condensed)) {
		findings.push({
			type: 'jws_span',
			match: text.slice(span.start, span.end),
		});
	}
	return findings;
}

export function containsSecret(text: string): boolean {
	return findSecrets(text).length > 0;
}

export function redactSecrets(text: string): string {
	// #3882 perf: the presence of a fill-class byte is invariant across the
	// per-pattern iterations (placeholders contain no such byte), so decide
	// once. When absent, every iteration skips the condensed view — this is
	// the no-secret / no-fill common case that previously paid a full O(n)
	// build per pattern.
	const hasFill = SECRET_ZERO_WIDTH_FILL_RE.test(text);
	let work = text;
	for (const { type, pattern } of SECRET_PATTERNS) {
		// #3743: each pattern operates on the CURRENT (already rewritten) string
		// — sequential-priority semantics are preserved exactly (earlier
		// patterns' placeholders contain `[`/`:`, outside every body class, so
		// later arms can never match inside them). The two-view span set is
		// rebuilt from the current string each iteration because offsets from
		// earlier rewrites are invalid.
		pattern.lastIndex = 0;
		const spans = selectedSecretSpans(
			work,
			pattern,
			hasFill ? condenseSecretView(work) : null,
		);
		if (spans.length === 0) continue;
		work = replaceSpans(work, spans, `[REDACTED:${type}]`);
	}
	// #3893 AC10 / F5: the JWS sweep runs LAST, on the fully pattern-rewritten
	// string — the family placeholders contain `[`/`:`/`_`-runs with no dots,
	// outside every JWS run class, so the sweep can never match inside them
	// (same sequential-priority argument as the pattern loop above).
	const jwsSpans = jwsSpanSelection(
		work,
		hasFill ? condenseSecretView(work) : null,
	);
	if (jwsSpans.length > 0) {
		work = replaceSpans(work, jwsSpans, '[REDACTED:jws_span]');
	}
	return work;
}

/**
 * #3882 perf (extracted for the F5 JWS sweep): build the rewritten string
 * with a single join instead of one full-string splice per span (was
 * O(n·spans), ~18 s on a dense 1.4 MB blob); this is O(n) per call and
 * produces byte-identical output. Spans must be non-overlapping and ordered.
 */
function replaceSpans(
	text: string,
	spans: SecretSpan[],
	label: string,
): string {
	const parts: string[] = [];
	let last = 0;
	for (const { start, end } of spans) {
		parts.push(text.slice(last, start));
		parts.push(label);
		last = end;
	}
	parts.push(text.slice(last));
	return parts.join('');
}

// #3743: Cf/DI fill tolerance for the memory secret scanner. A zero-width or
// default-ignorable byte inside a credential (e.g. `sk-AAA\u200BBBB…`) splits
// every alphabet-anchored body run, so the raw-text pass misses the token.
// Mirrors the #3730 fix shape at the two failure-evidence sites
// (src/failures/invocation-failure.ts and src/hooks/guardrails/helpers.ts) —
// deliberately an inline mirror per that precedent, not a shared module: this
// scanner keeps its small import graph, and the parity discipline lives in the
// per-family test suites.
//
// #3915 AC11 / F4: ONE module-level SOURCE for the fill class. Until now this
// file carried TWO copies — the named non-global constant below (used by the
// `.test()` fast paths) and a separate local global literal inside
// condenseSecretView's matchAll — so extending only one would have silently
// left condensation behind. Both a `/…/u` master (fast-path `.test()`) and a
// `/…/gu` twin (condenseSecretView's matchAll requires `g`) are built from the
// single source string, so they cannot drift.
//
// Extended set (#3915 AC11): adds `\p{Mn}` (combining marks — U+0301 splits)
// and `\u2800` (the Braille blank). Braille is deliberately restricted to
// U+2800, the INVISIBLE blank pattern: the other Braille code points are
// visible glyphs, and broadening them would redact legitimate Braille content
// (recorded as a deliberate bound, plan critic R1).
const SECRET_ZERO_WIDTH_FILL_SOURCE =
	'\\p{Cf}|\\p{Default_Ignorable_Code_Point}|\\p{Mn}|\\u2800';
const SECRET_ZERO_WIDTH_FILL_RE = new RegExp(
	SECRET_ZERO_WIDTH_FILL_SOURCE,
	'u',
);

interface SecretSpan {
	start: number;
	end: number;
}

/**
 * #3743: per-pattern two-view span selection. Collects the pattern's matches
 * on the raw text AND on the fill-deleted condensed view (mapped back to
 * original offsets — a mapped-back span INCLUDES the invisible bytes inside
 * it), then hands the union to selectNonOverlappingSpans.
 */
/**
 * #3882 perf: `condensed` is the caller-prebuilt fill-deleted view (and its
 * offset map) when the text carries fill-class bytes, or `null` when it does
 * not. Passing it in lets `findSecrets` build it once for all patterns (and
 * the F5 JWS sweep) and lets the no-fill common case skip the build entirely;
 * the `condensed === text` guard below keeps the raw-only path exact.
 */
function selectedSecretSpans(
	text: string,
	pattern: RegExp,
	condensed: ReturnType<typeof condenseSecretView> | null,
): SecretSpan[] {
	const spans: SecretSpan[] = [];
	pattern.lastIndex = 0;
	for (const match of text.matchAll(pattern)) {
		if (match[0] && match.index !== undefined) {
			spans.push({ start: match.index, end: match.index + match[0].length });
		}
	}
	if (condensed && condensed.condensed !== text) {
		pattern.lastIndex = 0;
		for (const match of condensed.condensed.matchAll(pattern)) {
			if (!match[0] || match.index === undefined) continue;
			const last =
				condensed.condensedToOriginal[match.index + match[0].length - 1];
			const start = condensed.condensedToOriginal[match.index];
			if (start === undefined || last === undefined) continue;
			spans.push({ start, end: Math.min(last + 1, text.length) });
		}
	}
	return selectNonOverlappingSpans(spans);
}

/**
 * #3743 (selection core, extracted for the #3893 F5 JWS sweep): deduplicate
 * byte-identical spans, then select non-overlapping leftmost-longest
 * (sort start asc / end desc; overlapping later spans extend the kept span's
 * end). One span per selected match: a plain token identical in both views
 * yields exactly one span.
 */
function selectNonOverlappingSpans(spans: SecretSpan[]): SecretSpan[] {
	spans.sort((a, b) => a.start - b.start || b.end - a.end);
	const selected: SecretSpan[] = [];
	for (const span of spans) {
		const last = selected[selected.length - 1];
		if (!last || span.start >= last.end) {
			selected.push({ ...span });
		} else if (span.end > last.end) {
			// Overlapping but longer: EXTEND the earlier span (keep the earlier
			// start — a replace would uncover the earlier span's exclusive
			// prefix; same rule as the #3730 mirror's union walk).
			last.end = span.end;
		}
	}
	return selected;
}

/**
 * #3893 AC10 / F5: the shared JWS scanner's spans over the raw text AND (when
 * the text carries fill bytes) over the fill-deleted condensed view, mapped
 * back to original offsets — a mapped-back span INCLUDES the invisible bytes
 * inside it, exactly like a pattern's condensed match. The result goes through
 * the same leftmost-longest selection as every pattern's two-view span set, so
 * a plain token identical in both views yields exactly one span.
 */
function jwsSpanSelection(
	text: string,
	condensed: ReturnType<typeof condenseSecretView> | null,
): SecretSpan[] {
	const spans: SecretSpan[] = [];
	for (const span of findRedactableTokenSpans(text)) {
		spans.push({ start: span.start, end: span.end });
	}
	if (condensed && condensed.condensed !== text) {
		for (const span of findRedactableTokenSpans(condensed.condensed)) {
			const last = condensed.condensedToOriginal[span.end - 1];
			const start = condensed.condensedToOriginal[span.start];
			if (start === undefined || last === undefined) continue;
			spans.push({ start, end: Math.min(last + 1, text.length) });
		}
	}
	return selectNonOverlappingSpans(spans);
}

// #3743: global twin for condenseSecretView's matchAll (which requires `g`),
// built from the SAME SECRET_ZERO_WIDTH_FILL_SOURCE as the non-global
// fast-path regex above (#3915 AC11 / F4: one source, two flaggings — the
// pre-F4 code carried a second local literal here, which is exactly the
// two-copies drift this unification closes).
const SECRET_ZERO_WIDTH_FILL_RE_GLOBAL = new RegExp(
	SECRET_ZERO_WIDTH_FILL_SOURCE,
	'gu',
);

/** #3743: build the fill-deleted view plus its code-unit offset map. */
function condenseSecretView(text: string): {
	condensed: string;
	condensedToOriginal: number[];
} {
	// One matchAll scan finds every fill-class run (the `u` flag keeps this
	// correct for astral code points too — a few Cf chars live above the BMP),
	// and the verbatim runs between them are copied with their per-code-unit
	// offset map. This avoids a per-code-point regex test over long fill-dense
	// text.
	const condensedChars: string[] = [];
	const condensedToOriginal: number[] = [];
	let cursor = 0;
	for (const m of text.matchAll(SECRET_ZERO_WIDTH_FILL_RE_GLOBAL)) {
		const run = text.slice(cursor, m.index);
		for (let k = 0; k < run.length; k++) {
			condensedChars.push(run[k]);
			// One map entry per UTF-16 code unit, each carrying its OWN absolute
			// original offset (cursor + k) — the map stays unit-aligned across
			// astral characters AND a match's end offset (map[lastUnit] + 1)
			// lands after the full astral char instead of splitting the
			// surrogate pair (#3743 implementation review: the start-only
			// mapping truncated a match ending in an astral char and corrupted
			// redactSecrets output with a lone low surrogate).
			condensedToOriginal.push(cursor + k);
		}
		cursor = (m.index as number) + m[0].length;
	}
	const tail = text.slice(cursor);
	for (let k = 0; k < tail.length; k++) {
		condensedChars.push(tail[k]);
		condensedToOriginal.push(cursor + k);
	}
	return { condensed: condensedChars.join(''), condensedToOriginal };
}
