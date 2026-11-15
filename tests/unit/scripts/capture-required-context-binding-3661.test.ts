/**
 * #3661 AC3 — a required context that matches MULTIPLE check runs at a
 * candidate head must bind unambiguously, or the capture refuses.
 *
 * At the current code the candidate-head gate uses
 * `all.find((run) => run.name === name)` — the FIRST same-named run wins —
 * so a head carrying TWO runs named like a required context, one
 * completed+success and one completed+failure, passes the gate (the success
 * entry is found first) and the capture never notices the failed sibling.
 * The failure conclusion is evidence that the context did NOT succeed at
 * that head; every same-named run must be completed+success and the match
 * must bind to the producing app, else the capture must refuse.
 *
 * RED at the current code: the fixture below (success entry listed FIRST)
 * sails through `runCapture` and returns an artifact — no CaptureRefusal is
 * thrown at all.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	CaptureRefusal,
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

let root = '';
const originalGhApi = _internals.ghApi;
const originalWrite = _internals.writeArtifactAtomic;
const writes: Array<{ target: string; contents: string }> = [];

/** Seed the local workflow files (hashes must match the served contents). */
function seedLocalWorkflows(): void {
	for (const workflow of CONTRACT.workflows) {
		fs.mkdirSync(path.join(root, path.dirname(workflow.file)), {
			recursive: true,
		});
		fs.writeFileSync(path.join(root, workflow.file), WORKFLOW_CONTENT, 'utf-8');
	}
}

/** One check-run record at the candidate head (GitHub Checks API shape). */
type CheckRunRecord = {
	name: string;
	status: string;
	conclusion: string | null;
	app?: { slug: string } | null;
};

/** Build the duplicate-name pair for the first required context per mode:
 *  - failure-sibling: one success + one failure conclusion (the original leg);
 *  - differing-app:   both success, different app slugs;
 *  - missing-app:     both success, one app null (ambiguous identity);
 *  - same-app:        both success, SAME app slug (the accepting control). */
function duplicatePair(
	mode: 'failure-sibling' | 'differing-app' | 'missing-app' | 'same-app',
): CheckRunRecord[] {
	const duplicated = CONTRACT.requiredContexts[0] as string;
	if (mode === 'failure-sibling') {
		return [
			{ name: duplicated, status: 'completed', conclusion: 'success' },
			{ name: duplicated, status: 'completed', conclusion: 'failure' },
		];
	}
	if (mode === 'differing-app') {
		return [
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
				app: { slug: 'some-other-app' },
			},
		];
	}
	if (mode === 'missing-app') {
		return [
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
				app: null,
			},
		];
	}
	return [
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
}

/** The green API fixture from capture-required-check-evidence.test.ts, with
 *  the check-run set at the candidate head carrying a DUPLICATE-NAME pair. */
function duplicateNameApi(pair: CheckRunRecord[]): void {
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
			// The duplicate-name pair comes FIRST (the current find() picks the
			// first same-named entry); every other required context appears
			// once, successful.
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

describe('capture-required-check-evidence duplicate-name context binding (#3661 AC3)', () => {
	beforeEach(() => {
		root = canonicalMkdtemp('capture-context-binding-3661-');
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

	test('a required context matching a success run AND a failure run at the candidate head refuses the capture', () => {
		duplicateNameApi(duplicatePair('failure-sibling'));
		seedLocalWorkflows();
		let refusal: unknown;
		try {
			runCapture(root);
		} catch (error) {
			refusal = error;
		}
		// RED at the current code: the find() picks the success entry, the
		// failed sibling is never examined, and runCapture returns an artifact
		// (no refusal is thrown at all).
		expect(refusal).toBeInstanceOf(CaptureRefusal);
		const message = (refusal as Error).message.toLowerCase();
		expect(/quality|binding/.test(message)).toBe(true);
		expect(writes).toEqual([]);
	}, 60_000);

	// C14 (critic amendment): same-named runs from DIFFERENT apps cannot bind
	// to one producing app — the capture must refuse naming the context or
	// the binding. RED at the current code (app identity is never examined;
	// find() picks the first success and the capture proceeds).
	test('C14: same-named successful runs from different apps refuse the capture', () => {
		duplicateNameApi(duplicatePair('differing-app'));
		seedLocalWorkflows();
		let refusal: unknown;
		try {
			runCapture(root);
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(CaptureRefusal);
		const message = (refusal as Error).message.toLowerCase();
		expect(/quality|binding/.test(message)).toBe(true);
		expect(writes).toEqual([]);
	}, 60_000);

	// C14: an app-less duplicate cannot bind at all — identity is ambiguous.
	// RED at the current code (same fall-through as above).
	test('C14: same-named successful runs with a missing app on one refuse the capture', () => {
		duplicateNameApi(duplicatePair('missing-app'));
		seedLocalWorkflows();
		let refusal: unknown;
		try {
			runCapture(root);
		} catch (error) {
			refusal = error;
		}
		expect(refusal).toBeInstanceOf(CaptureRefusal);
		const message = (refusal as Error).message.toLowerCase();
		expect(/quality|binding/.test(message)).toBe(true);
		expect(writes).toEqual([]);
	}, 60_000);

	// C14 CONTROL leg (green at the base by design — its discrimination comes
	// from the refusing legs above): two same-named successful runs from the
	// SAME app bind unambiguously, so the capture must proceed. Current code
	// accepts (find() picks the first success), and the post-fix binding rule
	// must keep accepting this shape.
	test('C14 control: same-named successful runs from the same app proceed with the capture', () => {
		duplicateNameApi(duplicatePair('same-app'));
		seedLocalWorkflows();
		const artifact = runCapture(root);
		expect(artifact.captureSha).toBe(EVIDENCE_JSON.captureSha);
		expect(
			(artifact.mergeGroup?.contexts ?? []).includes(
				CONTRACT.requiredContexts[0] as string,
			),
		).toBe(true);
		// runCapture itself never writes; main() does. Nothing written here.
		expect(writes).toEqual([]);
	}, 60_000);
});
