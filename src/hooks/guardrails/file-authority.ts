/**
 * File Authority Subsystem
 *
 * Extracted from guardrails.ts. Provides file-write authority checking,
 * attestation API, path normalization caching, and glob matching for
 * agent file permissions.
 *
 * All exports are re-exported by the barrel guardrails.ts for backward
 * compatibility.
 */

import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import picomatch from 'picomatch';
import QuickLRU from 'quick-lru';

import type { AgentName } from '../../config/agent-names';
import {
	type AuthorityConfig,
	stripKnownSwarmPrefix,
} from '../../config/schema';
import { classifyFile, type FileZone } from '../../context/zone-classifier';
import {
	getPathFlavor,
	isOnDifferentPathRoot,
	isPathIdentityWithin,
	type PathFlavor,
	pathIdentitiesEqual,
	sanitizeDiagnosticText,
	unsafePathTextReason,
} from '../../scope/path-identity';
import { log, warn } from '../../utils';
import {
	boundedBunHash,
	coarseObjectDiscriminator,
} from '../../utils/arg-hash';
import { stableCanonicalStringify } from '../../utils/stable-stringify';

/**
 * Hashes tool arguments for repetition detection.
 *
 * Uses `stableCanonicalStringify` (recursive key-sorting at every depth, no
 * nested-key filtering) so that two args with the same values hash equally
 * regardless of key insertion order — including nested objects. This matters
 * for repetition detection on nested-args tools (e.g. `todowrite` with a
 * `todos` array): the previous `JSON.stringify(args, sortedKeys)` replacer
 * silently dropped nested keys, collapsing distinct todo contents to the same
 * hash.
 *
 * When `stableCanonicalStringify` throws (cyclic refs, BigInt quirks), a
 * constant fallback would make distinct-but-unserializable args collide,
 * producing false-positive consecutive-equality detection (#2060-class
 * bug). `coarseObjectDiscriminator` mixes in a shallow structural summary
 * instead, so identical unserializable args still collide (true positive
 * preserved) while distinct ones no longer do.
 *
 * Hash input is bounded by `boundedBunHash` (`src/utils/arg-hash.ts`), which
 * hashes a length-prefixed head+tail SAMPLE rather than a bare prefix. That
 * matters here more than anywhere: this hash drives the consecutive-repetition
 * circuit breaker in `tool-before.ts`, which THROWS. Under a bare-prefix cap,
 * ten consecutive large writes sharing a 64 KB boilerplate header but with
 * differing appended bodies would have hashed identically and tripped it.
 *
 * Both this bounding and the fallback discriminator are shared verbatim with
 * `hooks/adversarial-detector.ts:hashArgsForSpiral`; keep them in the shared
 * module rather than re-inlining a copy here.
 *
 * @param args Tool arguments to hash
 * @returns Numeric hash (0 for non-objects; a discriminated fallback hash if
 *   stable stringification fails)
 */
export function hashArgs(args: unknown): number {
	try {
		if (typeof args !== 'object' || args === null) {
			return 0;
		}
		const stable = stableCanonicalStringify(args);
		return Number(boundedBunHash(stable));
	} catch (error) {
		log('[Guardrails] hashArgs failed', {
			error: error instanceof Error ? error.message : String(error),
		});
		return Number(boundedBunHash(coarseObjectDiscriminator(args)));
	}
}

// ============================================================
// Attestation API
// ============================================================

/** A record of an agent attesting to (resolving/suppressing/deferring) a finding. */
export interface AttestationRecord {
	findingId: string;
	agent: string;
	attestation: string;
	action: 'resolve' | 'suppress' | 'defer';
	timestamp: string;
}

/**
 * Validates that an attestation string meets the minimum length requirement.
 */
export function validateAttestation(
	attestation: string,
	_findingId: string,
	_agent: string,
	_action: 'resolve' | 'suppress' | 'defer',
): { valid: true } | { valid: false; reason: string } {
	if (attestation.length < 30) {
		return {
			valid: false,
			reason: `Attestation too short (${attestation.length} chars, minimum 30 required)`,
		};
	}
	return { valid: true };
}

/**
 * Appends an attestation record to `.swarm/evidence/attestations.jsonl`.
 */
export async function recordAttestation(
	dir: string,
	record: AttestationRecord,
): Promise<void> {
	const evidenceDir = path.join(dir, '.swarm', 'evidence');
	await fs.mkdir(evidenceDir, { recursive: true });
	const attestationsPath = path.join(evidenceDir, 'attestations.jsonl');
	await fs.appendFile(attestationsPath, `${JSON.stringify(record)}\n`);
}

/**
 * Validates an attestation and, on success, records it; on failure, logs a rejection event.
 */
export async function validateAndRecordAttestation(
	dir: string,
	findingId: string,
	agent: string,
	attestation: string,
	action: 'resolve' | 'suppress' | 'defer',
): Promise<{ valid: true } | { valid: false; reason: string }> {
	const result = validateAttestation(attestation, findingId, agent, action);
	if (!result.valid) {
		const swarmDir = path.join(dir, '.swarm');
		await fs.mkdir(swarmDir, { recursive: true });
		const eventsPath = path.join(swarmDir, 'events.jsonl');
		const event = {
			event: 'attestation_rejected',
			findingId,
			agent,
			length: attestation.length,
			reason: result.reason,
			timestamp: new Date().toISOString(),
		};
		await fs.appendFile(eventsPath, `${JSON.stringify(event)}\n`);
		return result;
	}
	const record: AttestationRecord = {
		findingId,
		agent,
		attestation,
		action,
		timestamp: new Date().toISOString(),
	};
	await recordAttestation(dir, record);
	return { valid: true };
}

