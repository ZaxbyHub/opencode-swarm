import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { advisoryWarn } from '../services/warning-buffer.js';
import { canonicalRootKeyFresh } from '../utils/canonical-root.js';
import { log } from '../utils/logger.js';
export const BUNDLED_PROJECT_SKILLS = [
	'brainstorm',
	'specify',
	'clarify-spec',
	'swarm-resume',
	'clarify',
	'discover',
	'consult',
	'pre-phase-briefing',
	'council',
	'deep-dive',
	'deep-research',
	'codebase-review-swarm',
	'swarm-implement',
	'design-docs',
	'swarm-pr-review',
	'swarm',
	'swarm-pr-feedback',
	'swarm-pr-subscribe',
	'swarm-ci-monitor',
	'issue-ingest',
	'swarm-plan',
	'critic-gate',
	'execute',
	'phase-wrap',
	'loop',
	'writing-tests',
	'running-tests',
	'engineering-conventions',
	'commit-pr',
	// Phase 1 / swarm workflow skills
	'ci-failure-batching',
	'gate-attribution',
	'merge-queue-readiness',
	'skill-edit-validation',
	'worktree-retry-cleanup',
	'test-file-split',
	'fork-pr-operations',
	'parallel-work-check',
	'ci-fix-monitor',
	'issue-tracer',
	'orchestrating-subagents',
	'durable-session-state',
] as const;
export type BundledProjectSkill = (typeof BUNDLED_PROJECT_SKILLS)[number];
/**
 * Bundled skill slugs that were retired (renamed away) in shipped releases.
 * The sync removes their materialized directories from
 * `.swarm/bundled-skills/` in existing user projects so a rename never leaves
 * a stale protocol copy behind (issue #2379: `resume` → `swarm-resume`;
 * issue #2388 via #2493: `plan` → `swarm-plan`).
 * A slug must never appear both here and in BUNDLED_PROJECT_SKILLS (asserted
 * by tests/unit/skills/claude-slug-collision-guard.test.ts).
 */
export const RETIRED_BUNDLED_PROJECT_SKILLS = [
	// `resume` → `swarm-resume` (issue #2379): the bare slug shadowed Claude
	// Code's built-in /resume conversation-resume command.
	'resume',
	// `plan` → `swarm-plan` (issue #2388, delivered via #2493): the bare slug
	// shadowed both hosts' built-in /plan plan-mode command.
	'plan',
] as const;
/**
 * Project-private runtime location for plugin-owned skills. Repository-native
 * skill roots (`.opencode/skills`, `.claude/skills`, and `.agents/skills`) are
 * user-owned and must never be used as materialization destinations.
 */
