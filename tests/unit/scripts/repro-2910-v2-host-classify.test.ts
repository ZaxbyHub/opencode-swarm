/**
 * Issue #2910 residual scope item 1 — pure-classification harness tests for
 * scripts/repro-2910-v2-host.mjs's exported classifyHostRun (round-2
 * amendment). frozen as PRESERVING check C29 (manifest row + AC28): this
 * file pins the repro script's OWN decision rules so a future refactor of
 * the evidence gating cannot silently reopen the round-2 hole.
 *
 * THE ROUND-2 HOLE (case a): the script used to derive its verdict only
 * from auth-free evidence lines, so a host that emitted full load evidence
 * and then HUNG to the 120s kill still printed result=PASS. A timeout is
 * now an UNCONDITIONAL failure inside classifyHostRun.
 *
 * The module import at the top is INERT by design — the script guards
 * main() behind invokedAsMain() (prefers Bun's import.meta.main when it is
 * a boolean, else entry-URL comparison, which works under Node where
 * import.meta.main is undefined) — so importing it here neither installs
 * the pinned host nor runs it. The source-shape test at the bottom pins
 * that guard.
 *
 * classifyHostRun contract ({ timedOut, exitCode, output, swarmDirExists,
 * priorFailures? } -> { pass, reasons }): timeout ALWAYS fails;
 * priorFailures (install/binary) fail; each missing auth-free evidence
 * condition fails (loading-plugin line naming local-v2-smoke.js, the
 * /[opencode-swarm] running v/ banner, an agent.updated/command.updated
 * event line, .swarm/ materialization); exitCode alone NEVER fails — an
 * AUTH-ERROR exit (1) with full evidence passes, because every evidence
 * condition is auth-free by design (CI has no model auth).
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error JavaScript CLI module intentionally has no declaration file.
import { classifyHostRun } from '../../../scripts/repro-2910-v2-host.mjs';

/** Host output fixture carrying EVERY auth-free evidence condition. */
const FULL_EVIDENCE_OUTPUT = [
	'[opencode] loading plugin file:///tmp/repro-2910-v2-host-scratch-abc/proj/.opencode/plugins/local-v2-smoke.js',
	'[opencode-swarm] running v7.9.9',
	'event.type=agent.updated',
	'event.type=command.updated',
].join('\n');

const FULL_INPUT = {
	timedOut: false,
	exitCode: 0,
	output: FULL_EVIDENCE_OUTPUT,
	swarmDirExists: true,
} as const;

describe('repro-2910-v2-host classifyHostRun decision rules', () => {
	test('(a) round-2 hole: timedOut with FULL evidence still FAILS', () => {
		const verdict = classifyHostRun({
			...FULL_INPUT,
			timedOut: true,
			exitCode: 1,
		});
		expect(verdict.pass).toBe(false);
		expect(verdict.reasons).toContain('host run timed out');
	});

	test('(b) auth-error exit (exitCode 1) with full evidence PASSES', () => {
		const verdict = classifyHostRun({
			...FULL_INPUT,
			exitCode: 1,
		});
		expect(verdict.pass).toBe(true);
		expect(verdict.reasons).toEqual([]);
	});

	test('(c) missing banner FAILS with the banner reason', () => {
		const output = FULL_EVIDENCE_OUTPUT.split('\n')
			.filter((ln) => !ln.includes('[opencode-swarm] running v'))
			.join('\n');
		const verdict = classifyHostRun({ ...FULL_INPUT, output });
		expect(verdict.pass).toBe(false);
		expect(verdict.reasons).toContain(
			'no /[opencode-swarm] running v/ banner in the host output',
		);
	});

	test('(d) zero registration event lines FAILS with the event reason', () => {
		const output = FULL_EVIDENCE_OUTPUT.split('\n')
			.filter((ln) => !ln.startsWith('event.type='))
			.join('\n');
		const verdict = classifyHostRun({ ...FULL_INPUT, output });
		expect(verdict.pass).toBe(false);
		expect(verdict.reasons).toContain(
			'no agent.updated or command.updated event line in the host output',
		);
	});

	test('(e) no .swarm dir FAILS with the swarm-dir reason', () => {
		const verdict = classifyHostRun({ ...FULL_INPUT, swarmDirExists: false });
		expect(verdict.pass).toBe(false);
		expect(verdict.reasons).toContain(
			'.swarm/ not materialized under the project dir',
		);
	});

	test('(f) clean exit 0 with full evidence PASSES', () => {
		const verdict = classifyHostRun({ ...FULL_INPUT });
		expect(verdict.pass).toBe(true);
		expect(verdict.reasons).toEqual([]);
	});

	test('main() is entry-guarded: importing the script is inert under both node and bun', () => {
		const source = readFileSync(
			path.resolve(import.meta.dir, '../../../scripts/repro-2910-v2-host.mjs'),
			'utf8',
		);
		// Bun's import.meta.main is honored when present (boolean), and the
		// Node fallback compares the entry URL — a bare `if (import.meta.main)`
		// would be falsy under Node and break `node scripts/repro-2910-v2-host.mjs`.
		expect(source).toContain('function invokedAsMain()');
		expect(source).toContain("typeof import.meta.main === 'boolean'");
		expect(source).toContain('if (invokedAsMain()) {');
		// Behavioral half: this file's top-level import already proved the
		// module is importable without launching the install/run flow —
		// classifyHostRun itself must be the pure, spawn-free export.
		expect(typeof classifyHostRun).toBe('function');
	});
});
