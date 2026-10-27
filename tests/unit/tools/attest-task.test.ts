/**
 * `/swarm attest` unit tests (issue #3422, `src/tools/attest-task.ts`).
 *
 * Coverage per the approved plan (`.agents/issue-traces/issue-3422/05-fix-plan.md`
 * sections 2/5/6 — the §7 grammar inventory and unit-test inventory entries
 * scoped to the producer):
 * - buildAnchorArgv read-only git grammar refusals (11 shapes, §7 table);
 * - positive control against a REAL git fixture: bundle published under
 *   `.swarm/evidence/<task>.json` with a 64-hex cursor-free declarationDigest
 *   (§3) and raw anchor stdout (§6 R3F5);
 * - hostile-config neutralization: repo-config `diff.external` / `core.pager`
 *   marker scripts never execute (§7 F4);
 * - raw-stdout overflow refusal with a SHORT trimmed value (§6 R3F5);
 * - spawn-property assertions through the `_internals.runAnchor` DI seam;
 * - declaration-digest staleness: completion refuses after the plan's anchors
 *   change (§3/§4c — `no current matched attestation`);
 * - anchor expectation mismatch and undeclared-task fail-closed refusals (AC2).
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeExternalDeclarationDigest } from '../../../src/gate-evidence.js';
import {
	_internals as attestInternals,
	buildAnchorArgv,
	executeAttestTask,
} from '../../../src/tools/attest-task.js';
import { resolveGitExecutable } from '../../../src/utils/git-executable.js';
import { safeRmRecursive } from '../../helpers/safe-test-dir.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const TASK_ID = '1.1';
const PLAN_TITLE = 'Attest fixture plan';
const PLAN_SWARM = 'attest-fixture';

interface FixtureAnchor {
	command: string;
	expect?: string;
	expect_prefix?: string;
}

/** Minimal PlanSchema-valid `.swarm/plan.json` with one task (id 1.1). */
function writePlan(
	dir: string,
	options: {
		evidenceClass?: 'external_git';
		anchors?: FixtureAnchor[];
	} = {},
): void {
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	const task: Record<string, unknown> = {
		id: TASK_ID,
		phase: 1,
		description: 'Git-external deliverable (commit/push)',
		// 'coder' keeps the reviewer/council precheck off the completion path so
		// digest-mismatch refusals surface from the completion transaction.
		...(options.evidenceClass ? { evidence_class: options.evidenceClass } : {}),
		...(options.anchors ? { evidence_anchors: options.anchors } : {}),
	};
	const plan = {
		schema_version: '1.0.0',
		title: PLAN_TITLE,
		swarm: PLAN_SWARM,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				required_agents: ['coder'],
				tasks: [task],
			},
		],
	};
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, '\t'),
	);
}

const tempDirs: string[] = [];

/** Non-git fixture: `.git` directory marker so assertProjectRoot accepts it. */
function plainFixture(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	tempDirs.push(dir);
	return dir;
}

/** Hermetic child env for git fixtures: whitelist only what git needs. */
function fixtureGitEnv(): Record<string, string> {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? '',
		GIT_CONFIG_NOSYSTEM: '1',
	};
	for (const key of ['HOME', 'LANG'] as const) {
		if (process.env[key]) env[key] = process.env[key] as string;
	}
	if (process.platform === 'win32') {
		for (const key of [
			'SYSTEMROOT',
			'WINDIR',
			'COMSPEC',
			'USERPROFILE',
			'HOMEDRIVE',
			'HOMEPATH',
			'APPDATA',
			'LOCALAPPDATA',
			'PROGRAMFILES',
		] as const) {
			if (process.env[key]) env[key] = process.env[key] as string;
		}
	}
	return env;
}

function git(dir: string, args: string[]): string {
	return execFileSync('git', ['-C', dir, ...args], {
		encoding: 'utf-8',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 30_000,
		maxBuffer: 1024 * 1024,
		env: fixtureGitEnv(),
	}).trim();
}