export const BUNDLED_PROJECT_SKILL_ROOT = '.swarm/bundled-skills';
export function bundledProjectSkillFileReference(
	slug: BundledProjectSkill,
): string {
	return `file:${BUNDLED_PROJECT_SKILL_ROOT}/${slug}/SKILL.md`;
}
const MAX_SKILL_FILES = 64;
const MAX_SKILL_BYTES = 512_000;
const MAX_IN_FLIGHT_SYNCS = 64;
const inFlightSyncs = new Map<string, Promise<void>>();
interface CopyState {
	files: number;
	bytes: number;
}
interface BundledSkillFile {
	relativePath: string;
}
function describeBundledSkillSyncFailure(err: unknown): string {
	const message = err instanceof Error ? err.message : String(err);
	return `[opencode-swarm] Could not install bundled project skills; continuing without sync: ${message}`;
}
// ---------------------------------------------------------------------------
// Async materialization for the plugin-init path. The plugin-init path must be
// bounded by `withTimeout` (AGENTS.md Invariant 1). `withTimeout` is
// `Promise.race`, so it can only bound work that actually yields — a synchronous
// copy loop wrapped in an async IIFE still runs to completion on one tick and is
// NOT bounded. This implementation uses `fs/promises` with real await points
// between files so the timeout is enforceable at file boundaries.
//
// Guarantees: update known private bundled copies in place, symlink refusal,
// MAX_SKILL_FILES/MAX_SKILL_BYTES bounds, and rollback-on-error. Any filesystem
// error leaves command execution fail-open.
// ---------------------------------------------------------------------------
async function isSymbolicLinkAsync(p: string): Promise<boolean> {
	try {
		return (await fsp.lstat(p)).isSymbolicLink();
	} catch {
		return false;
	}
}
async function ensureNotSymlinkedDirectoryAsync(p: string): Promise<boolean> {
	try {
		const stat = await fsp.lstat(p);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'ENOENT';
	}
}
async function pathExistsAsync(p: string): Promise<boolean> {
	try {
		await fsp.access(p);
		return true;
	} catch {
		return false;
	}
}
async function collectBundledSkillFilesBoundedAsync(
	sourceDir: string,
	state: CopyState,
	relativeDir = '',
): Promise<BundledSkillFile[]> {
	const currentSource = path.join(sourceDir, relativeDir);
	const entries = await fsp.readdir(currentSource, { withFileTypes: true });
	entries.sort((a, b) => a.name.localeCompare(b.name));
	const files: BundledSkillFile[] = [];
	for (const entry of entries) {
		const relativeEntry = path.join(relativeDir, entry.name);
		const sourcePath = path.join(sourceDir, relativeEntry);
		if (entry.isSymbolicLink() || (await isSymbolicLinkAsync(sourcePath))) {
			throw new Error('refusing to copy symlinked bundled skill entry');
		}
		if (entry.isDirectory()) {
			files.push(
				...(await collectBundledSkillFilesBoundedAsync(
					sourceDir,
					state,
					relativeEntry,
				)),
			);
			continue;
		}
		if (!entry.isFile()) continue;
		const stat = await fsp.stat(sourcePath);
		const nextFiles = state.files + 1;
		const nextBytes = state.bytes + stat.size;
		if (nextFiles > MAX_SKILL_FILES || nextBytes > MAX_SKILL_BYTES) {
			throw new Error('bundled skill package exceeds copy bounds');
		}
		state.files = nextFiles;
		state.bytes = nextBytes;
		files.push({ relativePath: relativeEntry });
	}
	return files;
}
async function ensureContainedDirectoryAsync(
	rootDir: string,
	directory: string,
): Promise<void> {
	const safeRoot = path.resolve(rootDir);
	const safeDirectory = path.resolve(directory);
	const relative = path.relative(safeRoot, safeDirectory);
	if (relative.startsWith('..') || path.isAbsolute(relative)) {
		throw new Error('bundled skill destination escaped its private root');
	}
	try {
		const rootStat = await fsp.lstat(safeRoot);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
			throw new Error('refusing to traverse unsafe bundled skill directory');
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		await fsp.mkdir(safeRoot, { recursive: true });
		const rootStat = await fsp.lstat(safeRoot);
		if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
			throw new Error('refusing to traverse unsafe bundled skill directory');
		}
	}
	let current = safeRoot;
	for (const segment of relative.split(path.sep).filter(Boolean)) {
		current = path.join(current, segment);
		try {
			const stat = await fsp.lstat(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) {
				throw new Error('refusing to traverse unsafe bundled skill directory');
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
			try {
				await fsp.mkdir(current);
			} catch (mkdirErr) {
				if ((mkdirErr as NodeJS.ErrnoException).code !== 'EEXIST') {
					throw mkdirErr;
				}
			}
			const stat = await fsp.lstat(current);
			if (stat.isSymbolicLink() || !stat.isDirectory()) {
				throw new Error('refusing to traverse unsafe bundled skill directory');
			}
		}
	}
}
async function rollbackCopiedFilesAsync(
	copiedFiles: string[],
	destDir: string,
	overwrittenFiles: Array<{ path: string; contents: Buffer }> = [],
): Promise<void> {
	const safeDestDir = path.resolve(destDir);
	const dirs = new Set<string>();
	for (const copiedFile of copiedFiles) {
		const resolvedFile = path.resolve(copiedFile);
		const relative = path.relative(safeDestDir, resolvedFile);
		if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
		try {
			await fsp.rm(resolvedFile, { force: true });
		} catch {
			// Best effort cleanup only; the original copy error is more useful.
		}
		dirs.add(path.dirname(resolvedFile));
	}
	for (const overwritten of overwrittenFiles.reverse()) {
		const resolvedFile = path.resolve(overwritten.path);
		const relative = path.relative(safeDestDir, resolvedFile);
		if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
		try {
			await fsp.writeFile(resolvedFile, overwritten.contents);
		} catch {
			// Best effort restore only; the original copy error remains primary.
		}
	}
	for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
		const relative = path.relative(safeDestDir, path.resolve(dir));
		if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
		try {
			await fsp.rmdir(dir);
		} catch {
			// Directory may contain user files or previously installed skill files.
		}
	}
}
async function copyFileAtomicAsync(
	sourcePath: string,
	destPath: string,
): Promise<void> {
	const tempPath = path.join(
		path.dirname(destPath),
		`.${path.basename(destPath)}.tmp.${randomUUID()}`,
	);
	try {
		await fsp.copyFile(sourcePath, tempPath);
		await fsp.rename(tempPath, destPath);
	} catch (err) {
		try {
			await fsp.rm(tempPath, { force: true });
		} catch {
			// Best effort cleanup of a temp file from this copy attempt.
		}
		throw err;
	}
}
async function copyBundledDirectoryBoundedAsync(
	sourceDir: string,
	destDir: string,
): Promise<void> {
	const files = await collectBundledSkillFilesBoundedAsync(sourceDir, {
		files: 0,
		bytes: 0,
	});
	const copiedFiles: string[] = [];
	const overwrittenFiles: Array<{ path: string; contents: Buffer }> = [];
	try {
		for (const file of files) {
			const sourcePath = path.join(sourceDir, file.relativePath);
			const destPath = path.join(destDir, file.relativePath);
			await ensureContainedDirectoryAsync(destDir, path.dirname(destPath));
			if (await pathExistsAsync(destPath)) {
				if (await isSymbolicLinkAsync(destPath)) {
					throw new Error('refusing to overwrite symlinked bundled skill file');
				}
				const [sourceContents, destContents] = await Promise.all([
					fsp.readFile(sourcePath),
					fsp.readFile(destPath),
				]);
				if (sourceContents.equals(destContents)) {
					continue;
				}
				overwrittenFiles.push({ path: destPath, contents: destContents });
				await copyFileAtomicAsync(sourcePath, destPath);
			} else {
				await copyFileAtomicAsync(sourcePath, destPath);
				copiedFiles.push(destPath);
			}
		}
	} catch (err) {
		await rollbackCopiedFilesAsync(copiedFiles, destDir, overwrittenFiles);
		throw err;
	}
}
/**
 * Best-effort removal of retired bundled-slug directories from a project's
 * private runtime root. Validates its own root (refuses a symlinked
 * `skillsDir` before any delete), is bounded (fixed retired list — no
 * directory scanning), contained (each target is verified to sit under
 * `skillsDir` before any delete), symlink-refusing, and fail-open per slug:
 * a removal failure (including Windows EPERM/EACCES, which `force: true`
 * does not swallow) logs and continues without failing the surrounding sync.
 */
