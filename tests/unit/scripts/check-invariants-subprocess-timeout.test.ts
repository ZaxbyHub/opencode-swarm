import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	checkSubprocessTimeout,
	scanSourceForSubprocessTimeouts,
} from '../../../scripts/check-invariants';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

describe('subprocess timeout invariant — issue #1028/#2479', () => {
	test('recognizes every supported direct and property-access spawn shape', () => {
		const source = [
			"import { spawn, execFile, exec } from 'node:child_process';",
			"import * as child_process from 'node:child_process';",
			"import * as cp from 'node:child_process';",
			"import { bunSpawn } from '../../../src/utils/bun-compat';",
			"import { runExternalTool } from '../../../src/utils/external-tool-runner';",
			"spawn('x', [], { timeout: 1 });",
			"child_process.spawnSync('x', [], { timeout: 1 });",
			"execFile('x', [], { timeout: 1 });",
			"cp.execFileSync('x', [], { timeout: 1 });",
			"exec('x', { timeout: 1 });",
			"cp.execSync('x', { timeout: 1 });",
			"bunSpawn(['x'], { timeout: 1 });",
			"runExternalTool({ executable: 'x', timeoutMs: 1 });",
		].join('\n');
		expect(scanSourceForSubprocessTimeouts('all.ts', source)).toEqual([]);
	});

	test('reports every supported imported subprocess API when its call has no timeout', () => {
		const source = [
			"import { spawn, execFile, exec } from 'node:child_process';",
			"import * as cp from 'node:child_process';",
			"import { bunSpawn } from '../../../src/utils/bun-compat';",
			"import { runExternalTool } from '../../../src/utils/external-tool-runner';",
			"spawn('x');",
			"cp.spawnSync('x');",
			"execFile('x');",
			"cp.execFileSync('x');",
			"exec('x');",
			"cp.execSync('x');",
			"bunSpawn(['x']);",
			"runExternalTool({ executable: 'x' });",
		].join('\n');
		expect(
			scanSourceForSubprocessTimeouts('all-unsafe.ts', source).map(
				(violation) => violation.callee,
			),
		).toEqual([
			'spawn',
			'spawnSync',
			'execFile',
			'execFileSync',
			'exec',
			'execSync',
			'bunSpawn',
			'runExternalTool',
		]);
	});

	test('reports each call locally despite comments, strings, or a safe sibling', () => {
		const source = [
			"import { spawn } from 'node:child_process';",
			"import * as child_process from 'node:child_process';",
			"import { runExternalTool } from '../../../src/utils/external-tool-runner';",
			'// spawn("comment", [], { timeout: 1 });',
			'const prose = \'execFileSync("string", [], { timeout: 1 })\';',
			"/unsafe/.exec('not a subprocess');",
			"spawn('safe', [], { timeout: 1 });",
			"child_process.spawn('unsafe', []);",
			"runExternalTool({ executable: 'unsafe' });",
		].join('\n');
		expect(scanSourceForSubprocessTimeouts('mixed.ts', source)).toEqual([
			{ line: 8, callee: 'spawn' },
			{ line: 9, callee: 'runExternalTool' },
		]);
	});

	test('covers Bun globals, DI seams, require, dynamic import, and spread-composed options', () => {
		const source = [
			"import { spawnSync } from 'node:child_process';",
			'const shared = { timeout: 1 };',
			"const cp = require('node:child_process');",
			"const { execSync: requiredExecSync } = require('node:child_process');",
			"const { spawn: dynamicSpawn } = await import('node:child_process');",
			"Bun.spawn(['safe'], { ...shared });",
			"_internals.spawnSync(['unsafe']);",
			"cp.execFileSync('unsafe');",
			"requiredExecSync('safe', { timeout: 1 });",
			"dynamicSpawn('unsafe');",
			"require('node:child_process').spawnSync('unsafe');",
			"(await import('node:child_process')).execFile('unsafe');",
		].join('\n');
		expect(scanSourceForSubprocessTimeouts('extended.ts', source)).toEqual([
			{ line: 7, callee: 'spawnSync' },
			{ line: 8, callee: 'execFileSync' },
			{ line: 10, callee: 'spawn' },
			{ line: 11, callee: 'spawnSync' },
			{ line: 12, callee: 'execFile' },
		]);
	});

	test('resolves object options passed through a local identifier and nested spreads', () => {
		const source = [
			'const timeoutOptions = { timeoutMs: 1 };',
			'const spawnOptions = { cwd: ".", ...timeoutOptions };',
			"Bun.spawn(['safe'], spawnOptions);",
			"Bun.spawn(['unsafe'], { ...{ cwd: '.' } });",
		].join('\n');
		expect(scanSourceForSubprocessTimeouts('options.ts', source)).toEqual([
			{ line: 4, callee: 'spawn' },
		]);
	});

	test('scans both production and test TypeScript while exempting bun-compat', () => {
		const root = canonicalMkdtemp('subprocess-timeout-scope-');
		roots.push(root);
		for (const relative of [
			'src/feature.ts',
			'src/feature.test.ts',
			'tests/unit/feature.test.ts',
			'src/utils/bun-compat.ts',
		]) {
			const file = path.join(root, ...relative.split('/'));
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(
				file,
				"import { spawn } from 'node:child_process';\nspawn('x', []);\n",
				'utf-8',
			);
		}
		const result = checkSubprocessTimeout(root);
		const warnings = result.messages.filter((line) =>
			line.startsWith('WARNING:'),
		);
		expect(warnings.some((line) => line.includes('src/feature.ts:2'))).toBe(
			true,
		);
		expect(
			warnings.some((line) => line.includes('src/feature.test.ts:2')),
		).toBe(true);
		expect(
			warnings.some((line) => line.includes('tests/unit/feature.test.ts:2')),
		).toBe(true);
		expect(warnings.some((line) => line.includes('bun-compat.ts'))).toBe(false);
		expect(result.violations).toBe(0);
	});
});
