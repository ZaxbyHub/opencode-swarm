import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

export const BUNDLED_PROJECT_SKILLS = [
	'brainstorm',
	'specify',
	'clarify-spec',
	'resume',
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
	'swarm-pr-feedback',
	'swarm-pr-subscribe',
	'issue-ingest',
	'plan',
	'critic-gate',
	'execute',
	'phase-wrap',
	'loop',
	'writing-tests',
	'running-tests',
	'engineering-conventions',
	'commit-pr',
] as const;

const MAX_SKILL_FILES = 64;
const MAX_SKILL_BYTES = 512_000;

interface CopyState {
	files: number;
	bytes: number;
}

interface BundledSkillFile {
	relativePath: string;
}

function warnBundledSkillSyncFailure(err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	console.warn(
		`[opencode-swarm] Could not install bundled project skills; continuing without sync: ${message}`,
	);
}

// ---------------------------------------------------------------------------
// Async materialization for the plugin-init path. The plugin-init path must be
// bounded by `withTimeout` (AGENTS.md Invariant 1). `withTimeout` is
// `Promise.race`, so it can only bound work that actually yields — a synchronous
// copy loop wrapped in an async IIFE still runs to completion on one tick and is
// NOT bounded. This implementation uses `fs/promises` with real await points
// between files so the timeout is enforceable at file boundaries.
//
// Guarantees: update known bundled slugs in place, symlink refusal,
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
	const files: BundledSkillFile[] = [];

	for (const entry of entries) {
		const relativeEntry = path.join(relativeDir, entry.name);
		const sourcePath = path.join(sourceDir, relativeEntry);

		if (entry.isSymbolicLink() || (await isSymbolicLinkAsync(sourcePath)))
			continue;

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

			await fsp.mkdir(path.dirname(destPath), { recursive: true });
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
 * Materialize missing built-in mode skills into the target project so architect
 * MODE dispatch can load SKILL.md files in repositories that do not already
 * vendor the latest opencode-swarm skill tree.
 *
 * Async, bounded, and fail-open: safe to `await withTimeout(...)` on the
 * plugin-init path (AGENTS.md Invariant 1). Runs at plugin init so the
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
	try {
		const sourceRoot = path.join(packageRoot, '.opencode', 'skills');
		const opencodeDir = path.join(projectDirectory, '.opencode');
		const skillsDir = path.join(opencodeDir, 'skills');

		if (!(await ensureNotSymlinkedDirectoryAsync(opencodeDir))) return;
		if (!(await ensureNotSymlinkedDirectoryAsync(skillsDir))) return;

		for (const slug of BUNDLED_PROJECT_SKILLS) {
			const sourceDir = path.join(sourceRoot, slug);
			const sourceSkill = path.join(sourceDir, 'SKILL.md');
			const destDir = path.join(skillsDir, slug);

			if (!(await pathExistsAsync(sourceSkill))) continue;
			if (!(await ensureNotSymlinkedDirectoryAsync(destDir))) continue;

			await copyBundledDirectoryBoundedAsync(sourceDir, destDir);
			if (!quiet) {
				console.warn(
					`[opencode-swarm] Synchronized bundled skill .opencode/skills/${slug}/SKILL.md for first-class /swarm command support`,
				);
			}
		}
	} catch (err) {
		// Non-fatal: plugin init and command registration must remain fail-open.
		if (!quiet) warnBundledSkillSyncFailure(err);
	}
}

export const _test_exports = {
	collectBundledSkillFilesBoundedAsync,
	// No-op: the cache was removed in favor of content-equality checks on every
	// call. This stub is retained for backward compatibility with existing tests.
	resetBundledProjectSkillSyncCache: () => undefined,
};
