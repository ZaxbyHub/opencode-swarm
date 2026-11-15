/**
 * #3661 AC5 — merge-group run receipts recorded as "observed" must be scoped
 * to the CONTRACT's workflows.
 *
 * The listing endpoint (`/actions/runs?event=merge_group&status=success`)
 * returns every successful merge-group run at the head, including runs of
 * workflows that are NOT in the contract. At the current code
 * `observedRuns` copies every selected run unfiltered, so the generated
 * artifact carries a receipt with a non-contract `workflowPath` — and the
 * validator's own offline evaluation (EVIDENCE_MERGE_GROUP_UNKNOWN:
 * `!contractWorkflowFiles.includes(run.workflowPath)`) refuses the artifact
 * the capture itself just produced.
 *
 * RED at the current code: runCapture throws a CaptureRefusal (the
 * non-contract run is included). After the fix the capture excludes
 * non-contract runs from observedRuns and completes offline.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	runCapture,
} from '../../../scripts/capture-required-check-evidence';
import {
	CONTRACT_PATH,
	EVIDENCE_PATH,
} from '../../../scripts/check-required-check-contract';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const CONTRACT_JSON = fs.readFileSync(CONTRACT_PATH, 'utf-8');
const EVIDENCE_JSON = JSON.parse(
	fs.readFileSync(EVIDENCE_PATH, 'utf-8'),
) as Record<string, unknown>;

const CONTRACT = JSON.parse(CONTRACT_JSON) as {
	repository: string;
	rulesetId: string;
	requiredContexts: string[];
	workflows: Array<{ file: string }>;
};

const WORKFLOW_CONTENT =
	'on:\n  pull_request:\n  merge_group:\njobs:\n  quality:\n';
const NON_CONTRACT_WORKFLOW = '.github/workflows/not-in-contract.yml';

let root = '';
const originalGhApi = _internals.ghApi;
const originalWrite = _internals.writeArtifactAtomic;

function seedLocalWorkflows(): void {
	for (const workflow of CONTRACT.workflows) {
		fs.mkdirSync(path.join(root, path.dirname(workflow.file)), {
			recursive: true,
		});
		fs.writeFileSync(path.join(root, workflow.file), WORKFLOW_CONTENT, 'utf-8');
	}
}

/** The green fixture plus ONE extra merge-group run at the candidate head
 *  for a workflow that is NOT in the contract. */
function extraRunApi(): void {
	const headSha = EVIDENCE_JSON.captureSha as string;
	_internals.ghApi = ((endpoint: string) => {
		if (endpoint.startsWith(`/repos/${CONTRACT.repository}/rulesets/`)) {
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
			return {
				ok: true,
				status: 0,
				json: {
					workflow_runs: [
						{
							id: 42999999999,
							name: 'CI',
							path: '.github/workflows/ci.yml',
							event: 'merge_group',
							status: 'completed',
							conclusion: 'success',
							head_sha: headSha,
						},
						{
							id: 42999999998,
							name: 'PR Standards',
							path: '.github/workflows/pr-standards.yml',
							event: 'merge_group',
							status: 'completed',
							conclusion: 'success',
							head_sha: headSha,
						},
						{
							// A merge-group run at the SAME head for a workflow the
							// contract does not know.
							id: 42999999995,
							name: 'Not In Contract',
							path: NON_CONTRACT_WORKFLOW,
							event: 'merge_group',
							status: 'completed',
							conclusion: 'success',
							head_sha: headSha,
						},
					],
				},
			};
		}
		if (endpoint.includes('/check-runs')) {
			return {
				ok: true,
				status: 0,
				json: {
					check_runs: CONTRACT.requiredContexts.map((name) => ({
						name,
						status: 'completed',
						conclusion: 'success',
					})),
				},
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

describe('capture-required-check-evidence observed-runs scope (#3661 AC5)', () => {
	beforeEach(() => {
		root = canonicalMkdtemp('capture-observed-runs-3661-');
	});

	afterEach(() => {
		_internals.ghApi = originalGhApi;
		_internals.writeArtifactAtomic = originalWrite;
		removeTreeWithRetry(root);
	});

	test('a merge-group run for a non-contract workflow at the head is excluded from observedRuns and the capture still succeeds', () => {
		extraRunApi();
		seedLocalWorkflows();
		// RED at the current code: the non-contract run lands in observedRuns,
		// the offline evaluation reddens with EVIDENCE_MERGE_GROUP_UNKNOWN,
		// and runCapture refuses.
		const artifact = runCapture(root);
		const observed = artifact.mergeGroup?.observedRuns ?? [];
		expect(observed.length).toBeGreaterThan(0);
		const contractFiles = CONTRACT.workflows.map((workflow) => workflow.file);
		for (const run of observed) {
			expect(contractFiles).toContain(run.workflowPath);
		}
		expect(
			observed.some((run) => run.workflowPath === NON_CONTRACT_WORKFLOW),
		).toBe(false);
	}, 60_000);
});
