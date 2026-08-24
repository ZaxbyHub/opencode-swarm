/**
 * Adversarial coverage for the six entry points that were fixed to validate a
 * TRUSTED, absolute project root with `validateProjectDirectory` instead of
 * `validateDirectory` (issue #1619 follow-up).
 *
 * Why this file exists rather than more cases in the existing service tests:
 * those files mocked `validateDirectory` to a no-op precisely BECAUSE the real
 * one rejected the absolute temp directories they pass. A no-op mock proves
 * nothing about validation. Every test here runs the REAL validator against a
 * REAL absolute directory — the exact shape production uses — with no
 * `mock.module` anywhere.
 *
 * Each fixed site gets, at minimum:
 *   1. a success case with a realistic absolute project directory, and
 *   2. an adversarial case per rejection class (empty, traversal, control
 *      characters, relative).
 * Plus a containment proof (invariant 4) for the two paths that write.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// node:fs/promises, deliberately: several sibling files in tests/unit/services
// (diagnose-service*.test.ts, diagnose-sandbox.test.ts) replace `node:fs`
// process-wide with `existsSync: () => true` / `readdirSync: () => []`, and
// Bun's mock.module leaks across files in the shared runner. Asserting through
// node:fs/promises — which nothing mocks — keeps these containment checks
// honest in a multi-file run instead of order-dependent.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	type ContextBudgetReport,
	formatBudgetWarning,
	getContextBudgetReport,
	getDefaultConfig,
} from '../../../src/services/context-budget-service';
import {
	getRunMemorySummary,
	getTaskHistory,
	type RunMemoryEntry,
	recordOutcome,
	_internals as runMemoryInternals,
} from '../../../src/services/run-memory';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Rejection classes every fixed site must still refuse. `../` and the NUL byte
 * are the classic escapes; U+202E is a display-spoofing directional override;
 * a RELATIVE root is included because it resolves `.swarm/` against whatever
 * the host process cwd happens to be, which is the invariant-4 hazard the
 * absolute requirement exists to close.
 */
const UNSAFE_ROOTS: ReadonlyArray<
	[label: string, root: string, reason: string]
> = [
	['empty', '', 'empty'],
	['whitespace-only', '   ', 'empty'],
	['traversal', '/srv/app/../../etc', 'path traversal'],
	['windows traversal', 'C:\\app\\..\\..\\Windows', 'path traversal'],
	['NUL byte', '/srv/app\0/etc', 'control characters'],
	['RTL override', '/srv/\u202eapp', 'control characters'],
	['relative', 'src/services', 'absolute path'],
	['dot-relative', './workspace', 'absolute path'],
];

const WARNING_REPORT: ContextBudgetReport = {
	timestamp: '2026-08-10T00:00:00.000Z',
	systemPromptTokens: 1000,
	planCursorTokens: 0,
	knowledgeTokens: 0,
	runMemoryTokens: 0,
	handoffTokens: 0,
	contextMdTokens: 0,
	swarmTotalTokens: 1000,
	estimatedTurnCount: 3,
	estimatedSessionTokens: 3000,
	budgetPct: 80,
	status: 'warning',
	recommendation: null,
};

function entry(overrides: Partial<RunMemoryEntry> = {}): RunMemoryEntry {
	return {
		timestamp: '2026-08-10T00:00:00.000Z',
		taskId: '1.1',
		taskFingerprint: 'abc12345',
		agent: 'coder',
		outcome: 'fail',
		attemptNumber: 1,
		failureReason: 'compile error',
		...overrides,
	};
}

