/**
 * Fail-closed physical filesystem identity for existing entries.
 *
 * Unlike canonicalRootKey, this helper never falls back to a lexical path:
 * callers use it only when equality must be proven for entries that exist.
 * It does not establish containment, authorization, hard-link equivalence, or
 * race-free safety; it proves pathname identity at the instant of resolution.
 */

import * as fsSync from 'node:fs';
import * as path from 'node:path';

export const _internals: {
	realpathSyncNative: (path: fsSync.PathLike) => string;
	realpathSync: typeof fsSync.realpathSync;
	lstatSync: typeof fsSync.lstatSync;
	platform: () => NodeJS.Platform;
} = {
	realpathSyncNative: fsSync.realpathSync.native,
	realpathSync: fsSync.realpathSync,
	lstatSync: fsSync.lstatSync,
	platform: () => process.platform,
};

function normalizeIdentityPath(resolved: string): string {
	const normalized =
		_internals.platform() === 'win32'
			? path.win32.normalize(resolved)
			: path.posix.normalize(resolved);
	return _internals.platform() === 'win32'
		? normalized.replaceAll('\\', '/').toLowerCase()
		: normalized;
}

/**
 * Return a canonical pathname only when the entry physically resolves.
 * Native realpath expands Windows 8.3 names; ordinary realpath is a portable
 * fallback for runtimes/filesystems where the native binding is unavailable.
 */
export function canonicalExistingFilesystemPath(
	entryPath: string,
): string | null {
	if (typeof entryPath !== 'string') return null;
	const resolvedInput = path.resolve(entryPath);
	try {
		return normalizeIdentityPath(_internals.realpathSyncNative(resolvedInput));
	} catch {
		try {
			return normalizeIdentityPath(_internals.realpathSync(resolvedInput));
		} catch {
			return null;
		}
	}
}

/**
 * Return the pre-#2474 canonical spelling used in persisted scope bindings.
 *
 * It deliberately skips the native Windows resolver: old releases used the
 * ordinary `realpathSync` result (then slash-normalized and case-folded). The
 * scope persistence reader uses this as a narrow dual-read compatibility
 * witness and always rewrites a recovered binding with the current native-first
 * identity on its next durable write.
 */
export function legacyCanonicalExistingFilesystemPath(
	entryPath: string,
): string | null {
	if (typeof entryPath !== 'string') return null;
	try {
		return normalizeIdentityPath(
			_internals.realpathSync(path.resolve(entryPath)),
		);
	} catch {
		return null;
	}
}

export interface CanonicalPathFromExistingAncestor {
	canonicalPath: string;
	existingAncestor: string;
	existingAncestorIsLink: boolean;
	identityWitnesses: FilesystemIdentityWitness[];
}

export interface FilesystemIdentityWitness {
	lexicalPath: string;
	canonicalPath: string;
}

function appendLinkedAncestorWitnesses(
	witnesses: FilesystemIdentityWitness[],
	startPath: string,
): void {
	let probe = path.resolve(startPath);
	for (let depth = 0; depth < 4096; depth++) {
		const parent = path.dirname(probe);
		if (parent === probe) return;
		probe = parent;
		try {
			if (!_internals.lstatSync(probe).isSymbolicLink()) continue;
		} catch {
			continue;
		}
		const canonical = canonicalExistingFilesystemPath(probe);
		if (canonical !== null) {
			witnesses.push({ lexicalPath: probe, canonicalPath: canonical });
		}
	}
}

/** Capture the entry plus linked ancestors whose identity can prove retarget. */
export function filesystemIdentityWitnesses(
	entryPath: string,
): FilesystemIdentityWitness[] {
	const lexicalPath = path.resolve(entryPath);
	const canonicalPath = canonicalExistingFilesystemPath(lexicalPath);
	if (canonicalPath === null) return [];
	const witnesses = [{ lexicalPath, canonicalPath }];
	appendLinkedAncestorWitnesses(witnesses, lexicalPath);
	return witnesses;
}

/**
 * Resolve a not-yet-existing path through its nearest existing physical
 * ancestor, then append the normalized missing suffix. This does not prove the
 * leaf exists and must not be used for equality or authorization decisions; it
 * binds future lazy I/O to the mount/alias target observed at acquisition time.
 */
export function canonicalPathFromExistingAncestor(
	entryPath: string,
): CanonicalPathFromExistingAncestor | null {
	let probe = path.resolve(entryPath);
	const tail: string[] = [];
	for (let depth = 0; depth < 4096; depth++) {
		let stat: fsSync.Stats;
		try {
			stat = _internals.lstatSync(probe);
		} catch (error) {
			const code =
				error && typeof error === 'object' && 'code' in error
					? String(error.code)
					: undefined;
			if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
			const parent = path.dirname(probe);
			if (parent === probe) return null;
			tail.unshift(path.basename(probe));
			probe = parent;
			continue;
		}
		const canonicalAncestor = canonicalExistingFilesystemPath(probe);
		// The entry exists (including a broken link) but cannot be physically
		// resolved. Never reinterpret permission or unknown failures as missing.
		if (canonicalAncestor === null) return null;
		let existingAncestorIsLink = false;
		existingAncestorIsLink = stat.isSymbolicLink();
		return {
			canonicalPath: normalizeIdentityPath(
				path.join(canonicalAncestor, ...tail),
			),
			existingAncestor: probe,
			existingAncestorIsLink,
			identityWitnesses: filesystemIdentityWitnesses(probe),
		};
	}
	return null;
}

/**
 * Capture the path a future lazy filesystem operation must use. Existing paths
 * resolve exactly; missing paths inherit the physical identity of their nearest
 * existing ancestor. A wholly unresolvable path returns null so authority or
 * storage callers can fail closed rather than bind to a mutable lexical alias.
 */
export function canonicalPathForFutureIo(entryPath: string): string | null {
	return (
		canonicalExistingFilesystemPath(entryPath) ??
		canonicalPathFromExistingAncestor(entryPath)?.canonicalPath ??
		null
	);
}

/** Compare two existing entries, failing closed if either cannot resolve. */
export function sameExistingFilesystemPath(a: string, b: string): boolean {
	const canonicalA = canonicalExistingFilesystemPath(a);
	const canonicalB = canonicalExistingFilesystemPath(b);
	return (
		canonicalA !== null && canonicalB !== null && canonicalA === canonicalB
	);
}
