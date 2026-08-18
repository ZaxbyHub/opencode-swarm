const TIER_3_BASENAME_PATTERNS = [
	/^architect.*\.ts$/i,
	/^delegation.*\.ts$/i,
	/^guardrails?.*\.ts$/i,
	/^adversarial.*\.ts$/i,
	/^sanitiz.*\.ts$/i,
	/^security.*\.ts$/i,
];

const TIER_3_EXACT_BASENAMES = new Set([
	'auth',
	'authenticate',
	'authentication',
	'authorization',
	'permission',
	'permissions',
	'crypto',
	'secret',
	'secrets',
]);

const TIER_3_KEYWORD_PREFIX_RE =
	/^(auth|permission|crypto|secret|security)[-_.]/i;

const TIER_3_DIRECTORY_SEGMENTS = new Set([
	'auth',
	'security',
	'crypto',
	'permission',
	'secret',
]);

function normalizeToForwardSlash(filePath: string): string {
	return filePath.replace(/\\/g, '/');
}

export function matchesTier3(files: string[]): boolean {
	for (const file of files) {
		if (isTier3Path(file)) return true;
	}
	return false;
}

export function isTier3Path(filePath: string): boolean {
	const normalized = normalizeToForwardSlash(filePath);
	const segments = normalized.split('/');
	const fileName = segments[segments.length - 1] || '';
	const fileBaseName = fileName.replace(/\.[^.]*$/, '').toLowerCase();

	if (TIER_3_EXACT_BASENAMES.has(fileBaseName)) return true;

	if (TIER_3_KEYWORD_PREFIX_RE.test(fileBaseName)) return true;

	for (const pattern of TIER_3_BASENAME_PATTERNS) {
		if (pattern.test(fileName)) return true;
	}

	for (let i = 0; i < segments.length - 1; i++) {
		if (TIER_3_DIRECTORY_SEGMENTS.has(segments[i].toLowerCase())) return true;
	}

	return false;
}

export const _internals = {
	TIER_3_BASENAME_PATTERNS,
	TIER_3_EXACT_BASENAMES,
	TIER_3_KEYWORD_PREFIX_RE,
	TIER_3_DIRECTORY_SEGMENTS,
	normalizeToForwardSlash,
};
