/**
 * Normalize a repository-relative path for attribution comparisons.
 * Both slash forms are accepted; absolute paths, drive paths, traversal,
 * control characters, and empty values are rejected.
 */
export function normalizeAttributionPath(file: string): string | null {
	const normalized = file
		.trim()
		.replaceAll('\\', '/')
		.replace(/^\.\/+/, '');
	const hasControlCharacter = [...normalized].some((character) => {
		const code = character.charCodeAt(0);
		return code <= 31 || code === 127;
	});
	if (
		!normalized ||
		normalized.startsWith('/') ||
		/^[A-Za-z]:\//.test(normalized) ||
		normalized === '..' ||
		normalized.startsWith('../') ||
		normalized.split('/').includes('..') ||
		hasControlCharacter
	) {
		return null;
	}
	return normalized;
}
