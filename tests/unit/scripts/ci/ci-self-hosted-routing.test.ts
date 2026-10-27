import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';

/*
 * Security invariant for the self-hosted runner routing (issue #3404).
 *
 * `ZaxbyHub/opencode-swarm` is public and accepts fork PRs, and CI executes
 * PR-head code. Routing a `pull_request` job to a self-hosted runner would
 * therefore hand arbitrary code execution on that machine to anyone able to
 * open a fork PR. The routing is expressed per job as
 *
 *   runs-on: ${{ github.event_name == 'merge_group' && 'self-hosted' || 'ubuntu-latest' }}
 *
 * so one job definition keeps its untrusted leg on GitHub-hosted runners and
 * only its trusted merge-queue leg on the runner. These tests pin that split:
 * a future edit that makes a pull_request-triggered job run unconditionally on
 * `self-hosted`, or that gives an untrusted workflow an unconditional runner,
 * fails here instead of silently widening the trust boundary.
 *
 * The merge_group residual risk is accepted by the maintainer and documented in
 * docs/releases/pending/ci-self-hosted-runner-routing.md; it is not re-litigated
 * here. What IS pinned is that the untrusted leg never touches the runner.
 */

const WORKFLOWS_DIR = join(import.meta.dir, '../../../../.github/workflows');

function readWorkflow(name: string): string {
	return readFileSync(join(WORKFLOWS_DIR, name), 'utf8').replace(/\r\n/g, '\n');
}

function parseWorkflow(name: string): any {
	return yaml.load(readWorkflow(name)) as any;
}

/** Every event name a workflow declares, normalizing scalar/array/null forms. */
function declaredEvents(workflow: any): string[] {
	const on = workflow?.on ?? workflow?.[true];
	if (!on) return [];
	if (typeof on === 'string') return [on];
	if (Array.isArray(on)) return on.map(String);
	if (typeof on === 'object') return Object.keys(on);
	return [];
}

/** The `runs-on` value of a job, as a raw string (or '' when absent). */
function runsOnOf(job: any): string {
	const runsOn = job?.['runs-on'];
	if (typeof runsOn === 'string') return runsOn;
	if (Array.isArray(runsOn)) return `[${runsOn.join(', ')}]`;
	return '';
}

const SELF_HOSTED = 'self-hosted';

/** True when the runs-on value can resolve to the self-hosted runner. */
function canUseSelfHosted(runsOn: string): boolean {
	return runsOn.includes(SELF_HOSTED);
}

/** True when the runs-on value is gated on the merge_group event. */
function isMergeGroupGated(runsOn: string): boolean {
	return runsOn.includes("github.event_name == 'merge_group'");
}

/** True when the runs-on value can resolve to a GitHub-hosted label. */
function canUseGitHubHosted(runsOn: string): boolean {
	return /ubuntu-latest|windows-latest|macos-latest/.test(runsOn);
}

/*
 * The two sanctioned spellings, pinned exactly. A pull_request-triggered job
 * may reach the runner ONLY through one of these; anything else — including a
 * plausible-looking inversion such as
 * `merge_group && 'ubuntu-latest' || 'self-hosted'`, which keeps a
 * GitHub-hosted label reachable but puts the RUNNER on the untrusted leg — is
 * rejected. Adding a third shape must be a deliberate edit here.
 */
const RUNNER_LABELS = `fromJSON('["self-hosted","Linux","X64"]')`;
const MAC_RUNNER_LABELS = `fromJSON('["self-hosted","macOS","ARM64"]')`;

const SANCTIONED_ROUTER_SHAPES: string[] = [
	`github.event_name == 'merge_group' && ${RUNNER_LABELS} || 'ubuntu-latest'`,
	`github.event_name == 'pull_request' && 'ubuntu-latest' || ${RUNNER_LABELS}`,
	// Per-OS matrix jobs: only the merge_group legs of the Linux and macOS
	// matrix cells move; every other leg (pull_request, and Windows always)
	// falls through to the GitHub-hosted matrix.os label.
	`github.event_name == 'merge_group' && matrix.os == 'ubuntu-latest' && ${RUNNER_LABELS} || github.event_name == 'merge_group' && matrix.os == 'macos-latest' && ${MAC_RUNNER_LABELS} || matrix.os`,
];

function usesSanctionedRouterShape(runsOn: string): boolean {
	return SANCTIONED_ROUTER_SHAPES.some((shape) => runsOn.includes(shape));
}

/*
 * The org's self-hosted pool mixes operating systems, and every runner carries
 * the `self-hosted` label regardless of OS. A route that asks for
 * `self-hosted` alone can land on any machine, so every self-hosted label set
 * must name exactly one of the supported OS/arch pairs.
 */
