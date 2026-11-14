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
	'secretscan',
	// #3165 F-2: credential-style modules — singular AND plural, so both
	// credential.ts and credentials.ts classify (the keyword prefix below
	// covers the hyphenated/underscored/dotted forms of both spellings).
	'credential',
	'credentials',
]);

const TIER_3_KEYWORD_PREFIX_RE =
	/^(auth|permission|crypto|secret|security|credentials?)[-_.]/i;

const TIER_3_DIRECTORY_SEGMENTS = new Set([
	'auth',
	'security',
	'crypto',
	'permission',
	'secret',
	// #3165 F-2: the gate-critical subsystems the #3146 review named — every
	// file under hooks/guardrails/ and the sandbox executors is Tier 3.
	'guardrails',
	'sandbox',
]);

/**
 * #3165 F-2: gate-critical entry files whose basenames are innocuous
 * (`index.ts`, `phase-complete.ts`, `ledger.ts`). Compared against the
 * NORMALIZED, case-folded repo-relative path — a bare `index.ts` (pinned
 * non-Tier-3 by tests/unit/parallel/tier3-classifier.test.ts) never matches;
 * only these exact paths do.
 */
const TIER_3_EXACT_REPO_PATHS = new Set([
	'src/cli/index.ts',
	'src/tools/phase-complete.ts',
	'src/plan/ledger.ts',
]);

function normalizeToForwardSlash(filePath: string): string {
	return filePath.replace(/\\/g, '/');
}

/**
 * Normalizes a planned `files_touched` entry for classification (#3165 F-2,
 * plan-critic r1/r3): trim, backslashes → forward slashes, strip a leading
 * `./` run, collapse interior `./` segments — all LEXICALLY, with no
 * process.cwd() dependency (a task entry is repo-relative by contract, so an
 * entry that cannot be proven repo-relative without a cwd fails CLOSED).
 * Returns null when the entry must classify as Tier 3 precisely because it is
 * not provably a plain repo-relative path: blank/whitespace-only, absolute
 * (POSIX `/…` or Windows drive forms `C:\…` / `C:…`, the latter covering
 * drive-RELATIVE spellings), `~`-prefixed home aliases, or any `..` segment.
 */
export function normalizeTier3Path(input: string): string | null {
	if (typeof input !== 'string') return null;
	const trimmed = input.trim();
	if (trimmed === '') return null;
	if (trimmed.startsWith('~')) return null;
	// Convert backslashes FIRST (plan-critic r4): rejecting a leading '/' or
	// drive form on the RAW string lets Windows absolute spellings through —
	// `\\server\share\…` (UNC), `\src\…` (rooted), and `\\?\C:\…`
	// (extended-length) all normalize to benign-LOOKING relative paths after
	// the conversion and bypassed the gate in the r4 executed probe. After
	// conversion, a single leading-'/' rejection catches the POSIX absolute
	// form AND every backslash-rooted Windows form.
	const withSlashes = normalizeToForwardSlash(trimmed);
	if (withSlashes.startsWith('/')) return null;
	if (/^[A-Za-z]:/.test(withSlashes)) return null;
	// Directory-shaped entry (trailing slash or terminal-dot spellings —
	// final-critic rounds 1-2). At BASE the directory loop saw
	// `src/security/` as the non-final `security` segment and classified it
	// Tier 3; collapsing the empty/dot final segments silently DOWNGRADED it
	// (executed: base true -> head false for `src/security/`, and round 2
	// proved the same for `src/security/.` and `src/security/./.`, with the
	// real consumer granting Turbo bypass). A files_touched entry names a
	// FILE; a trailing slash or terminal dot(s) are malformed input and fail
	// CLOSED to Tier 3.
	if (/\/\.*$/.test(withSlashes)) return null;
	const segments: string[] = [];
	for (const segment of withSlashes.split('/')) {
		if (segment === '' || segment === '.') continue;
		if (segment === '..') return null;
		segments.push(segment);
	}
	if (segments.length === 0) return null;
	return segments.join('/');
}

export function matchesTier3(files: string[]): boolean {
	for (const file of files) {
		if (isTier3Path(file)) return true;
	}
	return false;
}

export function isTier3Path(filePath: string): boolean {
	const normalized = normalizeTier3Path(filePath);
	if (normalized === null) return true; // fail closed (#3165 F-2)
	const lower = normalized.toLowerCase();

	if (TIER_3_EXACT_REPO_PATHS.has(lower)) return true;

	const segments = lower.split('/');
	const fileName = segments[segments.length - 1] || '';
	const fileBaseName = fileName.replace(/\.[^.]*$/, '');

	if (TIER_3_EXACT_BASENAMES.has(fileBaseName)) return true;

	if (TIER_3_KEYWORD_PREFIX_RE.test(fileBaseName)) return true;

	for (const pattern of TIER_3_BASENAME_PATTERNS) {
		if (pattern.test(fileName)) return true;
	}

	for (let i = 0; i < segments.length - 1; i++) {
		if (TIER_3_DIRECTORY_SEGMENTS.has(segments[i])) return true;
	}

	return false;
}

export const _internals = {
	TIER_3_BASENAME_PATTERNS,
	TIER_3_EXACT_BASENAMES,
	TIER_3_KEYWORD_PREFIX_RE,
	TIER_3_DIRECTORY_SEGMENTS,
	TIER_3_EXACT_REPO_PATHS,
	normalizeToForwardSlash,
	normalizeTier3Path,
};
