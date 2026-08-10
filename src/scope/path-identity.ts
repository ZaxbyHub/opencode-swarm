import * as path from 'node:path';

/** Filesystem identity semantics used for comparisons, never for I/O. */
export type PathFlavor = 'win32' | 'posix';

const BIDI_CONTROL_CHARACTERS =
	/[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

function isControlCharacter(character: string): boolean {
	const codePoint = character.codePointAt(0) ?? 0;
	return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
}

function isBidiControlCharacter(character: string): boolean {
	return BIDI_CONTROL_CHARACTERS.test(character);
}

export function getPathFlavor(
	pathLib: Pick<typeof path, 'sep'> = path,
): PathFlavor {
	return pathLib.sep === '\\' ? 'win32' : 'posix';
}

function pathImplementation(
	flavor: PathFlavor,
): typeof path.win32 | typeof path.posix {
	return flavor === 'win32' ? path.win32 : path.posix;
}

/**
 * Produces a comparison-only path identity. Windows identities case-fold and
 * normalize both slash forms; POSIX identities preserve case.
 */
export function normalizePathIdentity(
	value: string,
	flavor: PathFlavor = getPathFlavor(),
): string {
	const pathImpl = pathImplementation(flavor);
	const normalized = pathImpl.normalize(
		flavor === 'win32' ? value.replace(/\//g, '\\') : value,
	);
	return flavor === 'win32' ? normalized.toLowerCase() : normalized;
}

export function pathIdentitiesEqual(
	a: string,
	b: string,
	flavor: PathFlavor = getPathFlavor(),
): boolean {
	return normalizePathIdentity(a, flavor) === normalizePathIdentity(b, flavor);
}

/** True when target is the container itself or a descendant of it. */
export function isPathIdentityWithin(
	target: string,
	container: string,
	flavor: PathFlavor = getPathFlavor(),
): boolean {
	const pathImpl = pathImplementation(flavor);
	const targetIdentity = normalizePathIdentity(target, flavor);
	const containerIdentity = normalizePathIdentity(container, flavor);
	if (targetIdentity === containerIdentity) return true;
	const relative = pathImpl.relative(containerIdentity, targetIdentity);
	return (
		relative.length > 0 &&
		relative !== '..' &&
		!relative.startsWith(`..${pathImpl.sep}`) &&
		!pathImpl.isAbsolute(relative)
	);
}

/**
 * Resolves a candidate and declared entries with one filesystem flavor, then
 * applies the canonical identity containment rule. This is the shared scope
 * predicate for guardrails, completion observers, and authority evaluation.
 */
export function isPathWithinDeclaredScope(
	filePath: string,
	scopeEntries: readonly string[],
	cwd = process.cwd(),
	flavor: PathFlavor = getPathFlavor(),
): boolean {
	const pathImpl = pathImplementation(flavor);
	const resolvedFile = pathImpl.resolve(cwd, filePath);
	return scopeEntries.some((scope) =>
		isPathIdentityWithin(resolvedFile, pathImpl.resolve(cwd, scope), flavor),
	);
}

/**
 * Compares drive/UNC/extended-device roots with Windows case-insensitive
 * identity while retaining POSIX case-sensitive path semantics.
 */
export function isOnDifferentPathRoot(
	target: string,
	cwd: string,
	flavor: PathFlavor = getPathFlavor(),
): boolean {
	const pathImpl = pathImplementation(flavor);
	const targetRoot = pathImpl.parse(pathImpl.normalize(target)).root;
	const cwdRoot = pathImpl.parse(pathImpl.normalize(cwd)).root;
	return !pathIdentitiesEqual(targetRoot, cwdRoot, flavor);
}

/** Returns a safe, caller-facing reason when path text is deceptive. */
export function unsafePathTextReason(value: string): string | null {
	if ([...value].some(isControlCharacter)) {
		return 'control characters are not allowed in paths';
	}
	if ([...value].some(isBidiControlCharacter)) {
		return 'bidirectional control characters are not allowed in paths';
	}
	return null;
}

/** Single-line, bounded rendering for untrusted diagnostic fields. */
export function sanitizeDiagnosticText(
	value: unknown,
	maxLength = 256,
): string {
	const rendered = String(value)
		.split('')
		.map((character) =>
			isControlCharacter(character) || isBidiControlCharacter(character)
				? '?'
				: character,
		)
		.join('')
		.replace(/\s+/gu, ' ')
		.trim();
	if (rendered.length <= maxLength) return rendered;
	return `${rendered.slice(0, Math.max(0, maxLength - 1))}…`;
}
