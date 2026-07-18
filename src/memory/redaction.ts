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

export interface MemoryCohortFingerprintInput {
	provider: string;
	redaction_policy_version: number;
	embedding_model: string;
	embedding_dimension: number;
	embedding_version: string;
}

export function computeMemoryCohortFingerprint(
	input: MemoryCohortFingerprintInput,
): string {
	const canonical = JSON.stringify(input, Object.keys(input).sort());
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
