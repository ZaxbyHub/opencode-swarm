/**
 * #3653 AC2 regression tests for scripts/capture-required-check-evidence.ts.
 *
 * The capture script's _internals seam (ghApi, writeArtifactAtomic) is
 * mocked; the validator reuse is REAL (the generated artifact must satisfy
 * evaluateRequiredCheckContract, exactly as at runtime). Fixtures mirror the
 * committed contract/artifact shapes on a canonicalMkdtemp root.
 *
 * NEW-SURFACE: the script does not exist at base; every test here is red
 * there by construction (module-not-found) and green after the fix.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	CaptureRefusal,
	main as captureMain,
	runCapture,
	runSelfTest,
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

let root = '';
const originalGhApi = _internals.ghApi;
const originalWrite = _internals.writeArtifactAtomic;
const writes: Array<{ target: string; contents: string }> = [];

beforeEach(() => {
	root = canonicalMkdtemp('capture-evidence-test-');
	fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
	fs.mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true });
	fs.writeFileSync(
		path.join(root, 'scripts', 'required-check-contract.json'),
		CONTRACT_JSON,
	);
	writes.length = 0;
	_internals.writeArtifactAtomic = (target: string, contents: string) => {
		writes.push({ target, contents });
	};
});

afterEach(() => {
	_internals.ghApi = originalGhApi;
	_internals.writeArtifactAtomic = originalWrite;
	mock.restore();
	removeTreeWithRetry(root);
});

const CONTRACT = JSON.parse(CONTRACT_JSON) as {
	repository: string;
	rulesetId: string;
	requiredContexts: string[];
	workflows: Array<{ file: string }>;
};

/** Seed the local workflow files (sha256 matches the served contents). */
function seedLocalWorkflows(
	content = 'on:\n  pull_request:\n  merge_group:\njobs:\n  quality:\n',
): void {
	for (const workflow of CONTRACT.workflows) {
		fs.mkdirSync(path.join(root, path.dirname(workflow.file)), {
			recursive: true,
		});
		fs.writeFileSync(path.join(root, workflow.file), content, 'utf-8');
	}
}

