import * as fs from 'node:fs';
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
	'design-docs',
	'swarm-pr-review',
	'swarm-pr-feedback',
	'issue-ingest',
	'plan',
	'critic-gate',
	'execute',
	'phase-wrap',
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

const syncedProjectSkillTargets = new Set<string>();

function isSymbolicLink(p: string): boolean {
	try {
		return fs.lstatSync(p).isSymbolicLink();
	} catch {
		return false;
	}
}

function ensureNotSymlinkedDirectory(p: string): boolean {
	try {
		const stat = fs.lstatSync(p);
		return stat.isDirectory() && !stat.isSymbolicLink();
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === 'ENOENT';
	}
}

function getSyncCacheKey(
	projectDirectory: string,
	packageRoot: string,
): string {
	return `${path.resolve(projectDirectory)}\0${path.resolve(packageRoot)}`;
}

function collectBundledSkillFilesBounded(
	sourceDir: string,
	state: CopyState,
	relativeDir = '',
): BundledSkillFile[] {
	const currentSource = path.join(sourceDir, relativeDir);
	const entries = fs.readdirSync(currentSource, { withFileTypes: true });
	const files: BundledSkillFile[] = [];

	for (const entry of entries) {
		const relativeEntry = path.join(relativeDir, entry.name);
		const sourcePath = path.join(sourceDir, relativeEntry);

		if (entry.isSymbolicLink() || isSymbolicLink(sourcePath)) continue;

		if (entry.isDirectory()) {
			files.push(
				...collectBundledSkillFilesBounded(sourceDir, state, relativeEntry),
			);
			continue;
		}

		if (!entry.isFile()) continue;

		const stat = fs.statSync(sourcePath);
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

function rollbackCopiedFiles(copiedFiles: string[], destDir: string): void {
	const safeDestDir = path.resolve(destDir);
	const dirs = new Set<string>();
	for (const copiedFile of copiedFiles) {
		const resolvedFile = path.resolve(copiedFile);
		const relative = path.relative(safeDestDir, resolvedFile);
		if (relative.startsWith('..') || path.isAbsolute(relative)) continue;

		try {
			fs.rmSync(resolvedFile, { force: true });
		} catch {
			// Best effort cleanup only; the original copy error is more useful.
		}
		dirs.add(path.dirname(resolvedFile));
	}

	for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
		const relative = path.relative(safeDestDir, path.resolve(dir));
		if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
		try {
			fs.rmdirSync(dir);
		} catch {
			// Directory may contain user files or previously installed skill files.
		}
	}
}

function copyBundledDirectoryBounded(sourceDir: string, destDir: string): void {
	const files = collectBundledSkillFilesBounded(sourceDir, {
		files: 0,
		bytes: 0,
	});
	const copiedFiles: string[] = [];

	try {
		for (const file of files) {
			const sourcePath = path.join(sourceDir, file.relativePath);
			const destPath = path.join(destDir, file.relativePath);

			fs.mkdirSync(path.dirname(destPath), { recursive: true });
			try {
				fs.copyFileSync(sourcePath, destPath, fs.constants.COPYFILE_EXCL);
				copiedFiles.push(destPath);
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
			}
		}
	} catch (err) {
		rollbackCopiedFiles(copiedFiles, destDir);
		throw err;
	}
}

function warnBundledSkillSyncFailure(err: unknown): void {
	const message = err instanceof Error ? err.message : String(err);
	console.warn(
		`[opencode-swarm] Could not install bundled project skills; continuing without sync: ${message}`,
	);
}

/**
 * Materialize missing built-in mode skills into the target project so architect
 * MODE dispatch can load SKILL.md files in repositories that do not already
 * vendor the latest opencode-swarm skill tree.
 *
 * This is intentionally missing-only and fail-open: custom project skills are
 * never overwritten, and any filesystem error leaves command execution fail-open.
 */
export function syncBundledProjectSkillsIfMissing(
	projectDirectory: string,
	packageRoot: string,
	quiet = false,
): void {
	try {
		const cacheKey = getSyncCacheKey(projectDirectory, packageRoot);
		if (syncedProjectSkillTargets.has(cacheKey)) return;

		const sourceRoot = path.join(packageRoot, '.opencode', 'skills');
		const opencodeDir = path.join(projectDirectory, '.opencode');
		const skillsDir = path.join(opencodeDir, 'skills');
		let sawBundledSource = false;

		if (!ensureNotSymlinkedDirectory(opencodeDir)) return;
		if (!ensureNotSymlinkedDirectory(skillsDir)) return;

		for (const slug of BUNDLED_PROJECT_SKILLS) {
			const sourceDir = path.join(sourceRoot, slug);
			const sourceSkill = path.join(sourceDir, 'SKILL.md');
			const destDir = path.join(skillsDir, slug);
			const destSkill = path.join(destDir, 'SKILL.md');

			if (!fs.existsSync(sourceSkill)) continue;
			sawBundledSource = true;
			if (fs.existsSync(destSkill)) continue;
			if (!ensureNotSymlinkedDirectory(destDir)) continue;

			copyBundledDirectoryBounded(sourceDir, destDir);
			if (!quiet) {
				console.warn(
					`[opencode-swarm] Installed bundled skill .opencode/skills/${slug}/SKILL.md for first-class /swarm command support`,
				);
			}
		}
		if (sawBundledSource) syncedProjectSkillTargets.add(cacheKey);
	} catch (err) {
		// Non-fatal: plugin init and command registration must remain fail-open.
		if (!quiet) warnBundledSkillSyncFailure(err);
	}
}

export const _test_exports = {
	collectBundledSkillFilesBounded,
	getSyncCacheKey,
	resetBundledProjectSkillSyncCache: () => syncedProjectSkillTargets.clear(),
};
