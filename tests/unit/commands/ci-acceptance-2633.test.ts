/**
 * Issue #2633 acceptance checks for the CLI/report/help contracts.
 *
 * These checks are intentionally authored against the current pre-fix tree:
 * AC4, AC8, AC9, AC14, AC15, and AC16 are expected to fail until their
 * corresponding contracts are implemented. AC5, AC6, and AC13 preserve
 * behavior that already works on the pre-fix tree.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	DEFAULT_CI_DEADLINE_MS,
	handleCiCommand,
} from '../../../src/commands/ci.js';
import {
	type CommandContext,
	isCommandFailure,
} from '../../../src/commands/registry.js';
import { DEFAULT_QA_GATES } from '../../../src/db/qa-gate-profile.js';
import {
	canonicalTmpDir as canonicalProjectTempRoot,
} from '../../helpers/tmpdir.js';

function makeContext(directory: string, args: string[] = []): CommandContext {
	return {
		directory,
		args,
		sessionID: '',
		agents: {},
		source: 'cli',
	};
}

function makeViolationReport() {
	return {
		version: 1 as const,
		verdict: 'fail' as const,
		exit_reason: 'gate_violations' as const,
		gates: [
			{
				name: 'plan',
				status: 'fail' as const,
				detail: 'synthetic violation',
			},
		],
		tasks: [],
		plan: { present: false, task_count: 0 },
		environment: {
			mode: 'advisory' as const,
			tty: false,
			host: 'none' as const,
		},
		gate_profile: 'default' as const,
		effective_gates: { ...DEFAULT_QA_GATES },
		not_evaluated: [],
		not_evaluable: [],
		counts: { pass: 0, fail: 1, no_data: 0, corrupt: 0, error: 0 },
	};
}

function parseJsonBlock(text: string): Record<string, unknown> {
	const open = '[SWARM_CI_JSON]';
	const close = '[/SWARM_CI_JSON]';
	const start = text.indexOf(open);
	const end = text.indexOf(close);
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	expect(text.slice(0, start)).toBe('');
	expect(text.slice(end + close.length).trim()).toBe('');
	return JSON.parse(text.slice(start + open.length, end)) as Record<
		string,
		unknown
	>;
}

describe('issue #2633 CLI acceptance checks', () => {
	const realRuntime = _internals.runAdvisoryCiRuntime;

	afterEach(() => {
		_internals.runAdvisoryCiRuntime = realRuntime;
	});

	test('AC4: rejects a finite timeout above the supported maximum', async () => {
		let runtimeCalls = 0;
		_internals.runAdvisoryCiRuntime = async () => {
			runtimeCalls++;
			throw new Error('runtime must not be entered for invalid timeout');
		};

		await expect(
			handleCiCommand(
				makeContext(path.resolve(canonicalProjectTempRoot(), 'swarm-ci-ac4-over-limit'), [
					'--timeout-ms',
					String(DEFAULT_CI_DEADLINE_MS + 1),
				]),
			),
		).rejects.toThrow(/--timeout-ms/);
		expect(runtimeCalls).toBe(0);
	});

	test('AC4: forwards a normal finite timeout unchanged to the runtime', async () => {
		let capturedDeadline: number | undefined;
		_internals.runAdvisoryCiRuntime = async (options) => {
			capturedDeadline = options.deadlineMs;
			return {
				outcome: 'deadline',
				journal: [],
				journalTruncated: 0,
				cleanupRan: true,
				detail: 'synthetic deadline',
			};
		};

		await handleCiCommand(
			makeContext(path.resolve(canonicalProjectTempRoot(), 'swarm-ci-ac4-forward'), [
				'--timeout-ms',
				'1234.5',
			]),
		);
		expect(capturedDeadline).toBe(1234.5);
	});

	test('AC6: violations --json emits only the marker-bounded report and exit 1', async () => {
		const report = makeViolationReport();
		_internals.runAdvisoryCiRuntime = async () => ({
			outcome: 'violations',
			report,
			journal: [],
			journalTruncated: 0,
			cleanupRan: true,
		});

		const result = await handleCiCommand(
			makeContext(path.resolve(canonicalProjectTempRoot(), 'swarm-ci-ac6-json'), ['--json']),
		);
		expect(isCommandFailure(result)).toBe(true);
		if (!isCommandFailure(result)) return;
		expect(result.exitCode).toBe(1);
		expect(parseJsonBlock(result.text)).toEqual(report);
		expect(result.text).not.toContain('## Swarm CI Advisory Report');
	});

	test('AC5: a real top-level ci --json argv reaches dispatch and exit status', () => {
		const repoRoot = path.resolve(import.meta.dir, '../../..');
		const child = spawnSync(
			process.execPath,
			[path.join(repoRoot, 'src', 'cli', 'index.ts'), 'ci', '--json'],
			{
				cwd: repoRoot,
				encoding: 'utf8',
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 15_000,
			},
		);
		const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
		// The checkout has no guaranteed passing plan fixture. This pins the
		// real argv path, machine report, and honest violation exit code.
		expect(child.status).toBe(1);
		expect(output).toContain('[SWARM_CI_JSON]');
		expect(output).toContain('[/SWARM_CI_JSON]');
	});

	test('AC9: cancellation/deadline diagnostics do not echo the absolute evaluated path', async () => {
		const directory = path.resolve(
			canonicalProjectTempRoot(),
			'swarm-ci-ac9-directory-with-sensitive-name',
		);
		_internals.runAdvisoryCiRuntime = async () => ({
			outcome: 'deadline',
			journal: [{ seq: 1, type: 'run_started', detail: directory }],
			journalTruncated: 0,
			cleanupRan: true,
			detail: `deadline while evaluating ${directory}`,
		});

		const result = await handleCiCommand(makeContext(directory));
		expect(isCommandFailure(result)).toBe(true);
		if (!isCommandFailure(result)) return;
		expect(result.text).not.toContain(directory);
	});

	test('AC14: ci --help and run ci --help provide command-specific help', () => {
		const repoRoot = path.resolve(import.meta.dir, '../../..');
		const runCli = (args: string[]) =>
			spawnSync(
				process.execPath,
				[path.join(repoRoot, 'src/cli/index.ts'), ...args],
				{
					cwd: repoRoot,
					encoding: 'utf8',
					input: undefined,
					stdio: ['ignore', 'pipe', 'pipe'],
					timeout: 15_000,
				},
			);

		for (const args of [
			['ci', '--help'],
			['run', 'ci', '--help'],
		]) {
			const child = runCli(args);
			const output = `${child.stdout ?? ''}${child.stderr ?? ''}`;
			expect(child.status).toBe(0);
			expect(output).toContain('Advisory headless CI');
			expect(output).toContain('--timeout-ms');
			expect(output).toContain('--json');
		}

		const globalHelp = runCli(['--help']);
		expect(globalHelp.status).toBe(0);
		expect(`${globalHelp.stdout ?? ''}${globalHelp.stderr ?? ''}`).toContain(
			'Usage: bunx opencode-swarm [command] [OPTIONS]',
		);
	});

	test('AC15: docs numeric claims stay bound to the owning source constants', () => {
		const sourceRoot = path.resolve(import.meta.dir, '../../..');
		const ciSource = fs.readFileSync(
			path.join(sourceRoot, 'src', 'commands', 'ci.ts'),
			'utf8',
		);
		const evaluateSource = fs.readFileSync(
			path.join(sourceRoot, 'src', 'ci', 'evaluate.ts'),
			'utf8',
		);
		const runtimeSource = fs.readFileSync(
			path.join(sourceRoot, 'src', 'ci', 'runtime.ts'),
			'utf8',
		);
		const docs = fs.readFileSync(
			path.join(sourceRoot, 'docs', 'ci.md'),
			'utf8',
		);
		const driftCheck = fs.readFileSync(
			path.join(sourceRoot, 'scripts', 'drift-check-docs-claims.ts'),
			'utf8',
		);

		expect(ciSource).toMatch(/DEFAULT_CI_DEADLINE_MS\s*=\s*300_000/);
		expect(evaluateSource).toMatch(
			/MAX_SHADOW_COPY_BYTES\s*=\s*512\s*\*\s*1024\s*\*\s*1024/,
		);
		expect(runtimeSource).toMatch(
			/(?:journal|JOURNAL)[^\n]{0,120}(?:200|MAX_JOURNAL)/i,
		);
		expect(docs).toContain('300000');
		expect(docs).toContain('512 MiB');
		expect(docs).toContain('200 events');
		for (const sourceName of [
			'DEFAULT_CI_DEADLINE_MS',
			'MAX_SHADOW_COPY_BYTES',
			'MAX_CI_JOURNAL_EVENTS',
		]) {
			expect(driftCheck).toContain(`sourceName: '${sourceName}'`);
		}
		expect(evaluateSource).toMatch(/MAX_SHADOW_COPY_ENTRIES\s*=\s*100_000/);
		expect(docs).toContain('100000 entries');
		expect(driftCheck).toContain("sourceName: 'MAX_SHADOW_COPY_ENTRIES'");

		const mutation = `
const fs = require('node:fs');
const path = require('node:path');
const original = fs.readFileSync;
fs.readFileSync = function(file, ...args) {
  const value = original.call(this, file, ...args);
  return path.resolve(String(file)) === path.resolve('docs/ci.md')
    ? value.replace('100000 entries', '100001 entries')
    : value;
};
const { detectDocsClaimDrift } = await import('./scripts/drift-check-docs-claims.ts');
const findings = detectDocsClaimDrift(process.cwd());
const red = findings.filter((finding) =>
  finding.file === 'docs/ci.md' && finding.message.includes('MAX_SHADOW_COPY_ENTRIES'));
console.log(JSON.stringify(red));
fs.readFileSync = original;
if (red.length === 0) process.exit(1);
`;
		const driftMutation = spawnSync(
			process.execPath,
			['--smol', '-e', mutation],
			{
				cwd: sourceRoot,
				encoding: 'utf8',
				input: undefined,
				stdio: ['ignore', 'pipe', 'pipe'],
				timeout: 15_000,
			},
		);
		expect(driftMutation.status).toBe(0);
		expect(
			`${driftMutation.stdout ?? ''}${driftMutation.stderr ?? ''}`,
		).toContain('100001');
	});

	test('AC8: the CI barrel omits implementation-only constants and event internals', () => {
		const sourceRoot = path.resolve(import.meta.dir, '../../..');
		const barrel = fs.readFileSync(
			path.join(sourceRoot, 'src', 'ci', 'index.ts'),
			'utf8',
		);
		for (const internalName of [
			'MAX_SHADOW_COPY_BYTES',
			'CI_QUALITY_THRESHOLDS',
			'SWARM_CI_JSON_OPEN',
			'SWARM_CI_JSON_CLOSE',
			'CiRunEvent',
			'MAX_CI_JOURNAL_EVENTS',
		]) {
			expect(barrel).not.toContain(internalName);
		}
	});

	test('AC13: unknown flags retain the exact diagnostic contract', async () => {
		await expect(
			handleCiCommand(
				makeContext(path.resolve(canonicalProjectTempRoot(), 'swarm-ci-ac13'), ['--wat']),
			),
		).rejects.toThrow('Unknown flag: --wat');
	});

	test('AC16: docs disclose uncatchable process-death shadow residue', () => {
		const sourceRoot = path.resolve(import.meta.dir, '../../..');
		const docs = fs.readFileSync(
			path.join(sourceRoot, 'docs', 'ci.md'),
			'utf8',
		);
		expect(docs).toMatch(/(?:SIGKILL|host crash)/i);
		expect(docs).toMatch(/cannot be cleaned in-process/i);
		expect(docs).toMatch(
			/(?:OS temporary directory|operating system.*reclaim)/i,
		);
	});
});
