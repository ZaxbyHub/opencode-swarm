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

import {
	type AuthorityConfig,
	stripKnownSwarmPrefix,
} from '../../config/schema';
import { classifyFile, type FileZone } from '../../context/zone-classifier';
import { log, warn } from '../../utils';
import { bunHash } from '../../utils/bun-compat';

/**
 * Hashes tool arguments for repetition detection
 * @param args Tool arguments to hash
 * @returns Numeric hash (0 if hashing fails)
 */
export function hashArgs(args: unknown): number {
	try {
		if (typeof args !== 'object' || args === null) {
			return 0;
		}
		const sortedKeys = Object.keys(args as Record<string, unknown>).sort();
		return Number(bunHash(JSON.stringify(args, sortedKeys)));
	} catch (error) {
		log('[Guardrails] hashArgs failed', {
			error: error instanceof Error ? error.message : String(error),
		});
		return 0;
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
 * @param caseInsensitive Whether to use case-insensitive matching (default: true on Windows/macOS)
 * @returns Matcher function that returns true if path matches the pattern
 */
export function getGlobMatcher(
	pattern: string,
	caseInsensitive = process.platform === 'win32' ||
		process.platform === 'darwin',
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

export const DEFAULT_AGENT_AUTHORITY_RULES: Record<string, AgentRule> = {
	// Opencode native built-in agents — pass through with no swarm write restrictions.
	// Opencode's own permission system governs what these agents may write; the swarm
	// authority layer must not add further constraints on top of it.
	build: {},
	plan: {},
	general: {},
	explore: {},

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
		if (rel === '' || rel.startsWith('..')) break;
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
			return `WRITE BLOCKED: "${ancestor}" is a symlink — writing through a symlink could redirect the write outside the working directory`;
		}
	}

	return null; // all clear
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
	return pathLib.parse(targetAbsolute).root !== pathLib.parse(cwdAbsolute).root;
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
	const caseInsensitive = process.platform === 'win32';
	const resolvedFileRaw = path.resolve(dir, filePath);
	const resolvedFile = caseInsensitive
		? resolvedFileRaw.toLowerCase()
		: resolvedFileRaw;
	return scopeEntries.some((scope) => {
		const resolvedScopeRaw = path.resolve(dir, scope);
		const resolvedScope = caseInsensitive
			? resolvedScopeRaw.toLowerCase()
			: resolvedScopeRaw;
		// Exact match: file IS the scope entry
		if (resolvedFile === resolvedScope) return true;
		// Directory containment: file is inside a scope directory
		const rel = path.relative(resolvedScope, resolvedFile);
		return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
	});
}

/**
 * Checks file path authority against a pre-computed rules map.
 * Implements DENY-first evaluation order:
 * 1. readOnly - blocks all writes
 * 2. blockedExact - exact path matches (fast path)
 * 3. blockedGlobs - glob pattern matches
 * 4. allowedExact - explicit allow for exact paths
 * 5. blockedZones - zone-based blocking (runs before allowedGlobs so that generated
 *    output dirs like dist/ and build/ cannot be bypassed by a glob pattern match)
 * 6. allowedGlobs - explicit allow for glob patterns (overrides blockedPrefix/allowedPrefix
 *    but NOT blockedZones, which is already decided in Step 5)
 * 7. blockedPrefix - prefix-based blocking (takes priority over allowedPrefix)
 * 8. allowedPrefix - prefix-based allow (whitelist)
 */
export function checkFileAuthorityWithRules(
	agentName: string,
	filePath: string,
	cwd: string,
	effectiveRules: Record<string, AgentRule>,
	options?: { declaredScope?: string[] | null },
): { allowed: true } | { allowed: false; reason: string; zone?: FileZone } {
	const normalizedAgent = agentName.toLowerCase();
	const strippedAgent = stripKnownSwarmPrefix(agentName).toLowerCase();

	// Resolve absolute-or-relative to absolute, then convert to relative for prefix matching.
	// This ensures absolute paths like "C:/Users/.../src/file.ts" or "/home/.../src/file.ts"
	// are correctly matched against relative prefixes like "src/". (Fix for #259)
	// Also normalize using realpath for symlink resolution for ALL path checks
	const dir = cwd || process.cwd();

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
		return {
			allowed: false,
			reason: `Path blocked: ${filePath} is on a different drive/root than the working directory`,
		};
	}
	if (normalizedPath === '..' || normalizedPath.startsWith('../')) {
		return {
			allowed: false,
			reason: `Path blocked: ${normalizedPath} resolves outside the working directory`,
		};
	}

	const rules =
		effectiveRules[normalizedAgent] ?? effectiveRules[strippedAgent];
	if (!rules) {
		return { allowed: false, reason: `Unknown agent: ${agentName}` };
	}

	// Step 1: readOnly - blocks all writes
	if (rules.readOnly) {
		return {
			allowed: false,
			reason: `Path blocked: ${normalizedPath} (agent ${normalizedAgent} is read-only)`,
		};
	}

	// Step 2: blockedExact - exact path matches (fast path)
	if (rules.blockedExact) {
		for (const blocked of rules.blockedExact) {
			if (normalizedPath === blocked) {
				return {
					allowed: false,
					reason: `Path blocked (exact): ${normalizedPath}`,
				};
			}
		}
	}

	// Step 3: blockedGlobs - glob pattern matches
	if (rules.blockedGlobs && rules.blockedGlobs.length > 0) {
		for (const glob of rules.blockedGlobs) {
			const matcher = getGlobMatcher(glob);
			if (matcher(normalizedPath)) {
				return {
					allowed: false,
					reason: `Path blocked (glob ${glob}): ${normalizedPath}`,
				};
			}
		}
	}

	// Step 4: allowedExact - explicit allow for exact paths (overrides blocked rules)
	if (rules.allowedExact && rules.allowedExact.length > 0) {
		const isExplicitlyAllowed = rules.allowedExact.some(
			(allowed) => normalizedPath === allowed,
		);
		if (isExplicitlyAllowed) {
			return { allowed: true };
		}
	}

	// Step 5: blockedZones - zone-based blocking (runs before allowedGlobs so that
	// generated output directories like dist/ and build/ cannot be accidentally
	// re-allowed by a glob pattern such as **/*.test.* or **/*.md).
	if (rules.blockedZones && rules.blockedZones.length > 0) {
		const { zone } = classifyFile(normalizedPath);
		if (rules.blockedZones.includes(zone)) {
			return {
				allowed: false,
				reason: `Path blocked: ${normalizedPath} is in ${zone} zone`,
				zone,
			};
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
		const isGlobAllowed = rules.allowedGlobs.some((glob) => {
			const matcher = getGlobMatcher(glob);
			return matcher(normalizedPath);
		});
		if (isGlobAllowed) {
			return { allowed: true };
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
			return { allowed: true };
		}
	}

	// Step 7: blockedPrefix - prefix-based blocking (runs before allowedPrefix so that
	// explicit block rules take priority over allowlist rules)
	if (rules.blockedPrefix && rules.blockedPrefix.length > 0) {
		for (const prefix of rules.blockedPrefix) {
			if (normalizedPath.startsWith(prefix)) {
				return {
					allowed: false,
					reason: `Path blocked: ${normalizedPath} is under ${prefix}`,
				};
			}
		}
	}

	// Step 8: allowedPrefix - prefix-based allow (whitelist model)
	// If configured, only paths starting with these prefixes are allowed.
	//
	// v6.70.0 (#496): If the architect has declared an explicit scope via the
	// `declare_scope` tool, paths inside that scope bypass the hardcoded
	// allowedPrefix whitelist. This lets the architect authorise framework-agnostic
	// paths (Rails `config/`, `app/`, `db/`; Python `module/`, `pyproject.toml`; etc.)
	// without editing the default rule set.
	//
	// SECURITY: declaredScope ONLY relaxes allowedPrefix (Step 8). All DENY rules
	// (readOnly, blockedExact, blockedGlobs, blockedPrefix, blockedZones) and
	// universal_deny_prefixes (checked upstream in toolBefore) remain fully
	// enforced. A declared scope cannot grant writes into .env, .git/, secrets/,
	// or any blocked path.
	//
	// v6.70.0 post-Codex-review: declaredScope is the architect→coder hand-off
	// channel ONLY. Honouring it for other roles (docs, designer, reviewer,
	// test_engineer, critic) would let an architect's coder authorisation leak
	// into other agents' write capabilities — e.g., declaring `src/foo.ts` for
	// the coder would also let `docs` write into `src/`, breaking per-agent
	// isolation. Restrict the bypass to coder agents (canonical or prefixed
	// like `local_coder` / `paid_coder`).
	const isCoderAgent = normalizedAgent === 'coder' || strippedAgent === 'coder';
	const pathIsInDeclaredScope =
		isCoderAgent &&
		options?.declaredScope != null &&
		options.declaredScope.length > 0 &&
		isInDeclaredScope(normalizedPath, options.declaredScope, dir);
	if (!pathIsInDeclaredScope) {
		if (rules.allowedPrefix != null && rules.allowedPrefix.length > 0) {
			const isAllowed = rules.allowedPrefix.some((prefix) =>
				normalizedPath.startsWith(prefix),
			);
			if (!isAllowed) {
				return {
					allowed: false,
					reason: `Path ${normalizedPath} not in allowed list for ${normalizedAgent}`,
				};
			}
		} else if (
			rules.allowedPrefix != null &&
			rules.allowedPrefix.length === 0
		) {
			// Empty allowedPrefix means nothing is allowed by prefix
			return {
				allowed: false,
				reason: `Path ${normalizedPath} not in allowed list for ${normalizedAgent}`,
			};
		}
	}

	return { allowed: true };
}

/**
 * Checks whether the given agent is authorised to write to the given file path.
 */
export function checkFileAuthority(
	agentName: string,
	filePath: string,
	cwd: string,
	authorityConfig?: AuthorityConfig,
	options?: { declaredScope?: string[] | null },
): { allowed: true } | { allowed: false; reason: string; zone?: FileZone } {
	return checkFileAuthorityWithRules(
		agentName,
		filePath,
		cwd,
		buildEffectiveRules(authorityConfig),
		options,
	);
}
