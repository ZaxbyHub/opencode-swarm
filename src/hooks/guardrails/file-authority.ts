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

import { execFileSync } from 'node:child_process';
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
import { appendCoreEventSync } from '../../events/core-events.js';
import {
	getPathFlavor,
	isOnDifferentPathRoot,
	isPathIdentityWithin,
	isPathWithinDeclaredScope,
	type PathFlavor,
	pathIdentitiesEqual,
	redactPath,
	sanitizeDiagnosticText,
	unsafePathTextReason,
} from '../../scope/path-identity';
import { isPolicyProtectedPath } from '../../security/protected-path-policy.js';
import { log, warn } from '../../utils';
import {
	boundedBunHash,
	coarseObjectDiscriminator,
} from '../../utils/arg-hash';
import { resolveGitExecutable } from '../../utils/git-executable.js';
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
		const event = {
			event: 'attestation_rejected',
			findingId,
			agent,
			length: attestation.length,
			reason: result.reason,
			timestamp: new Date().toISOString(),
		};
		appendCoreEventSync(dir, event);
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
 * LRU cache for git worktree roots.
 * Maps repository directory -> array of resolved worktree root paths.
 * Entries expire after 60 s so worktrees created or removed mid-session
 * (and transient git failures) are re-queried instead of staying frozen for
 * the process lifetime.
 */
const GIT_WORKTREE_CACHE_MAX_AGE_MS = 60_000;
const gitWorktreeCache = new QuickLRU<string, string[]>({
	maxSize: 50,
	maxAge: GIT_WORKTREE_CACHE_MAX_AGE_MS,
});

/**
 * Environment for git subprocesses with repository-redirecting variables
 * stripped: an inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE/GIT_COMMON_DIR
 * would silently retarget `git worktree list` at another repository (PRR-026
 * precedent in src/services/swarm-residue.ts), and every root that listing
 * returns becomes a trusted authority root.
 */
function gitEnvWithoutRepoRedirectors(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.GIT_DIR;
	delete env.GIT_WORK_TREE;
	delete env.GIT_INDEX_FILE;
	delete env.GIT_COMMON_DIR;
	return env;
}

/**
 * One `worktree` record of `git worktree list --porcelain`.
 */
interface WorktreeListRecord {
	path: string;
	attributes: Set<string>;
}

/**
 * Splits porcelain output into per-worktree records. Each record starts at a
 * `worktree <path>` line; subsequent lines (`bare`, `detached`, `locked`,
 * `prunable`, `HEAD <sha>`, `branch <ref>`) are that record's attributes.
 */
function parseWorktreeListPorcelain(output: string): WorktreeListRecord[] {
	const records: WorktreeListRecord[] = [];
	for (const line of output.split('\n')) {
		if (line.startsWith('worktree ')) {
			const wtPath = line.slice('worktree '.length).trim();
			if (wtPath) {
				records.push({ path: wtPath, attributes: new Set() });
			}
			continue;
		}
		const record = records[records.length - 1];
		if (!record) continue;
		const separator = line.indexOf(' ');
		const attribute = separator === -1 ? line : line.slice(0, separator);
		if (attribute) record.attributes.add(attribute);
	}
	return records;
}

/**
 * Back-anchor validation for a worktree record (issue #3368 review): the
 * main worktree record is the repository the listing ran in (its `.git` is a
 * directory, not a redirect file), and every LINKED root must round-trip —
 * the root's `.git` FILE must point at a registration directory whose own
 * `gitdir` file names the root's `.git` path back. Without this round-trip,
 * three attacker-forgeable files under `<repo>/.git/worktrees/<id>/` would
 * make `git worktree list` report an arbitrary directory as a worktree, and
 * every directory this function returns is a trusted containment root.
 */

/**
 * Native-realpath canonicalization for Windows paths. Expands 8.3 short-name
 * segments (C:\Users\RUNNER~1\... -> C:\Users\runneradmin\...) that the plain
 * JS realpath leaves untouched, and strips the \\?\ device prefix. Returns
 * undefined when the path does not exist (or cannot be opened) — callers
 * decide whether that means "skip" (a trusted root must exist) or
 * "keep lexical form" (see canonicalizeWindowsPathTailTolerant).
 */
