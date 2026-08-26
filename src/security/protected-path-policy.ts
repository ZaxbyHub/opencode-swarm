import * as path from 'node:path';

export interface ProtectedPathPolicyOptions {
	includeDefaults?: boolean;
	additional?: readonly string[];
}

const DEFAULT_SEGMENTS = new Set([
	'.git',
	'.swarm',
	'.env',
	'package.json',
	'package-lock.json',
	'bun.lock',
	'CHANGELOG.md',
	'.release-please-manifest.json',
	'release-please-config.json',
	'CODEOWNERS',
]);

const DEFAULT_PREFIXES = [
	'.github/workflows',
	'.github/CODEOWNERS',
	'src/sandbox',
	'src/hooks/guardrails',
	'src/security',
	'src/evaluation',
	'docs/releases',
	'tests/fixtures/evaluation',
] as const;

export function normalizeProtectedPath(value: string): string {
	return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function equalsOrDescendant(candidate: string, protectedPath: string): boolean {
	const left =
		process.platform === 'win32' ? candidate.toLowerCase() : candidate;
	const right =
		process.platform === 'win32' ? protectedPath.toLowerCase() : protectedPath;
	return left === right || left.startsWith(`${right}/`);
}

/** Central lexical policy; canonical containment remains caller-owned. */
export function isPolicyProtectedPath(
	filePath: string,
	options: ProtectedPathPolicyOptions = {},
): boolean {
	if (!filePath) return false;
	const normalized = normalizeProtectedPath(filePath);
	const segments = normalized.split('/').filter(Boolean);
	if (options.includeDefaults !== false) {
		if (
			segments.some((segment) =>
				DEFAULT_SEGMENTS.has(
					process.platform === 'win32' ? segment.toLowerCase() : segment,
				),
			)
		)
			return true;
		if (
			DEFAULT_PREFIXES.some((prefix) => equalsOrDescendant(normalized, prefix))
		)
			return true;
	}
	return (options.additional ?? []).some((entry) => {
		const protectedPath = normalizeProtectedPath(entry);
		if (!protectedPath) return false;
		if (equalsOrDescendant(normalized, protectedPath)) return true;
		if (protectedPath.includes('/')) return false;
		return segments.some(
			(segment) =>
				(process.platform === 'win32' ? segment.toLowerCase() : segment) ===
				(process.platform === 'win32'
					? protectedPath.toLowerCase()
					: protectedPath),
		);
	});
}

export function protectedRoots(
	projectRoot: string,
	additional: readonly string[] = [],
): string[] {
	return [...DEFAULT_PREFIXES, ...DEFAULT_SEGMENTS, ...additional].map(
		(entry) => path.resolve(projectRoot, entry),
	);
}