const ALLOWED_LABEL_SETS = new Set([
	'self-hosted,Linux,X64',
	'self-hosted,macOS,ARM64',
]);

/** Every self-hosted label set named in a runs-on value, normalized. */
function selfHostedLabelSets(runsOn: string): string[] {
	const sets: string[] = [];
	for (const m of runsOn.matchAll(/\[([^[\]]*self-hosted[^[\]]*)\]/g)) {
		sets.push(
			m[1]
				.split(',')
				.map((s) => s.trim().replace(/^["']|["']$/g, ''))
				.join(','),
		);
	}
	// A bare `self-hosted` (string runs-on, or a label outside any array).
	const outside = runsOn.replace(/\[[^[\]]*\]/g, '');
	if (outside.includes('self-hosted')) sets.push('self-hosted');
	return sets;
}

function pinsOsAndArch(runsOn: string): boolean {
	const sets = selfHostedLabelSets(runsOn);
	return sets.length > 0 && sets.every((s) => ALLOWED_LABEL_SETS.has(s));
}

describe('self-hosted runner routing — security invariant (issue #3404)', () => {
	// Workflows that legitimately run on the runner unconditionally. Each one
	// MUST NOT declare a pull_request trigger, or the untrusted-code boundary
	// would be crossed. release-and-publish.yml is deliberately NOT here: npm
	// trusted publishing does not support self-hosted runners and its jobs
	// carry publish credentials, so it stays on GitHub-hosted runners (pinned
	// by the publishing-contract test below).
	const RUNNER_ONLY_WORKFLOWS = ['stale.yml', 'quarantine-aging.yml'];

	// Workflows whose jobs may use the runner only on the merge_group leg.
	const PER_EVENT_WORKFLOWS = ['ci.yml', 'host-contract-check.yml'];

	test('no pull_request-triggered job anywhere runs unconditionally on the runner', () => {
		// The load-bearing assertion. Sweeps every workflow in the directory so
		// a NEW workflow added later is covered without editing this test.
		const fs = require('node:fs') as typeof import('node:fs');
		const offenders: string[] = [];
		for (const file of fs.readdirSync(WORKFLOWS_DIR)) {
			if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
			let workflow: any;
			try {
				workflow = yaml.load(readWorkflow(file)) as any;
			} catch {
				continue; // unparseable workflows are covered by their own guards
			}
			const events = declaredEvents(workflow);
			if (!events.includes('pull_request')) continue;
			for (const [jobName, job] of Object.entries<any>(workflow?.jobs ?? {})) {
				const runsOn = runsOnOf(job);
				if (canUseSelfHosted(runsOn) && !usesSanctionedRouterShape(runsOn)) {
					offenders.push(`${file}:${jobName} -> ${runsOn}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test('every route to the self-hosted pool pins a supported OS and arch', () => {
		const fs = require('node:fs') as typeof import('node:fs');
		const offenders: string[] = [];
		let routed = 0;
		for (const file of fs.readdirSync(WORKFLOWS_DIR)) {
			if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
			let workflow: any;
			try {
				workflow = yaml.load(readWorkflow(file)) as any;
			} catch {
				continue;
			}
			for (const [jobName, job] of Object.entries<any>(workflow?.jobs ?? {})) {
				const runsOn = runsOnOf(job);
				if (!canUseSelfHosted(runsOn)) continue;
				routed++;
				if (!pinsOsAndArch(runsOn)) {
					offenders.push(`${file}:${jobName} -> ${runsOn}`);
				}
			}
		}
		expect(routed, 'some job routes to the self-hosted pool').toBeGreaterThan(
			0,
		);
		expect(offenders).toEqual([]);
	});

	test('every workflow that runs on the runner declares no pull_request trigger', () => {
		for (const file of RUNNER_ONLY_WORKFLOWS) {
			const workflow = parseWorkflow(file);
			const events = declaredEvents(workflow);
			expect(events, `${file} must not run on pull_request`).not.toContain(
				'pull_request',
			);
			const jobs = Object.entries<any>(workflow.jobs ?? {});
			expect(jobs.length, `${file} has jobs`).toBeGreaterThan(0);
			// Non-vacuity: the workflow really is runner-routed. Every job here
			// is runner-routed, but asserting at least one keeps the loop from
			// passing vacuously on an empty job map.
			const runnerJobs = jobs.filter(([, job]) =>
				canUseSelfHosted(runsOnOf(job)),
			);
			expect(
				runnerJobs.length,
				`${file} routes at least one job to the runner`,
			).toBeGreaterThan(0);
			// Every runner-routed job here is unconditional, which is only safe
			// because the workflow never fires on an untrusted event.
			for (const [jobName, job] of runnerJobs) {
				expect(
					isMergeGroupGated(runsOnOf(job)),
					`${file}:${jobName} routes unconditionally`,
				).toBe(false);
			}
		}
	});

	test('per-event routing keeps a GitHub-hosted leg for the untrusted event', () => {
		// Both branches must exist: the runner leg is gated on the event name and
		// a GitHub-hosted label is reachable, so pull_request still runs somewhere.
		// The expression shape differs per workflow — ci.yml gates the runner on
		// merge_group, host-contract-check.yml gates the GitHub-hosted leg on
		// pull_request — so the pinned property is the event-gated expression plus
		// a reachable GitHub-hosted label, not one particular spelling.
		for (const file of PER_EVENT_WORKFLOWS) {
			const workflow = parseWorkflow(file);
			expect(declaredEvents(workflow)).toContain('pull_request');
			for (const [jobName, job] of Object.entries<any>(workflow.jobs ?? {})) {
				const runsOn = runsOnOf(job);
				if (!canUseSelfHosted(runsOn)) continue;
				expect(
					runsOn.includes('github.event_name'),
					`${file}:${jobName} gates the runner behind an event expression`,
				).toBe(true);
				expect(
					canUseGitHubHosted(runsOn),
					`${file}:${jobName} keeps a GitHub-hosted leg`,
				).toBe(true);
			}
		}
	});

	test('host-contract-check routes pull_request to GitHub-hosted, not the runner', () => {
		// Inverted expression shape (`pull_request && 'ubuntu-latest' || …`): the
		// untrusted leg is the one that must stay on GitHub-hosted runners.
		const runsOn = runsOnOf(
			parseWorkflow('host-contract-check.yml').jobs?.check,
		);
		expect(runsOn).toContain("github.event_name == 'pull_request'");
		expect(runsOn).toContain('ubuntu-latest');
	});

	test('release publishing stays on GitHub-hosted runners', () => {
		// npm trusted publishing (OIDC provenance) does not support self-hosted
		// runners, and these jobs carry publish credentials — a self-hosted
		// compromise must never yield them. Every job of the release workflow is
		// pinned to a GitHub-hosted label; a runner route here needs explicit
		// maintainer sign-off, not just a label edit.
		const workflow = parseWorkflow('release-and-publish.yml');
		const offenders: string[] = [];
		for (const [jobName, job] of Object.entries<any>(workflow.jobs ?? {})) {
			const runsOn = runsOnOf(job);
			if (canUseSelfHosted(runsOn)) {
				offenders.push(`${jobName} -> ${runsOn}`);
			}
		}
		expect(offenders).toEqual([]);
		expect(runsOnOf(workflow.jobs?.['publish-npm'])).toContain('ubuntu-latest');
	});

	test('untrusted-execution events never reach the runner (fail-closed sweep)', () => {
		// pull_request_target executes untrusted head code with secrets, and
		// workflow_run inherits the privileges of its triggering workflow's
		// artifacts — neither may resolve to the pool under ANY expression
		// shape, unlike pull_request which has the two sanctioned routers.
		const fs = require('node:fs') as typeof import('node:fs');
		const offenders: string[] = [];
		for (const file of fs.readdirSync(WORKFLOWS_DIR)) {
			if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
			let workflow: any;
			try {
				workflow = yaml.load(readWorkflow(file)) as any;
			} catch {
				continue;
			}
			const events = declaredEvents(workflow);
			if (
				!events.includes('pull_request_target') &&
				!events.includes('workflow_run')
			) {
				continue;
			}
			for (const [jobName, job] of Object.entries<any>(workflow?.jobs ?? {})) {
				const runsOn = runsOnOf(job);
				if (canUseSelfHosted(runsOn)) {
					offenders.push(`${file}:${jobName} -> ${runsOn}`);
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test('the preinstalled-bun probe implements the documented truth table', () => {
		// Contract: setup-bun installs the pinned bun unless the probe positively
		// found that exact pin. Three cases — pin match (skip download), missing
		// or mismatched bun (install), probe skipped on hosted legs (install,
		// the empty output must fall through). The consumer comparison is
		// `!= 'false'`, NOT `!= 'true'` — the latter inverts the table.
		const shouldInstall = (need: string): boolean => need !== 'false';
		expect(shouldInstall('false')).toBe(false);
		expect(shouldInstall('true')).toBe(true);
		expect(shouldInstall('')).toBe(true);

		const jobs = parseWorkflow('ci.yml').jobs ?? {};
		for (const [jobName, job] of Object.entries<any>(jobs)) {
			const steps: any[] = job.steps ?? [];
			const probe = steps.find((s) => s.id === 'bun-present');
			if (!probe) continue;
			const setup = steps.find((s) =>
				String(s.uses ?? '').startsWith('oven-sh/setup-bun@'),
			);
			expect(setup, `${jobName} pairs the probe with setup-bun`).toBeDefined();
			expect(
				String(probe.run),
				`${jobName} probe writes need=false only on a match`,
			).toContain('grep -qx');
			expect(String(probe.run)).toContain('echo "need=false"');
			expect(String(probe.run)).toContain('echo "need=true"');
			expect(
				String(setup.if),
				`${jobName} setup-bun runs unless the pin was matched`,
			).toContain("steps.bun-present.outputs.need != 'false'");
			// Version drift guard: the probe's accepted version must equal the
			// version setup-bun installs, or the probe can never skip it.
			const probed = /grep -qx "([^"]+)"/.exec(String(probe.run))?.[1];
			const pinned = String(setup.with?.['bun-version'] ?? '');
			expect(probed, `${jobName} probe names a version`).toBeTruthy();
			expect(probed, `${jobName} probe matches the setup-bun pin`).toBe(pinned);
		}
	});

	test('the runner-routed ci.yml jobs are the declared set', () => {
		// Guards the migration's scope. A new runner-routed job in ci.yml must be
		// a deliberate edit here. `unit` and `smoke` are deliberately NOT routed:
		// in the first routed queue run the self-hosted Linux hosts ran unit
		// shards at 29-40+ min against the 40-minute ceiling (two of six shards
		// were killed at the limit) and could not finish smoke inside its
		// 15-minute window, and the self-hosted macs fail a broad class of
		// subprocess-spawning suites. Both stay GitHub-hosted until root-caused.
		const jobs = Object.entries<any>(parseWorkflow('ci.yml').jobs ?? {});
		const routed = jobs
			.filter(([, job]) => canUseSelfHosted(runsOnOf(job)))
			.map(([name]) => name)
			.sort();
		expect(routed).toEqual([
			'coverage',
			'coverage-shard',
			'integration',
			'memory-recall-regression',
			'package-check',
			'quality',
			'security',
		]);
	});

	test('the unit and smoke matrices stay fully GitHub-hosted', () => {
		// No per-event routing at all: every OS cell of both jobs uses the
		// GitHub-hosted label on every trigger. A routed cell here reintroduces
		// the 40-minute-ceiling kills (Linux unit shards) and the subprocess
		// test-class failures (mac unit shards) observed in the first routed run.
		const jobs = Object.entries<any>(parseWorkflow('ci.yml').jobs ?? {});
		for (const name of ['unit', 'smoke']) {
			const runsOn = runsOnOf(jobs.find(([jobName]) => jobName === name)?.[1]);
			expect(runsOn, `${name} runs-on`).toBe('${{ matrix.os }}');
		}
	});

	test('Windows legs and the sandbox runner stay GitHub-hosted', () => {
		// No Windows self-hosted runner is online yet, so a Windows leg routed to
		// the pool would queue forever. The matrix route must fall through to the
		// GitHub-hosted matrix.os label for windows-latest, and must not name a
		// Windows label set.
		const jobs = Object.entries<any>(parseWorkflow('ci.yml').jobs ?? {});
		const name = 'memory-recall-regression';
		const runsOn = runsOnOf(jobs.find(([jobName]) => jobName === name)?.[1]);
		expect(runsOn, `${name} runs-on`).not.toBe('');
		expect(runsOn).toMatch(/\|\| matrix\.os\s*}}$/);
		expect(runsOn).not.toMatch(/windows/i);
		const sandbox = jobs.find(
			([jobName]) => jobName === 'rust-sandbox-runner',
		)?.[1];
		expect(sandbox, 'ci.yml has a rust-sandbox-runner job').toBeDefined();
		expect(runsOnOf(sandbox)).toBe('windows-latest');
	});

	test('every runner-routed ci.yml job isolates its temp dir on self-hosted runners', () => {
		// Self-hosted machines persist between jobs, and several runner instances
		// share each host. Each routed job must point TMPDIR at its own per-job
		// RUNNER_TEMP before any other step runs.
		const jobs = Object.entries<any>(parseWorkflow('ci.yml').jobs ?? {});
		for (const [name, job] of jobs) {
			if (!canUseSelfHosted(runsOnOf(job))) continue;
			const first = (job.steps ?? [])[0] ?? {};
			expect(first.name, `${name} first step`).toBe(
				'Isolate temp dir on self-hosted runners',
			);
			expect(first.if).toContain("runner.environment == 'self-hosted'");
			expect(first.run).toContain('TMPDIR=$RUNNER_TEMP');
			// The live ~/.bun/install/cache is shared across runner instances on
			// one host and concurrent installs corrupted it (FileNotFound during
			// cache copy in two merge-group batches), so each job gets its own.
			expect(first.run).toContain('BUN_CACHE=$RUNNER_TEMP/bun-cache');
		}
	});
});