async function removeRetiredBundledSkillDirsAsync(
	skillsDir: string,
): Promise<void> {
	if (!(await ensureNotSymlinkedDirectoryAsync(skillsDir))) return;
	const safeRoot = path.resolve(skillsDir);
	for (const slug of RETIRED_BUNDLED_PROJECT_SKILLS) {
		try {
			const target = path.resolve(safeRoot, slug);
			const relative = path.relative(safeRoot, target);
			if (relative.startsWith('..') || path.isAbsolute(relative)) {
				throw new Error('retired bundled skill path escaped its private root');
			}
			try {
				const stat = await fsp.lstat(target);
				// Skip symlinks (never delete through a link) and non-directories.
				if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
			} catch (err) {
				// ENOENT: nothing to clean up — the expected state for projects
				// that never materialized this slug.
				if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
				throw err;
			}
			await fsp.rm(target, { recursive: true, force: true });
			log('removed retired bundled skill', { slug });
		} catch (err) {
			log('could not remove retired bundled skill (continuing)', {
				slug,
				message: err instanceof Error ? err.message : String(err),
			});
		}
	}
}
async function performBundledProjectSkillSyncAsync(
	projectDirectory: string,
	packageRoot: string,
	quiet: boolean,
): Promise<void> {
	// Tracks whether `skillsDir` passed its symlink/directory guards. The
	// retired-dir cleanup below must ONLY run on that validated path: running
	// it unconditionally (e.g. via a bare `finally`) would also fire on the
	// guard early-returns above, where `skillsDir` may be a symlink and a
	// recursive rm could follow it outside the project (PR #2387 review
	// finding F-003). Inside the validated region the cleanup must also run
	// when the copy loop throws, so a failed copy can never leave the stale
	// retired directory behind.
	let skillsDirValidated = false;
	try {
		const sourceRoot = path.join(packageRoot, '.opencode', 'skills');
		const swarmDir = path.join(projectDirectory, '.swarm');
		const skillsDir = path.join(projectDirectory, BUNDLED_PROJECT_SKILL_ROOT);
		if (!(await ensureNotSymlinkedDirectoryAsync(sourceRoot))) {
			throw new Error('refusing to copy symlinked bundled skill source root');
		}
		if (!(await ensureNotSymlinkedDirectoryAsync(swarmDir))) return;
		if (!(await ensureNotSymlinkedDirectoryAsync(skillsDir))) return;
		skillsDirValidated = true;
		for (const slug of BUNDLED_PROJECT_SKILLS) {
			const sourceDir = path.join(sourceRoot, slug);
			const sourceSkill = path.join(sourceDir, 'SKILL.md');
			const destDir = path.join(skillsDir, slug);
			if (!(await pathExistsAsync(sourceSkill))) continue;
			if (!(await ensureNotSymlinkedDirectoryAsync(sourceDir))) {
				throw new Error('refusing to copy symlinked bundled skill directory');
			}
			if (!(await ensureNotSymlinkedDirectoryAsync(destDir))) continue;
			await copyBundledDirectoryBoundedAsync(sourceDir, destDir);
			// Success is a routine, expected, non-advisory event (the sync is
			// best-effort by design). Emit ONLY through the debug-gated logger so
			// it never reaches raw stderr/stdout and corrupts the host TUI (issue
			// #1249 class). `quiet` is intentionally not consulted here: a success
			// narration is diagnostic noise under either quiet setting.
			log('synchronized bundled skill', {
				slug: bundledProjectSkillFileReference(slug),
			});
		}
	} catch (err) {
		// Non-fatal: plugin init and command registration must remain fail-open.
		// The failure IS operator-actionable (the backstop broke): under
		// quiet=true route it to advisoryWarn (buffered for /swarm diagnose +
		// debug-gated, no raw stderr). The quiet=false branch keeps the legacy
		// visible-warning for parity with other init advisories that still use
		// the two-way `!config.quiet` routing. PR2-5 of epic #1752 collapses
		// this to advisoryWarn once the broader surface is migrated.
		// Per AGENTS.md Invariant 10.
		const failureMsg = describeBundledSkillSyncFailure(err);
		if (quiet) {
			advisoryWarn(failureMsg);
		} else {
			// biome-ignore lint/suspicious/noConsole: Fallback user-facing warning when bundled skill sync fails non-quietly — cannot use advisoryWarn as it would duplicate the already-raised advisory
			console.warn(failureMsg);
		}
	} finally {
		// Retired slugs (renamed away in past releases) have no copy loop entry,
		// so remove their stale materialized directories separately — on the
		// success path AND after a caught copy failure. Gated on the validated
		// flag so the guard early-returns above never reach it. Fail-open per
		// slug inside the helper; a cleanup failure must never surface as a
		// sync failure.
		if (skillsDirValidated) {
			await removeRetiredBundledSkillDirsAsync(
				path.join(projectDirectory, BUNDLED_PROJECT_SKILL_ROOT),
			);
		}
	}
}
/**
 * Materialize built-in mode skills into the target project's private runtime
 * tree so architect MODE dispatch never collides with repository-owned skills
 * that happen to use the same slug.
 *
 * Async, bounded, and fail-open: register `withTimeout(...)` in the
 * wrapper-owned post-resolution task queue on the plugin-init path
 * (AGENTS.md Invariant 1). Runs at plugin init so the
 * architect's very first auto-entered mode (e.g. SPECIFY on a fresh project) can
 * load its SKILL.md without a manual `/swarm` command or session restart; the
 * command path calls it again as a backstop for pre-existing projects.
 *
 * This is intentionally fail-open: bundled slugs are refreshed from the package
 * source, and any filesystem error leaves command execution fail-open.
 */
export async function syncBundledProjectSkillsIfMissingAsync(
	projectDirectory: string,
	packageRoot: string,
	quiet = false,
): Promise<void> {
	const syncKey = `${canonicalRootKeyFresh(projectDirectory)}\u0000${BUNDLED_PROJECT_SKILL_ROOT}`;
	const existing = inFlightSyncs.get(syncKey);
	if (existing) return existing;
	if (inFlightSyncs.size >= MAX_IN_FLIGHT_SYNCS) {
		log('skipping bundled skill sync because the in-flight limit was reached', {
			limit: MAX_IN_FLIGHT_SYNCS,
		});
		return;
	}
	const syncPromise = performBundledProjectSkillSyncAsync(
		projectDirectory,
		packageRoot,
		quiet,
	).finally(() => {
		if (inFlightSyncs.get(syncKey) === syncPromise) {
			inFlightSyncs.delete(syncKey);
		}
	});
	inFlightSyncs.set(syncKey, syncPromise);
	return syncPromise;
}
export const _test_exports = {
	collectBundledSkillFilesBoundedAsync,
	copyBundledDirectoryBoundedAsync,
	resetBundledProjectSkillSyncCache: () => inFlightSyncs.clear(),
};
