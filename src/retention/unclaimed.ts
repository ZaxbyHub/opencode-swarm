/**
 * Catch-all lifecycle for directories immediately under `.swarm/` that no
 * retention family and no owner manifest claims (issue #2483 follow-up).
 *
 * THE DEFECT CLASS: the retention sweep's `familiesFor()` is a CLOSED set. Any
 * directory it does not name — an agent-written scratch tree such as a
 * reviewer's `.swarm/review-sandbox` or a mutation run's `.swarm/review-mut` —
 * has no lifecycle at all, and no supported command can reclaim it: the shell
 * guardrails refuse an unsanctioned recursive delete, and the sweep blocks
 * every path it has not been taught. Such trees grow for the lifetime of the
 * project.
 *
 * THE FIX: three tiers of ownership, no global config key.
 *
 *  1. TIER 1 — `TIER1_PRESERVED_SWARM_ENTRIES`. Swarm's own state, hardcoded
 *     here. Never pruned by the catch-all, whatever its age.
 *  2. TIER 2 — owner manifests under `.swarm/retention.d/*.json`:
 *     `{ "owner": "reviewer", "preserve": ["review-sandbox"], "maxAgeDays": 90 }`.
 *     One file per owner and one writer each, so there is no shared file to
 *     merge and no cross-agent edit surface — a shared config would turn every
 *     new scratch owner into a conflict in one file. A claim SETS the
 *     directory's horizon to the owner's declared `maxAgeDays` (longer or
 *     shorter than the 30-day default); it is a LEASE, not a permanent
 *     exemption, because a claim that never expires would recreate the very
 *     defect this module fixes.
 *     A malformed, unreadable or misnamed (outside the name grammar) manifest
 *     skips this catch-all (fail closed); an unparseable claim is no licence.
 *  3. TIER 3 — the catch-all. An unclaimed, non-symlinked directory with no
 *     `.preserve` marker whose entire content is older than its horizon is
 *     pruned. The retention log is validated BEFORE the first delete and every
 *     pruned path is appended to it after the delete loop.
 *
 * CONTAINMENT, in three layers:
 *  - the tier-3 pass refuses to run at all when `.swarm` itself is a link
 *    (`.swarm` -> project root would make `.git` and `src` "children");
 *  - every candidate is `lstat`-ed and must be a real directory, not a link;
 *  - every candidate's realpath must be an IMMEDIATE child of the realpath of
 *    `.swarm`, checked right before its delete. This narrows the window in
 *    which a parent can be swapped for a link (`fs.rmSync` follows a swapped
 *    PARENT) but cannot close it; the window needs write access to `.swarm`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { SUBTREE_SCAN_CAP, subtreeContentStats } from './dir-prune';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Default horizon for an unclaimed directory under `.swarm/` (30 days). */
export const DEFAULT_UNCLAIMED_MAX_AGE_DAYS = 30;
/** Owner manifests live here, one file per owner. */
export const RETENTION_MANIFEST_DIR = 'retention.d';
/** Append-only record of what the catch-all reclaimed. */
export const RETENTION_LOG_FILE = 'retention.log';
/** Presence of this marker file in a directory blocks the catch-all. */
export const RETENTION_PRESERVE_MARKER = '.preserve';
/** One manifest may not exceed this size; an oversized claim is malformed. */
export const RETENTION_MANIFEST_MAX_BYTES = 64 * 1024;
/** Byte budget for the retention log; the newest lines win when exceeded. */
export const RETENTION_LOG_MAX_BYTES = 256 * 1024;

/**
 * Tier 1: swarm's own state under `.swarm/`, which the catch-all must never
 * prune. Directory entries are the load-bearing ones (the catch-all only ever
 * deletes directories); flat files are listed too so the allowlist stays a
 * complete statement of ownership if the catch-all is ever widened to files.
 *
 * This list deliberately over-includes rather than under-includes: a name that
 * is wrongly preserved merely stays where it is, while a name that is wrongly
 * pruned loses authoritative state.
 */
