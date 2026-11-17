/**
 * #3716 item 2 (AC8 durable pin): the captured success set
 * (mergeGroup.contexts) is producer-bound — the SAME all-success +
 * unambiguous-app-slug + repo-producer rule the completeness loop applies
 * (one shared helper, contextRunsSatisfyBinding), not a name-only Set over
 * all successful runs.
 *
 * Root cause: scripts/capture-required-check-evidence.ts derived
 * mergeGroup.contexts from a name-keyed Set with no producer binding, so a
 * same-named run from a foreign app could satisfy a required context on this
 * path. Harness mirrors tests/unit/scripts/capture-required-context-binding-3661.test.ts
 * (_internals.ghApi swap; credentials-free).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	CaptureRefusal,
	contextRunsSatisfyBinding,
	runCapture,
} from '../../../scripts/capture-required-check-evidence';
import {
	CONTRACT_PATH,
	EVIDENCE_PATH,
} from '../../../scripts/check-required-check-contract';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const CONTRACT = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf-8')) as {
	repository: string;
	rulesetId: string;
	requiredContexts: string[];
	workflows: Array<{ file: string }>;
};
const EVIDENCE_JSON = JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf-8')) as {
	captureSha: string;
};

const FOREIGN_APP = 'some-other-app';
const FIRST_REQUIRED = CONTRACT.requiredContexts[0] as string;
const headOld = EVIDENCE_JSON.captureSha;
const headNew = 'f'.repeat(40);
const WORKFLOW_CONTENT =
	'on:\n  pull_request:\n  merge_group:\njobs:\n  quality:\n';

const originalGhApi = _internals.ghApi;

function seedLocalWorkflows(root: string): void {
	for (const workflow of CONTRACT.workflows) {
		fs.mkdirSync(path.join(root, path.dirname(workflow.file)), {
			recursive: true,
		});
		fs.writeFileSync(path.join(root, workflow.file), WORKFLOW_CONTENT, 'utf-8');
	}
}

function rulesetJson(): unknown {
	return {
		ok: true,
		status: 0,
		json: {
			id: Number(CONTRACT.rulesetId),
			enforcement: 'active',
			conditions: {
				ref_name: { include: ['refs/heads/main', '~DEFAULT_BRANCH'] },
			},
			rules: [
				{
					type: 'required_status_checks',
					parameters: { required_status_checks: CONTRACT.requiredContexts },
				},
			],
		},
	};
}

function runRecord(id: number, head: string): unknown[] {
	return CONTRACT.workflows.map((workflow, index) => ({
		id: id + index,
		name: `run-${path.basename(workflow.file)}`,
		path: workflow.file,
		event: 'merge_group',
		status: 'completed',
		conclusion: 'success',
		head_sha: head,
	}));
}

/**
 * checkRunsFor: builds the check-run list for a head. The FIRST required
 * context's runs are caller-controlled (the binding surface); every other
 * required context is a clean single success.
 */
function checkRunsFor(firstRequiredRuns: unknown[]): unknown {
	return {
		check_runs: [
			...firstRequiredRuns,
			...CONTRACT.requiredContexts.slice(1).map((name) => ({
				name,
				status: 'completed',
				conclusion: 'success',
			})),
		],
	};
}

function installApi(
	checkRunsByHead: Record<string, unknown>,
	runsOrder: unknown[],
): void {
	_internals.ghApi = ((endpoint: string) => {
		if (endpoint.startsWith(`/repos/${CONTRACT.repository}/rulesets/`)) {
			return rulesetJson();
		}
		if (endpoint.includes('/rules/branches/')) {
			return {
				ok: true,
				status: 0,
				json: [
					{ type: 'pull_request', ruleset_id: Number(CONTRACT.rulesetId) },
					{
						type: 'required_status_checks',
						ruleset_id: Number(CONTRACT.rulesetId),
					},
					{ type: 'merge_queue', ruleset_id: Number(CONTRACT.rulesetId) },
				],
			};
		}
		if (endpoint.includes('/branches/')) {
			return { ok: true, status: 0, json: { protected: true } };
		}
		if (endpoint.includes('/actions/runs?')) {
			return { ok: true, status: 0, json: { workflow_runs: runsOrder } };
		}
		if (endpoint.includes('/check-runs')) {
			const head = /\/commits\/([0-9a-f]{40})\/check-runs/.exec(endpoint)?.[1];
			return {
				ok: true,
				status: 0,
				json: checkRunsByHead[head ?? ''] ?? { check_runs: [] },
			};
		}
		if (endpoint.includes('/contents/')) {
			return {
				ok: true,
				status: 0,
				json: {
					sha: 'a'.repeat(40),
					encoding: 'base64',
					content: Buffer.from(WORKFLOW_CONTENT, 'utf-8').toString('base64'),
				},
			};
		}
		return {
			ok: false,
			status: 404,
			json: null,
			error: `unexpected ${endpoint}`,
		};
	}) as typeof _internals.ghApi;
}