function canonicalizeWindowsPathNative(p: string): string | undefined {
	if (process.platform !== 'win32') return p;
	try {
		const native = fsSync.realpathSync.native(p);
		return native.startsWith(String.fromCharCode(92, 92, 63, 92))
			? native.slice(4)
			: native;
	} catch {
		return undefined;
	}
}

function canonicalizeWindowsPath(p: string): string {
	return canonicalizeWindowsPathNative(p) ?? p;
}

/**
 * Windows: canonicalize a WRITE TARGET that may not exist yet — the common
 * case for a write-authority check. realpathSync.native fails on a missing
 * leaf, which would leave an 8.3 short-form target unexpanded while the
 * (existing) worktree roots are canonicalized long-form, so the two sides
 * can never lexically match and every not-yet-existing in-worktree write is
 * denied (windows CI, guardrails-worktree-authority). Canonicalize the
 * nearest EXISTING ancestor instead and re-append the missing tail. A
 * symlink/junction ancestor is resolved through, so a target chained out of
 * every trusted root still fails to match and is denied as before.
 */
function canonicalizeWindowsPathTailTolerant(p: string): string {
	if (process.platform !== 'win32') return p;
	const tail: string[] = [];
	let probe = p;
	for (;;) {
		const native = canonicalizeWindowsPathNative(probe);
		if (native !== undefined) {
			return tail.length === 0 ? native : path.join(native, ...tail.reverse());
		}
		const parent = path.dirname(probe);
		if (parent === probe) return p;
		tail.push(path.basename(probe));
		probe = parent;
	}
}

function isValidWorktreeRecord(
	repoRootRecord: WorktreeListRecord | undefined,
	record: WorktreeListRecord,
): boolean {
	if (record === repoRootRecord) {
		try {
			return fsSync.statSync(path.join(record.path, '.git')).isDirectory();
		} catch {
			return false;
		}
	}
	if (record.attributes.has('bare')) return false;
	const dotGitPath = path.join(record.path, '.git');
	let dotGitStat: fsSync.Stats;
	try {
		dotGitStat = fsSync.lstatSync(dotGitPath);
	} catch {
		return false;
	}
	if (!dotGitStat.isFile()) return false;
	let gitDirLine: string;
	try {
		gitDirLine = fsSync.readFileSync(dotGitPath, 'utf8').trim();
	} catch {
		return false;
	}
	if (!gitDirLine.startsWith('gitdir:')) return false;
	const gitDirRef = gitDirLine.slice('gitdir:'.length).trim();
	if (!gitDirRef) return false;
	const gitDirPath = path.isAbsolute(gitDirRef)
		? gitDirRef
		: path.resolve(record.path, gitDirRef);
	// REPO-ANCHOR leg: the referenced registration must live inside THIS
	// repository's .git/worktrees/. The round-trip leg below alone would also
	// accept a DIFFERENT repository's real linked worktree (its .git file
	// round-trips against its own registration), which would re-root
	// containment onto an unrelated checkout.
	let registrationGitdirFile: string;
	try {
		registrationGitdirFile = fsSync.realpathSync(
			path.join(gitDirPath, 'gitdir'),
		);
	} catch {
		return false;
	}
	if (repoRootRecord) {
		// Canonicalize the repo .git dir (realpath) before the lexical
		// containment check: git's porcelain output may carry 8.3 short-name
		// or differently-cased segments on Windows, and realpath on the
		// registration file alone would then mismatch the raw-path root.
		let worktreesRoot: string;
		try {
			worktreesRoot = path.join(
				fsSync.realpathSync(path.join(repoRootRecord.path, '.git')),
				'worktrees',
			);
		} catch {
			return false;
		}
		if (!isPathIdentityWithin(registrationGitdirFile, worktreesRoot)) {
			return false;
		}
	}
	// ROUND-TRIP leg: the registration's gitdir file must name this root's
	// .git path back. This proves the pair is mutually consistent, which
	// rejects the 3-file forgery (gitdir pointing at a dir with no
	// cooperating .git file) and registrations naming unrelated repos.
	// SCOPE: it does NOT reject a cooperative forgery where the target
	// directory also contains an attacker-written .git file — git itself
	// cannot distinguish that from a real `git worktree add`, and every
	// anchor leg lives in .git/ which the repo's own content can write.
	// Worktree trust is therefore git-native trust, bounded by the
	// precondition that .git/ is not attacker-writable.
	let backReference: string;
	try {
		backReference = fsSync.readFileSync(registrationGitdirFile, 'utf8').trim();
	} catch {
		return false;
	}
	try {
		return pathIdentitiesEqual(
			fsSync.realpathSync(dotGitPath),
			fsSync.realpathSync(backReference),
		);
	} catch {
		return false;
	}
}

