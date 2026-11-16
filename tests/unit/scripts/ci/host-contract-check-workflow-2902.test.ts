import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

const REPO_ROOT = process.cwd();
const WORKFLOW_PATH = join(
	REPO_ROOT,
	'.github/workflows/host-contract-check.yml',
);

interface WorkflowShape {
	on?: {
		schedule?: Array<{ cron?: string }>;
		workflow_dispatch?: unknown;
		pull_request?: { paths?: string[] };
	};
	permissions?: Record<string, string>;
	jobs?: Record<
		string,
		{
			permissions?: Record<string, string>;
			steps?: Array<{
				uses?: string;
				name?: string;
				if?: string;
				'continue-on-error'?: string | boolean;
				env?: Record<string, string>;
			}>;
		}
	>;
}

function loadWorkflow(): WorkflowShape {
	return load(readFileSync(WORKFLOW_PATH, 'utf8')) as WorkflowShape;
}

describe('host-contract-check workflow (issue #2902)', () => {
	test('the workflow file exists and parses', () => {
		const doc = loadWorkflow();
		expect(doc).toBeTruthy();
		expect(doc.jobs?.check).toBeTruthy();
	});

	test('weekly schedule and workflow_dispatch drive the blocking lane', () => {
		const triggers = loadWorkflow().on;
		expect(triggers?.schedule?.[0]?.cron).toBe('0 13 * * 1');
		expect(triggers?.workflow_dispatch).toBeTruthy();
	});

	test('the PR lane is gated on host-contract surfaces and advisory', () => {
		const paths = loadWorkflow().on?.pull_request?.paths ?? [];
		for (const required of [
			'tests/helpers/host-*',
			'tests/fixtures/host/**',
			'scripts/check-host-contract.ts',
			'bun.lock',
			'package.json',
		]) {
			expect(paths).toContain(required);
		}
		const checkStep = loadWorkflow().jobs?.check?.steps?.find((s) =>
			s.name?.includes('host-contract check'),
		);
		expect(checkStep).toBeTruthy();
		expect(checkStep!['continue-on-error']).toBe(
			"${{ github.event_name == 'pull_request' }}",
		);
	});

	test('routing only runs on non-PR events and is wired with GH_TOKEN', () => {
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		// The routing flag is added only when the event is not a pull_request.
		expect(raw).toContain("github.event_name != 'pull_request'");
		expect(raw).toContain('--route-on-drift');
		const checkStep = loadWorkflow().jobs?.check?.steps?.find((s) =>
			s.name?.includes('host-contract check'),
		);
		expect(checkStep?.env?.GH_TOKEN).toBe('${{ github.token }}');
		expect(checkStep?.env?.GH_REPO).toBe('${{ github.repository }}');
		// The dispatch tag must reach the shell only as an env value — never
		// inline-interpolated (PRR-006 injection class).
		expect(checkStep?.env?.INPUT_TAG).toBe('${{ inputs.tag }}');
		expect(raw.includes('TAG=')).toBe(false);
	});

	test('the job summary step always runs and records the compared tag', () => {
		const summaryStep = loadWorkflow().jobs?.check?.steps?.find((s) =>
			s.name?.includes('summary'),
		);
		expect(summaryStep?.if).toBe('always()');
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		expect(raw).toContain('GITHUB_STEP_SUMMARY');
		expect(raw).toContain('host-contract-output.txt');
	});

	test('issues: write is granted for tracking-issue routing', () => {
		const job = loadWorkflow().jobs?.check;
		expect(job?.permissions?.issues).toBe('write');
		expect(job?.permissions?.contents).toBe('read');
	});

	test('actions are pinned by commit SHA with version comments', () => {
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		for (const action of [
			'actions/checkout',
			'oven-sh/setup-bun',
			'actions/cache',
		]) {
			const m = raw.match(new RegExp(`${action}@[0-9a-f]{40}`));
			expect(m).not.toBeNull();
		}
	});
});

// Issue #2910 W1.4: the v2 host-contract leg runs in the SAME workflow with
// its own output file, PR continue-on-error, path triggers, and summary
// block, and is failure-INDEPENDENT of the v1 leg (all v1 pins above stay
// green — the additions below are purely additive).
describe('host-contract-check workflow: v2 lane (issue #2910)', () => {
	function v2Step() {
		return loadWorkflow().jobs?.check?.steps?.find(
			(s) => s.id === 'host_contract_v2',
		);
	}

	test('the v2 step exists after the v1 step and runs the v2 script', () => {
		const steps = loadWorkflow().jobs?.check?.steps ?? [];
		const v1Index = steps.findIndex((s) => s.id === 'host_contract');
		const v2Index = steps.findIndex((s) => s.id === 'host_contract_v2');
		expect(v1Index).toBeGreaterThanOrEqual(0);
		expect(v2Index).toBeGreaterThan(v1Index);
		expect(v2Step()?.name).toBe('Run v2 host-contract check');
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		expect(raw).toContain('bun scripts/check-host-contract-v2.ts');
	});

	test('the v2 step writes its own output file', () => {
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		expect(raw).toContain('host-contract-v2-output.txt');
	});

	test('the v2 step is advisory on PRs (own continue-on-error)', () => {
		expect(v2Step()?.['continue-on-error']).toBe(
			"${{ github.event_name == 'pull_request' }}",
		);
	});

	test('the v2 step is NOT gated on the v1 step outcome (if: always())', () => {
		// Step-level independence: even a blocking v1 failure on the weekly
		// lane must never mask v2 drift.
		expect(v2Step()?.if).toBe('always()');
	});

	test('PR path triggers include the v2 script, fixture, and its test file', () => {
		const paths = loadWorkflow().on?.pull_request?.paths ?? [];
		for (const required of [
			'scripts/check-host-contract-v2.ts',
			'tests/fixtures/host/expected-structure-v2.json',
			'tests/unit/scripts/check-host-contract-v2.test.ts',
		]) {
			expect(paths).toContain(required);
		}
	});

	test('the v2 step routes with the same GH_TOKEN/GH_REPO env discipline', () => {
		const step = v2Step();
		expect(step?.env?.GH_TOKEN).toBe('${{ github.token }}');
		expect(step?.env?.GH_REPO).toBe('${{ github.repository }}');
		// The dispatch tag stays env-only (PRR-006): no inline TAG= anywhere.
		expect(step?.env?.INPUT_TAG_V2).toBe('${{ inputs.tag_v2 }}');
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		expect(raw.includes('TAG=')).toBe(false);
	});

	test('the v2 summary step always runs and records its own output file', () => {
		const steps = loadWorkflow().jobs?.check?.steps ?? [];
		const summary = steps.find(
			(s) => s.name === 'Record v2 verdict in job summary',
		);
		expect(summary?.if).toBe('always()');
		const raw = readFileSync(WORKFLOW_PATH, 'utf8');
		expect(raw).toContain('Host contract check (v2)');
	});
});