// ============================================================
// File Authority API
// ============================================================

/**
 * LRU cache for path normalization (realpath).
 * Maps original path -> resolved absolute path.
 */
const pathNormalizationCache = new QuickLRU<string, string>({
	maxSize: 500,
});

/**
 * LRU cache for compiled picomatch matchers.
 * Maps glob pattern + case-sensitivity mode -> matcher function.
 */
const globMatcherCache = new QuickLRU<string, (path: string) => boolean>({
	maxSize: 200,
});

/**
 * Clears all guardrails caches.
 * Use this for test isolation or when guardrails config reloads at runtime.
 */
export function clearGuardrailsCaches(): void {
	pathNormalizationCache.clear();
	globMatcherCache.clear();
}

/**
 * Normalizes a file path using fs.realpathSync with caching.
 * This resolves symlinks and normalizes the path for cross-platform consistency.
 * @param filePath The file path to normalize (absolute or relative)
 * @param cwd Working directory for relative paths
 * @returns Normalized absolute path or original on error
 */
export function normalizePathWithCache(filePath: string, cwd: string): string {
	// Generate cache key: cwd + filePath combination
	const cacheKey = `${cwd}:${filePath}`;

	// Check cache first
	const cached = pathNormalizationCache.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}

	try {
		// Resolve to absolute path first
		const absolutePath = path.isAbsolute(filePath)
			? filePath
			: path.resolve(cwd, filePath);

		// Use realpathSync to resolve symlinks and normalize
		const normalized = fsSync.realpathSync(absolutePath);

		// Cache the result
		pathNormalizationCache.set(cacheKey, normalized);

		return normalized;
	} catch {
		// If realpath fails (e.g., file doesn't exist), fall back to path.resolve
		const fallback = path.isAbsolute(filePath)
			? filePath
			: path.resolve(cwd, filePath);
		pathNormalizationCache.set(cacheKey, fallback);
		return fallback;
	}
}

/**
 * Gets or creates a cached picomatch matcher for a glob pattern.
 * @param pattern Glob pattern to compile
 * @param caseInsensitive Whether to use case-insensitive matching (default: true for cross-platform policy consistency)
 * @returns Matcher function that returns true if path matches the pattern
 */
export function getGlobMatcher(
	pattern: string,
	caseInsensitive = true,
): (path: string) => boolean {
	const cacheKey = `${caseInsensitive ? 'nocase' : 'case'}\0${pattern}`;
	const cached = globMatcherCache.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}

	// Compile the matcher with cross-platform options
	try {
		const matcher = picomatch(pattern, {
			dot: true, // Allow matching dotfiles
			nocase: caseInsensitive, // Case-insensitive on Windows/macOS
		});

		globMatcherCache.set(cacheKey, matcher);

		return matcher;
	} catch (err) {
		// Malformed glob pattern - log warning and return permissive matcher
		warn(`picomatch error for pattern "${pattern}": ${err}`);
		return () => false;
	}
}

export type AgentRule = {
	readOnly?: boolean;
	blockedExact?: string[];
	allowedExact?: string[];
	blockedPrefix?: string[];
	allowedPrefix?: string[];
	blockedZones?: FileZone[];
	blockedGlobs?: string[];
	allowedGlobs?: string[];
	allowedCaseSensitiveGlobs?: string[];
};

export type AuthorityRoleCapability =
	| 'native'
	| 'direct-write'
	| 'read-only'
	| 'dedicated-tool-only';

/**
 * Exhaustive classification for every swarm role. Dedicated-tool roles may
 * mutate state only through their purpose-built tools, never raw file writes.
 */
export const AUTHORITY_ROLE_CAPABILITIES = {
	architect: 'direct-write',
	coder: 'direct-write',
	reviewer: 'direct-write',
	critic: 'direct-write',
	critic_oversight: 'dedicated-tool-only',
	critic_finding_validator: 'dedicated-tool-only',
	explorer: 'read-only',
	sme: 'read-only',
	researcher: 'read-only',
	test_engineer: 'direct-write',
	docs: 'direct-write',
	docs_design: 'direct-write',
	designer: 'direct-write',
	critic_sounding_board: 'read-only',
	critic_drift_verifier: 'read-only',
	critic_hallucination_verifier: 'read-only',
	critic_architecture_supervisor: 'read-only',
	curator_init: 'dedicated-tool-only',
	curator_phase: 'dedicated-tool-only',
	curator_postmortem: 'dedicated-tool-only',
	curator_consolidation: 'dedicated-tool-only',
	council_generalist: 'read-only',
	council_skeptic: 'read-only',
	council_domain_expert: 'read-only',
	skill_improver: 'dedicated-tool-only',
	spec_writer: 'dedicated-tool-only',
} as const satisfies Record<AgentName, AuthorityRoleCapability>;

const NON_WRITING_SWARM_RULES = Object.fromEntries(
	Object.entries(AUTHORITY_ROLE_CAPABILITIES)
		.filter(
			([, capability]) =>
				capability === 'read-only' || capability === 'dedicated-tool-only',
		)
		.map(([agent]) => [agent, { readOnly: true } satisfies AgentRule]),
) as Record<string, AgentRule>;

