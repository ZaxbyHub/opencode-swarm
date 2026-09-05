import { describe, expect, test } from 'bun:test';
import {
	SEED_HELPER_CALLEE_PATTERN,
	scanSourceForBareSpawn,
} from '../../../scripts/check-bare-executable-spawn';

/**
 * Issue #2476 AC4 / source issue #2266: the three scanner blind spots —
 * aliased callee (`getExecFileAsync()('git', …)`), wrapper callee
 * (`spawnSyncWithTransientRetry('git', …)`), and src/ callers of
 * `__seed*ForTests` — must now be flagged.
 */
describe('scanSourceForBareSpawn blind-spot forms (#2476 AC4)', () => {
	test('flags an aliased callee: getExecFileAsync()("git", ...) [co-change-analyzer shape]', () => {
		const src = [
			"import * as child_process from 'node:child_process';",
			"import { promisify } from 'node:util';",
			'',
			'function getExecFileAsync() {',
			'	return promisify(child_process.execFile);',
			'}',
			'',
			'export async function run(): Promise<void> {',
			"	await getExecFileAsync()('git', ['log', '-n1'], { timeout: 10_000 });",
			'}',
		].join('\n');
		const violations = scanSourceForBareSpawn('src/probe/aliased.ts', src);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.form).toBe('aliased-callee');
		expect(violations[0]?.executable).toBe('git');
		expect(violations[0]?.line).toBe(9);
	});

	test('flags a wrapper callee: local wrapper forwarding its first param to spawnSync [pr.ts shape]', () => {
		const src = [
			"import * as child_process from 'node:child_process';",
			'',
			'function spawnSyncWithTransientRetry(',
			'	command: string,',
			'	args: string[],',
			'	options?: { cwd?: string },',
			') {',
			'	return child_process.spawnSync(command, args, options);',
			'}',
			'',
			'export function run(): void {',
			"	spawnSyncWithTransientRetry('git', ['status'], { cwd: '.' });",
			'}',
		].join('\n');
		const violations = scanSourceForBareSpawn('src/probe/wrapper.ts', src);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.form).toBe('wrapper-callee');
		expect(violations[0]?.executable).toBe('git');
	});

	test('flags a const-arrow wrapper the same way', () => {
		const src = [
			"import { spawn } from 'node:child_process';",
			'',
			'const runTool = (bin: string, args: string[]) => spawn(bin, args);',
			'',
			'export function go(): void {',
			"	runTool('gh', ['pr', 'view']);",
			'}',
		].join('\n');
		const violations = scanSourceForBareSpawn('src/probe/arrow.ts', src);
		expect(violations.some((v) => v.form === 'wrapper-callee')).toBe(true);
	});

	test('flags a src/ caller of __seedGhBinaryForTests', () => {
		const src = [
			"import { __seedGhBinaryForTests } from './tools/gh-evidence.js';",
			'',
			'export function warmup(): void {',
			"	__seedGhBinaryForTests('C:/fixture/gh.exe');",
			'}',
		].join('\n');
		const violations = scanSourceForBareSpawn('src/seed-caller.ts', src);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.form).toBe('seed-helper-call');
		expect(violations[0]?.executable).toBe('__seedGhBinaryForTests');
	});

	test('does NOT flag a seed-helper DEFINITION or doc-comment mention', () => {
		const src = [
			'/**',
			' * `__seedGhBinaryForTests` is a TEST-ONLY seam — see also',
			' * `__seedGitExecutableForTests`.',
			' */',
			'export function __seedGhBinaryForTests(value: string | null): void {',
			'	pin(value);',
			'}',
		].join('\n');
		expect(scanSourceForBareSpawn('src/tools/gh-evidence.ts', src)).toEqual([]);
	});

	test('does NOT flag an availability probe whose inner spawn uses an unrelated literal', () => {
		// The param-position rule: isCommandAvailable forwards its param, but
		// the inner spawn feeds a DIFFERENT literal — the function is not a
		// bare-spawn wrapper for our purposes.
		const src = [
			"import { spawnSync } from 'node:child_process';",
			'',
			'function isCommandAvailable(bin: string): boolean {',
			"	const r = spawnSync('where', [bin]);",
			'	return r.status === 0;',
			'}',
			'',
			'export function go(): void {',
			"	isCommandAvailable('git');",
			'}',
		].join('\n');
		expect(scanSourceForBareSpawn('src/probe/avail.ts', src)).toEqual([]);
	});

	test('does NOT flag a resolver-routed variable executable', () => {
		const src = [
			"import { spawnSync } from 'node:child_process';",
			"import { resolveGitExecutable } from './git-executable.js';",
			'',
			'export function go(): void {',
			'	spawnSync(resolveGitExecutable(), ["status"]);',
			'}',
		].join('\n');
		expect(scanSourceForBareSpawn('src/probe/routed.ts', src)).toEqual([]);
	});

	test('SEED_HELPER_CALLEE_PATTERN matches the shipped seed helpers only', () => {
		expect(SEED_HELPER_CALLEE_PATTERN.test('__seedGhBinaryForTests')).toBe(
			true,
		);
		expect(SEED_HELPER_CALLEE_PATTERN.test('__seedGitExecutableForTests')).toBe(
			true,
		);
		expect(SEED_HELPER_CALLEE_PATTERN.test('__seedGhExecutableForTests')).toBe(
			true,
		);
		expect(SEED_HELPER_CALLEE_PATTERN.test('seedThing')).toBe(false);
		expect(SEED_HELPER_CALLEE_PATTERN.test('__seededField')).toBe(false);
	});

	test('control: the original direct-literal form still fires (scanner sanity)', () => {
		const src =
			"import { spawnSync } from 'node:child_process';\nspawnSync('git', ['status']);\n";
		const violations = scanSourceForBareSpawn('src/probe/direct.ts', src);
		expect(violations).toHaveLength(1);
		expect(violations[0]?.form).toBe('first-arg');
	});
});