describe('trusted project-root validation at every fixed entry point', () => {
	let projectRoot: string;

	beforeEach(async () => {
		projectRoot = canonicalMkdtemp('trusted-root-');
		await fs.mkdir(path.join(projectRoot, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(projectRoot, { recursive: true, force: true });
	});

	/**
	 * The six fixed sites, each reduced to "call me with this root". Kept as one
	 * table so a new fixed site cannot be added without also getting every
	 * adversarial case below.
	 */
	const SITES: ReadonlyArray<
		[name: string, call: (root: string) => Promise<unknown>]
	> = [
		[
			'getContextBudgetReport',
			(root) =>
				getContextBudgetReport(root, 'system prompt', getDefaultConfig()),
		],
		[
			'formatBudgetWarning',
			(root) => formatBudgetWarning(WARNING_REPORT, root, getDefaultConfig()),
		],
		['recordOutcome', (root) => recordOutcome(root, entry())],
		['getTaskHistory', (root) => getTaskHistory(root, '1.1')],
		['getRunMemorySummary', (root) => getRunMemorySummary(root)],
	];

	test.each(
		SITES,
	)('%s succeeds with a realistic absolute project directory', async (_name, call) => {
		// Before the fix this threw "Invalid directory: Windows absolute path"
		// (or "absolute path" on POSIX) for EVERY real project root, and the
		// throw was swallowed by a debug-gated catch — the feature was dead.
		// Asserted as "did not throw" rather than on a return value because
		// recordOutcome resolves to void.
		let thrown: unknown = null;
		try {
			await call(projectRoot);
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeNull();
	});

	for (const [label, root, reason] of UNSAFE_ROOTS) {
		test.each(
			SITES,
		)(`%s still rejects an unsafe root (${label})`, async (_name, call) => {
			await expect(call(root)).rejects.toThrow(reason);
		});
	}

	test('rejection happens BEFORE any filesystem effect (fail-closed ordering)', async () => {
		// A traversal root pointed at a real sibling must not create, read or
		// truncate anything on the way to the throw.
		const sibling = canonicalMkdtemp('victim-');
		try {
			const victim = path.join(sibling, 'victim.txt');
			await fs.writeFile(victim, 'ORIGINAL', 'utf-8');
			// Built by concatenation, NOT path.join: join() normalizes the '..'
			// segments away, so a joined path carries no traversal for the
			// validator to catch. This is the string shape a caller would
			// actually pass through, and the reason the check is lexical.
			const traversalRoot = `${projectRoot}/../../escape`;

			await expect(recordOutcome(traversalRoot, entry())).rejects.toThrow(
				'path traversal',
			);
			await expect(
				getContextBudgetReport(traversalRoot, 'x', getDefaultConfig()),
			).rejects.toThrow('path traversal');

			expect(await fs.readFile(victim, 'utf-8')).toBe('ORIGINAL');
			expect(await fs.readdir(sibling)).toEqual(['victim.txt']);
		} finally {
			await fs.rm(sibling, { recursive: true, force: true });
		}
	});
});

describe('invariant 4 — activated write paths stay inside .swarm/', () => {
	let projectRoot: string;

	beforeEach(async () => {
		projectRoot = canonicalMkdtemp('containment-');
		await fs.mkdir(path.join(projectRoot, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		await fs.rm(projectRoot, { recursive: true, force: true });
	});

	test('recordOutcome writes only .swarm/run-memory.jsonl', async () => {
		await recordOutcome(projectRoot, entry());
		expect(await fs.readdir(projectRoot)).toEqual(['.swarm']);
		expect(await fs.readdir(path.join(projectRoot, '.swarm'))).toContain(
			'run-memory.jsonl',
		);
	});

	test('formatBudgetWarning writes only .swarm/session/budget-state.json', async () => {
		const warning = await formatBudgetWarning(
			WARNING_REPORT,
			projectRoot,
			getDefaultConfig(),
		);
		expect(warning).toContain('[SWARM INJECTION FOOTPRINT:');
		expect(await fs.readdir(projectRoot)).toEqual(['.swarm']);
		expect(
			await fs.readdir(path.join(projectRoot, '.swarm', 'session')),
		).toEqual(['budget-state.json']);
	});

	test('the round trip is real: the recorded entry is what the summarizer consumes', async () => {
		// Proves activation produces a real, well-formed artifact rather than
		// merely not throwing.
		//
		// The on-disk read goes through node:fs/promises and the summary through
		// the pure `_internals.summarizeTask`, deliberately NOT through
		// `getRunMemorySummary`: its reader (`readSwarmFileAsync` from
		// src/hooks/utils) is replaced process-wide by
		// tests/unit/services/diagnose-*.test.ts, so a reader-side assertion here
		// would pass alone and fail in a multi-file run. The reader-side coverage
		// lives in tests/unit/services/run-memory.test.ts.
		await recordOutcome(projectRoot, entry({ failureReason: 'compile error' }));

		const raw = await fs.readFile(
			path.join(projectRoot, '.swarm', 'run-memory.jsonl'),
			'utf-8',
		);
		const lines = raw.split('\n').filter((l) => l.trim() !== '');
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0] as string) as RunMemoryEntry;
		expect(parsed.taskId).toBe('1.1');
		expect(parsed.outcome).toBe('fail');
		expect(parsed.failureReason).toBe('compile error');

		const summary = runMemoryInternals.summarizeTask(parsed.taskId, [parsed]);
		expect(summary).toContain('compile error');
		expect(summary).toContain('Still failing');
	});
});
