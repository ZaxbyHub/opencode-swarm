import { describe, expect, test } from 'bun:test';
import { evaluateFragmentCheck } from '../../../scripts/check-pending-fragment';

/**
 * Acceptance checks for issue #2677.
 *
 * The required-check and release-owner evaluators are intentionally loaded
 * lazily: they are the NEW-SURFACE introduced by the issue and are expected
 * to be absent on the Phase-0 tree. Keeping the fixtures here makes the
 * contract executable without coupling it to a workflow implementation.
 */

const requiredContexts = ['quality', 'unit', 'drift'];

const healthyContract = {
	contract: { requiredContexts },
	workflows: [
		{
			file: '.github/workflows/ci.yml',
			events: ['pull_request', 'merge_group'],
			contexts: ['quality', 'unit'],
		},
		{
			file: '.github/workflows/drift-check.yml',
			events: ['pull_request', 'push', 'merge_group'],
			contexts: ['drift'],
		},
	],
	evidence: {
		ruleset: { requiredContexts },
		branch: { name: 'main', protected: true },
		mergeGroup: { contexts: requiredContexts },
		workflowEvents: {
			ci: ['pull_request', 'merge_group'],
			drift: ['pull_request', 'push', 'merge_group'],
		},
	},
};

async function requiredCheckContract() {
	return import('../../../scripts/check-required-check-contract.ts');
}

async function releaseOwnership() {
	return import('../../../scripts/check-required-check-contract.ts');
}

describe('issue #2677 acceptance checks', () => {
	test('AC1: a complete contract matches ruleset and workflow event evidence', async () => {
		const { evaluateRequiredCheckContract } = await requiredCheckContract();
		const result = evaluateRequiredCheckContract(healthyContract);

		expect(result.status).toBe('pass');
		expect(result.findings).toEqual([]);
		expect(result.unknown).toEqual([]);
	});

	test('AC2: present, absent, renamed, and event-skipped contexts are distinct', async () => {
		const { evaluateRequiredCheckContract } = await requiredCheckContract();

		const present = evaluateRequiredCheckContract(healthyContract);
		expect(present.findings).toEqual([]);

		const absent = evaluateRequiredCheckContract({
			...healthyContract,
			evidence: {
				...healthyContract.evidence,
				ruleset: { requiredContexts: ['quality', 'unit'] },
				mergeGroup: { contexts: ['quality', 'unit'] },
			},
		});
		expect(absent.findings.map((finding) => finding.code)).toContain(
			'PROMISED_CONTEXT_MISSING',
		);

		const renamed = evaluateRequiredCheckContract({
			...healthyContract,
			workflows: healthyContract.workflows.map((workflow) =>
				workflow.file.endsWith('ci.yml')
					? { ...workflow, contexts: ['quality', 'unit-renamed'] }
					: workflow,
			),
			evidence: {
				...healthyContract.evidence,
				ruleset: { requiredContexts: ['quality', 'unit-renamed', 'drift'] },
				mergeGroup: { contexts: ['quality', 'unit-renamed', 'drift'] },
			},
		});
		expect(renamed.findings.map((finding) => finding.code)).toContain(
			'PROMISED_CONTEXT_RENAMED',
		);

		const eventSkipped = evaluateRequiredCheckContract({
			...healthyContract,
			workflows: healthyContract.workflows.map((workflow) =>
				workflow.file.endsWith('drift-check.yml')
					? { ...workflow, events: ['pull_request', 'push'] }
					: workflow,
			),
			evidence: {
				...healthyContract.evidence,
				workflowEvents: {
					...healthyContract.evidence.workflowEvents,
					drift: ['pull_request', 'push'],
				},
			},
		});
		expect(eventSkipped.findings.map((finding) => finding.code)).toContain(
			'PROMISED_CONTEXT_EVENT_SKIPPED',
		);
	});

	test('AC3: unavailable external evidence is unknown and cannot close locally', async () => {
		const { evaluateRequiredCheckContract } = await requiredCheckContract();
		const result = evaluateRequiredCheckContract({
			...healthyContract,
			evidence: {
				ruleset: null,
				branch: null,
				mergeGroup: null,
				workflowEvents: null,
			},
		});

		expect(result.status).toBe('unknown');
		expect(result.ok).toBe(false);
		expect(result.unknown).toEqual(
			expect.arrayContaining([
				'ruleset',
				'branch',
				'merge_group',
				'workflow_events',
			]),
		);
	});

	test('AC4: release ownership allows only the automation exception', async () => {
		const { evaluateReleaseOwnership } = await releaseOwnership();
		const ownerFiles = [
			'package.json',
			'CHANGELOG.md',
			'.release-please-manifest.json',
		];

		const unauthorized = evaluateReleaseOwnership({
			changedFiles: ownerFiles,
			actor: 'contributor',
			event: 'pull_request',
		});
		expect(unauthorized.ok).toBe(false);
		expect(unauthorized.code).toBe('UNAUTHORIZED_RELEASE_OWNER_EDIT');

		const automation = evaluateReleaseOwnership({
			changedFiles: ownerFiles,
			actor: 'release-please[bot]',
			event: 'pull_request',
			releaseAutomation: true,
			tagName: 'v9.9.9',
		});
		expect(automation.ok).toBe(true);
		expect(automation.code).toBe('RELEASE_AUTOMATION_EXCEPTION');
		expect(automation.requiredNotes).toEqual([]);
	});

	test('AC5: pending fragments remain normal and tags never create versioned notes', async () => {
		const { evaluateReleaseOwnership } = await releaseOwnership();

		const fragment = evaluateFragmentCheck({
			changedFiles: ['src/index.ts', 'docs/releases/pending/issue-2677.md'],
			addedFiles: ['docs/releases/pending/issue-2677.md'],
		});
		expect(fragment.violation).toBe(false);

		const ordinary = evaluateReleaseOwnership({
			changedFiles: ['src/index.ts'],
			addedFiles: ['docs/releases/pending/issue-2677.md'],
			actor: 'contributor',
			event: 'pull_request',
			tagName: 'v9.9.9',
		});
		expect(ordinary.ok).toBe(true);
		expect(ordinary.requiredNotes).toEqual([]);
		expect(ordinary.requiredNotes).not.toContain('docs/releases/v9.9.9.md');

		const ownerWithFragment = evaluateReleaseOwnership({
			changedFiles: ['package.json', 'docs/releases/pending/issue-2677.md'],
			addedFiles: ['docs/releases/pending/issue-2677.md'],
			actor: 'contributor',
			event: 'pull_request',
		});
		expect(ownerWithFragment.ok).toBe(false);
		expect(ownerWithFragment.code).toBe('UNAUTHORIZED_RELEASE_OWNER_EDIT');
	});
});