function cleanRun(name: string): unknown {
	return { name, status: 'completed', conclusion: 'success' };
}

beforeEach(() => {
	// default: no interception (direct-helper legs need none)
});

afterEach(() => {
	_internals.ghApi = originalGhApi;
});

describe('capture success-set producer binding (#3716 item 2)', () => {
	test('a foreign-app singleton at the newest head is not credited — the capture skips to the older, cleanly-produced head', async () => {
		const root = canonicalMkdtemp('capture-foreign-3716-');
		try {
			seedLocalWorkflows(root);
			installApi(
				{
					[headNew]: checkRunsFor([
						{
							name: FIRST_REQUIRED,
							status: 'completed',
							conclusion: 'success',
							app: { slug: FOREIGN_APP },
						},
					]),
					[headOld]: checkRunsFor([cleanRun(FIRST_REQUIRED)]),
				},
				[
					...runRecord(42999999990, headNew),
					...runRecord(42999999980, headOld),
				],
			);
			const artifact = runCapture(root) as {
				captureSha: string;
				mergeGroup: { contexts?: string[] };
			};
			expect(artifact.captureSha).toBe(headOld);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	test('same-named successful runs from different apps still refuse the capture terminally (rule 2 preserved)', async () => {
		const root = canonicalMkdtemp('capture-ambig-3716-');
		try {
			seedLocalWorkflows(root);
			installApi(
				{
					[headNew]: checkRunsFor([
						{
							name: FIRST_REQUIRED,
							status: 'completed',
							conclusion: 'success',
							app: { slug: 'github-actions' },
						},
						{
							name: FIRST_REQUIRED,
							status: 'completed',
							conclusion: 'success',
							app: { slug: FOREIGN_APP },
						},
					]),
				},
				[...runRecord(42999999990, headNew)],
			);
			expect(() => runCapture(root)).toThrow(CaptureRefusal);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	test('same-named successful runs from the SAME app satisfy the context (control)', async () => {
		const root = canonicalMkdtemp('capture-sameapp-3716-');
		try {
			seedLocalWorkflows(root);
			installApi(
				{
					[headNew]: checkRunsFor([
						{
							name: FIRST_REQUIRED,
							status: 'completed',
							conclusion: 'success',
							app: { slug: 'github-actions' },
						},
						{
							name: FIRST_REQUIRED,
							status: 'completed',
							conclusion: 'success',
							app: { slug: 'github-actions' },
						},
					]),
				},
				[...runRecord(42999999990, headNew)],
			);
			const artifact = runCapture(root) as {
				captureSha: string;
				mergeGroup: { contexts?: string[] };
			};
			expect(artifact.captureSha).toBe(headNew);
			expect(artifact.mergeGroup.contexts).toContain(FIRST_REQUIRED);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);
});

describe('contextRunsSatisfyBinding direct legs (#3716 item 2)', () => {
	const HEAD = 'a'.repeat(40);

	test('a singleton success with no app field satisfies (legacy tolerance)', () => {
		expect(
			contextRunsSatisfyBinding(
				FIRST_REQUIRED,
				[cleanRun(FIRST_REQUIRED)],
				HEAD,
			),
		).toBe(true);
	});

	test('a foreign explicit app slug does not satisfy (head skip, not refusal)', () => {
		expect(() =>
			contextRunsSatisfyBinding(
				FIRST_REQUIRED,
				[
					{
						name: FIRST_REQUIRED,
						status: 'completed',
						conclusion: 'success',
						app: { slug: FOREIGN_APP },
					},
				],
				HEAD,
			),
		).not.toThrow();
		expect(
			contextRunsSatisfyBinding(
				FIRST_REQUIRED,
				[
					{
						name: FIRST_REQUIRED,
						status: 'completed',
						conclusion: 'success',
						app: { slug: FOREIGN_APP },
					},
				],
				HEAD,
			),
		).toBe(false);
	});

	test('a failing duplicate makes the head unqualifying (skip, F-002 preserved)', () => {
		expect(
			contextRunsSatisfyBinding(
				FIRST_REQUIRED,
				[
					cleanRun(FIRST_REQUIRED),
					{ name: FIRST_REQUIRED, status: 'completed', conclusion: 'failure' },
				],
				HEAD,
			),
		).toBe(false);
	});

	test('a missing-app duplicate refuses terminally (exact message shape)', () => {
		try {
			contextRunsSatisfyBinding(
				FIRST_REQUIRED,
				[
					cleanRun(FIRST_REQUIRED),
					{ ...cleanRun(FIRST_REQUIRED), app: { slug: null } },
				],
				HEAD,
			);
			throw new Error('expected CaptureRefusal');
		} catch (error) {
			expect(error).toBeInstanceOf(CaptureRefusal);
			expect((error as Error).message).toContain(
				`ambiguous producer binding at head ${HEAD}`,
			);
		}
	});
});