/** A green API fixture: every required context successful on one head. */
function greenApi(): void {
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
					content: Buffer.from(
						'on:\n  pull_request:\n  merge_group:\njobs:\n  quality:\n',
						'utf-8',
					).toString('base64'),
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

describe('capture-required-check-evidence — full capture (mocked API)', () => {
	test('green fixture generates an artifact the validator accepts offline', () => {
		greenApi();
		seedLocalWorkflows();
		const artifact = runCapture(root);
		expect(artifact.captureSha).toBe(EVIDENCE_JSON.captureSha);
		expect(artifact.mergeGroup?.contexts).toEqual(CONTRACT.requiredContexts);
		expect(artifact.mergeGroup?.observedRuns?.length).toBeGreaterThan(0);
		for (const workflow of CONTRACT.workflows) {
			const capture = artifact.capturedWorkflowFiles?.[workflow.file];
			expect(capture?.contentsEndpoint).toContain(
				`/contents/${workflow.file}?ref=${artifact.captureSha}`,
			);
			const sourceEndpoints = (artifact.sources ?? [])
				.map((source) => source.endpoint)
				.join('\n');
			expect(sourceEndpoints).toContain(capture!.contentsEndpoint);
		}
	}, 60_000);

	test('a candidate head missing one required context is refused (no write)', () => {
		greenApi();
		seedLocalWorkflows();
		const green = _internals.ghApi;
		_internals.ghApi = ((endpoint: string) => {
			if (endpoint.includes('/check-runs')) {
				return {
					ok: true,
					status: 0,
					json: {
						check_runs: CONTRACT.requiredContexts.slice(1).map((name) => ({
							name,
							status: 'completed',
							conclusion: 'success',
						})),
					},
				};
			}
			return (green as (e: string) => unknown)(endpoint) as ReturnType<
				typeof green
			>;
		}) as typeof _internals.ghApi;
		expect(() => runCapture(root)).toThrow(CaptureRefusal);
	}, 60_000);

	test('local workflow divergence from the captured blob is refused', () => {
		greenApi();
		seedLocalWorkflows('on:\n  push:\n');
		expect(() => runCapture(root)).toThrow(CaptureRefusal);
	}, 60_000);
});

describe('capture-required-check-evidence — self-test', () => {
	test('committed artifact passes (reroute to the real evidence path)', () => {
		// runSelfTest reads the committed paths by default; on CI the
		// committed artifact is fresh, and on any host it is well-formed.
		const consoleLog = console.log;
		const lines: string[] = [];
		console.log = ((line: string) => {
			lines.push(line);
		}) as typeof console.log;
		try {
			const ok = runSelfTest();
			expect(lines.some((line) => line.startsWith('self-test: PASS'))).toBe(
				true,
			);
			expect(ok).toBe(true);
		} finally {
			console.log = consoleLog;
		}
	}, 60_000);

	test('a malformed artifact (bad captureSha hex) fails the self-test', () => {
		const malformedPath = path.join(root, 'malformed-evidence.json');
		const malformed = {
			...JSON.parse(JSON.stringify(EVIDENCE_JSON)),
			captureSha: 'not-hex',
		};
		fs.writeFileSync(malformedPath, JSON.stringify(malformed, null, '\t'));
		const consoleError = console.error;
		const errors: string[] = [];
		console.error = ((line: string) => {
			errors.push(line);
		}) as typeof console.error;
		try {
			const ok = runSelfTest(malformedPath);
			expect(ok).toBe(false);
			expect(errors.some((line) => line.includes('self-test: FAIL'))).toBe(
				true,
			);
		} finally {
			console.error = consoleError;
		}
	}, 60_000);

	test('a ruleset scoped away from the branch is refused', () => {
		greenApi();
		seedLocalWorkflows();
		const green = _internals.ghApi;
		_internals.ghApi = ((endpoint: string) => {
			if (endpoint.startsWith(`/repos/${CONTRACT.repository}/rulesets/`)) {
				return {
					ok: true,
					status: 0,
					json: {
						id: Number(CONTRACT.rulesetId),
						enforcement: 'active',
						conditions: { ref_name: { include: ['refs/heads/other'] } },
						rules: [
							{
								type: 'required_status_checks',
								parameters: {
									required_status_checks: CONTRACT.requiredContexts,
								},
							},
						],
					},
				};
			}
			return (green as (e: string) => unknown)(endpoint) as ReturnType<
				typeof green
			>;
		}) as typeof _internals.ghApi;
		expect(() => runCapture(root)).toThrow(CaptureRefusal);
	}, 60_000);

	test('merge-group runs on a head with no complete check-run set are refused', () => {
		greenApi();
		seedLocalWorkflows();
		const green = _internals.ghApi;
		_internals.ghApi = ((endpoint: string) => {
			if (endpoint.includes('/actions/runs?')) {
				const wrongHead = 'f'.repeat(40);
				const wrongRun = (id: number, name: string, wfPath: string) => ({
					id,
					name,
					path: wfPath,
					event: 'merge_group',
					status: 'completed',
					conclusion: 'success',
					head_sha: wrongHead,
				});
				return {
					ok: true,
					status: 0,
					json: {
						workflow_runs: [
							wrongRun(42999999997, 'CI', '.github/workflows/ci.yml'),
							wrongRun(
								42999999996,
								'PR Standards',
								'.github/workflows/pr-standards.yml',
							),
						],
					},
				};
			}
			if (endpoint.includes('/check-runs')) {
				// The wrong head has NO completed successful check runs, so
				// no candidate qualifies and the capture refuses.
				return { ok: true, status: 0, json: { check_runs: [] } };
			}
			if (endpoint.includes('/contents/')) {
				return {
					ok: true,
					status: 0,
					json: {
						sha: 'a'.repeat(40),
						encoding: 'base64',
						content: Buffer.from(
							'on:\n  pull_request:\n  merge_group:\njobs:\n  quality:\n',
							'utf-8',
						).toString('base64'),
					},
				};
			}
			return (green as (e: string) => unknown)(endpoint) as ReturnType<
				typeof green
			>;
		}) as typeof _internals.ghApi;
		expect(() => runCapture(root)).toThrow(CaptureRefusal);
	}, 60_000);

	test('main() writes the artifact atomically on success (positive control for the write seam)', () => {
		greenApi();
		seedLocalWorkflows();
		const target = path.join(root, 'captured.json');
		const rc = captureMain(['--output', target], root);
		expect(rc).toBe(0);
		expect(writes.length).toBe(1);
		expect(writes[0]?.target).toBe(target);
		const written = JSON.parse(writes[0]!.contents) as { captureSha?: string };
		expect(written.captureSha).toBe(EVIDENCE_JSON.captureSha);
	}, 60_000);

	test('main() writes nothing when the capture refuses (negative control)', () => {
		greenApi();
		const green = _internals.ghApi;
		_internals.ghApi = ((endpoint: string) => {
			if (endpoint.includes('/check-runs')) {
				return {
					ok: true,
					status: 0,
					json: {
						check_runs: CONTRACT.requiredContexts.slice(1).map((name) => ({
							name,
							status: 'completed',
							conclusion: 'success',
						})),
					},
				};
			}
			return (green as (e: string) => unknown)(endpoint) as ReturnType<
				typeof green
			>;
		}) as typeof _internals.ghApi;
		seedLocalWorkflows();
		const target = path.join(root, 'refused.json');
		const rc = captureMain(['--output', target], root);
		expect(rc).toBe(1);
		expect(writes).toEqual([]);
	}, 60_000);
});
