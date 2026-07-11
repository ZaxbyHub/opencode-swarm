import * as path from 'node:path';

function normalizeCandidate(value: unknown): string | null {
	if (typeof value !== 'string' || value.length === 0) return null;
	if (
		[...value].some((character) => {
			const codePoint = character.codePointAt(0) ?? 0;
			return codePoint <= 0x1f || codePoint === 0x7f;
		})
	)
		return null;
	if (path.win32.isAbsolute(value) || path.posix.isAbsolute(value)) return null;
	const normalized = value.replace(/\\/g, '/');
	const segments = normalized.split('/');
	if (
		segments.some(
			(segment) => segment === '' || segment === '.' || segment === '..',
		)
	) {
		return null;
	}
	return normalized;
}

export function isExactMarkdownPath(value: unknown): boolean {
	const normalized = normalizeCandidate(value);
	return normalized !== null && path.posix.extname(normalized) === '.md';
}

/** Require independent non-empty declared and observed exact-.md proof. */
export function isMarkdownOnlyTaskChange(
	declaredFiles: unknown,
	observedFiles: unknown,
): boolean {
	if (!Array.isArray(declaredFiles) || !Array.isArray(observedFiles))
		return false;
	if (declaredFiles.length === 0 || observedFiles.length === 0) return false;
	if (!declaredFiles.every(isExactMarkdownPath)) return false;
	if (!observedFiles.every(isExactMarkdownPath)) return false;

	const declared = new Set(
		declaredFiles
			.map(normalizeCandidate)
			.filter((value): value is string => value !== null),
	);
	return observedFiles.every((value) => {
		const normalized = normalizeCandidate(value);
		return normalized !== null && declared.has(normalized);
	});
}