export const TIER1_PRESERVED_SWARM_ENTRIES: ReadonlySet<string> = new Set([
	// Retention control plane (this module's own state).
	RETENTION_MANIFEST_DIR,
	RETENTION_LOG_FILE,

	// Authoritative stores and their sidecars (AGENTS.md invariant 5, #2484).
	'swarm.db',
	'swarm.db-wal',
	'swarm.db-shm',
	'plan',
	'plan.json',
	'plan.md',
	'plan-ledger.jsonl',
	'plan-export',
	'refs',
	'authority',
	'memory',
	'knowledge',
	'knowledge.jsonl',
	'events.jsonl',
	'run-memory.jsonl',
	'handoff.json',
	'handoff.md',
	'close-lessons.md',
	'full-auto-state.json',

	// Evidence, scopes, and archives.
	'evidence',
	'evidence-cache',
	'scopes',
	'archive',
	'spec-archive',

	// Session, summaries, and per-session state.
	'session',
	'summaries',
	'context',
	'context.md',
	'context-snapshot.md',
	'outputs',
	'advisories',
	'quarantine',
	'reset-backups',
	'rollback-backups',
	'locks',
	'cache',
	'checkpoints',

	// Retention families (each owns its own per-entry semantics — a catch-all
	// pass over the family ROOT would bypass the family's keep-newest caps).
	'runs',
	'capsules',
	'lane-results',
	'review-receipts',
	'pr-review',
	'pr-workflow-gates',
	'pr-workflow-checkouts',
	'pr-feedback-events',
	'pr-feedback-evidence',
	'pr-feedback-loop-cleanups',
	'pr-monitor',
	'recovery',
	'evolution',
	'epic',
	'epic-prior',
	'loops',
	'loop',

	// Skill stores and their proposals/state.
	'skills',
	'skill-improver',
	'skill-improve',
	'skill-changelogs',
	'bundled-skills',
	'external-skills',

	// Agent-visible working state.
	'lanes',
	'learning',
	'trajectories',
	'replays',
	'observability',
	'training',
	'task-repairs',
	'task-terminals',
	'coder-settlements',
	'council',
	'worktree-recovery-claims',
	'review-v8',
	'semgrep-rules',

	// Registry-owned `project-swarm` directories (scripts/retention-registry.
	// data.ts). Two are classified `authoritative` and are protected regardless
	// of age; the others are rebuilt or short-lived but their own writers own
	// their lifecycle. `tests/unit/retention/unclaimed-guards.test.ts`
	// fails when a registry directory is missing from this set.
	'background-delegation-fallback',
	'worktree-provisioning-owners',
	'reflections',
	'otlp-export',
	'stage-b-dispatch-bindings',
]);

/** One owner's claim over directories immediately under `.swarm/`. */
export interface OwnerClaim {
	/** Owner name from the manifest (`owner`). */
	owner: string;
	/** Manifest file, project-relative, for diagnostics and log lines. */
	manifestFile: string;
	/** Owner-declared horizon for the directories it claims. */
	maxAgeDays: number;
}

export interface OwnerManifestSet {
	/** Immediate child name under `.swarm/` -> the claim that owns it. */
	claims: ReadonlyMap<string, OwnerClaim>;
	/** Manifest files read, project-relative and sorted. */
	files: readonly string[];
}

/** A malformed or unreadable ownership claim. Skips the catch-all pass. */
export class RetentionManifestError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'RetentionManifestError';
	}
}

/** One directory the catch-all would prune, with the evidence for it. */
export interface ExplainedPrune {
	/** Project-relative path, e.g. `.swarm/review-sandbox`. */
	path: string;
	/** Whole days since the newest content in the subtree (or the node). */
	ageDays: number;
	/**
	 * Regular-file bytes in the subtree. Symlinks are never followed, so a
	 * link's own size is excluded and its TARGET's content is not counted:
	 * the target is not ours to reclaim.
	 */
	sizeBytes: number;
	/** Owner whose manifest claim set this directory's horizon, if claimed. */
	owner?: string;
}

