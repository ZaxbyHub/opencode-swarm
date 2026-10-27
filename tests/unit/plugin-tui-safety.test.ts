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

	test('init path (#3405): ownership hints carry no raw console leg and keep their advisory legs', () => {
		const source = readRepoFile('src/index.ts');
		// Statement-anchored absence pin: a comment naming the call cannot
		// satisfy it. The scan covers EVERY console method (warn, error,
		// log, info, debug, trace — debug and trace are NOT covered by the
		// repo's console.(warn|error|log) rationale scan, and under the
		// Node sidecar console.trace writes to stderr), the
		// bracket-notated form, and both raw process streams, in the
		// `if (...)` / trailing-comment / multi-line call shapes.
		// Residual (disclosed): this SOURCE scan cannot see an emitter whose
		// method is reached indirectly — an aliased binding (`const w =
		// console.warn; w(hint)`) or a bracket-notated process stream
		// (`process["stdout"]["write"](hint)`). The boot-suite capture is
		// the backstop for an alias bound at CALL time; an IMPORT-time
		// binding (captured before the capture installs) defeats both
		// layers, and no test can observe it.
		const RAW_HINT_EMITTER =
			/(?:console\.\w+|console\s*\[\s*['"](?:warn|error|log|info|debug|trace)['"]\s*\]|process\.(?:stdout|stderr)\.write)\s*\([\s\S]{0,240}?\b(?:redirectHint|failClosedHint)\b/;
		expect(RAW_HINT_EMITTER.test(source)).toBe(false);
		// Retention: the buffered advisory legs must survive any future edit
		// that touches these branches (partial-deletion mutant must fail).
		expect(/^\s*advisoryWarn\(redirectHint\);/m.test(source)).toBe(true);
		expect(/^\s*advisoryWarn\(failClosedHint\);/m.test(source)).toBe(true);
	});

	test('init path (#3405): the version banner warn exists exactly once and is gated by the opt-in env var', () => {
		const source = readRepoFile('src/index.ts');
		const lines = source.split(/\r?\n/);
		const bannerWarnLines: number[] = [];
		for (let i = 0; i < lines.length; i += 1) {
			if (/^\s*console\.warn\(/.test(lines[i]) && /running v/.test(lines[i])) {
				bannerWarnLines.push(i);
			}
		}
		// The opt-in leg legitimately exists — this is a block-aware pin, not
		// an absence check.
		expect(bannerWarnLines).toHaveLength(1);
		const windowStart = Math.max(0, bannerWarnLines[0] - 8);
		const gateWindow = lines.slice(windowStart, bannerWarnLines[0]).join('\n');
		// Statement-anchored: the gate must appear as CODE. A comment that
		// merely names the env var cannot satisfy this pattern.
		expect(
			/^\s*if\s*\(\s*process\.env\.OPENCODE_SWARM_VERSION_BANNER\s*===\s*'1'\s*\)\s*\{\s*$/m.test(
				gateWindow,
			),
		).toBe(true);
	});
});
