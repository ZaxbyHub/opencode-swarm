/**
 * F-008 (PR #3718 swarm-pr-review test-quality cluster): the artifact WRITE
 * path for the duplicate-name binding contract is pinned through `main()`
 * with the `_internals.writeArtifactAtomic` seam stubbed — the real write
 * boundary. The sibling capture-required-context-binding-3661.test.ts pins
 * the refusal/selection behavior through `runCapture`, which never writes;
 * its former `expect(writes).toEqual([])` assertions were vacuous and were
 * replaced by these real legs.
 *
 * Legs:
 *  - refusal shape: a single candidate head carrying a failing duplicate ->
 *    main() exits 1 (the CaptureRefusal catch), the terminal refusal is
 *    logged, and NOTHING is written (a pre-refusal partial write would be a
 *    committed-evidence corruption the vacuous assertion never guarded).
 *  - success shape: the same-app duplicate control -> main() exits 0 and
 *    writes EXACTLY ONE artifact to the explicit --output target, whose
 *    contents carry the capture SHA and the bound contexts.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	main,
} from '../../../scripts/capture-required-check-evidence';
import {
	CONTRACT_PATH,
	EVIDENCE_PATH,
} from '../../../scripts/check-required-check-contract';
import { canonicalMkdtemp, removeTreeWithRetry } from '../../helpers/tmpdir';

const CONTRACT = JSON.parse(fs.readFileSync(CONTRACT_PATH, 'utf-8')) as {
	repository: string;
	rulesetId: string;
	requiredContexts: string[];
	workflows: Array<{ file: string }>;
};
const EVIDENCE_JSON = JSON.parse(
	fs.readFileSync(EVIDENCE_PATH, 'utf-8'),
) as Record<string, unknown>;

const WORKFLOW_CONTENT =
	'on:\n  pull_request:\n  merge_group:\njobs:\n  quality:\n';

let root = '';
const originalGhApi = _internals.ghApi;
const originalWrite = _internals.writeArtifactAtomic;
const writes: Array<{ target: string; contents: string }> = [];

function seedLocalWorkflows(): void {
	for (const workflow of CONTRACT.workflows) {
		fs.mkdirSync(path.join(root, path.dirname(workflow.file)), {
			recursive: true,
		});
		fs.writeFileSync(path.join(root, workflow.file), WORKFLOW_CONTENT, 'utf-8');
	}
}

/** Green API; the first required context carries a duplicate pair per mode. */
function api(pairMode: 'failure-sibling' | 'same-app'): void {
	const headSha = EVIDENCE_JSON.captureSha as string;
	const duplicated = CONTRACT.requiredContexts[0] as string;
	const pair =
		pairMode === 'failure-sibling'
			? [
					{ name: duplicated, status: 'completed', conclusion: 'success' },
					{ name: duplicated, status: 'completed', conclusion: 'failure' },
				]
			: [
					{
						name: duplicated,
						status: 'completed',
						conclusion: 'success',
						app: { slug: 'github-actions' },
					},
					{
						name: duplicated,
						status: 'completed',
						conclusion: 'success',
						app: { slug: 'github-actions' },
					},
				];
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
					],
				},
			};
		}
		if (endpoint.includes('/check-runs')) {
			return {
				ok: true,
				status: 0,
				json: {
					check_runs: [
						...pair,
						...CONTRACT.requiredContexts.slice(1).map((name) => ({
							name,
							status: 'completed',
							conclusion: 'success',
						})),
					],
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

describe('capture-required-check-evidence artifact write path (F-008)', () => {
	beforeEach(() => {
		root = canonicalMkdtemp('capture-write-path-3661-');
		writes.length = 0;
		_internals.writeArtifactAtomic = (target: string, contents: string) => {
			writes.push({ target, contents });
		};
	});

	afterEach(() => {
		_internals.ghApi = originalGhApi;
		_internals.writeArtifactAtomic = originalWrite;
		removeTreeWithRetry(root);
	});

	test('main() exits 1 and writes NOTHING when the only candidate head carries a failing duplicate', () => {
		api('failure-sibling');
		seedLocalWorkflows();
		const target = path.join(root, 'evidence.json');
		const code = main(['--output', target], root);
		expect(code).toBe(1);
		// The real no-write guard the vacuous runCapture assertion could never
		// provide: a refusal must leave the --output target untouched.
		expect(writes).toEqual([]);
		expect(fs.existsSync(target)).toBe(false);
	}, 60_000);

	test('main() exits 0 and writes EXACTLY ONE artifact to --output when the binding is unambiguous', () => {
		api('same-app');
		seedLocalWorkflows();
		const target = path.join(root, 'evidence.json');
		const code = main(['--output', target], root);
		expect(code).toBe(0);
		expect(writes.length).toBe(1);
		expect(writes[0]?.target).toBe(target);
		const artifact = JSON.parse(writes[0]?.contents ?? '{}') as {
			captureSha?: string;
			mergeGroup?: { contexts?: string[] };
		};
		expect(artifact.captureSha).toBe(EVIDENCE_JSON.captureSha);
		expect(
			(artifact.mergeGroup?.contexts ?? []).includes(
				CONTRACT.requiredContexts[0] as string,
			),
		).toBe(true);
	}, 60_000);
});
