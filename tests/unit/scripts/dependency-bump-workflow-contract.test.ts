/**
 * Frozen acceptance check C7 (trace
 * `.agents/issue-traces/3501-3285-3527-dep-bump-channel/`, 05-fix-plan.md
 * Change 2) for the NEW `.github/workflows/dependency-bump.yml` — the
 * maintainer workflow_dispatch channel through which github-actions[bot]
 * opens exactly one dependency-bump PR per dispatch.
 *
 * RED at base is expected and honest: the workflow does not exist yet, so
 * every test fails with a message naming the expected path. The implementer
 * turns the suite green by creating the workflow exactly as plan Change 2
 * specifies. The plan's mutation probes must each fail this suite: M8 (the
 * verify step tolerates an empty list) and M9 (the post-force
 * `bun install --frozen-lockfile` gate removed or reordered).
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dir, '../../..');
const workflowPath = path.join(
	root,
	'.github',
	'workflows',
	'dependency-bump.yml',
);
const workflowText = existsSync(workflowPath)
	? readFileSync(workflowPath, 'utf8')
	: '';
const parsed: WorkflowDoc | null = workflowText
	? (parse(workflowText) as WorkflowDoc)
	: null;

function missingWorkflow(): Error {
	return new Error(
		`dependency-bump workflow not found (or empty) at ${workflowPath} — this suite is frozen acceptance check C7 (trace .agents/issue-traces/3501-3285-3527-dep-bump-channel, 05-fix-plan.md Change 2); create the workflow the plan specifies to turn this suite green`,
	);
}

interface WorkflowInput {
	type?: string;
	required?: boolean;
	options?: string[];
}

interface WorkflowStep {
	name?: string;
	uses?: string;
	run?: string;
	with?: Record<string, unknown>;
	env?: Record<string, string>;
}

interface WorkflowJob {
	'runs-on'?: string;
	'timeout-minutes'?: unknown;
	steps?: WorkflowStep[];
	env?: Record<string, string>;
}

interface WorkflowDoc {
	on?: Record<string, unknown>;
	jobs?: Record<string, WorkflowJob>;
	env?: Record<string, string>;
}

function requireWorkflow(): WorkflowDoc {
	if (!parsed) throw missingWorkflow();
	return parsed;
}

function requireText(): string {
	if (!workflowText) throw missingWorkflow();
	return workflowText;
}

function onlyJob(): WorkflowJob {
	const jobs = requireWorkflow().jobs ?? {};
	const names = Object.keys(jobs);
	if (names.length !== 1) {
		throw new Error(
			`expected exactly one job in dependency-bump.yml, found ${names.length}: ${names.join(', ')}`,
		);
	}
	return jobs[names[0] ?? ''] ?? {};
}

function steps(): WorkflowStep[] {
	return onlyJob().steps ?? [];
}

/** Every step's run script, concatenated in step order. */
function script(): string {
	return steps()
		.map((step) => (typeof step.run === 'string' ? step.run : ''))
		.join('\n');
}

/** Index of the first step whose run script contains `needle` (-1 if none). */
function stepIndexContaining(needle: string): number {
	return steps().findIndex(
		(step) => typeof step.run === 'string' && step.run.includes(needle),
	);
}

/** All occurrence indices of `needle` in `haystack`, ascending. */
function allIndices(haystack: string, needle: string): number[] {
	const indices: number[] = [];
	let at = haystack.indexOf(needle);
	while (at !== -1) {
		indices.push(at);
		at = haystack.indexOf(needle, at + needle.length);
	}
	return indices;
}

/**
 * The workflow's event keys. The `yaml` package (YAML 1.2 core schema)
 * decodes BOTH the bare `on:` and the quoted `'on':` / `"on":` spellings to
 * the plain string key 'on', so one property access covers every form (the
 * wiring-2677 suite pins the text-level variants; here the parsed form is
 * unambiguous). String and list `on:` shorthands are normalized.
 */
function triggerKeys(): string[] {
	const raw: unknown = requireWorkflow()['on'];
	if (typeof raw === 'string') return [raw];
	if (Array.isArray(raw)) return raw.map((entry) => String(entry));
	if (raw && typeof raw === 'object') return Object.keys(raw);
	return [];
}

function dispatchInputs(): Record<string, WorkflowInput> {
	const dispatch = requireWorkflow()['on']?.workflow_dispatch as
		| { inputs?: Record<string, WorkflowInput> }
		| null
		| undefined;
	const inputs = dispatch?.inputs;
	if (!inputs) throw new Error('workflow_dispatch inputs block missing');
	return inputs;
}

