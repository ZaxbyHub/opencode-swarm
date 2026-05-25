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
			/\b(?:[A-Z0-9]+_)*(?:KEY|TOKEN|SECRET|PASSWORD)\b\s*=\s*["']?[^\s"'`]{8,}["']?/gi,
	},
];

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
