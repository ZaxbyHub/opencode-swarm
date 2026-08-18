import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ToolContext } from '@opencode-ai/plugin';
import type { ToolResult } from './create-tool';
import { search, _internals as searchInternals } from './search';

// Helper to extract string from ToolResult
function resultToString(result: ToolResult): string {
	return typeof result === 'string' ? result : result.output;
}

// Helper to call tool execute with proper context
async function executeSearch(
	args: Record<string, unknown>,
	directory: string,
): Promise<string> {
	const result = await search.execute(args, {
		directory,
	} as unknown as ToolContext);
	return resultToString(result);
}

let tmpDir: string;
const realResolveRipgrepBinary = searchInternals.resolveRipgrepBinary;
const realRunExternalTool = searchInternals.runExternalTool;
const realFallbackSearch = searchInternals.fallbackSearch;

beforeEach(() => {
	tmpDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sdd-test-')));
	mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
});

afterEach(() => {
	searchInternals.resolveRipgrepBinary = realResolveRipgrepBinary;
	searchInternals.runExternalTool = realRunExternalTool;
	searchInternals.fallbackSearch = realFallbackSearch;
	try {
		rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		/* best effort */
	}
});

function createTestFile(relativePath: string, content: string): void {
	const fullPath = path.join(tmpDir, relativePath);
	mkdirSync(path.dirname(fullPath), { recursive: true });
	writeFileSync(fullPath, content);
}

// ============ Dot-directory include tests (#2212) ============

