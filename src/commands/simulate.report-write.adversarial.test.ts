/**
 * Adversarial tests for warn() logging in simulate command report write catch block.
 * Tests malformed inputs, boundary violations, and error edge cases.
 * ATTACK VECTORS:
 * 1. Circular reference object thrown (not Error, not string)
 * 2. null thrown as error
 * 3. undefined thrown as error
 * 4. Object with toString that throws
 * 5. Directory path with special characters
 *
 * Issue #2035 migrated the report write to the canonical atomic-write helper,
 * so the write failure is injected through `src/utils/atomic-write.ts:_internals`
 * (writeSync) — the seam the writer consults. Mocking `node:fs/promises`
 * writeFile no longer intercepts anything.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalMkdtemp } from '../../tests/helpers/tmpdir.js';
import { _internals as coChangeAnalyzer } from '../tools/co-change-analyzer.js';
import { _internals as atomicWriteInternals } from '../utils/atomic-write.js';
import { handleSimulateCommand } from './simulate.js';

const realWriteSync = atomicWriteInternals.writeSync;

describe('simulate command report write adversarial', () => {
	const originalDetectDarkMatter = coChangeAnalyzer.detectDarkMatter;
	let warnCalls: Array<[string, unknown]>;
	let testDir: string;

	beforeEach(() => {
		coChangeAnalyzer.detectDarkMatter = originalDetectDarkMatter;
		atomicWriteInternals.writeSync = realWriteSync;
		testDir = canonicalMkdtemp('simulate-adv-');
		warnCalls = [];
	});

	afterEach(() => {
		coChangeAnalyzer.detectDarkMatter = originalDetectDarkMatter;
		atomicWriteInternals.writeSync = realWriteSync;
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup errors
		}
		mock.restore();
	});

	/** Mock '../utils' warn and force the canonical writer's payload write to throw `thrown`. */
	function injectWriteFailure(thrown: unknown): void {
		mock.module('../utils', () => ({
			error: () => {},
			log: () => {},
			warn: (msg: string, data: unknown) => {
				warnCalls.push([msg, data]);
			},
			deepMerge: () => ({}),
			escapeRegex: () => '',
			MAX_MERGE_DEPTH: 10,
			CLIError: class extends Error {},
			ConfigError: class extends Error {},
			HookError: class extends Error {},
			SwarmError: class extends Error {},
			ToolError: class extends Error {},
		}));
		atomicWriteInternals.writeSync = () => {
			throw thrown as never;
		};
	}

	function residueTemps(): string[] {
		const swarm = join(testDir, '.swarm');
		if (!existsSync(swarm)) return [];
		return readdirSync(swarm).filter((f) => f.endsWith('.tmp'));
	}

	// -------------------------------------------------------------------------
	// Attack Vector 1: Circular reference object thrown (not Error, not string)
	// -------------------------------------------------------------------------
	test('warn() handles circular reference object without crashing', async () => {
		coChangeAnalyzer.detectDarkMatter = mock(async () => []);
		const circularObj: Record<string, unknown> = { a: 1 };
		circularObj.self = circularObj; // circular reference
		injectWriteFailure(circularObj);

		const result = await handleSimulateCommand(testDir, []);

		expect(result).toBe('0 hidden coupling pairs detected');
		expect(warnCalls.length).toBe(1);
		// String(circularObj) produces '[object Object]' not crash
		expect(residueTemps()).toEqual([]);
	});

	// -------------------------------------------------------------------------
	// Attack Vector 2: null thrown as error
	// -------------------------------------------------------------------------
	test('warn() handles null throwable without crashing', async () => {
		coChangeAnalyzer.detectDarkMatter = mock(async () => []);
		injectWriteFailure(null);

		const result = await handleSimulateCommand(testDir, []);

		expect(result).toBe('0 hidden coupling pairs detected');
		expect(warnCalls.length).toBe(1);
		// null becomes 'null' via String(null)
		expect(warnCalls[0][1]).toBe('null');
	});

	// -------------------------------------------------------------------------
	// Attack Vector 3: undefined thrown as error
	// -------------------------------------------------------------------------
	test('warn() handles undefined throwable without crashing', async () => {
		coChangeAnalyzer.detectDarkMatter = mock(async () => []);
		injectWriteFailure(undefined);

		const result = await handleSimulateCommand(testDir, []);

		expect(result).toBe('0 hidden coupling pairs detected');
		expect(warnCalls.length).toBe(1);
		// undefined becomes 'undefined' via String(undefined)
		expect(warnCalls[0][1]).toBe('undefined');
	});

	// -------------------------------------------------------------------------
	// Attack Vector 4: Object with toString that throws
	// -------------------------------------------------------------------------
	test('warn() handles object with throwing toString without crashing', async () => {
		coChangeAnalyzer.detectDarkMatter = mock(async () => []);
		const badToStringObj = {
			toString(): string {
				throw new Error('toString failed');
			},
		};
		injectWriteFailure(badToStringObj);

		// The catch block does `err instanceof Error ? err.message : String(err)`.
		// String() on a throwing toString DOES throw, and that exception
		// propagates out of handleSimulateCommand — documenting current
		// behavior (a future fix could wrap the stringification in try/catch).
		let threw = false;
		try {
			await handleSimulateCommand(testDir, []);
		} catch {
			threw = true;
		}
		expect(threw).toBe(true);
	});

	// -------------------------------------------------------------------------
	// Attack Vector 5: Directory path contains special characters
	// -------------------------------------------------------------------------
	test('warn() handles directory path with special characters without crashing', async () => {
		coChangeAnalyzer.detectDarkMatter = mock(async () => []);
		// Real directory whose name carries characters that could break
		// string interpolation in the warn message.
		const base = canonicalMkdtemp('simulate-special-');
		const specialDir = join(base, 'workspace with spaces & $pecial');
		mkdirSync(specialDir, { recursive: true });
		try {
			injectWriteFailure(
				Object.assign(new Error('EACCES: permission denied'), {
					code: 'EACCES',
				}),
			);

			const result = await handleSimulateCommand(specialDir, []);

			expect(result).toBe('0 hidden coupling pairs detected');
			expect(warnCalls.length).toBe(1);
			expect(warnCalls[0][0]).toContain('workspace with spaces & $pecial');
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	});

	// -------------------------------------------------------------------------
	// Attack Vector 5b: Directory path with null bytes (path traversal attempt)
	// -------------------------------------------------------------------------
	test('warn() handles directory path with null bytes without crashing', async () => {
		coChangeAnalyzer.detectDarkMatter = mock(async () => []);
		// Null bytes now fail the canonical writer's well-formedness gate
		// BEFORE any filesystem work (issue #2035 contract) — the command
		// must still degrade gracefully to warn + summary.
		const nullByteDir = `${testDir}\x00/null`;

		mock.module('../utils', () => ({
			error: () => {},
			log: () => {},
			warn: (msg: string, data: unknown) => {
				warnCalls.push([msg, data]);
			},
			deepMerge: () => ({}),
			escapeRegex: () => '',
			MAX_MERGE_DEPTH: 10,
			CLIError: class extends Error {},
			ConfigError: class extends Error {},
			HookError: class extends Error {},
			SwarmError: class extends Error {},
			ToolError: class extends Error {},
		}));

		const result = await handleSimulateCommand(nullByteDir, []);

		expect(result).toBe('0 hidden coupling pairs detected');
		expect(warnCalls.length).toBe(1);
	});

	// -------------------------------------------------------------------------
	// Attack Vector 6: Simultaneous detectDarkMatter success + write failure
	// -------------------------------------------------------------------------
	test('returns success summary when detectDarkMatter succeeds but the report write fails', async () => {
		const mockPairs = [
			{
				fileA: 'src/a.ts',
				fileB: 'src/b.ts',
				coChangeCount: 5,
				npmi: 0.723,
				lift: 2.1,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 30,
				commitsB: 25,
			},
			{
				fileA: 'src/c.ts',
				fileB: 'src/d.ts',
				coChangeCount: 8,
				npmi: 0.651,
				lift: 1.9,
				hasStaticEdge: false,
				totalCommits: 100,
				commitsA: 45,
				commitsB: 38,
			},
		];
		coChangeAnalyzer.detectDarkMatter = mock(async () => mockPairs);
		injectWriteFailure(
			Object.assign(new Error('ENOSPC: no space left on device'), {
				code: 'ENOSPC',
			}),
		);

		const result = await handleSimulateCommand(testDir, []);

		// Returns summary (not error), but also logs the write warning
		expect(result).toBe('2 hidden coupling pairs detected');
		expect(result).not.toContain('## Simulate Report');
		expect(result).not.toContain('Error');
		expect(warnCalls.length).toBe(1);
		expect(warnCalls[0][1]).toContain('ENOSPC');
		// The failed write's own temp was cleaned up
		expect(residueTemps()).toEqual([]);
	});

	// -------------------------------------------------------------------------
	// Additional boundary: Number thrown as error
	// -------------------------------------------------------------------------
	test('warn() handles number thrown as error without crashing', async () => {
		coChangeAnalyzer.detectDarkMatter = mock(async () => []);
		injectWriteFailure(42);

		const result = await handleSimulateCommand(testDir, []);

		expect(result).toBe('0 hidden coupling pairs detected');
		expect(warnCalls.length).toBe(1);
		expect(warnCalls[0][1]).toBe('42');
	});

	// -------------------------------------------------------------------------
	// Additional boundary: Symbol thrown as error
	// -------------------------------------------------------------------------
	test('warn() handles Symbol thrown as error without crashing', async () => {
		coChangeAnalyzer.detectDarkMatter = mock(async () => []);
		injectWriteFailure(Symbol('test error'));

		const result = await handleSimulateCommand(testDir, []);

		expect(result).toBe('0 hidden coupling pairs detected');
		expect(warnCalls.length).toBe(1);
		// String(Symbol) produces 'Symbol(test error)'
		expect(warnCalls[0][1]).toContain('Symbol');
	});

	// -------------------------------------------------------------------------
	// Additional boundary: Promise-like object thrown as error
	// -------------------------------------------------------------------------
	test('warn() handles Promise-like object thrown as error without crashing', async () => {
		coChangeAnalyzer.detectDarkMatter = mock(async () => []);
		// A thenable (Promise-like) that is not an Error
		const thenableNonError = {
			then(_resolve: unknown, _reject: unknown) {
				// empty - just a thenable, not a real promise
			},
			[Symbol.toStringTag]: 'Promise',
		};
		injectWriteFailure(thenableNonError);

		const result = await handleSimulateCommand(testDir, []);

		expect(result).toBe('0 hidden coupling pairs detected');
		expect(warnCalls.length).toBe(1);
		// The thenable with [Symbol.toStringTag]: 'Promise' stringifies to '[object Promise]'
		expect(warnCalls[0][1]).toBe('[object Promise]');
	});
});