export interface UnclaimedSweepOptions {
	/** Clock injection point for tests/checks. */
	now: number;
	/** Plan without deleting (the sweep-wide `dry_run` surface). */
	dryRun?: boolean;
	/** Parsed tier-2 claims; an absent map means "no owner claims anything". */
	claims?: ReadonlyMap<string, OwnerClaim>;
	/** Cooperative stop token, polled between candidates. */
	shouldContinue?: () => boolean;
}

export interface UnclaimedSweepOutcome {
	/** Every directory this pass selected (pruned, or would prune). */
	planned: ExplainedPrune[];
	/** Directories actually removed (empty under dryRun). */
	pruned: ExplainedPrune[];
	/** Per-directory failures; the pass stays fail-open per candidate. */
	failures: Array<{ path: string; message: string }>;
	/**
	 * Directories deliberately KEPT because their content could not be verified
	 * (unreadable level, or more entries than the per-subtree scan budget).
	 * Reported so an operator can see why a stale tree is never reclaimed.
	 */
	unverifiable: Array<{ path: string; message: string }>;
}

function errorCode(error: unknown): string {
	return typeof error === 'object' && error !== null && 'code' in error
		? String((error as { code?: unknown }).code)
		: '';
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Read and validate every owner manifest. THROWS `RetentionManifestError` on
 * anything ambiguous — a malformed claim, a symlinked manifest, a duplicate
 * claim, or two files declaring the same owner — because the caller's contract
 * is to skip the catch-all pass rather than guess at ownership.
 */
export function loadOwnerManifests(swarmRoot: string): OwnerManifestSet {
	const manifestDir = path.join(swarmRoot, RETENTION_MANIFEST_DIR);
	let dirStat: fs.Stats;
	try {
		dirStat = fs.lstatSync(manifestDir);
	} catch (error) {
		// No manifest directory (or `.swarm` is not a directory at all): there
		// are no ownership claims to honour, which is not an error.
		const code = errorCode(error);
		if (code === 'ENOENT' || code === 'ENOTDIR') {
			return { claims: new Map(), files: [] };
		}
		throw new RetentionManifestError(
			`refusing retention sweep: cannot inspect .swarm/${RETENTION_MANIFEST_DIR}/ (${describeError(error)})`,
		);
	}
	if (dirStat.isSymbolicLink()) {
		throw new RetentionManifestError(
			`refusing retention sweep: .swarm/${RETENTION_MANIFEST_DIR} is a symlink; ownership manifests must be real files inside the project`,
		);
	}
	if (!dirStat.isDirectory()) {
		throw new RetentionManifestError(
			`refusing retention sweep: .swarm/${RETENTION_MANIFEST_DIR} is not a directory`,
		);
	}
	let names: string[];
	try {
		names = fs.readdirSync(manifestDir).sort();
	} catch (error) {
		throw new RetentionManifestError(
			`refusing retention sweep: cannot read .swarm/${RETENTION_MANIFEST_DIR}/ (${describeError(error)})`,
		);
	}

	const claims = new Map<string, OwnerClaim>();
	const owners = new Map<string, string>();
	const files: string[] = [];
	for (const name of names) {
		// Dotfiles and names that do not end in `.json` are not manifests (a temp
		// file mid-write must not be mistaken for one). `.json` plus trailing dots
		// or whitespace is still a claim attempt: refused below, never skipped.
		if (name.startsWith('.') || !/\.json[.\s]*$/i.test(name)) continue;
		const manifestPath = path.join(manifestDir, name);
		const relFile = `.swarm/${RETENTION_MANIFEST_DIR}/${name}`;
		const fail = (reason: string): never => {
			throw new RetentionManifestError(
				`refusing retention sweep: ${escapeLogPath(relFile)}: ${reason}`,
			);
		};
		// A `.json` name outside the manifest grammar is refused, never skipped: a
		// silently ignored claim would let its directory be pruned.
		if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/i.test(name)) {
			fail(
				'is not a valid manifest file name (letters, digits, ".", "_" and "-", starting with a letter or digit)',
			);
		}
		let fileStat: fs.Stats;
		try {
			fileStat = fs.lstatSync(manifestPath);
		} catch (error) {
			return fail(`unreadable (${describeError(error)})`);
		}
		if (fileStat.isSymbolicLink()) {
			fail('is a symlink; ownership manifests must be real files');
		}
		if (!fileStat.isFile()) {
			fail('is not a regular file');
		}
		if (fileStat.size > RETENTION_MANIFEST_MAX_BYTES) {
			fail(
				`is ${fileStat.size} bytes, over the ${RETENTION_MANIFEST_MAX_BYTES}-byte manifest bound`,
			);
		}
		let raw: string;
		try {
			raw = fs.readFileSync(manifestPath, 'utf-8');
		} catch (error) {
			return fail(`unreadable (${describeError(error)})`);
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			return fail(`is not valid JSON (${describeError(error)})`);
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			fail('must be a JSON object');
		}
		const record = parsed as Record<string, unknown>;
		const owner = record.owner;
		if (typeof owner !== 'string' || owner.trim().length === 0) {
			fail('"owner" must be a non-empty string');
		}
		if ((owner as string).length > 120) {
			fail('"owner" must be at most 120 characters');
		}
		const previousOwnerFile = owners.get(owner as string);
		if (previousOwnerFile !== undefined) {
			fail(
				`declares owner "${owner}" which ${previousOwnerFile} already declares; one owner has exactly one manifest`,
			);
		}
		const preserve = record.preserve;
		if (!Array.isArray(preserve)) {
			fail('"preserve" must be an array of directory names');
		}
		const maxAgeDays = record.maxAgeDays;
		if (
			maxAgeDays !== undefined &&
			(typeof maxAgeDays !== 'number' ||
				!Number.isFinite(maxAgeDays) ||
				maxAgeDays < 1 ||
				maxAgeDays > 36500)
		) {
			fail('"maxAgeDays" must be a finite number between 1 and 36500');
		}
		const declared = preserve as unknown[];
		const seen = new Set<string>();
		for (const [index, entry] of declared.entries()) {
			if (
				typeof entry !== 'string' ||
				entry.length === 0 ||
				entry.length > 255 ||
				entry === '.' ||
				entry === '..' ||
				entry.includes('/') ||
				entry.includes('\\') ||
				// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters IS the validation.
				/[\u0000-\u001f]/.test(entry)
			) {
				fail(
					`"preserve[${index}]" is not a plain directory name (got ${JSON.stringify(entry)})`,
				);
			}
			const claimed = entry as string;
			if (seen.has(claimed)) {
				fail(`"preserve" lists "${claimed}" twice`);
			}
			seen.add(claimed);
			const existing = claims.get(claimed.toLowerCase());
			if (existing) {
				fail(
					`claims "${claimed}", already claimed by ${existing.manifestFile}; two owners cannot share one directory`,
				);
			}
		}
		owners.set(owner as string, relFile);
		files.push(relFile);
		const claim: OwnerClaim = {
			owner: owner as string,
			manifestFile: relFile,
			maxAgeDays:
				typeof maxAgeDays === 'number'
					? maxAgeDays
					: DEFAULT_UNCLAIMED_MAX_AGE_DAYS,
		};
		for (const claimedName of seen)
			claims.set(claimedName.toLowerCase(), claim);
	}
	return { claims, files };
}