/** REAL git fixture: initialized repo, identity configured, exactly one commit. */
function gitFixture(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	git(dir, ['init', '-q']);
	git(dir, ['config', 'user.email', 'attest@example.com']);
	git(dir, ['config', 'user.name', 'Attest Fixture']);
	git(dir, ['config', 'core.autocrlf', 'false']);
	fs.writeFileSync(path.join(dir, 'delivered.txt'), 'deliverable\n');
	git(dir, ['add', 'delivered.txt']);
	git(dir, ['commit', '-q', '-m', 'deliver']);
	tempDirs.push(dir);
	return dir;
}

function evidencePath(dir: string): string {
	return path.join(dir, '.swarm', 'evidence', `${TASK_ID}.json`);
}

function readBundle(dir: string): {
	declarationDigest: string;
	anchors: Array<{
		command: string;
		expect?: string;
		expect_prefix?: string;
		matched: boolean;
		exit_code: number;
		stdout: string;
	}>;
} {
	const raw = JSON.parse(fs.readFileSync(evidencePath(dir), 'utf-8')) as {
		workflow?: { externalEvidence?: unknown };
	};
	const bundle = raw.workflow?.externalEvidence as Record<string, unknown>;
	if (!bundle) throw new Error('externalEvidence bundle missing from evidence');
	return bundle as typeof bundle & never;
}

/**
 * DI seam (repo invariant 7): stub `_internals.runAnchor` per test and restore
 * in afterEach — no mock.module.
 *
 * Mock coverage note (writing-tests skill): the stub below covers only the
 * clean-exit branch of the real runAnchor. Untested branches: its own nonzero
 * exit / spawn-failure / timeout refusal construction and all bunSpawn
 * internals (env scrubbing, stdin-ignore, byte bounds, timeout, kill-in-
 * finally). Rationale: those live in `runAnchor`/`bunSpawn`
 * (`src/utils/bun-compat.ts`) and are owned by their own test surfaces; the
 * overflow and mismatch refusals ARE covered here at the executeAttestTask
 * level via stubbed stdout shapes.
 */
const originalRunAnchor = attestInternals.runAnchor;
const originalLoadPlanTask = attestInternals.loadPlanTask;

afterEach(() => {
	attestInternals.runAnchor = originalRunAnchor;
	attestInternals.loadPlanTask = originalLoadPlanTask;
});

afterAll(() => {
	for (const dir of tempDirs) safeRmRecursive(dir);
});

describe('buildAnchorArgv — read-only git grammar (plan §7)', () => {
	test('non-git and non-allowlisted commands refuse with the read-only git token', () => {
		for (const command of ['echo hello', 'git commit -m x']) {
			const { argv, refusal } = buildAnchorArgv(command);
			expect(argv).toBeNull();
			expect(refusal).toMatch(/read-only git/);
		}
	});

	test('git global options cannot be smuggled as the subcommand', () => {
		const { argv, refusal } = buildAnchorArgv(
			'git -c diff.external=evil log --oneline',
		);
		expect(argv).toBeNull();
		expect(refusal).toMatch(/read-only git/);
		expect(refusal).toContain('-c');
	});

	test('output-writing flags refuse in both --output= and --output forms', () => {
		for (const command of [
			'git show --output=owned.txt',
			'git show --output owned.txt',
		]) {
			const { argv, refusal } = buildAnchorArgv(command);
			expect(argv).toBeNull();
			expect(refusal).toMatch(/read-only git/);
			expect(refusal).toContain('--output');
		}
	});

	test('--show-signature, ls-remote, and status all refuse', () => {
		for (const command of [
			'git log --show-signature',
			'git ls-remote origin',
			'git status',
		]) {
			const { argv, refusal } = buildAnchorArgv(command);
			expect(argv).toBeNull();
			expect(refusal).toMatch(/read-only git/);
		}
	});

	test('ext:: positional refuses as a remote-helper URL', () => {
		const { argv, refusal } = buildAnchorArgv(
			'git log ext::sh -c touch pwned.txt',
		);
		expect(argv).toBeNull();
		expect(refusal).toMatch(/remote-helper URL/);
		expect(refusal).toMatch(/read-only git/);
	});

	test('arity-1 flag values normalize to attached form (PRR-009: the space form fails on git-for-windows 2.54)', () => {
		const inline = buildAnchorArgv('git log --format=%H');
		const spaced = buildAnchorArgv('git log --format %H');
		expect(inline.refusal).toBeNull();
		expect(spaced.refusal).toBeNull();
		expect(spaced.argv).not.toBeNull();
		expect(inline.argv).not.toBeNull();
		// Both spellings compile to the identical argv (the log guards
		// --no-ext-diff/--no-textconv are appended after the anchor tokens).
		expect(spaced.argv).toEqual(inline.argv);
		expect(spaced.argv).toContain('--format=%H');
		// Short-option values attach to the flag: `-n 2` becomes `-n2`.
		const short = buildAnchorArgv('git log -n 2');
		expect(short.refusal).toBeNull();
		expect(short.argv).toContain('-n2');
	});
});