describe('search - dot-directory include patterns (#2212)', () => {
	it('fallback finds files in .swarm/ when include explicitly targets it', async () => {
		searchInternals.resolveRipgrepBinary = () => null;
		createTestFile(
			'.swarm/bundled-skills/brainstorm/SKILL.md',
			'# Brainstorm Skill\nPhase 1: Discovery\n',
		);
		createTestFile('src/app.ts', 'unrelated\n');

		const result = await executeSearch(
			{
				query: 'Brainstorm',
				include: '.swarm/bundled-skills/brainstorm/SKILL.md',
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.engine).toBe('fallback');
		expect(parsed.matches.length).toBeGreaterThan(0);
		expect(parsed.matches[0].file).toBe(
			'.swarm/bundled-skills/brainstorm/SKILL.md',
		);
	});

	// .claude is NOT in DEFAULT_SKIP_DIRS, so this tests the hidden-dir traversal path
	// (not the skip bypass). The .swarm/ test above covers the skip bypass.
	it('fallback finds files in .claude/skills/ when include explicitly targets it', async () => {
		searchInternals.resolveRipgrepBinary = () => null;
		createTestFile(
			'.claude/skills/writing-tests/SKILL.md',
			'# Writing Tests\n',
		);

		const result = await executeSearch(
			{
				query: 'Writing Tests',
				include: '.claude/skills/writing-tests/SKILL.md',
			},
			tmpDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.error).toBeUndefined();
		expect(parsed.engine).toBe('fallback');
		expect(parsed.matches.length).toBeGreaterThan(0);
		expect(parsed.matches[0].file).toBe(
			'.claude/skills/writing-tests/SKILL.md',
		);
	});

	it('fallback still skips .swarm/ by default when no include targets it', async () => {
		searchInternals.resolveRipgrepBinary = () => null;
		createTestFile('src/app.ts', 'SKIP_TEST_MARKER\n');
		createTestFile('.swarm/cache/output.txt', 'SKIP_TEST_MARKER\n');

		const result = await executeSearch({ query: 'SKIP_TEST_MARKER' }, tmpDir);
		const parsed = JSON.parse(result);
		const files = parsed.matches.map((m: { file: string }) => m.file);

		expect(files).toEqual(['src/app.ts']);
	});

	it('ripgrep receives path operands for exact dot-dir includes', async () => {
		createTestFile(
			'.swarm/bundled-skills/brainstorm/SKILL.md',
			'# Brainstorm\n',
		);
		let capturedArgs: string[] | undefined;
		searchInternals.resolveRipgrepBinary = () => '/usr/bin/rg';
		searchInternals.runExternalTool = async (opts: { args: string[] }) => {
			capturedArgs = opts.args;
			return {
				status: 'success' as const,
				stdout: '',
				stderr: '',
				exitCode: 1,
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		};

		await executeSearch(
			{
				query: '.*',
				mode: 'regex',
				include: '.swarm/bundled-skills/brainstorm/SKILL.md',
			},
			tmpDir,
		);

		expect(capturedArgs).toBeDefined();
		// Path operand should be the exact file, not '.'
		const dashDashIdx = capturedArgs!.indexOf('--');
		expect(capturedArgs![dashDashIdx + 2]).toBe(
			'.swarm/bundled-skills/brainstorm/SKILL.md',
		);
		// Should NOT contain --hidden or --no-ignore (path operands bypass filtering)
		expect(capturedArgs).not.toContain('--hidden');
		expect(capturedArgs).not.toContain('--no-ignore');
	});

	it('ripgrep does NOT add --hidden for non-dot-dir glob includes', async () => {
		createTestFile('src/app.ts', 'marker\n');
		let capturedArgs: string[] | undefined;
		searchInternals.resolveRipgrepBinary = () => '/usr/bin/rg';
		searchInternals.runExternalTool = async (opts: { args: string[] }) => {
			capturedArgs = opts.args;
			return {
				status: 'success' as const,
				stdout: '',
				stderr: '',
				exitCode: 1,
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		};

		await executeSearch({ query: 'marker', include: '*.ts' }, tmpDir);

		expect(capturedArgs).toBeDefined();
		expect(capturedArgs).not.toContain('--hidden');
		expect(capturedArgs).not.toContain('--no-ignore');
		// Should use '.' as path operand
		expect(capturedArgs![capturedArgs!.length - 1]).toBe('.');
	});

	it('ripgrep adds --hidden --no-ignore for glob includes targeting dot-dirs', async () => {
		createTestFile(
			'.swarm/bundled-skills/brainstorm/SKILL.md',
			'# Brainstorm\n',
		);
		let capturedArgs: string[] | undefined;
		searchInternals.resolveRipgrepBinary = () => '/usr/bin/rg';
		searchInternals.runExternalTool = async (opts: { args: string[] }) => {
			capturedArgs = opts.args;
			return {
				status: 'success' as const,
				stdout: '',
				stderr: '',
				exitCode: 1,
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		};

		await executeSearch(
			{ query: '.*', mode: 'regex', include: '.swarm/**/*.md' },
			tmpDir,
		);

		expect(capturedArgs).toBeDefined();
		expect(capturedArgs).toContain('--hidden');
		expect(capturedArgs).toContain('--no-ignore');
		// Should use '.' as path operand (glob-based search)
		expect(capturedArgs![capturedArgs!.length - 1]).toBe('.');
	});

	it('ripgrep rejects .git paths during path-operand promotion', async () => {
		createTestFile(
			'.git/config',
			'[remote "origin"]\n  url = https://token@github.com/org/repo\n',
		);
		let capturedArgs: string[] | undefined;
		searchInternals.resolveRipgrepBinary = () => '/usr/bin/rg';
		searchInternals.runExternalTool = async (opts: { args: string[] }) => {
			capturedArgs = opts.args;
			return {
				status: 'success' as const,
				stdout: '',
				stderr: '',
				exitCode: 1,
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		};

		await executeSearch(
			{ query: '.*', mode: 'regex', include: '.git/config' },
			tmpDir,
		);

		expect(capturedArgs).toBeDefined();
		// .git path should NOT be promoted to path operand — must use '.' with glob
		expect(capturedArgs![capturedArgs!.length - 1]).toBe('.');
		// Should NOT add --hidden/--no-ignore for .git paths (prevents traversal)
		expect(capturedArgs).not.toContain('--hidden');
		expect(capturedArgs).not.toContain('--no-ignore');
	});

	it('fallback does not un-skip .git even when include targets it', async () => {
		searchInternals.resolveRipgrepBinary = () => null;
		createTestFile(
			'.git/config',
			'[remote "origin"]\n  url = https://token@github.com/org/repo\n',
		);
		createTestFile('src/app.ts', 'unrelated\n');

		const result = await executeSearch(
			{ query: 'token', include: '.git/config' },
			tmpDir,
		);
		const parsed = JSON.parse(result);
		const files = parsed.matches.map((m: { file: string }) => m.file);

		// .git/ must remain blocked even with explicit include
		expect(files).not.toContain('.git/config');
	});

	it('ripgrep excludes .git when mixed with other dot-dir includes', async () => {
		createTestFile(
			'.swarm/bundled-skills/brainstorm/SKILL.md',
			'# Brainstorm\n',
		);
		createTestFile(
			'.git/config',
			'[remote "origin"]\n  url = https://token@github.com/org/repo\n',
		);
		let capturedArgs: string[] | undefined;
		searchInternals.resolveRipgrepBinary = () => '/usr/bin/rg';
		searchInternals.runExternalTool = async (opts: { args: string[] }) => {
			capturedArgs = opts.args;
			return {
				status: 'success' as const,
				stdout: '',
				stderr: '',
				exitCode: 1,
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		};

		await executeSearch(
			{
				query: '.*',
				mode: 'regex',
				include: '.swarm/bundled-skills/brainstorm/SKILL.md,.git/config',
			},
			tmpDir,
		);

		expect(capturedArgs).toBeDefined();
		// --hidden --no-ignore should be present (triggered by .swarm)
		expect(capturedArgs).toContain('--hidden');
		expect(capturedArgs).toContain('--no-ignore');
		// But .git must be excluded via negative glob to prevent traversal
		expect(capturedArgs).toContain('!.git');
	});

	it('ripgrep rejects .Git (case-variant) paths during promotion and flag injection', async () => {
		createTestFile(
			'.Git/config',
			'[remote]\n  url = https://token@github.com\n',
		);
		let capturedArgs: string[] | undefined;
		searchInternals.resolveRipgrepBinary = () => '/usr/bin/rg';
		searchInternals.runExternalTool = async (opts: { args: string[] }) => {
			capturedArgs = opts.args;
			return {
				status: 'success' as const,
				stdout: '',
				stderr: '',
				exitCode: 1,
				stdoutTruncated: false,
				stderrTruncated: false,
			};
		};

		await executeSearch(
			{ query: '.*', mode: 'regex', include: '.Git/config' },
			tmpDir,
		);

		expect(capturedArgs).toBeDefined();
		// .Git must NOT be promoted — should use '.' as path operand
		expect(capturedArgs![capturedArgs!.length - 1]).toBe('.');
		// Should NOT trigger --hidden/--no-ignore (case-insensitive .git check)
		expect(capturedArgs).not.toContain('--hidden');
		expect(capturedArgs).not.toContain('--no-ignore');
	});
});