/**
 * Returns a list of absolute, realpath-normalized worktree roots for the given working directory.
 * Cached in gitWorktreeCache.
 *
 * Only roots that pass back-anchor validation are returned: `bare` records
 * are skipped (their git dir would otherwise become a writable trusted root
 * whose hooks/config have no `.git` path segment), and a record whose
 * registration cannot be round-tripped back to this repository is rejected —
 * closing registrations whose target has no cooperating `.git` pointer and
 * registrations naming other repositories. Residual (git-native): a target
 * directory that already holds a `.git` pointer from earlier git history
 * (moved/copied/pruned worktree folders) still validates, because git
 * itself cannot distinguish that from a real `git worktree add`.
 */
export function canonicalizeWindowsPathPublic(p: string): string {
	return canonicalizeWindowsPath(p);
}

export function canonicalizeWindowsPathTailTolerantPublic(p: string): string {
	return canonicalizeWindowsPathTailTolerant(p);
}

export function getLinkedGitWorktrees(dir: string): string[] {
	const cached = gitWorktreeCache.get(dir);
	if (cached !== undefined) {
		return cached;
	}

	const worktrees: string[] = [];
	try {
		const output = execFileSync(
			resolveGitExecutable(),
			['worktree', 'list', '--porcelain'],
			{
				cwd: dir,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'ignore'],
				timeout: 1500,
				maxBuffer: 4 * 1024 * 1024,
				windowsHide: true,
				env: gitEnvWithoutRepoRedirectors(),
			},
		);

		const records = parseWorktreeListPorcelain(output);
		const repoRootRecord = records[0];
		for (const record of records) {
			if (!isValidWorktreeRecord(repoRootRecord, record)) {
				continue;
			}
			const native = canonicalizeWindowsPathNative(record.path);
			if (native === undefined) {
				// A root that cannot be natively realpath'd is not a verified
				// directory; failing closed here beats trusting a lexical path.
				continue;
			}
			worktrees.push(native);
		}
	} catch {
		// Not a git repository or git command failed
	}

	gitWorktreeCache.set(dir, worktrees);
	return worktrees;
}

/**
 * Clears all guardrails caches.
 * Use this for test isolation or when guardrails config reloads at runtime.
 */
