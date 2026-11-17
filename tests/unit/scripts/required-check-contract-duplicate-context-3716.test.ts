/**
 * #3716 item 1 (AC7 durable pin): duplicate context owner-record names are
 * rejected at validation time instead of silently first-match-resolving.
 *
 * Root cause: `contextRecords()` in scripts/check-required-check-contract.ts
 * resolves owner records with `records.find(...)` over the COMBINED
 * required + intendedRequired arrays — two records sharing a name silently
 * discarded the second record's workflow/job anchoring, and strict validation
 * checked record PRESENCE per name, never uniqueness. Harness mirrors the
 * required-check-contract-2677 fixtures and the frozen C8 probe.
 */
import { describe, expect, test } from 'bun:test';
import { evaluateRequiredCheckContract } from '../../../scripts/check-required-check-contract';

const DUPLICATED = 'quality';

const workflowList = [
	{
		file: '.github/workflows/ci.yml',
		events: ['pull_request', 'merge_group'],
		contexts: [DUPLICATED, 'unit'],
	},
	{
		file: '.github/workflows/other.yml',
		events: ['pull_request', 'merge_group'],
		contexts: [],
	},
	{
		file: '.github/workflows/drift-check.yml',
		events: ['pull_request', 'push', 'merge_group'],
		contexts: ['drift'],
	},
];

const evidence = {
	ruleset: { requiredContexts: [DUPLICATED, 'unit', 'drift'] },
	branch: { name: 'main', protected: true },
	mergeGroup: { contexts: [DUPLICATED, 'unit', 'drift'] },
	workflowEvents: {
		ci: ['pull_request', 'merge_group'],
		other: ['pull_request', 'merge_group'],
		drift: ['pull_request', 'push', 'merge_group'],
	},
};

const duplicateRecords = [
	{ name: DUPLICATED, workflow: '.github/workflows/ci.yml', job: 'quality' },
	{
		name: DUPLICATED,
		workflow: '.github/workflows/other.yml',
		job: 'other-job',
	},
	{ name: 'unit', workflow: '.github/workflows/ci.yml', job: 'unit' },
	{
		name: 'drift',
		workflow: '.github/workflows/drift-check.yml',
		job: 'drift',
	},
];

const uniqueRecords = duplicateRecords.filter(
	(record, index) => !(record.name === DUPLICATED && index === 1),
);

function isAmbiguityFinding(finding: {
	code: string;
	message: string;
	context?: string;
}): boolean {
	const haystack = `${finding.code} ${finding.message}`.toLowerCase();
	const namesAmbiguity = /duplicat|ambigu/.test(haystack);
	const namesContext =
		finding.context === DUPLICATED ||
		finding.message.includes(`"${DUPLICATED}"`) ||
		finding.message.includes(DUPLICATED);
	return namesAmbiguity && namesContext;
}

describe('required-check contract duplicate owner records (#3716 item 1)', () => {
	test('a contract with unique owner records evaluates clean (control)', () => {
		const result = evaluateRequiredCheckContract({
			contexts: { required: uniqueRecords, intendedRequired: [] },
			workflows: workflowList,
			requiredContexts: [DUPLICATED, 'unit', 'drift'],
			evidence,
		});
		expect(result.status).toBe('pass');
		expect(result.findings.filter(isAmbiguityFinding)).toHaveLength(0);
	});

	test('two owner records sharing a context name produce a CONTRACT_MALFORMED finding naming the duplicate', () => {
		const result = evaluateRequiredCheckContract({
			contexts: { required: duplicateRecords, intendedRequired: [] },
			workflows: workflowList,
			requiredContexts: [DUPLICATED, 'unit', 'drift'],
			evidence,
		});
		expect(result.status).not.toBe('pass');
		const findings = result.findings.filter(
			(finding) =>
				finding.code === 'CONTRACT_MALFORMED' && isAmbiguityFinding(finding),
		);
		expect(findings.length).toBeGreaterThan(0);
		expect(
			findings.some((finding) => finding.message.includes(DUPLICATED)),
		).toBe(true);
	});

	test('a cross-bucket duplicate (required and intendedRequired share a name) is also rejected', () => {
		const crossBucketRecords = [
			...uniqueRecords,
			{
				name: 'unit',
				workflow: '.github/workflows/other.yml',
				job: 'other-unit',
			},
		];
		const result = evaluateRequiredCheckContract({
			contexts: {
				required: uniqueRecords,
				intendedRequired: crossBucketRecords.slice(uniqueRecords.length),
			},
			workflows: workflowList,
			requiredContexts: [DUPLICATED, 'unit', 'drift'],
			evidence,
		});
		const findings = result.findings.filter(
			(finding) =>
				finding.code === 'CONTRACT_MALFORMED' &&
				/duplicat|ambigu/i.test(finding.message) &&
				finding.message.includes('unit'),
		);
		expect(findings.length).toBeGreaterThan(0);
	});
});
