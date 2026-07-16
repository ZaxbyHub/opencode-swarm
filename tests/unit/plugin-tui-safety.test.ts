import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dir, '../..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');
const RAW_CONSOLE = /console\.(warn|error|log)\(/;
const INLINE_RATIONALE = /biome-ignore lint\/suspicious\/noConsole:\s*\S/;
const IMPLEMENTATION_EXEMPTIONS = new Set([
	'src/utils/logger.ts',
	'src/services/warning-buffer.ts',
]);

function toRepoPath(file: string): string {
	return path.relative(REPO_ROOT, file).replaceAll('\\', '/');
}

function productionSourceFiles(directory = SRC_ROOT): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name !== '__tests__')
				files.push(...productionSourceFiles(absolute));
			continue;
		}
		if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
			files.push(absolute);
		}
	}
	return files.sort();
}

function rawConsoleViolations(source: string): number[] {
	const lines = source.split(/\r?\n/);
	const violations: number[] = [];
	for (let index = 0; index < lines.length; index += 1) {
		if (!RAW_CONSOLE.test(lines[index])) continue;
		if (!INLINE_RATIONALE.test(lines[index - 1] ?? '')) {
			violations.push(index + 1);
		}
	}
	return violations;
}

function readRepoFile(file: string): string {
	return readFileSync(path.join(REPO_ROOT, file), 'utf8');
}

function isAllowedNoConsoleOverride(pattern: string): boolean {
	return (
		pattern === 'src/cli/**' ||
		IMPLEMENTATION_EXEMPTIONS.has(pattern) ||
		pattern.startsWith('tests/') ||
		pattern.startsWith('test/') ||
		pattern.endsWith('.test.ts') ||
		pattern.includes('/__tests__/')
	);
}

describe('Plugin TUI safety', () => {
	test('full production src scan requires an inline rationale for every raw console call', () => {
		const scanned = productionSourceFiles();
		expect(scanned.length).toBeGreaterThan(200);
		expect(scanned.map(toRepoPath)).toContain('src/index.ts');

		const violations: string[] = [];
		for (const file of scanned) {
			const repoPath = toRepoPath(file);
			if (
				repoPath.startsWith('src/cli/') ||
				IMPLEMENTATION_EXEMPTIONS.has(repoPath)
			) {
				continue;
			}
			for (const line of rawConsoleViolations(readFileSync(file, 'utf8'))) {
				violations.push(`${repoPath}:${line}`);
			}
		}

		expect(violations).toEqual([]);
	});

	test('raw-console detector rejects an unannotated call and accepts a reasoned exception', () => {
		expect(rawConsoleViolations("console.warn('unsafe');")).toEqual([1]);
		expect(
			rawConsoleViolations(
				"// biome-ignore lint/suspicious/noConsole: test-only reason\nconsole.warn('guarded');",
			),
		).toEqual([]);
	});

	test('Biome noConsole exemptions are limited to tests, CLI, and logger implementations', () => {
		const biome = JSON.parse(readRepoFile('biome.json')) as {
			overrides?: Array<{
				includes?: string[];
				linter?: { rules?: { suspicious?: { noConsole?: string } } };
			}>;
		};
		const forbidden = (biome.overrides ?? [])
			.filter(
				(override) => override.linter?.rules?.suspicious?.noConsole === 'off',
			)
			.flatMap((override) => override.includes ?? [])
			.filter((pattern) => !isAllowedNoConsoleOverride(pattern));
		expect(forbidden).toEqual([]);
	});

	test('no SIGINT or SIGTERM handler registrations are introduced', () => {
		const indexSource = readRepoFile('src/index.ts');
		for (const method of [
			'process.once',
			'process.on',
			'process.addListener',
		]) {
			for (const signal of ['SIGINT', 'SIGTERM']) {
				expect(indexSource).not.toContain(`${method}('${signal}'`);
				expect(indexSource).not.toContain(`${method}("${signal}"`);
			}
		}
	});

	test('command registry never writes raw console output mid-turn', () => {
		const registry = readRepoFile('src/commands/registry.ts');
		expect(registry.match(/console\.(warn|error|log)\(/g) ?? []).toEqual([]);
	});

	test('gitignore warning keeps exactly one documented always-visible security warning', () => {
		const source = readRepoFile('src/utils/gitignore-warning.ts');
		expect(source.match(/console\.warn\(/g) ?? []).toHaveLength(1);
		expect(source).toContain('intentionally always emitted as raw');
		expect(rawConsoleViolations(source)).toEqual([]);
	});
});