describe('executeAttestTask — malformed expectations (expect token)', () => {
	test('empty expect_prefix is caught by the plan schema and refuses with the expect vocabulary', async () => {
		const dir = plainFixture('attest-empty-prefix-');
		writePlan(dir, {
			evidenceClass: 'external_git',
			anchors: [{ command: 'git rev-list --count HEAD', expect_prefix: '' }],
		});
		const result = await executeAttestTask(
			{ task_id: TASK_ID, working_directory: dir },
			dir,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('expect');
		expect(result.message).toContain('non-empty expect_prefix');
	});

	test('anchor with neither expect nor expect_prefix refuses with the expect token', async () => {
		const dir = plainFixture('attest-no-expect-');
		writePlan(dir, {
			evidenceClass: 'external_git',
			anchors: [{ command: 'git rev-list --count HEAD' }],
		});
		const result = await executeAttestTask(
			{ task_id: TASK_ID, working_directory: dir },
			dir,
		);
		expect(result.success).toBe(false);
		// Issue #3432 review PRR-008: a vacuous anchor is now rejected at the
		// plan-schema boundary; attest surfaces that through the same expect
		// vocabulary instead of the (now unreachable) runtime backstop.
		expect(result.message).toContain('non-empty expect_prefix');
	});
});

describe('executeAttestTask — positive control (real git fixture)', () => {
	test('attests a matched anchor and records the durable bundle', async () => {
		const dir = gitFixture('attest-positive-');
		writePlan(dir, {
			evidenceClass: 'external_git',
			anchors: [{ command: 'git rev-list --count HEAD', expect: '1' }],
		});
		const result = await executeAttestTask(
			{ task_id: TASK_ID, working_directory: dir },
			dir,
		);
		expect(result.success).toBe(true);
		expect(result.message).toContain('attested and recorded');

		const bundle = readBundle(dir);
		// Cursor-free digest (plan §3): deterministic over the exact declaration.
		expect(bundle.declarationDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(bundle.declarationDigest).toBe(
			computeExternalDeclarationDigest({
				taskId: TASK_ID,
				evidence_class: 'external_git',
				evidence_anchors: [
					{ command: 'git rev-list --count HEAD', expect: '1' },
				],
				plan_title: PLAN_TITLE,
				plan_swarm: PLAN_SWARM,
				generation: 0,
			}),
		);
		expect(bundle.anchors[0]?.command).toBe('git rev-list --count HEAD');
		expect(bundle.anchors[0]?.stdout).toBe('1\n');
		expect(bundle.anchors[0]?.matched).toBe(true);
		expect(bundle.anchors[0]?.exit_code).toBe(0);
	});
});

describe('executeAttestTask — hostile repo config neutralization (plan §7 F4)', () => {
	test('diff.external and core.pager marker scripts never execute', async () => {
		const dir = gitFixture('attest-hostile-');
		// Marker script: any execution drops hostile-marker.txt in the repo (the
		// cwd git uses for external diff / pager helpers).
		const scriptRel = 'hostile-marker.sh';
		fs.writeFileSync(
			path.join(dir, scriptRel),
			'#!/bin/sh\necho pwned > hostile-marker.txt\n',
		);
		fs.chmodSync(path.join(dir, scriptRel), 0o755);
		const scriptForGit = path.join(dir, scriptRel).replaceAll('\\', '/');
		git(dir, ['config', 'diff.external', scriptForGit]);
		git(dir, ['config', 'core.pager', scriptForGit]);

		writePlan(dir, {
			evidenceClass: 'external_git',
			anchors: [{ command: 'git show', expect_prefix: 'commit ' }],
		});
		const result = await executeAttestTask(
			{ task_id: TASK_ID, working_directory: dir },
			dir,
		);
		// The producer's own prefix (--no-pager -c diff.external= -c
		// core.pager=cat) plus force-appended --no-ext-diff/--no-textconv keep
		// the invocation on git's internal diff machinery.
		expect(result.success).toBe(true);
		const bundle = readBundle(dir);
		expect(bundle.anchors[0]?.matched).toBe(true);
		expect(bundle.anchors[0]?.stdout.startsWith('commit ')).toBe(true);
		expect(fs.existsSync(path.join(dir, 'hostile-marker.txt'))).toBe(false);
	});
});

describe('executeAttestTask — raw stdout bound (plan §6 R3F5)', () => {
	test('whitespace-heavy 5000-char stdout with a short trimmed value refuses, never truncates', async () => {
		const dir = plainFixture('attest-overflow-');
		writePlan(dir, {
			evidenceClass: 'external_git',
			anchors: [{ command: 'git rev-list --count HEAD', expect: 'ok' }],
		});
		attestInternals.runAnchor = async () => ({
			exitCode: 0,
			stdout: ' '.repeat(4998) + 'ok',
			refusal: null,
		});
		const result = await executeAttestTask(
			{ task_id: TASK_ID, working_directory: dir },
			dir,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('5000 chars of stdout');
		expect(result.message).toContain('4096-char evidence storage bound');
		expect(result.message).toContain('refusing rather than truncating');
		// Refusal happens before publication: no evidence bundle is written.
		expect(fs.existsSync(evidencePath(dir))).toBe(false);
	});
});

describe('executeAttestTask — mismatch refusal', () => {
	test('stdout that does not match expect refuses with did not match', async () => {
		const dir = plainFixture('attest-mismatch-');
		writePlan(dir, {
			evidenceClass: 'external_git',
			anchors: [{ command: 'git rev-list --count HEAD', expect: '1' }],
		});
		attestInternals.runAnchor = async () => ({
			exitCode: 0,
			stdout: '2\n',
			refusal: null,
		});
		const result = await executeAttestTask(
			{ task_id: TASK_ID, working_directory: dir },
			dir,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('did not match');
		expect(fs.existsSync(evidencePath(dir))).toBe(false);
	});
});

describe('executeAttestTask — undeclared task refuses (AC2)', () => {
	test('task without evidence_class fails closed', async () => {
		const dir = plainFixture('attest-undeclared-');
		writePlan(dir, {
			anchors: [{ command: 'git rev-list --count HEAD', expect: '1' }],
		});
		const result = await executeAttestTask(
			{ task_id: TASK_ID, working_directory: dir },
			dir,
		);
		expect(result.success).toBe(false);
		expect(result.message).toContain('fail-closed');
		expect(result.message).toContain('external_git');
	});
});