/** A `.preserve` marker blocks pruning; an unreadable marker is treated as present. */
async function hasPreserveMarker(dir: string): Promise<boolean> {
	try {
		await fs.promises.lstat(path.join(dir, RETENTION_PRESERVE_MARKER));
		return true;
	} catch (error) {
		return errorCode(error) !== 'ENOENT';
	}
}

/**
 * Per-resolved-path containment. `resolvedSwarmRoot` MUST already be a
 * realpath; the candidate is resolved at call time so a directory swapped for
 * a symlink after enumeration is refused rather than followed.
 *
 * `path.relative` (not a string prefix) is what makes this correct on every
 * platform: it compares case-insensitively on Windows, tolerates a root that
 * carries a trailing separator, and reports a different drive/volume as an
 * absolute path. Only an IMMEDIATE child may be deleted — the caller
 * enumerates direct children, so a multi-segment remainder means the
 * candidate was re-pointed at a nested path (or out of the root) after it was
 * enumerated.
 */
function isContainedInSwarmRoot(
	resolvedSwarmRoot: string,
	candidatePath: string,
): boolean {
	let resolved: string;
	try {
		resolved = fs.realpathSync(candidatePath);
	} catch {
		return false;
	}
	const relative = path.relative(resolvedSwarmRoot, resolved);
	if (relative.length === 0 || path.isAbsolute(relative)) return false;
	if (relative === '..' || relative.startsWith(`..${path.sep}`)) return false;
	return !relative.includes(path.sep);
}

