import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
	changedFilesFromGitResult,
	collectRequiredCheckContract,
	deriveReleaseAutomation,
	evaluateReleaseOwnership,
	evaluateRequiredCheckContract,
	parseWorkflowSurface,
	releaseOwnerDiffArgs,
} from '../../../scripts/check-required-check-contract';
import {
	DETECTORS,
	detectRequiredCheckContractDrift,
} from '../../../scripts/drift-check';

const repoRoot = resolve(import.meta.dir, '../../..');

function readWorkflow(file: string): string {
	return readFileSync(resolve(repoRoot, file), 'utf8');
}

function readEvidence(): Record<string, unknown> {
	return JSON.parse(
		readFileSync(
			resolve(repoRoot, 'docs/ci/required-check-evidence.json'),
			'utf8',
		),
	) as Record<string, unknown>;
}

describe('issue #2677 required-check contract wiring', () => {
	test('the real contract is registered and only reports the pre-promotion notice', () => {
		const result = collectRequiredCheckContract(repoRoot);
		expect(result.ok).toBe(true);
		expect(result.findings.length).toBeGreaterThan(0);
		expect(
			result.findings.every(
				(finding) =>
					finding.code === 'RULESET_DIVERGENCE' &&
					finding.severity === 'notice',
			),
		).toBe(true);
		expect(DETECTORS.map(([category]) => category)).toContain(
			'required-check-contract',
		);
		expect(detectRequiredCheckContractDrift(repoRoot)[0]?.severity).toBe(
			'notice',
		);
	});

	test('all contract-owned workflows expose the required event and job surfaces', () => {
		const ci = parseWorkflowSurface(
			readWorkflow('.github/workflows/ci.yml'),
			'ci.yml',
		);
		const standards = parseWorkflowSurface(
			readWorkflow('.github/workflows/pr-standards.yml'),
			'pr-standards.yml',
		);
		const drift = parseWorkflowSurface(
			readWorkflow('.github/workflows/drift-check.yml'),
			'drift-check.yml',
		);
		expect(ci.events).toEqual(
			expect.arrayContaining(['pull_request', 'merge_group']),
		);
		expect(ci.mergeGroupTypes).toEqual(['checks_requested']);
		expect(ci.jobs).toEqual(
			expect.arrayContaining(['quality', 'unit', 'coverage', 'smoke']),
		);
		expect(standards.events).toEqual(
			expect.arrayContaining(['pull_request', 'merge_group']),
		);
		expect(standards.mergeGroupTypes).toEqual(['checks_requested']);
		expect(standards.jobs).toEqual(
			expect.arrayContaining(['check-title', 'pr-standards']),
		);
		expect(drift.events).toEqual(
			expect.arrayContaining(['pull_request', 'push', 'merge_group']),
		);
		expect(drift.mergeGroupTypes).toEqual(['checks_requested']);
		expect(drift.jobs).toContain('drift');
	});

	test('merge-group type mutation is detected instead of accepting any activity', () => {
		const source = readWorkflow('.github/workflows/ci.yml');
		const mutated = source.replace(
			'types: [checks_requested]',
			'types: [completed]',
		);

		expect(mutated).not.toBe(source);
		expect(parseWorkflowSurface(mutated, 'ci.yml').mergeGroupTypes).toEqual([
			'completed',
		]);
		expect(
			parseWorkflowSurface(mutated, 'ci.yml').mergeGroupTypes,
		).not.toContain('checks_requested');
	});

	test('quoted top-level on keys retain workflow event discovery', () => {
		const source = readWorkflow('.github/workflows/ci.yml');
		const doubleQuoted = source.replace(/^on:/m, '"on":');
		const singleQuoted = source.replace(/^on:/m, "'on':");
		expect(parseWorkflowSurface(doubleQuoted, 'ci.yml').events).toEqual(
			expect.arrayContaining(['pull_request', 'merge_group']),
		);
		expect(parseWorkflowSurface(singleQuoted, 'ci.yml').events).toEqual(
			expect.arrayContaining(['pull_request', 'merge_group']),
		);
	});

	test('a context owner mutation is rejected instead of silently re-anchoring coverage', () => {
		const contract = JSON.parse(
			readFileSync(
				resolve(repoRoot, 'scripts/required-check-contract.json'),
				'utf8',
			),
		) as {
			contexts: {
				required: Array<Record<string, unknown>>;
				intendedRequired: Array<Record<string, unknown>>;
			};
		} & Record<string, unknown>;
		const result = evaluateRequiredCheckContract(
			{
				...contract,
				contexts: {
					required: contract.contexts.required.map((record) =>
						record.name === 'quality'
							? { ...record, job: 'wrong-owner' }
							: record,
					),
					intendedRequired: contract.contexts.intendedRequired,
				},
				evidence: readEvidence(),
			},
			{ strict: true, now: new Date('2026-09-11T22:00:00Z') },
		);

		expect(result.ok).toBe(false);
		expect(result.findings.map((finding) => finding.code)).toContain(
			'CONTRACT_MALFORMED',
		);
	});

	test('quality remains a required failure when the release-owner guard fails', () => {
		const qualityStart = readWorkflow('.github/workflows/ci.yml').indexOf(
			'\n  quality:',
		);
		const unitStart = readWorkflow('.github/workflows/ci.yml').indexOf(
			'\n  unit:',
			qualityStart,
		);
		const quality = readWorkflow('.github/workflows/ci.yml').slice(
			qualityStart,
			unitStart,
		);

		expect(quality).toContain('needs: [detect-release, release-owner-guard]');
		expect(quality).toMatch(/^ {4}if: always\(\)$/m);
		expect(
			quality.indexOf('- name: Release-owner guard dependency check'),
		).toBeGreaterThan(-1);
		expect(quality).toMatch(
			/- name: Release-owner guard dependency check[\s\S]*?if: always\(\)[\s\S]*?exit 1/,
		);
		expect(
			quality.indexOf('- name: Release-owner guard dependency check'),
		).toBeLessThan(quality.indexOf('- uses: actions/checkout@'));
		expect(quality).toContain('needs.release-owner-guard.result');
	});

	test('an intended-only external event gap stays visible without blocking local trigger coverage', () => {
		const result = evaluateRequiredCheckContract({
			contract: {
				requiredContexts: ['quality'],
				intendedRequiredContexts: ['drift'],
			},
			workflows: [
				{
					file: 'ci.yml',
					events: ['pull_request', 'merge_group'],
					contexts: ['quality'],
				},
				{
					file: 'drift-check.yml',
					events: ['workflow_dispatch', 'pull_request', 'push', 'merge_group'],
					contexts: ['drift'],
				},
			],
			evidence: {
				ruleset: { requiredContexts: ['quality'] },
				branch: { name: 'main', protected: true },
				mergeGroup: { contexts: ['quality'] },
				workflowEvents: {
					ci: ['pull_request', 'merge_group'],
					drift: ['workflow_dispatch', 'pull_request', 'push'],
				},
			},
		});

		expect(result.ok).toBe(true);
		expect(result.findings).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: 'RULESET_DIVERGENCE',
					severity: 'notice',
				}),
			]),
		);
		expect(
			result.findings.some((finding) => finding.severity === 'error'),
		).toBe(false);
	});

	test('an already-required external event gap remains blocking', () => {
		const result = evaluateRequiredCheckContract({
			contract: { requiredContexts: ['drift'] },
			workflows: [
				{
					file: 'drift-check.yml',
					events: ['pull_request', 'merge_group'],
					contexts: ['drift'],
				},
			],
			evidence: {
				ruleset: { requiredContexts: ['drift'] },
				branch: { name: 'main', protected: true },
				mergeGroup: { contexts: ['drift'] },
				workflowEvents: { drift: ['pull_request'] },
			},
		});

		expect(result.ok).toBe(false);
		expect(result.findings.map((finding) => finding.code)).toContain(
			'PROMISED_CONTEXT_EVENT_SKIPPED',
		);
	});

	test('release automation composes trusted PR identity but not merge-group actor', () => {
		expect(
			deriveReleaseAutomation({
				event: 'pull_request',
				actor: 'github-actions[bot]',
				releaseBranch: 'release-please--main',
			}),
		).toBe(true);
		expect(
			deriveReleaseAutomation({
				event: 'pull_request',
				actor: 'contributor',
				releaseBranch: 'release-please--main',
			}),
		).toBe(false);
		expect(
			deriveReleaseAutomation({
				event: 'merge_group',
				actor: 'contributor',
				headCommitSubject: 'chore(main): release 7.177.0',
			}),
		).toBe(true);
		expect(
			deriveReleaseAutomation({
				event: 'merge_group',
				actor: 'github-actions[bot]',
				headCommitSubject:
					'Merge pull request #1 from ZaxbyHub/release-please--branches--main',
			}),
		).toBe(true);
		expect(
			deriveReleaseAutomation({
				event: 'merge_group',
				actor: 'contributor',
				headCommitSubject:
					'Merge pull request #1 from attacker/release-please--spoof',
			}),
		).toBe(false);
	});

	test('owner anchoring remains exact and evaluator consumes only derived authorization', () => {
		const pending = evaluateReleaseOwnership({
			changedFiles: ['docs/releases/pending/2677.md'],
			releaseAutomation: false,
		});
		expect(pending.ok).toBe(true);
		expect(pending.requiredNotes).toEqual([]);
		const nested = evaluateReleaseOwnership({
			changedFiles: ['docs/package.json'],
			releaseAutomation: false,
		});
		expect(nested.ok).toBe(true);
		const owner = evaluateReleaseOwnership({
			changedFiles: ['package.json'],
			actor: 'github-actions[bot]',
			releaseAutomation: false,
		});
		expect(owner.code).toBe('UNAUTHORIZED_RELEASE_OWNER_EDIT');
		const authorized = evaluateReleaseOwnership({
			changedFiles: ['package.json'],
			actor: 'spoofed-actor',
			releaseAutomation: true,
		});
		expect(authorized.code).toBe('RELEASE_AUTOMATION_EXCEPTION');
	});

	test('release-owner inspection fails closed when Git cannot resolve the diff', () => {
		expect(() =>
			changedFilesFromGitResult({ exitCode: 128, stdout: '' }),
		).toThrow('cannot determine changed files');
		expect(
			changedFilesFromGitResult({ exitCode: 0, stdout: 'package.json\n' }),
		).toEqual(['package.json']);
	});

	test('release-owner diff is pathspec-bounded to exact release-owned files', () => {
		expect(releaseOwnerDiffArgs('base-sha', 'head-sha')).toEqual([
			'diff',
			'--name-only',
			'--no-renames',
			'base-sha',
			'head-sha',
			'--',
			'package.json',
			'CHANGELOG.md',
			'.release-please-manifest.json',
		]);
	});

	test('strict evidence cannot pass stale or demoted captures', () => {
		const base = {
			contract: { requiredContexts: ['quality'], intendedRequiredContexts: [] },
			workflows: [
				{
					file: 'ci.yml',
					events: ['pull_request', 'merge_group'],
					contexts: ['quality'],
				},
			],
			evidence: {
				schemaVersion: 1,
				capturedAt: '2020-01-01T00:00:00Z',
				captureSha: 'b21cdce',
				repository: 'ZaxbyHub/opencode-swarm',
				branch: { name: 'main', protected: true, rulesetId: '17809658' },
				ruleset: {
					id: '17809658',
					enforcement: 'active',
					requiredContexts: ['quality'],
				},
				mergeGroup: { known: true, contexts: ['quality'] },
				workflowEvents: { 'ci.yml': ['pull_request', 'merge_group'] },
				sources: [{ endpoint: 'https://api.github.com/example' }],
			},
		};
		const stale = evaluateRequiredCheckContract(base, {
			now: new Date('2026-09-11T00:00:00Z'),
		});
		expect(stale.status).toBe('unknown');
		expect(stale.findings.map((finding) => finding.code)).toContain(
			'EVIDENCE_STALE',
		);
		const demoted = evaluateRequiredCheckContract(
			{
				...base,
				previousRequiredContexts: ['quality'],
				contract: {
					requiredContexts: [],
					intendedRequiredContexts: ['quality'],
				},
			},
			{ now: new Date('2020-01-02T00:00:00Z') },
		);
		expect(demoted.findings.map((finding) => finding.code)).toContain(
			'CONTRACT_BUCKET_DEMOTION',
		);
	});
});