export function clearGuardrailsCaches(): void {
	pathNormalizationCache.clear();
	globMatcherCache.clear();
	gitWorktreeCache.clear();
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
	// authority layer must not add further constraints on top of it. EXCEPTION (#3120):
	// built-in verifier-config globs still deny for these roles (see the
	// AUTHORITY_VERIFIER_CONFIG check ahead of the role-policy paths) — the ignore
	// file class is owner policy for the verification system, not a swarm capability.
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
/**
 * #3606 D15: dependency-injection seam for the ancestor lstat (repo
 * convention, AGENTS.md invariant 7) so tests can drive the non-ENOENT
 * failure arm deterministically on every platform (on Windows, lstat of every
 * malformed-ancestor shape returns ENOENT — the arm is POSIX-only reachable
 * natively). Production routes through this seam.
 */
export const _internals: {
	lstatSync: (
		...args: Parameters<typeof fsSync.lstatSync>
	) => ReturnType<typeof fsSync.lstatSync>;
} = {
	lstatSync: (pathLike, options) => fsSync.lstatSync(pathLike, options),
};

/**
 * #3606 D15: compose an ancestor denial within a whole-message bound of 320.
 * The ancestor is home-redacted (redactPath) and sanitized; the error detail
 * renders the error CODE only (never String(err) — the raw message embeds
 * paths); the class text is preserved inside the bound.
 */
function renderAncestorDenial(
	kind: 'lstat-failed' | 'symlink-junction',
	ancestor: string,
	err?: unknown,
): string {
	const safeAncestor = sanitizeDiagnosticText(redactPath(ancestor), 320);
	if (kind === 'lstat-failed') {
		const code =
			(err as NodeJS.ErrnoException | undefined)?.code ??
			(err instanceof Error ? err.name : 'UNKNOWN');
		const safeCode = sanitizeDiagnosticText(code, 40);
		return sanitizeDiagnosticText(
			`WRITE BLOCKED: lstat failed on "${safeAncestor}": ${safeCode} — refusing write on unverifiable path`,
			320,
		);
	}
	return sanitizeDiagnosticText(
		`WRITE BLOCKED: "${safeAncestor}" is a symlink/junction — writing through a symlink or junction could redirect the write outside the working directory`,
		320,
	);
}

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
			stat = _internals.lstatSync(ancestor);
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT') continue; // not yet created — OK for writes
			// Unexpected error: fail closed
			return renderAncestorDenial('lstat-failed', ancestor, err);
		}
		if (stat?.isSymbolicLink()) {
			return renderAncestorDenial('symlink-junction', ancestor);
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
	// #3587 (v2): the REASON's path slot stays WORKSPACE-RELATIVE (the
	// pre-change display — escaping-write pins match the ../shape, so a
	// resolved-absolute render is wrong here) with two home-fold rules: an
	// ABSOLUTE normalizedPath (invalid-path arm, cross-drive arm) folds via
	// redactPath; an ESCAPING relative path (../ prefix — provably outside
	// the workspace, so a home/Users segment there is the real profile root,
	// not a workspace dir name) folds that segment to ~. Ordinary relative
	// and non-home absolute paths render unchanged. The structured `path`
	// field (consumed by scope-guard and the audit channel) keeps its
	// pre-change sanitized value. The invalid-path arm passes the RAW caller
	// input (pre-normalization, backslashes on win32), so the display source
	// is slash-normalized first — otherwise `..\Users\<name>\…` shapes dodge
	// both fold branches (#3587 review round).
	const displaySource = normalizedPath.replace(/\\/g, '/');
	// #3587 review round: the escaping probe runs on the NORMALIZED form so
	// non-canonical spellings (`./..`, `src/../..`) share the message
	// channel's fold decision — same-class disagreement, killed in the
	// helper first.
	const escapingProbe = path.posix.normalize(displaySource);
	// Non-escaping displays always route through the LEXICAL redactPath
	// (pre-change host-normalized form on non-profile shapes), so a
	// Windows-profile spelling folds even on POSIX hosts where `C:/…` is not
	// path-absolute.
	let reasonDisplay = redactPath(displaySource);
	if (escapingProbe.startsWith('../')) {
		reasonDisplay = escapingProbe.replace(
			/(^|\/)(?:home|Users)\/[^/]+/g,
			'$1~',
		);
	}
	const safeReasonPath = sanitizeDiagnosticText(reasonDisplay, 320);
	return {
		allowed: false,
		code: input.code,
		layer: input.layer,
		rule: sanitizeDiagnosticText(input.rule, 128),
		path: safePath,
		agent: safeAgent,
		reason: sanitizeDiagnosticText(
			`${input.code}: Path blocked: ${safeDetail} [agent=${safeAgent}; path=${safeReasonPath}]`,
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
	let effectiveDir = dir;
	// The caller cwd/target may be in 8.3 short-name form (GitHub Windows
	// runners report TEMP as C:\Users\RUNNER~1\...) while git reports
	// long-form roots; canonicalize before every lexical comparison. The
	// target may not exist yet (write check), so canonicalization walks to
	// the nearest existing ancestor instead of giving up on the leaf.
	const nativeTarget2 = canonicalizeWindowsPathTailTolerant(resolvedTarget);
	// Re-root to the LONGEST (most specific) matching worktree root, not the
	// first: `git worktree list` always lists the main worktree first, so a
	// first-match loop re-roots targets inside a NESTED linked worktree to the
	// outer root, and deny rules resolved against the wrong root silently stop
	// matching (issue #3368 review, F-001).
	const matchWorktreeRoot = (): string | undefined => {
		const worktrees = getLinkedGitWorktrees(dir);
		let best: { wt: string; rel: string } | undefined;
		for (const wt of worktrees) {
			const relToWt = path.relative(wt, nativeTarget2).replace(/\\/g, '/');
			if (
				relToWt !== '..' &&
				!relToWt.startsWith('../') &&
				!isOnDifferentFilesystemRoot(nativeTarget2, wt)
			) {
				if (!best || wt.length > best.wt.length) {
					best = { wt, rel: relToWt };
				}
			}
		}
		if (best) {
			effectiveDir = best.wt;
			normalizedPath = best.rel;
		}
		return best?.wt;
	};
	// A re-rooted target whose lexical chain crosses a symlink/junction inside
	// the matched worktree can redirect a NEW-file write anywhere (the target
	// itself does not exist yet, so realpath normalization cannot catch it).
	// Walk the ancestors between the matched root and the target and deny on
	// the first planted link, mirroring checkWriteTargetForSymlink's walk but
	// bounded by the re-rooted base instead of the session cwd.
	const findPlantedLinkBelow = (root: string): string | null => {
		const ancestors: string[] = [];
		let current = nativeTarget2;
		while (true) {
			const rel = path.relative(root, current);
			if (
				rel === '' ||
				rel === '..' ||
				rel.startsWith(`..${path.sep}`) ||
				path.isAbsolute(rel)
			)
				break;
			ancestors.push(current);
			const parent = path.dirname(current);
			if (parent === current) break;
			current = parent;
		}
		for (const ancestor of ancestors) {
			try {
				if (fsSync.lstatSync(ancestor).isSymbolicLink()) return ancestor;
			} catch (err: unknown) {
				const code = (err as NodeJS.ErrnoException).code;
				if (code === 'ENOENT') continue;
				return ancestor;
			}
		}
		return null;
	};
	if (isOnDifferentFilesystemRoot(resolvedTarget, dir)) {
		// Even across roots, check if target resides in a linked Git worktree of dir
		const matchedWorktree = matchWorktreeRoot();

		if (!matchedWorktree) {
			return denyAuthority(agentName, normalizedPath, {
				code: 'AUTHORITY_ROOT_ESCAPE',
				layer: 'containment',
				rule: 'same-filesystem-root',
				detail: 'target is on a different drive or filesystem root',
			});
		}
		const plantedLink = findPlantedLinkBelow(matchedWorktree);
		if (plantedLink) {
			return denyAuthority(agentName, normalizedPath, {
				code: 'AUTHORITY_ROOT_ESCAPE',
				layer: 'containment',
				rule: 'workspace-containment',
				detail: `re-rooted target crosses symlink/junction "${plantedLink}" inside the matched worktree`,
			});
		}
	} else if (normalizedPath === '..' || normalizedPath.startsWith('../')) {
		// Check whether target resides in a linked Git worktree of dir
		const matchedWorktree = matchWorktreeRoot();

		if (!matchedWorktree) {
			return denyAuthority(agentName, normalizedPath, {
				code: 'AUTHORITY_ROOT_ESCAPE',
				layer: 'containment',
				rule: 'workspace-containment',
				detail: 'target resolves outside the working directory',
			});
		}
		const plantedLink = findPlantedLinkBelow(matchedWorktree);
		if (plantedLink) {
			return denyAuthority(agentName, normalizedPath, {
				code: 'AUTHORITY_ROOT_ESCAPE',
				layer: 'containment',
				rule: 'workspace-containment',
				detail: `re-rooted target crosses symlink/junction "${plantedLink}" inside the matched worktree`,
			});
		}
	}

	const classifiedRules =
		effectiveRules[normalizedAgent] ?? effectiveRules[strippedAgent];
	// With authority disabled, an agent that has no classification (a custom or
	// host agent such as `sre-planner`) is not denied merely for being unknown.
	// It still passes through every hard-policy check below (universal deny,
	// control-state protection, canonical capabilities) and then hits the
	// authorityEnabled === false allow. The literal `unknown` name is the
	// fail-open sentinel for a session registered without an agent name
	// (state.ts ensureAgentSession), so it keeps the unknown-agent denial.
	const unclassifiedWhileDisabled =
		!classifiedRules &&
		options.authorityEnabled === false &&
		normalizedAgent !== 'unknown';
	const rules: AgentRule | undefined =
		classifiedRules ?? (unclassifiedWhileDisabled ? {} : undefined);
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
			path.resolve(effectiveDir, candidate),
			path.resolve(effectiveDir, prefix),
			flavor,
		);
	const matchesGlob = (glob: string): boolean =>
		getGlobMatcher(glob)(normalizedPath);

	for (const prefix of options.universalDenyPrefixes ?? []) {
		if (
			matchesAuthorityDenyPrefix(normalizedPath, prefix, effectiveDir, flavor)
		) {
			return denyAuthority(agentName, normalizedPath, {
				code: 'AUTHORITY_UNIVERSAL_DENY',
				layer: 'universal-deny',
				rule: `universal:${prefix}`,
				detail: `target is under universal deny prefix ${prefix}`,
			});
		}
	}

	const isCoderAgent = normalizedAgent === 'coder' || strippedAgent === 'coder';
	if (
		isCoderAgent &&
		isPolicyProtectedPath(normalizedPath, {
			includeDefaults: false,
			additional: ['.git', '.swarm'],
		})
	) {
		return denyAuthority(agentName, normalizedPath, {
			code: 'AUTHORITY_PROTECTED_PATH',
			layer: 'protected-path',
			rule: 'coder-control-state-protection',
			detail:
				'coder writes to repository control state (.git/.swarm) are always protected',
		});
	}
	// Agents admitted only because authority is disabled were denied outright
	// before authority.enabled:false admitted them, so through this file-write
	// authority check they never gain write access to repository control state.
	// (Shell-command writes are decided by the shell path in tool-before.ts.)
	if (
		unclassifiedWhileDisabled &&
		isPolicyProtectedPath(normalizedPath, {
			includeDefaults: false,
			additional: ['.git', '.swarm'],
		})
	) {
		return denyAuthority(agentName, normalizedPath, {
			code: 'AUTHORITY_PROTECTED_PATH',
			layer: 'protected-path',
			rule: 'unclassified-agent-control-state-protection',
			detail:
				'unclassified agent writes to repository control state (.git/.swarm) are always protected',
		});
	}
	// #3120 LEG 1: verifier-config globs are owner policy for the verification
	// system itself (the secretscan Stage-A gate trusts .secretscanignore, see
	// #3107/PR #3116), so the deny is a property of the protected FILE CLASS,
	// not a capability of swarm roles. It therefore applies to EVERY agent —
	// including the OpenCode-native roles deliberately exempted from swarm
	// write restrictions below (general/build/plan/explore carry {} rule maps)
	// — and it stays ahead of the authorityEnabled === false allow so the
	// other knob cannot switch it off either.
	const matchedVerifier = [
		...BUILT_IN_VERIFIER_CONFIG_GLOBS,
		...(options.verifierConfigPaths ?? []),
	].find(matchesGlob);
	if (matchedVerifier) {
		return denyAuthority(agentName, normalizedPath, {
			code: 'AUTHORITY_VERIFIER_CONFIG',
			layer: 'protected-path',
			rule: `verifier-config:${matchedVerifier}`,
			detail: `Path blocked (glob ${matchedVerifier}): verifier-owned configuration in the config zone is protected for every agent role (#3120)`,
		});
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
		// Declared scope is evaluated once, in the same coordinate system as
		// every other post-containment rule (re-rooted normalizedPath against
		// effectiveDir). The removed second disjunct tested the RAW caller
		// string against the ORIGINAL dir — a different coordinate system that
		// could grant declared-scope allow for a path the containment layer
		// never matched (issue #3368 review, F-006); every production caller
		// passes declaredScope entries covering the same file the
		// normalized operands already resolve.
		isPathWithinDeclaredScope(
			normalizedPath,
			options.declaredScope,
			effectiveDir,
		);
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
