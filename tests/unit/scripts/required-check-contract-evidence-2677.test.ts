import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
	collectRequiredCheckContract,
	evaluateRequiredCheckContract,
	parseWorkflowSurface,
} from '../../../scripts/check-required-check-contract';

const repoRoot = resolve(import.meta.dir, '../../..');

function readEvidence(): Record<string, unknown> {
	return JSON.parse(
		readFileSync(
			resolve(repoRoot, 'docs/ci/required-check-evidence.json'),
			'utf8',
		),
	) as Record<string, unknown>;
}

describe('issue #2677 required-check contract evidence', () => {
	test('external capture facts are pinned separately from proposed workflow hashes', () => {
		const evidence = readEvidence();
		const captured = evidence.capturedWorkflowFiles as Record<
			string,
			{ contentsEndpoint: string; blobSha: string }
		>;
		const local = evidence.localWorkflowHashes as Record<string, string>;
		const runs = (
			evidence.mergeGroup as {
				observedRuns: Array<{ id: number; workflow: string }>;
				workflowRunsByWorkflow: Record<string, number[]>;
			}
		).observedRuns;
		const runsByWorkflow = (
			evidence.mergeGroup as {
				workflowRunsByWorkflow: Record<string, number[]>;
			}
		).workflowRunsByWorkflow;

		expect(evidence.captureSha).toBe(
			'b21cdce17b8731143ed5fab7fdf32dd8ad5f7a7f',
		);
		expect(
			captured['.github/workflows/drift-check.yml'].contentsEndpoint,
		).toContain('?ref=b21cdce17b8731143ed5fab7fdf32dd8ad5f7a7f');
		expect(captured['.github/workflows/drift-check.yml'].blobSha).toBe(
			'33eae23dd213bd91caa55d951ab98cdd1af8101e',
		);
		expect(local['.github/workflows/drift-check.yml']).toHaveLength(64);
		expect(runs.map((run) => run.id)).toEqual(
			expect.arrayContaining([34639685905, 34639685670]),
		);
		expect(runsByWorkflow['.github/workflows/drift-check.yml']).toEqual([]);
	});

	test('collector verifies each pinned capture blob against the local Git object', () => {
		const evidence = readEvidence();
		const captured = evidence.capturedWorkflowFiles as Record<
			string,
			{ contentsEndpoint: string; blobSha: string }
		>;
		captured['.github/workflows/ci.yml'].blobSha = '0'.repeat(40);
		const tempRoot = mkdtempSync(
			join(tmpdir(), 'required-check-contract-2677-'),
		);
		try {
			const evidencePath = join(tempRoot, 'evidence.json');
			writeFileSync(evidencePath, JSON.stringify(evidence));
			const result = collectRequiredCheckContract(repoRoot, { evidencePath });
			expect(result.status).toBe('unknown');
			expect(result.findings.map((finding) => finding.code)).toContain(
				'CAPTURE_BLOB_MISMATCH',
			);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});

	test('strict capture receipts reject repository, path, or run endpoint drift', () => {
		const contract = JSON.parse(
			readFileSync(
				resolve(repoRoot, 'scripts/required-check-contract.json'),
				'utf8',
			),
		) as Record<string, unknown>;
		const evidence = readEvidence();
		const captured = evidence.capturedWorkflowFiles as Record<
			string,
			Record<string, unknown>
		>;
		captured['.github/workflows/ci.yml'].contentsEndpoint =
			'https://api.github.com/repos/other/repo/contents/.github/workflows/ci.yml?ref=b21cdce17b8731143ed5fab7fdf32dd8ad5f7a7f';
		const observedRuns = (evidence.mergeGroup as Record<string, unknown>)
			.observedRuns as Array<Record<string, unknown>>;
		observedRuns[0].endpoint =
			'https://api.github.com/repos/other/repo/actions/runs/34639685905';
		const result = evaluateRequiredCheckContract(
			{ ...contract, evidence },
			{ strict: true, now: new Date('2026-09-11T22:00:00Z') },
		);
		expect(result.status).toBe('unknown');
		expect(result.findings.map((finding) => finding.code)).toContain(
			'EVIDENCE_MALFORMED',
		);
		expect(result.findings.map((finding) => finding.code)).toContain(
			'EVIDENCE_MERGE_GROUP_UNKNOWN',
		);
	});

	test('strict run maps reject malformed or unlinked receipt IDs', () => {
		const contract = JSON.parse(
			readFileSync(
				resolve(repoRoot, 'scripts/required-check-contract.json'),
				'utf8',
			),
		) as Record<string, unknown>;
		const evidence = readEvidence();
		const runMap = (evidence.mergeGroup as Record<string, unknown>)
			.workflowRunsByWorkflow as Record<string, unknown[]>;
		runMap['.github/workflows/ci.yml'] = [99999999999];
		const result = evaluateRequiredCheckContract(
			{ ...contract, evidence },
			{ strict: true, now: new Date('2026-09-11T22:00:00Z') },
		);
		expect(result.status).toBe('unknown');
		expect(result.findings.map((finding) => finding.code)).toContain(
			'EVIDENCE_MALFORMED',
		);
	});

	test('strict merge-group receipts require successful runs at the captured head', () => {
		const contract = JSON.parse(
			readFileSync(
				resolve(repoRoot, 'scripts/required-check-contract.json'),
				'utf8',
			),
		) as Record<string, unknown>;
		const evidence = readEvidence();
		const observedRuns = (evidence.mergeGroup as Record<string, unknown>)
			.observedRuns as Array<Record<string, unknown>>;
		observedRuns[0].headSha = '0'.repeat(40);
		observedRuns[0].conclusion = 'failure';
		const result = evaluateRequiredCheckContract(
			{ ...contract, evidence },
			{ strict: true, now: new Date('2026-09-11T22:00:00Z') },
		);
		expect(result.status).toBe('unknown');
		expect(result.findings.map((finding) => finding.code)).toContain(
			'EVIDENCE_MERGE_GROUP_UNKNOWN',
		);
	});

	test('strict merge-group receipts require a non-empty exact workflow identity', () => {
		const contract = JSON.parse(
			readFileSync(
				resolve(repoRoot, 'scripts/required-check-contract.json'),
				'utf8',
			),
		) as Record<string, unknown>;
		const evidence = readEvidence();
		const observedRuns = (evidence.mergeGroup as Record<string, unknown>)
			.observedRuns as Array<Record<string, unknown>>;
		observedRuns[0].workflowPath = '';
		const result = evaluateRequiredCheckContract(
			{ ...contract, evidence },
			{ strict: true, now: new Date('2026-09-11T22:00:00Z') },
		);
		expect(result.status).toBe('unknown');
		expect(result.findings.map((finding) => finding.code)).toContain(
			'EVIDENCE_MERGE_GROUP_UNKNOWN',
		);
	});

	test('strict merge-group receipts reject swapped workflow identities', () => {
		const contract = JSON.parse(
			readFileSync(
				resolve(repoRoot, 'scripts/required-check-contract.json'),
				'utf8',
			),
		) as Record<string, unknown>;
		const evidence = readEvidence();
		const observedRuns = (evidence.mergeGroup as Record<string, unknown>)
			.observedRuns as Array<Record<string, unknown>>;
		const firstPath = observedRuns[0].workflowPath;
		observedRuns[0].workflowPath = observedRuns[1].workflowPath;
		observedRuns[1].workflowPath = firstPath;
		const result = evaluateRequiredCheckContract(
			{ ...contract, evidence },
			{ strict: true, now: new Date('2026-09-11T22:00:00Z') },
		);
		expect(result.status).toBe('unknown');
		expect(result.findings.map((finding) => finding.code)).toContain(
			'EVIDENCE_MALFORMED',
		);
	});

	test('strict merge-group receipts reject duplicate observed run IDs', () => {
		const contract = JSON.parse(
			readFileSync(
				resolve(repoRoot, 'scripts/required-check-contract.json'),
				'utf8',
			),
		) as Record<string, unknown>;
		const evidence = readEvidence();
		const observedRuns = (evidence.mergeGroup as Record<string, unknown>)
			.observedRuns as Array<Record<string, unknown>>;
		observedRuns[1].id = observedRuns[0].id;
		const result = evaluateRequiredCheckContract(
			{ ...contract, evidence },
			{ strict: true, now: new Date('2026-09-11T22:00:00Z') },
		);
		expect(result.status).toBe('unknown');
		expect(result.findings.map((finding) => finding.code)).toContain(
			'EVIDENCE_MALFORMED',
		);
	});

	test('strict merge-group maps reject a run ID reused across workflows', () => {
		const contract = JSON.parse(
			readFileSync(
				resolve(repoRoot, 'scripts/required-check-contract.json'),
				'utf8',
			),
		) as Record<string, unknown>;
		const evidence = readEvidence();
		const runMap = (evidence.mergeGroup as Record<string, unknown>)
			.workflowRunsByWorkflow as Record<string, unknown[]>;
		runMap['.github/workflows/pr-standards.yml'] = [34639685905];
		const result = evaluateRequiredCheckContract(
			{ ...contract, evidence },
			{ strict: true, now: new Date('2026-09-11T22:00:00Z') },
		);
		expect(result.status).toBe('unknown');
		expect(result.findings.map((finding) => finding.code)).toContain(
			'EVIDENCE_MALFORMED',
		);
	});

	test('the collector forces strict evidence validation even without metadata hints', () => {
		const tempRoot = mkdtempSync(
			join(tmpdir(), 'required-check-contract-2677-'),
		);
		try {
			const contractPath = join(tempRoot, 'contract.json');
			const evidencePath = join(tempRoot, 'evidence.json');
			const contract = JSON.parse(
				readFileSync(
					resolve(repoRoot, 'scripts/required-check-contract.json'),
					'utf8',
				),
			);
			const evidence = readEvidence();
			for (const field of [
				'schemaVersion',
				'capturedAt',
				'captureSha',
				'repository',
				'sources',
				'capturedWorkflowFiles',
				'localWorkflowHashes',
			])
				delete evidence[field];
			writeFileSync(contractPath, JSON.stringify(contract));
			writeFileSync(evidencePath, JSON.stringify(evidence));

			const result = collectRequiredCheckContract(repoRoot, {
				contractPath,
				evidencePath,
			});
			expect(result.status).toBe('unknown');
			expect(result.findings.map((finding) => finding.code)).toContain(
				'EVIDENCE_MALFORMED',
			);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});