/** `<ISO-8601> pruned <path> age=<days> size=<bytes>` — one line per prune. */
export function formatRetentionLogLine(
	now: number,
	entry: ExplainedPrune,
): string {
	return `${new Date(now).toISOString()} pruned ${escapeLogPath(entry.path)} age=${entry.ageDays} size=${entry.sizeBytes}`;
}

/**
 * A POSIX directory name may legally hold a newline; written raw it would let
 * a directory name forge a second log record. Control characters are escaped
 * as `\xNN` so the log stays one record per line.
 */
function escapeLogPath(value: string): string {
	return value.replace(
		// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters IS the escape.
		/[\u0000-\u001f\u007f]/g,
		(char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`,
	);
}

function splitLogLines(text: string): string[] {
	return text.split('\n').filter((line) => line.length > 0);
}

/**
 * Read at most the newest `RETENTION_LOG_MAX_BYTES` of the log.
 *
 * This helper only reads bytes: the CALLER owns target validation
 * (`assertLogTargetIsWritable` before the append, plus the post-append
 * re-check before any compaction write). It throws only what fs throws.
 */
function readRetentionLogTail(logPath: string, size: number): string[] {
	if (size <= RETENTION_LOG_MAX_BYTES) {
		return splitLogLines(fs.readFileSync(logPath, 'utf-8'));
	}
	const length = RETENTION_LOG_MAX_BYTES;
	const buffer = Buffer.alloc(length);
	const fd = fs.openSync(logPath, 'r');
	try {
		const read = fs.readSync(fd, buffer, 0, length, size - length);
		// The slice almost certainly starts mid-line; drop that partial line.
		return splitLogLines(buffer.subarray(0, read).toString('utf-8')).slice(1);
	} finally {
		fs.closeSync(fd);
	}
}

/** Keep the newest lines that fit the byte budget; a lone oversized line stays. */
function trimLogToBudget(lines: readonly string[]): string[] {
	let bytes = 0;
	let start = lines.length;
	while (start > 0) {
		const lineBytes = Buffer.byteLength(lines[start - 1], 'utf-8') + 1;
		if (bytes + lineBytes > RETENTION_LOG_MAX_BYTES) break;
		bytes += lineBytes;
		start -= 1;
	}
	// Never drop the newest line, even if it alone exceeds the budget: the log
	// must always name the most recent prune.
	if (start === lines.length && lines.length > 0) start = lines.length - 1;
	return lines.slice(start);
}

function assertLogTargetIsWritable(logPath: string): void {
	let stat: fs.Stats;
	try {
		stat = fs.lstatSync(logPath);
	} catch (error) {
		if (errorCode(error) === 'ENOENT') return;
		throw new Error(
			`cannot inspect .swarm/${RETENTION_LOG_FILE} (${describeError(error)})`,
		);
	}
	if (stat.isSymbolicLink()) {
		throw new Error(
			`.swarm/${RETENTION_LOG_FILE} is a symlink; refusing to write through it`,
		);
	}
	if (!stat.isFile()) {
		throw new Error(`.swarm/${RETENTION_LOG_FILE} is not a regular file`);
	}
}

/**
 * Append one line per pruned directory, then compact the log to its byte
 * budget when the append pushed it over. Bounded on both sides: the read that
 * feeds compaction is itself capped at `RETENTION_LOG_MAX_BYTES`.
 */
export async function appendRetentionLog(
	swarmRoot: string,
	now: number,
	pruned: readonly ExplainedPrune[],
): Promise<void> {
	if (pruned.length === 0) return;
	const logPath = path.join(swarmRoot, RETENTION_LOG_FILE);
	assertLogTargetIsWritable(logPath);
	const payload = `${pruned
		.map((entry) => formatRetentionLogLine(now, entry))
		.join('\n')}\n`;
	await fs.promises.appendFile(logPath, payload, 'utf-8');
	const stat = await fs.promises.lstat(logPath).catch(() => null);
	// Re-validate AFTER the append: the path can be swapped for a symlink
	// between the pre-append check and this read, and the compaction
	// `writeFile` below WOULD follow it. A swapped or non-regular target skips
	// compaction — the append already succeeded, compaction is best-effort,
	// and the next append re-validates from scratch.
	if (!stat || stat.isSymbolicLink() || !stat.isFile()) return;
	if (stat.size <= RETENTION_LOG_MAX_BYTES) return;
	const kept = trimLogToBudget(readRetentionLogTail(logPath, stat.size));
	await fs.promises.writeFile(logPath, `${kept.join('\n')}\n`, 'utf-8');
}

/**
 * True when `.swarm` is a real directory that sits directly inside its own
 * parent. A `.swarm` that is a link (a symlink, or a junction on Windows) is
 * refused outright: if it points INTO the project, every project directory
 * would look like an unclaimed child of `.swarm`, and the per-candidate
 * containment check compares against the already-redirected root so it cannot
 * help.
 */
function swarmRootIsCanonical(swarmRoot: string): boolean {
	try {
		if (fs.lstatSync(swarmRoot).isSymbolicLink()) return false;
		const resolvedParent = fs.realpathSync(path.dirname(swarmRoot));
		const resolvedSwarm = fs.realpathSync(swarmRoot);
		return (
			path.relative(resolvedParent, resolvedSwarm) === path.basename(swarmRoot)
		);
	} catch {
		return false;
	}
}

/**
 * Tier 3: prune unclaimed directories immediately under `.swarm/`. Every
 * candidate must satisfy ALL of: not tier 1 (compared case-insensitively, so a
 * differently-cased spelling on a case-insensitive filesystem is preserved);
 * not claimed by a live tier-2 manifest; a real directory (lstat, never a
 * symlink); no `.preserve` marker; content verifiable within the subtree scan
 * budget; no future mtime; and content strictly older than its horizon.
 * `dryRun` lists the planned set and deletes nothing.
 *
 * The pass is skipped when `.swarm` is itself a link, and when deletes are
 * armed it is skipped when the retention log is a link, not a regular file or
 * uninspectable. A permission failure on a regular log is only caught by the
 * post-delete append and reported in `failures`.
 *
 * Never throws: an unreadable `.swarm` is an empty pass, and a per-directory
 * failure is reported in `failures` without aborting the siblings.
 */
export async function pruneUnclaimedDirectories(
	swarmRoot: string,
	options: UnclaimedSweepOptions,
): Promise<UnclaimedSweepOutcome> {
	const outcome: UnclaimedSweepOutcome = {
		planned: [],
		pruned: [],
		failures: [],
		unverifiable: [],
	};
	const suppressDeletes = options.dryRun === true;
	if (!swarmRootIsCanonical(swarmRoot)) {
		outcome.failures.push({
			path: '.swarm',
			message:
				'refusing unclaimed-directory pass: .swarm is a link or does not resolve to a directory directly inside the project root',
		});
		return outcome;
	}
	if (!suppressDeletes) {
		try {
			assertLogTargetIsWritable(path.join(swarmRoot, RETENTION_LOG_FILE));
		} catch (error) {
			outcome.failures.push({
				path: `.swarm/${RETENTION_LOG_FILE}`,
				message: `refusing unclaimed-directory pass: the prune audit log is not writable (${describeError(error)})`,
			});
			return outcome;
		}
	}
	// The caller proved the swarm root sits inside the project; the realpath is
	// the REFERENT every candidate must resolve inside, per delete.
	let resolvedSwarmRoot: string;
	try {
		resolvedSwarmRoot = fs.realpathSync(swarmRoot);
	} catch {
		return outcome;
	}
	let names: string[];
	try {
		names = (await fs.promises.readdir(swarmRoot)).sort();
	} catch {
		return outcome;
	}
	const claims = new Map<string, OwnerClaim>();
	for (const [claimed, claim] of options.claims ?? []) {
		claims.set(claimed.toLowerCase(), claim);
	}

	for (const name of names) {
		if (options.shouldContinue && !options.shouldContinue()) break;
		if (TIER1_PRESERVED_SWARM_ENTRIES.has(name.toLowerCase())) continue;
		const entryPath = path.join(swarmRoot, name);
		const stat = await fs.promises.lstat(entryPath).catch(() => null);
		if (!stat || stat.isSymbolicLink() || !stat.isDirectory()) continue;
		if (await hasPreserveMarker(entryPath)) continue;
		const claim = claims.get(name.toLowerCase());
		const horizonDays = claim?.maxAgeDays ?? DEFAULT_UNCLAIMED_MAX_AGE_DAYS;
		const content = subtreeContentStats(entryPath, SUBTREE_SCAN_CAP);
		// Unverifiable content is never a victim (fail closed): an unreadable or
		// over-budget subtree may still be in use. It is REPORTED, not silently
		// skipped, so an operator can see why a stale tree is never reclaimed.
		if (content === null) {
			outcome.unverifiable.push({
				path: `.swarm/${name}`,
				message: `kept: content could not be verified (unreadable, or more than ${SUBTREE_SCAN_CAP} entries); add a .preserve marker to silence this, or remove the tree by hand`,
			});
			continue;
		}
		const newest = content.newestFileMtime ?? stat.mtimeMs;
		if (newest > options.now) continue; // clock-skew guard
		const ageMs = options.now - newest;
		if (ageMs <= horizonDays * DAY_MS) continue;
		if (!isContainedInSwarmRoot(resolvedSwarmRoot, entryPath)) continue;
		const plan: ExplainedPrune = {
			// Always `/`-separated (the documented and logged form), on every OS.
			path: `.swarm/${name}`,
			ageDays: Math.floor(ageMs / DAY_MS),
			sizeBytes: content.bytes,
			...(claim ? { owner: claim.owner } : {}),
		};
		outcome.planned.push(plan);
		if (suppressDeletes) continue;
		try {
			fs.rmSync(entryPath, { recursive: true, force: true });
			outcome.pruned.push(plan);
		} catch (error) {
			outcome.failures.push({
				path: plan.path,
				message: describeError(error),
			});
		}
	}

	if (outcome.pruned.length > 0) {
		try {
			await appendRetentionLog(swarmRoot, options.now, outcome.pruned);
		} catch (error) {
			outcome.failures.push({
				path: `.swarm/${RETENTION_LOG_FILE}`,
				message: describeError(error),
			});
		}
	}
	return outcome;
}