/**
 * PINNED SUBSTRING (C7 verify gate): `VERIFY_FILES` — the env name that
 * carries inputs.verify. The verify step must reject an empty list BEFORE the
 * per-file loop runs; the guard pins the LOWER bound (`-lt 1`) explicitly on
 * the VERIFY_FILES line — the upper bound alone is insufficient (an OR-shaped
 * emptiness-or-cap pin survived mutation probe M8; the strengthening requires
 * the emptiness arm specifically). Removing the emptiness bound is M8, which
 * must fail this suite.
 */
const VERIFY_EMPTY_GUARD = /VERIFY_FILES[^\n]*-lt 1/i;

describe('dependency-bump workflow contract (frozen check C7, trace 3501-3285-3527)', () => {
	test('trigger surface: workflow_dispatch only — no pull_request, push, schedule, issues, pull_request_target, or workflow_run keys', () => {
		const keys = triggerKeys();
		expect(keys).toEqual(['workflow_dispatch']);
		for (const forbidden of [
			'pull_request',
			'push',
			'schedule',
			'issues',
			'pull_request_target',
			'workflow_run',
		]) {
			expect(keys).not.toContain(forbidden);
		}
	});

	test('workflow_dispatch inputs: package/version/verify required; dependency_kind choice dependencies|devDependencies; save_exact boolean; regen choice none|generate-config-schema; advisory, reason, pin_specs, note present', () => {
		const inputs = dispatchInputs();
		const inputNames = Object.keys(inputs);
		for (const name of [
			'package',
			'version',
			'advisory',
			'reason',
			'dependency_kind',
			'save_exact',
			'pin_specs',
			'regen',
			'verify',
			'note',
		]) {
			expect(inputNames).toContain(name);
		}
		expect(inputs.package?.required).toBe(true);
		expect(inputs.version?.required).toBe(true);
		expect(inputs.verify?.required).toBe(true);
		expect(inputs.dependency_kind?.type).toBe('choice');
		expect(inputs.dependency_kind?.options).toEqual([
			'dependencies',
			'devDependencies',
		]);
		expect(inputs.save_exact?.type).toBe('boolean');
		expect(inputs.regen?.type).toBe('choice');
		expect(inputs.regen?.options).toEqual(['none', 'generate-config-schema']);
	});

	test('job shape: exactly one job, runs-on ubuntu-latest, job-level timeout-minutes is a plain number', () => {
		const jobs = requireWorkflow().jobs ?? {};
		expect(Object.keys(jobs)).toHaveLength(1);
		const job = onlyJob();
		expect(job['runs-on']).toBe('ubuntu-latest');
		// A quoted expression or unparsable scalar arrives from YAML as a
		// string — only a plain number proves the bound is a real constant.
		const timeout = job['timeout-minutes'];
		expect(typeof timeout).toBe('number');
		expect(Number.isFinite(timeout)).toBe(true);
		expect(timeout as number).toBeGreaterThan(0);
	});

	test('concurrency: same-tuple dispatches serialize (per-request group, never cancel-in-progress)', () => {
		// The push/PR path is a read-modify-write over a branch whose identity
		// is a pure function of package|version|kind|exact — two simultaneous
		// dispatches must queue instead of racing it.
		const text = requireText();
		const group = text.indexOf('concurrency:');
		expect(group).toBeGreaterThanOrEqual(0);
		expect(text).toContain('cancel-in-progress: false');
		const jobStart = text.indexOf('jobs:');
		expect(group).toBeLessThan(jobStart);
	});

	test('every actions/checkout step carries persist-credentials: false', () => {
		const offenders: string[] = [];
		let checkoutCount = 0;
		for (const [index, step] of steps().entries()) {
			if (!(step.uses ?? '').startsWith('actions/checkout')) continue;
			checkoutCount += 1;
			if (step.with?.['persist-credentials'] !== false) {
				offenders.push(`steps[${index}] (${step.uses})`);
			}
		}
		expect(checkoutCount).toBeGreaterThan(0);
		expect(offenders).toEqual([]);
	});

	test('branch-before-mutation: git switch -C precedes bun add, and the github-actions[bot] identity precedes git commit', () => {
		const switchBranch = stepIndexContaining('git switch -C');
		const add = stepIndexContaining('bun add ');
		const identity = stepIndexContaining(
			'41898282+github-actions[bot]@users.noreply.github.com',
		);
		// The commit step builds a COMMIT_ARGS array (impl-review blocker 1
		// removed the literal 'git commit' text); the argv construction is the
		// commit site and the identity must precede it.
		const commit = stepIndexContaining('COMMIT_ARGS=(commit -m');
		expect(switchBranch).toBeGreaterThanOrEqual(0);
		expect(add).toBeGreaterThanOrEqual(0);
		expect(identity).toBeGreaterThanOrEqual(0);
		expect(commit).toBeGreaterThanOrEqual(0);
		// Plan R2: the branch is created off main BEFORE any mutation, and
		// the bot identity is configured BEFORE the commit is authored.
		expect(switchBranch).toBeLessThan(add);
		expect(identity).toBeLessThan(commit);
		expect(requireText()).toContain('github-actions[bot]');
	});

	test('dependency phase order: first frozen install < bun add < bun install --force < LAST frozen install (consistency gate runs last)', () => {
		const text = script();
		const firstFrozen = text.indexOf('bun install --frozen-lockfile');
		const add = text.indexOf('bun add ');
		const firstForce = text.indexOf('bun install --force');
		const lastFrozen = text.lastIndexOf('bun install --frozen-lockfile');
		expect(firstFrozen).toBeGreaterThanOrEqual(0);
		expect(add).toBeGreaterThanOrEqual(0);
		expect(firstForce).toBeGreaterThanOrEqual(0);
		expect(lastFrozen).toBeGreaterThanOrEqual(0);
		// Plan N7: clean base -> mutation -> force re-resolution -> the
		// frozen-lockfile consistency gate LAST (mutation M9 removes it).
		expect(firstFrozen).toBeLessThan(add);
		expect(add).toBeLessThan(firstForce);
		expect(firstForce).toBeLessThan(lastFrozen);
		expect(lastFrozen).toBeGreaterThan(firstFrozen);
	});

	test('verify gate: per-file bun --smol test runs before the push step and gh pr create, and an empty verify list is rejected before use', () => {
		const verifyStep = stepIndexContaining('bun --smol test');
		const pushStep = stepIndexContaining('git push');
		const prCreateStep = stepIndexContaining('gh pr create');
		expect(verifyStep).toBeGreaterThanOrEqual(0);
		expect(pushStep).toBeGreaterThanOrEqual(0);
		expect(prCreateStep).toBeGreaterThanOrEqual(0);
		expect(verifyStep).toBeLessThan(pushStep);
		expect(verifyStep).toBeLessThan(prCreateStep);

		const verifyRun = steps()[verifyStep]?.run ?? '';
		expect(verifyRun).toContain('VERIFY_FILES');
		const guard = VERIFY_EMPTY_GUARD.exec(verifyRun);
		expect(guard).not.toBeNull();
		// Validated BEFORE use: the guard precedes the first test invocation.
		const guardIndex = guard?.index ?? -1;
		expect(guardIndex).toBeGreaterThanOrEqual(0);
		expect(guardIndex).toBeLessThan(verifyRun.indexOf('bun --smol test'));
	});

	test('dirty-tree gates: two git status --porcelain checks bracket the verify loop, and git add -- staging is followed by a git diff --cached assertion', () => {
		const text = script();
		const porcelainChecks = allIndices(text, 'git status --porcelain');
		const verifyLoop = text.indexOf('bun --smol test');
		const staging = text.indexOf('git add --');
		const cachedDiff = text.indexOf('git diff --cached');
		expect(porcelainChecks.length).toBeGreaterThanOrEqual(2);
		expect(verifyLoop).toBeGreaterThanOrEqual(0);
		expect(staging).toBeGreaterThanOrEqual(0);
		expect(cachedDiff).toBeGreaterThanOrEqual(0);
		// Plan R6/N3: gate #1 pre-verify, gate #2 post-verify but BEFORE the
		// explicit-path staging, which is then proven by the cached diff.
		expect(porcelainChecks[0] ?? -1).toBeLessThan(verifyLoop);
		expect(porcelainChecks[1] ?? -1).toBeGreaterThan(verifyLoop);
		expect(porcelainChecks[1] ?? -1).toBeLessThan(staging);
		expect(staging).toBeLessThan(cachedDiff);
	});

	test('staging equality uses the dirty intersection of the allowlist, not the full allowlist (plan-critic r4)', () => {
		// An unchanged allowed output (e.g. docs/configuration.md when a regen
		// leaves it byte-identical) never stages, so full-allowlist equality
		// rejects the intended commit. The gate must compute the INTERSECTION
		// of the dirty set with the allowlist, compare the cached set against
		// THAT, and separately require the mandatory outputs.
		const text = script();
		const intersection = text.indexOf('ACTUAL_ALLOWED_DIRTY');
		const comm = text.indexOf('comm -12');
		const staging = text.indexOf('git add --');
		const cachedComparison = text.indexOf(
			'staged set differs from the actual allowed dirty set',
		);
		expect(intersection).toBeGreaterThanOrEqual(0);
		expect(comm).toBeGreaterThan(intersection);
		expect(comm).toBeLessThan(staging);
		expect(cachedComparison).toBeGreaterThan(staging);
		// Mandatory dispatch outputs: package.json and bun.lock must both be
		// present in the actual allowed dirty set (a vacuous dispatch denies).
		expect(text).toContain('package.json missing from the dispatch outputs');
		expect(text).toContain('bun.lock missing from the dispatch outputs');
	});

	test('push/PR transport: GH_TOKEN from secrets.GITHUB_TOKEN, gh auth setup-git, --force-with-lease over refs/heads/, gh pr create with both --base main and --head', () => {
		const prStepIndex = stepIndexContaining('gh pr create');
		expect(prStepIndex).toBeGreaterThanOrEqual(0);
		const step = steps()[prStepIndex] ?? {};
		expect(step.env?.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
		const run = typeof step.run === 'string' ? step.run : '';
		expect(run).toContain('gh auth setup-git');
		expect(run).toContain('--force-with-lease');
		expect(run).toContain('refs/heads/');
		expect(run).toContain('--base main');
		expect(run).toContain('--head');
	});

	test('commit argv is built as an array, never command-substitution quoting (impl-review blocker 1)', () => {
		// Command-substitution output is NOT re-parsed for quotes: a
		// $(printf -- '-m "%s"') form splits each trailer into two tokens and
		// embeds literal quotes, so the commit fails and the guard's
		// ^X-Dep-Bump-Channel: dependency-bump$ trailer match breaks — every
		// dispatch would die here. Pin the argv-array shape.
		const text = script();
		const commitStep = text.indexOf('COMMIT_ARGS=(commit -m');
		expect(commitStep).toBeGreaterThanOrEqual(0);
		expect(text).toContain('COMMIT_ARGS+=(-m "$trailer")');
		expect(text).toContain('git "${COMMIT_ARGS[@]}"');
		for (const forbidden of ["$(printf -- '-m", '$(printf %-m']) {
			expect(text).not.toContain(forbidden);
		}
	});

	test('no raw input interpolation: run blocks never embed ${{ inputs.* }} or ${{ github.event.* }} expressions, and GH_TOKEN maps only from secrets.GITHUB_TOKEN', () => {
		const offenders: string[] = [];
		for (const step of steps()) {
			if (typeof step.run !== 'string') continue;
			for (const match of step.run.matchAll(/\$\{\{.+?\}\}/g)) {
				if (
					match[0].includes('inputs.') ||
					match[0].includes('github.event.')
				) {
					offenders.push(match[0]);
				}
			}
		}
		expect(offenders).toEqual([]);

		const envEntries: Array<[string, string]> = [];
		const workflow = requireWorkflow();
		const envMaps = [
			workflow.env,
			onlyJob().env,
			...steps().map((step) => step.env),
		];
		for (const map of envMaps) {
			if (!map) continue;
			for (const entry of Object.entries(map)) {
				envEntries.push(entry);
			}
		}
		expect(envEntries.length).toBeGreaterThan(0);
		for (const [key, value] of envEntries) {
			if (key === 'GH_TOKEN') {
				expect(value).toBe('${{ secrets.GITHUB_TOKEN }}');
			}
		}
		// Non-vacuous: dispatch inputs ARE consumed somewhere via env mapping.
		const envValues = envEntries.map(([, value]) => value).join('\n');
		expect(envValues).toContain('inputs.');
	});

	test('typecheck step: bun run typecheck runs when pin_specs names a src/ file (pinned PIN_SPECS + src/ guard)', () => {
		const typecheckIndex = stepIndexContaining('bun run typecheck');
		expect(typecheckIndex).toBeGreaterThanOrEqual(0);
		const run = steps()[typecheckIndex]?.run ?? '';
		// PINNED SUBSTRINGS: the guard must key on PIN_SPECS naming a path
		// under src/ (plan N9 — source-affecting dispatches re-prove
		// compilation before any push).
		expect(run).toContain('PIN_SPECS');
		expect(run).toContain('src/');
	});

	test('approval runbook: the workflow records the action_required state for GITHUB_TOKEN-triggered CI runs', () => {
		expect(requireText()).toContain('action_required');
	});
});
