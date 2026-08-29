import * as fs from 'node:fs';
import * as path from 'node:path';

/** Manifest names used by language detection and project-context resolution. */
export const MANIFEST_FILES = [
	'package.json',
	'tsconfig.json',
	'pyproject.toml',
	'setup.py',
	'setup.cfg',
	'requirements.txt',
	'Pipfile',
	'Cargo.toml',
	'go.mod',
	'pom.xml',
	'build.gradle',
	'build.gradle.kts',
	'build.zig',
	'CMakeLists.txt',
	'Makefile',
	'meson.build',
	'Package.swift',
	'pubspec.yaml',
	'Gemfile',
	'composer.json',
] as const;

const MANIFEST_SET = new Set<string>(MANIFEST_FILES);

function hasManifestInDirectory(directory: string): boolean {
	try {
		return fs.readdirSync(directory).some((entry) => MANIFEST_SET.has(entry));
	} catch {
		return false;
	}
}

/**
 * Returns the marker's directory, null when the full walk proves there is no
 * marker, and undefined when an inaccessible marker or depth limit makes the
 * result unknown.
 */
function findGitMarkerAncestor(start: string): string | null | undefined {
	let current = path.resolve(start);
	for (let depth = 0; depth < 32; depth++) {
		const marker = path.join(current, '.git');
		try {
			const stat = fs.lstatSync(marker);
			if (!stat.isSymbolicLink()) return current;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code !== 'ENOENT' && code !== 'ENOTDIR') return undefined;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
	return undefined;
}

/**
 * Cheap, filesystem-only preflight used before loading the language backend
 * graph during plugin init. Project roots passed by OpenCode are checked
 * directly. For nested paths inside a Git repository, the walk is limited to
 * that repository's boundary; non-repository ancestors (which may be large
 * system or temporary directories) are never scanned.
 */
export function hasManifestAncestor(start: string): boolean {
	const resolved = path.resolve(start);
	const gitRoot = findGitMarkerAncestor(resolved);
	if (gitRoot === undefined) return true;
	if (gitRoot === null) return hasManifestInDirectory(resolved);

	let current = resolved;
	for (let depth = 0; depth < 32; depth++) {
		if (hasManifestInDirectory(current)) return true;
		if (current === gitRoot) return false;
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
	return true;
}

/**
 * Conservative Git-boundary preflight for startup hygiene.
 *
 * A false result means every ancestor was inspected and no non-symlink `.git`
 * marker exists, so invoking Git cannot protect this directory. Any
 * inaccessible marker, malformed marker, or depth exhaustion returns true so
 * callers fail closed and retain the full Git check. Symlink markers are
 * intentionally ignored: they are not trusted project-root declarations.
 */
export function hasGitMarkerAncestor(start: string): boolean {
	// Unknown (undefined) results deliberately return true so callers retain the
	// full Git check rather than skipping hygiene on incomplete evidence.
	return findGitMarkerAncestor(start) !== null;
}

/**
 * Whether `.swarm` exists at the supplied root. Unknown/inaccessible state is
 * treated as present so snapshot rehydration is never skipped accidentally.
 */
export function hasSwarmState(start: string): boolean {
	try {
		fs.lstatSync(path.join(path.resolve(start), '.swarm'));
		return true;
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code !== 'ENOENT' && code !== 'ENOTDIR';
	}
}