export const DEFAULT_AGENT_AUTHORITY_RULES: Record<string, AgentRule> = {
	// Opencode native built-in agents — pass through with no swarm write restrictions.
	// Opencode's own permission system governs what these agents may write; the swarm
	// authority layer must not add further constraints on top of it.
	build: {},
	plan: {},
	general: {},
	explore: {},
	...NON_WRITING_SWARM_RULES,

	architect: {
		blockedExact: ['.swarm/plan.md', '.swarm/plan.json'],
		// v7.x (#894): block config zone so architect cannot bypass lint gates
		// by editing config files (biome.json, eslintrc, tsconfig, etc.)
		// instead of fixing the underlying source code.
		blockedZones: ['generated', 'config'],
		blockedGlobs: [
			'**/oxlintrc*',
			'**/.oxlintrc*',
			'**/.eslintrc*',
			'**/eslint.config.*',
			'**/.prettierrc*',
			'**/prettier.config.*',
			'**/biome.jsonc',
			'**/.secretscanignore',
			'**/.golangci*',
		],
	},
	coder: {
		blockedPrefix: ['.swarm/'],
		blockedZones: ['generated', 'config'],
	},
	reviewer: {
		blockedExact: ['.swarm/plan.md', '.swarm/plan.json'],
		blockedPrefix: ['src/'],
		allowedPrefix: ['.swarm/evidence/', '.swarm/outputs/'],
		blockedZones: ['generated'],
	},
	explorer: {
		readOnly: true,
	},
	sme: {
		readOnly: true,
	},
	test_engineer: {
		blockedExact: ['.swarm/plan.md', '.swarm/plan.json'],
		blockedPrefix: ['src/'],
		allowedPrefix: ['tests/', 'test/', '.swarm/evidence/'],
		// v7.x (#bug-test-engineer-write-access): allow writes to any tests/test
		// directory at any depth (e.g. src-tauri/tests/, packages/foo/test/) and
		// to common framework test-file conventions so that projects with non-root
		// test layouts are not blocked. allowedGlobs runs at Step 6, BEFORE blockedPrefix
		// at Step 7; this ordering is intentional — it means test files inside a
		// blocked directory like src/ (e.g. src/__tests__/, src/auth/test_login.py)
		// are explicitly re-allowed by the glob before blockedPrefix can deny them.
		// NOTE: blockedZones runs at Step 5, BEFORE allowed globs, so test files
		// inside generated output dirs (dist/, build/) are still blocked.
		allowedGlobs: [
			'**/tests/**',
			'**/test/**',
			'**/__tests__/**',
			'**/*.test.*',
			'**/*.spec.*',
			'test_*.py',
			'**/test_*.py',
			'*_test.py',
			'**/*_test.py',
			'*_test.go',
			'**/*_test.go',
			'*_spec.rb',
			'**/*_spec.rb',
			'*.Tests.ps1',
			'**/*.Tests.ps1',
		],
		// Language class suffixes must remain case-sensitive even on Windows/macOS:
		// case-insensitive "*Test.java" matches Contest.java, and "*Tests.cs"
		// matches Contests.cs.
		allowedCaseSensitiveGlobs: [
			'*Test.java',
			'**/*Test.java',
			'*Test.kt',
			'**/*Test.kt',
			'*Tests.cs',
			'**/*Tests.cs',
		],
		blockedZones: ['generated'],
	},
	docs: {
		allowedPrefix: ['docs/', '.swarm/outputs/'],
		// v7.x (#bug-test-engineer-write-access follow-up): allow writes to any
		// docs/ directory at any depth (e.g. packages/core/docs/, apps/web/docs/)
		// and to Markdown/RST documentation files co-located anywhere in the tree.
		allowedGlobs: ['**/docs/**', '**/*.md', '**/*.mdx', '**/*.rst'],
		blockedZones: ['generated'],
	},
	// Design-doc author variant (issue #1080). Same documentation surface as
	// `docs`, plus its machine-readable `reference/traceability.json` registry
	// (a .json, not matched by the markdown globs). This rule is what lets
	// docs_design write its deliverables AND constrains it to doc-like files —
	// source writes (src/**, etc.) remain denied. Without this entry the
	// file-authority guard rejects every docs_design write as "Unknown agent".
	//
	// blockedGlobs runs at Step 3, BEFORE allowedGlobs at Step 6. This prevents
	// the broad `**/reference/traceability.json` glob from accidentally rescuing
	// a write to `src/reference/traceability.json` (F-3 / PR #1096 follow-up).
	docs_design: {
		allowedPrefix: ['docs/', '.swarm/outputs/'],
		blockedGlobs: ['src/**', 'lib/**'],
		allowedGlobs: [
			'**/docs/**',
			'**/*.md',
			'**/*.mdx',
			'**/*.rst',
			'**/reference/traceability.json',
		],
		blockedZones: ['generated'],
	},
	designer: {
		allowedPrefix: ['docs/', '.swarm/outputs/'],
		// v7.x (#bug-test-engineer-write-access follow-up): same reasoning as docs —
		// UI scaffolds and design docs may live in nested package directories.
		allowedGlobs: ['**/docs/**', '**/*.md', '**/*.mdx', '**/*.rst'],
		blockedZones: ['generated'],
	},
	critic: {
		allowedPrefix: ['.swarm/evidence/'],
		blockedZones: ['generated'],
	},
};

