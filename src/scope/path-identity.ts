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

/**
 * Best-effort path redaction for diagnostics and audit logs (#3587: moved
 * here from src/hooks/guardrails/audit-log.ts so lower-level consumers —
 * notably the file-authority reason builder — can fold home/profile prefixes
 * without importing the audit subsystem; audit-log re-exports it unchanged).
 *
 * Replaces leading home/profile segments with a tilde placeholder so absolute
 * paths do not leak user-specific directory names (POSIX `/home/<name>`,
 * macOS `/Users/<name>`, Windows drive profiles `C:\Users\<name>`
 * case-insensitive, and UNC profile shares).
 *
 * This is intentionally minimal on non-home paths — ordinary project paths
 * are diagnostic content and are preserved (over-redaction guards pin it).
 */
export function redactPath(filePath: string): string {
	// Non-strings can never be safely redacted — coerce to the empty string
	// instead of passing them through (issue #2040 reviewer round R2: the old
	// passthrough let an unredacted non-string value reach disk silently).
	if (typeof filePath !== 'string') return '';
	if (filePath.length === 0) return filePath;

	// #3587 review round: profile classification is LEXICAL on a canonical
	// slash-normalized form, so (a) normalization-created home shapes
	// (`/tmp/../home/<name>/x`) fold, (b) the exact profile root folds
	// (trailing component optional), and (c) Windows-drive and UNC forms fold
	// in either separator flavor on ANY host — matchability no longer depends
	// on the host path module's flavor. A redacted output keeps the input's
	// separator flavor (and the old Windows branch's `~\\rest` double
	// separator is gone); a NON-profile path returns the exact pre-change
	// host-normalized form, so audit/log shapes for ordinary paths do not
	// drift.
	const hadBackslash = filePath.includes('\\');
	const slashForm = filePath.replace(/\\/g, '/');
	// posix.normalize collapses a leading `//`, so keep the UNC root marker
	// out of normalization and re-attach it.
	const normalized = /^\/\/[^/]/.test(slashForm)
		? `/${path.posix.normalize(slashForm.slice(1))}`
		: path.posix.normalize(slashForm);

	// POSIX/mac home (root or descendant): /home/<name>[/<rest>] -> ~/<rest>
	const homeMatch = normalized.match(/^\/(?:home|Users)\/[^/]+((?:\/.*)?)$/);
	if (homeMatch) {
		return renderRedacted(`~${homeMatch[1] ?? ''}`, hadBackslash);
	}

	// Windows profile in either flavor (case-insensitive Users):
	// <drive>:/(Users|home)/<name>[/<rest>] -> ~/<rest>
	const driveMatch = normalized.match(
		/^[A-Za-z]:\/(?:[Uu][Ss][Ee][Rr][Ss]|home)\/[^/]+((?:\/.*)?)$/i,
	);
	if (driveMatch) {
		return renderRedacted(`~${driveMatch[1] ?? ''}`, hadBackslash);
	}

	// Windows UNC: //<server>/<share>/<name>[/<rest>] -> ~\<share>\<name>\<rest>
	// (server folded, per the F-004 contract; a profile-shaped share folds the
	// account segment too: \\server\Users\alice\x -> ~\x).
	const uncMatch = normalized.match(/^\/\/[^/]+\/([^/]+)\/([^/]+)((?:\/.*)?)$/);
	if (uncMatch) {
		const [, share, name, rest = ''] = uncMatch;
		// Windows share naming is case-insensitive.
		if (/^(?:users|home)$/i.test(share)) {
			return renderRedacted(`~${rest}`, hadBackslash);
		}
		return renderRedacted(`~/${share}/${name}${rest}`, hadBackslash);
	}

	return path.normalize(filePath);
}

/** Emit a folded path in the input's separator flavor. */
function renderRedacted(display: string, hadBackslash: boolean): string {
	return hadBackslash ? display.replace(/\//g, '\\') : display;
}
