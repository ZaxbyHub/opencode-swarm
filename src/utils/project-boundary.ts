import * as fs from 'node:fs';
import * as path from 'node:path';

/** Direct declarations that make a nested directory an independent project root. */
const PROJECT_BOUNDARY_MARKERS = [
	{
		name: '.git',
		accepts: (stat: fs.Stats) => stat.isFile() || stat.isDirectory(),
	},
	{ name: '.opencode', accepts: (stat: fs.Stats) => stat.isDirectory() },
] as const;

function isAbsoluteDirectoryInput(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.trim().length > 0 &&
		path.isAbsolute(value)
	);
}

/**
 * Return whether `directory` directly declares its own project boundary.
 *
 * Markers are local declarations, not verified Git metadata. A direct `.git`
 * file/directory covers repositories, linked worktrees, and submodules; a
 * direct `.opencode` directory is the manual opt-in. `lstatSync` is deliberate:
 * marker symlinks/junctions do not grant an exemption. Missing, inaccessible,
 * or ambiguous markers fail closed.
 */
export function hasExplicitProjectBoundary(directory: unknown): boolean {
	if (!isAbsoluteDirectoryInput(directory)) return false;

	for (const marker of PROJECT_BOUNDARY_MARKERS) {
		try {
			const stat = _internals.lstatSync(path.join(directory, marker.name));
			if (!stat.isSymbolicLink() && marker.accepts(stat)) return true;
		} catch {
			// A failed marker probe cannot grant a project-root exemption. Continue
			// so one ambiguous/missing marker does not hide a valid second marker.
		}
	}
	return false;
}

/**
 * Test whether `candidate` is a strict lexical descendant of `root` using the
 * host platform's path semantics (including case-insensitive Windows paths).
 */
export function isStrictPathDescendant(
	candidate: unknown,
	root: unknown,
): boolean {
	if (!isAbsoluteDirectoryInput(candidate) || !isAbsoluteDirectoryInput(root)) {
		return false;
	}
	const relative = path.relative(root, candidate);
	return (
		relative !== '' &&
		relative !== '..' &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

/** Narrow filesystem seam for deterministic marker error tests. */
export const _internals: { lstatSync: typeof fs.lstatSync } = {
	lstatSync: fs.lstatSync,
};