/**
 * Checks whether a write target path (or any ancestor strictly inside cwd)
 * is a symlink. Writing through a symlink can redirect the write to a
 * location outside the working directory, bypassing scope containment.
 *
 * The walk stops at cwd — cwd itself is NOT lstat'd. A user's chosen
 * working directory may legitimately be reached via a symlink (e.g.,
 * macOS's /tmp → /private/tmp), and that symlink does not constitute a
 * redirect *within* the workspace. Only attacker-plantable symlinks
 * BELOW cwd are relevant to this guard.
 *
 * ENOENT on any node in the chain is allowed — the file/dir doesn't exist yet.
 * Any other lstat error (EPERM, EACCES, ENAMETOOLONG, …) fails closed:
 * an unverifiable ancestor must not be written through, even if the OS
 * would eventually reject the write. Defense-in-depth over optimism.
 *
 * @returns A block reason string if a symlink is detected, null if all clear.
 */
export function checkWriteTargetForSymlink(
	targetPath: string,
	cwd: string,
): string | null {
	const normalizedCwd = path.resolve(cwd);
	const normalizedTarget = path.resolve(cwd, targetPath);

	// Walk ancestor chain from target up to (but NOT including) cwd.
	const ancestors: string[] = [];
	let current = normalizedTarget;
	while (true) {
		const rel = path.relative(normalizedCwd, current);
		// Stop at cwd (rel === '') or as soon as we leave cwd (starts with '..').
		// Do NOT push cwd itself onto the ancestor list — see function docstring.
		if (
			rel === '' ||
			rel === '..' ||
			rel.startsWith(`..${path.sep}`) ||
			path.isAbsolute(rel)
		)
			break;
		ancestors.push(current);
		const parent = path.dirname(current);
		if (parent === current) break; // filesystem root
		current = parent;
	}

	for (const ancestor of ancestors) {
		let stat: ReturnType<typeof fsSync.lstatSync> | null = null;
		try {
			stat = fsSync.lstatSync(ancestor);
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') continue; // not yet created — OK for writes
			// Unexpected error: fail closed
			return `WRITE BLOCKED: lstat failed on "${ancestor}": ${String(err)} — refusing write on unverifiable path`;
		}
		if (stat.isSymbolicLink()) {
			return `WRITE BLOCKED: "${ancestor}" is a symlink/junction — writing through a symlink or junction could redirect the write outside the working directory`;
		}
	}

	return null; // all clear
}

/**
 * Match configured authority prefixes using normalized lexical-prefix
 * semantics. Thus `.env` covers `.env.local`; resolving both operands against
 * one workspace root prevents sibling-workspace string collisions. Windows
 * comparisons case-fold while POSIX comparisons remain case-sensitive.
 */
export function matchesAuthorityDenyPrefix(
	candidate: string,
	prefix: string,
	cwd: string,
	flavor: PathFlavor = getPathFlavor(),
): boolean {
	const pathImpl = flavor === 'win32' ? path.win32 : path.posix;
	const normalizeInput = (value: string): string =>
		flavor === 'win32' ? value.replace(/\//g, '\\') : value;
	const normalizedPrefixInput = normalizeInput(prefix);
	const requiresComponentBoundary = normalizedPrefixInput.endsWith(
		pathImpl.sep,
	);
	const root = pathImpl.resolve(normalizeInput(cwd));
	const target = pathImpl.resolve(root, normalizeInput(candidate));
	const denied = pathImpl.resolve(root, normalizedPrefixInput);

	// Universal prefixes are workspace-relative policy. Do not let a configured
	// parent/sibling path collide with a target that merely shares its raw text.
	if (
		!isPathIdentityWithin(target, root, flavor) ||
		!isPathIdentityWithin(denied, root, flavor)
	) {
		return false;
	}

	const identity = (value: string): string =>
		flavor === 'win32' ? value.toLowerCase() : value;
	const targetIdentity = identity(target);
	const deniedIdentity = identity(denied);
	return requiresComponentBoundary
		? targetIdentity === deniedIdentity ||
				targetIdentity.startsWith(`${deniedIdentity}${pathImpl.sep}`)
		: targetIdentity.startsWith(deniedIdentity);
}

/**
 * Builds the effective rules map by merging user-configured rules with defaults.
 * User overrides take precedence for each field.
 */
export function buildEffectiveRules(
	authorityConfig?: AuthorityConfig,
): Record<string, AgentRule> {
	if (authorityConfig?.enabled === false || !authorityConfig?.rules) {
		return { ...DEFAULT_AGENT_AUTHORITY_RULES };
	}
	const entries = Object.entries(authorityConfig.rules);
	if (entries.length === 0) {
		return { ...DEFAULT_AGENT_AUTHORITY_RULES }; // shallow copy so caller can mutate safely
	}
	const merged: Record<string, AgentRule> = {
		...DEFAULT_AGENT_AUTHORITY_RULES,
	};
	for (const [agent, userRule] of entries) {
		const normalizedRuleKey = agent.toLowerCase();
		const existing = merged[normalizedRuleKey] ?? {};
		merged[normalizedRuleKey] = {
			...existing,
			...userRule,
			readOnly: userRule.readOnly ?? existing.readOnly,
			blockedExact: userRule.blockedExact ?? existing.blockedExact,
			allowedExact: userRule.allowedExact ?? existing.allowedExact,
			blockedPrefix: userRule.blockedPrefix ?? existing.blockedPrefix,
			allowedPrefix: userRule.allowedPrefix ?? existing.allowedPrefix,
			blockedZones: userRule.blockedZones ?? existing.blockedZones,
			blockedGlobs: userRule.blockedGlobs ?? existing.blockedGlobs,
			allowedGlobs: userRule.allowedGlobs ?? existing.allowedGlobs,
			allowedCaseSensitiveGlobs:
				userRule.allowedCaseSensitiveGlobs ??
				existing.allowedCaseSensitiveGlobs,
		};
	}
	return merged;
}

/**
 * Returns true when `targetAbsolute` and `cwdAbsolute` resolve to different
 * filesystem roots. On POSIX this is always false (single root `/`); on
 * Windows it is true when the two paths sit on different drive letters or
 * different UNC roots — the symptom Codex flagged on PR #501, where
 * `path.relative('C:\\repo', 'D:\\secret.txt')` returns the absolute
 * `'D:\\secret.txt'` and slips past `startsWith('../')` containment.
 *
 * Exposed (and accepts an injectable `pathLib`) so the cross-drive guard
 * is falsifiable on Linux CI without depending on a Windows runner: tests
 * pass `path.win32` / `path.posix` directly.
 */
export function isOnDifferentFilesystemRoot(
	targetAbsolute: string,
	cwdAbsolute: string,
	pathLib: Pick<typeof path, 'parse'> = path,
): boolean {
	const flavor: PathFlavor =
		pathLib === path.win32 || pathLib.parse('C:\\probe').root !== ''
			? 'win32'
			: 'posix';
	return isOnDifferentPathRoot(targetAbsolute, cwdAbsolute, flavor);
}

/**
 * Checks whether the given filePath is within declared scope entries.
 * Handles both exact matches and directory containment.
 *
 * v6.70.0 gap-closure: on Windows (case-insensitive FS), compare lowercased
 * variants so scope `config/` correctly matches a write to `Config/foo.rb`.
 * POSIX filesystems stay case-sensitive.
 */
function isInDeclaredScope(
	filePath: string,
	scopeEntries: string[],
	cwd?: string,
): boolean {
	const dir = cwd ?? process.cwd();
	const flavor = getPathFlavor();
	const resolvedFile = path.resolve(dir, filePath);
	return scopeEntries.some((scope) => {
		return isPathIdentityWithin(resolvedFile, path.resolve(dir, scope), flavor);
	});
}

export const BUILT_IN_VERIFIER_CONFIG_GLOBS = [
	'**/oxlintrc*',
	'**/.oxlintrc*',
	'**/.eslintrc*',
	'**/eslint.config.*',
	'**/.prettierrc*',
	'**/prettier.config.*',
	'**/biome.json',
	'**/biome.jsonc',
	'**/tsconfig*.json',
	'**/.secretscanignore',
	'**/.golangci*',
] as const;

export type AuthorityDecisionCode =
	| 'AUTHORITY_INVALID_PATH'
	| 'AUTHORITY_ROOT_ESCAPE'
	| 'AUTHORITY_UNIVERSAL_DENY'
	| 'AUTHORITY_PROTECTED_PATH'
	| 'AUTHORITY_VERIFIER_CONFIG'
	| 'AUTHORITY_ROLE_READ_ONLY'
	| 'AUTHORITY_UNKNOWN_AGENT'
	| 'AUTHORITY_POLICY_DENY';

export type AuthorityDecisionLayer =
	| 'path-validation'
	| 'containment'
	| 'universal-deny'
	| 'protected-path'
	| 'role-capability'
	| 'declared-scope'
	| 'role-policy';

export type AuthorityRecoveryAction = 'declare_scope' | 'save_plan';

export type AuthorityDecision =
	| {
			allowed: true;
			layer: AuthorityDecisionLayer;
			path: string;
			agent: string;
	  }
	| {
			allowed: false;
			code: AuthorityDecisionCode;
			layer: AuthorityDecisionLayer;
			rule: string;
			path: string;
			agent: string;
			reason: string;
			recovery?: AuthorityRecoveryAction;
			zone?: FileZone;
	  };

export interface AuthorityEvaluationOptions {
	declaredScope?: string[] | null;
	authorityEnabled?: boolean;
	universalDenyPrefixes?: readonly string[];
	verifierConfigPaths?: readonly string[];
}

type DenyDecisionInput = Omit<
	Extract<AuthorityDecision, { allowed: false }>,
	'allowed' | 'reason' | 'path' | 'agent'
> & { detail: string };

function denyAuthority(
	agent: string,
	normalizedPath: string,
	input: DenyDecisionInput,
): Extract<AuthorityDecision, { allowed: false }> {
	const safeAgent = sanitizeDiagnosticText(agent, 96);
	const safePath = sanitizeDiagnosticText(normalizedPath, 320);
	const safeDetail = sanitizeDiagnosticText(input.detail, 640);
	return {
		allowed: false,
		code: input.code,
		layer: input.layer,
		rule: sanitizeDiagnosticText(input.rule, 128),
		path: safePath,
		agent: safeAgent,
		reason: sanitizeDiagnosticText(
			`${input.code}: Path blocked: ${safeDetail} [agent=${safeAgent}; path=${safePath}]`,
			1024,
		),
		recovery: input.recovery,
		zone: input.zone,
	};
}

/**
 * Maximum number of entries rendered per allow-pattern category in a Step 8
 * block reason. Generous so every built-in rule shows in full (the largest is
 * test_engineer's 15 ordinary globs at the time of writing); only pathological
 * custom configs truncate, with an accurate omitted-count tail. Keeps the
 * surfaced WRITE BLOCKED message bounded.
 */
const MAX_ALLOWED_HINT_ENTRIES = 20;

/**
 * Formats an agent's effective positive allow patterns into a hint appended to a
 * Step 8 allowedPrefix block reason, so a blocked agent can self-correct (rename
 * / redirect the file) instead of guessing.
 *
 * SECURITY: discloses ONLY the current agent's OWN positive permissions — never
 * blocked* rules, universal deny prefixes, or any other agent's policy. Allow
 * patterns are necessary-but-not-sufficient: blocked zones/prefixes/globs and
 * universal deny paths still take precedence, which the trailing caveat states
 * so a looping agent does not assume every listed pattern will succeed.
 *
 * Categories are rendered separately (exact paths, prefixes, globs, and
 * case-sensitive globs) because they have distinct matching semantics — in
 * particular `allowedCaseSensitiveGlobs` must not be merged into the
 * case-insensitive globs list (e.g. `*Test.java` is case-sensitive; merging it
 * could mislead an agent into a wrong-case filename).
 */
function formatAllowedHints(rules: AgentRule): string {
	const fmt = (items: string[] | undefined): string => {
		if (!items || items.length === 0) return '(none)';
		if (items.length <= MAX_ALLOWED_HINT_ENTRIES) return items.join(', ');
		const omitted = items.length - MAX_ALLOWED_HINT_ENTRIES;
		return `${items.slice(0, MAX_ALLOWED_HINT_ENTRIES).join(', ')}, … (+${omitted} more)`;
	};
	const parts: string[] = [];
	// Order mirrors the DENY-first evaluation so the hint reads like the rule model.
	if (rules.allowedExact && rules.allowedExact.length > 0) {
		parts.push(`Allowed exact paths: ${fmt(rules.allowedExact)}`);
	}
	parts.push(`Allowed prefixes: ${fmt(rules.allowedPrefix)}`);
	parts.push(`Allowed globs: ${fmt(rules.allowedGlobs)}`);
	if (
		rules.allowedCaseSensitiveGlobs &&
		rules.allowedCaseSensitiveGlobs.length > 0
	) {
		parts.push(
			`Allowed case-sensitive globs: ${fmt(rules.allowedCaseSensitiveGlobs)}`,
		);
	}
	parts.push(
		'Block rules (blocked zones/prefixes/globs/exact) and universal deny paths still apply.',
	);
	return parts.join(' ');
}

/**
 * Checks file path authority against a pre-computed rules map. Evaluation is
 * staged: safe path + workspace containment; universal and protected denies;
 * immutable role capability; exact declared coder scope; then configurable
 * role policy. Scope can therefore authorize config/generated deliverables but
 * can never authorize `.swarm`, verifier config, universal denies, root escape,
 * or raw writes from read-only/dedicated-tool roles.
 */
export function checkFileAuthorityWithRules(
	agentName: string,
	filePath: string,
	cwd: string,
	effectiveRules: Record<string, AgentRule>,
	options: AuthorityEvaluationOptions = {},
): AuthorityDecision {
	const normalizedAgent = agentName.toLowerCase();
	const strippedAgent = stripKnownSwarmPrefix(agentName).toLowerCase();

	// Resolve absolute-or-relative to absolute, then convert to relative for prefix matching.
	// This ensures absolute paths like "C:/Users/.../src/file.ts" or "/home/.../src/file.ts"
	// are correctly matched against relative prefixes like "src/". (Fix for #259)
	// Also normalize using realpath for symlink resolution for ALL path checks
	const dir = cwd || process.cwd();
	const unsafePathReason = unsafePathTextReason(filePath);
	if (unsafePathReason) {
		return denyAuthority(agentName, filePath, {
			code: 'AUTHORITY_INVALID_PATH',
			layer: 'path-validation',
			rule: 'safe-path-text',
			detail: unsafePathReason,
		});
	}

	// Single normalization call using normalizePathWithCache for consistent security
	// This resolves symlinks and normalizes paths the same way for ALL checks
	let normalizedPath: string;
	let resolvedTarget: string;
	try {
		const normalizedWithSymlinks = normalizePathWithCache(filePath, dir);
		resolvedTarget = path.resolve(dir, normalizedWithSymlinks);
		normalizedPath = path.relative(dir, resolvedTarget).replace(/\\/g, '/');
	} catch {
		resolvedTarget = path.resolve(dir, filePath);
		normalizedPath = path.relative(dir, resolvedTarget).replace(/\\/g, '/');
	}

	// Containment check (applies to all agents): reject paths that resolve
	// outside the working directory. Previously this was implicitly enforced
	// by the hardcoded relative allowedPrefix whitelist; removing that
	// whitelist (v6.70.0 #496 final) required making containment explicit.
	// Any path whose resolved location escapes cwd — via an absolute path
	// like "/etc/passwd" or a traversal like "../../etc/passwd" — is rejected
	// here regardless of agent rules. This is defense-in-depth and applies
	// even to architect (which never had an allowedPrefix).
	//
	// v6.70.0 post-Codex-review: also reject cross-drive / cross-root
	// targets. On Windows, `path.relative('C:/repo', 'D:/secret.txt')`
	// returns `"D:\\secret.txt"` — an absolute drive-letter path that does
	// NOT start with `..` and therefore would slip past the traversal check
	// below. Comparing filesystem roots catches this universally: POSIX
	// systems only have root `/`, so roots only differ when the target is
	// on a different Windows drive.
	if (isOnDifferentFilesystemRoot(resolvedTarget, dir)) {
		return denyAuthority(agentName, normalizedPath, {
			code: 'AUTHORITY_ROOT_ESCAPE',
			layer: 'containment',
			rule: 'same-filesystem-root',
			detail: 'target is on a different drive or filesystem root',
		});
	}
	if (normalizedPath === '..' || normalizedPath.startsWith('../')) {
		return denyAuthority(agentName, normalizedPath, {
			code: 'AUTHORITY_ROOT_ESCAPE',
			layer: 'containment',
			rule: 'workspace-containment',
			detail: 'target resolves outside the working directory',
		});
	}

	const rules =
		effectiveRules[normalizedAgent] ?? effectiveRules[strippedAgent];
	if (!rules) {
		return denyAuthority(agentName, normalizedPath, {
			code: 'AUTHORITY_UNKNOWN_AGENT',
			layer: 'role-capability',
			rule: 'known-agent-role',
			detail: 'Unknown agent: no authority classification exists',
		});
	}
	const flavor = getPathFlavor();
	const matchesPathPrefix = (candidate: string, prefix: string): boolean =>
		isPathIdentityWithin(
			path.resolve(dir, candidate),
			path.resolve(dir, prefix),
			flavor,
		);
	const matchesGlob = (glob: string): boolean =>
		getGlobMatcher(glob)(normalizedPath);

	for (const prefix of options.universalDenyPrefixes ?? []) {
		if (matchesAuthorityDenyPrefix(normalizedPath, prefix, dir, flavor)) {
			return denyAuthority(agentName, normalizedPath, {
				code: 'AUTHORITY_UNIVERSAL_DENY',
				layer: 'universal-deny',
				rule: `universal:${prefix}`,
				detail: `target is under universal deny prefix ${prefix}`,
			});
		}
	}

	const isCoderAgent = normalizedAgent === 'coder' || strippedAgent === 'coder';
	if (isCoderAgent && matchesPathPrefix(normalizedPath, '.swarm')) {
		return denyAuthority(agentName, normalizedPath, {
			code: 'AUTHORITY_PROTECTED_PATH',
			layer: 'protected-path',
			rule: 'coder-swarm-state-protection',
			detail: 'coder writes to .swarm are always protected',
		});
	}
	const isSwarmRole = Object.hasOwn(AUTHORITY_ROLE_CAPABILITIES, strippedAgent);
	if (isSwarmRole) {
		const matchedVerifier = [
			...BUILT_IN_VERIFIER_CONFIG_GLOBS,
			...(options.verifierConfigPaths ?? []),
		].find(matchesGlob);
		if (matchedVerifier) {
			return denyAuthority(agentName, normalizedPath, {
				code: 'AUTHORITY_VERIFIER_CONFIG',
				layer: 'protected-path',
				rule: `verifier-config:${matchedVerifier}`,
				detail: `Path blocked (glob ${matchedVerifier}): swarm roles cannot write verifier-owned configuration in the config zone`,
			});
		}
	}

	// Canonical non-writing capabilities are immutable hard policy. User config
	// may further restrict direct-write roles, but cannot turn a read-only or
	// dedicated-tool-only role into a raw writer (including prefixed roles).
	const canonicalCapability =
		AUTHORITY_ROLE_CAPABILITIES[strippedAgent as AgentName];
	if (
		canonicalCapability === 'read-only' ||
		canonicalCapability === 'dedicated-tool-only'
	) {
		return denyAuthority(agentName, normalizedPath, {
			code: 'AUTHORITY_ROLE_READ_ONLY',
			layer: 'role-capability',
			rule: `role-capability:${canonicalCapability}`,
			detail:
				canonicalCapability === 'dedicated-tool-only'
					? 'role may mutate state only through dedicated tools'
					: 'agent role is read-only',
		});
	}

	// Configurable readOnly only narrows roles that otherwise have write ability.
	if (rules.readOnly) {
		return denyAuthority(agentName, normalizedPath, {
			code: 'AUTHORITY_ROLE_READ_ONLY',
			layer: 'role-capability',
			rule: 'role-policy:read-only',
			detail: 'agent role is read-only',
		});
	}

	const pathIsInDeclaredScope =
		isCoderAgent &&
		options.declaredScope != null &&
		options.declaredScope.length > 0 &&
		isInDeclaredScope(normalizedPath, options.declaredScope, dir);
	if (pathIsInDeclaredScope) {
		return {
			allowed: true,
			layer: 'declared-scope',
			path: sanitizeDiagnosticText(normalizedPath, 320),
			agent: sanitizeDiagnosticText(agentName, 96),
		};
	}
	if (options.authorityEnabled === false) {
		return {
			allowed: true,
			layer: 'role-policy',
			path: sanitizeDiagnosticText(normalizedPath, 320),
			agent: sanitizeDiagnosticText(agentName, 96),
		};
	}

	// Step 2: blockedExact - exact path matches (fast path)
	if (rules.blockedExact) {
		for (const blocked of rules.blockedExact) {
			if (pathIdentitiesEqual(normalizedPath, blocked, flavor)) {
				return denyAuthority(agentName, normalizedPath, {
					code: 'AUTHORITY_POLICY_DENY',
					layer: 'role-policy',
					rule: `blockedExact:${blocked}`,
					detail: `path is blocked by exact role policy ${blocked}`,
					recovery: isCoderAgent ? 'declare_scope' : undefined,
				});
			}
		}
	}

	// Step 3: blockedGlobs - glob pattern matches
	if (rules.blockedGlobs && rules.blockedGlobs.length > 0) {
		for (const glob of rules.blockedGlobs) {
			if (matchesGlob(glob)) {
				return denyAuthority(agentName, normalizedPath, {
					code: 'AUTHORITY_POLICY_DENY',
					layer: 'role-policy',
					rule: `blockedGlob:${glob}`,
					detail: `Path blocked (glob ${glob}) by role policy`,
					recovery: isCoderAgent ? 'declare_scope' : undefined,
				});
			}
		}
	}

	// Step 4: allowedExact - explicit allow for exact paths (overrides blocked rules)
	if (rules.allowedExact && rules.allowedExact.length > 0) {
		const isExplicitlyAllowed = rules.allowedExact.some((allowed) =>
			pathIdentitiesEqual(normalizedPath, allowed, flavor),
		);
		if (isExplicitlyAllowed) {
			return {
				allowed: true,
				layer: 'role-policy',
				path: normalizedPath,
				agent: agentName,
			};
		}
	}

	// Step 5: blockedZones - zone-based blocking (runs before allowedGlobs so that
	// generated output directories like dist/ and build/ cannot be accidentally
	// re-allowed by a glob pattern such as **/*.test.* or **/*.md).
	if (rules.blockedZones && rules.blockedZones.length > 0) {
		const { zone } = classifyFile(normalizedPath);
		if (rules.blockedZones.includes(zone)) {
			return denyAuthority(agentName, normalizedPath, {
				code: 'AUTHORITY_POLICY_DENY',
				layer: 'role-policy',
				rule: `blockedZone:${zone}`,
				detail: `path is in ${zone} zone`,
				recovery: isCoderAgent ? 'declare_scope' : undefined,
				zone,
			});
		}
	}

	// Step 6: allowedGlobs - explicit allow for glob patterns (overrides blockedPrefix
	// and allowedPrefix, but NOT blockedZones which is already enforced in Step 5).
	//
	// v7.x (#bug-test-engineer-write-access): allowedGlobs runs BEFORE blockedPrefix
	// at Step 7; this ordering is intentional — it means test files inside a
	// blocked directory like src/ (e.g. src/__tests__/, src/auth/login.test.ts)
	// are explicitly re-allowed by the glob before blockedPrefix can deny them.
	if (rules.allowedGlobs && rules.allowedGlobs.length > 0) {
		const isGlobAllowed = rules.allowedGlobs.some(matchesGlob);
		if (isGlobAllowed) {
			return {
				allowed: true,
				layer: 'role-policy',
				path: normalizedPath,
				agent: agentName,
			};
		}
	}

	// Step 6b: allowedCaseSensitiveGlobs - explicit allow for language suffix
	// conventions that must not use Windows/macOS nocase matching.
	if (
		rules.allowedCaseSensitiveGlobs &&
		rules.allowedCaseSensitiveGlobs.length > 0
	) {
		const isCaseSensitiveGlobAllowed = rules.allowedCaseSensitiveGlobs.some(
			(glob) => {
				const matcher = getGlobMatcher(glob, false);
				return matcher(normalizedPath);
			},
		);
		if (isCaseSensitiveGlobAllowed) {
			return {
				allowed: true,
				layer: 'role-policy',
				path: normalizedPath,
				agent: agentName,
			};
		}
	}

	// Step 7: blockedPrefix - prefix-based blocking (runs before allowedPrefix so that
	// explicit block rules take priority over allowlist rules)
	if (rules.blockedPrefix && rules.blockedPrefix.length > 0) {
		for (const prefix of rules.blockedPrefix) {
			if (matchesPathPrefix(normalizedPath, prefix)) {
				return denyAuthority(agentName, normalizedPath, {
					code: 'AUTHORITY_POLICY_DENY',
					layer: 'role-policy',
					rule: `blockedPrefix:${prefix}`,
					detail: `path is under blocked role prefix ${prefix}`,
					recovery: isCoderAgent ? 'declare_scope' : undefined,
				});
			}
		}
	}

	// Ordinary allowedPrefix whitelist. The exact coder-scope grant was already
	// evaluated before this configurable policy stage and never applies to other
	// roles, so architect authorization cannot leak into docs/reviewer/etc.
	if (rules.allowedPrefix != null && rules.allowedPrefix.length > 0) {
		const isAllowed = rules.allowedPrefix.some((prefix) =>
			matchesPathPrefix(normalizedPath, prefix),
		);
		if (!isAllowed) {
			return denyAuthority(agentName, normalizedPath, {
				code: 'AUTHORITY_POLICY_DENY',
				layer: 'role-policy',
				rule: 'allowedPrefix',
				detail: `path is not in allowed list for this role. ${formatAllowedHints(rules)}`,
				recovery: isCoderAgent ? 'declare_scope' : undefined,
			});
		}
	} else if (rules.allowedPrefix != null && rules.allowedPrefix.length === 0) {
		return denyAuthority(agentName, normalizedPath, {
			code: 'AUTHORITY_POLICY_DENY',
			layer: 'role-policy',
			rule: 'allowedPrefix:empty',
			detail: `path is not in allowed list because the role allowlist is empty. ${formatAllowedHints(rules)}`,
			recovery: isCoderAgent ? 'declare_scope' : undefined,
		});
	}

	return {
		allowed: true,
		layer: 'role-policy',
		path: normalizedPath,
		agent: agentName,
	};
}

/**
 * Checks whether the given agent is authorised to write to the given file path.
 */
export function checkFileAuthority(
	agentName: string,
	filePath: string,
	cwd: string,
	authorityConfig?: AuthorityConfig,
	options: AuthorityEvaluationOptions = {},
): AuthorityDecision {
	return checkFileAuthorityWithRules(
		agentName,
		filePath,
		cwd,
		buildEffectiveRules(authorityConfig),
		{
			...options,
			authorityEnabled: authorityConfig?.enabled ?? options.authorityEnabled,
			universalDenyPrefixes:
				authorityConfig?.universal_deny_prefixes ??
				options.universalDenyPrefixes,
			verifierConfigPaths:
				authorityConfig?.verifier_config_paths ?? options.verifierConfigPaths,
		},
	);
}
