import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
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
			'c12cd853dd61858d17bb4e85ca21739b0169710e',
		);
		expect(
			captured['.github/workflows/drift-check.yml'].contentsEndpoint,
		).toContain('?ref=c12cd853dd61858d17bb4e85ca21739b0169710e');
		expect(captured['.github/workflows/drift-check.yml'].blobSha).toBe(
			'b6a49b60856deca97d2aa6464fe0f148739eb307',
		);
		expect(local['.github/workflows/drift-check.yml']).toHaveLength(64);
		expect(runs.map((run) => run.id)).toEqual(
			expect.arrayContaining([44078540845, 44078540792]),
		);
		expect(runsByWorkflow['.github/workflows/drift-check.yml']).toEqual([
			44078540845,
		]);
	});

	test('collector verifies each pinned capture blob against the local Git object', () => {
		const evidence = readEvidence();
		const captured = evidence.capturedWorkflowFiles as Record<
			string,
			{ contentsEndpoint: string; blobSha: string }
		>;
		captured['.github/workflows/ci.yml'].blobSha = '0'.repeat(40);
		const tempRoot = realpathSync(
			mkdtempSync(
				join(realpathSync(tmpdir()), 'required-check-contract-2677-'),
			),
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
			'https://api.github.com/repos/other/repo/contents/.github/workflows/ci.yml?ref=012c4e40db4a63dd9b771cb99d57c565949d2931';
		const observedRuns = (evidence.mergeGroup as Record<string, unknown>)
			.observedRuns as Array<Record<string, unknown>>;
		observedRuns[0].endpoint =
			'https://api.github.com/repos/other/repo/actions/runs/34639685905';
		const result = evaluateRequiredCheckContract(
			{ ...contract, evidence },
			{ strict: true, now: new Date('2026-10-12T14:00:00Z') },
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
			{ strict: true, now: new Date('2026-10-12T14:00:00Z') },
		);
		expect(result.status).toBe('unknown');
		expect(result.findings.map((finding) => finding.code)).toContain(
			'EVIDENCE_MALFORMED',
		);
	});

	test('strict merge-group receipts reject a wrong captured head', () => {
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
		const result = evaluateRequiredCheckContract(
			{ ...contract, evidence },
			{ strict: true, now: new Date('2026-10-12T14:00:00Z') },
		);
		expect(result.status).toBe('unknown');
		expect(result.findings.map((finding) => finding.code)).toContain(
			'EVIDENCE_MERGE_GROUP_UNKNOWN',
		);
	});

	test('strict merge-group receipts reject a failed conclusion', () => {
		const contract = JSON.parse(
			readFileSync(
				resolve(repoRoot, 'scripts/required-check-contract.json'),
				'utf8',
			),
		) as Record<string, unknown>;
		const evidence = readEvidence();
		const observedRuns = (evidence.mergeGroup as Record<string, unknown>)
			.observedRuns as Array<Record<string, unknown>>;
		observedRuns[0].conclusion = 'failure';
		const result = evaluateRequiredCheckContract(
			{ ...contract, evidence },
			{ strict: true, now: new Date('2026-10-12T14:00:00Z') },
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
			{ strict: true, now: new Date('2026-10-12T14:00:00Z') },
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
			{ strict: true, now: new Date('2026-10-12T14:00:00Z') },
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
			{ strict: true, now: new Date('2026-10-12T14:00:00Z') },
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
		runMap['.github/workflows/pr-standards.yml'] = [38204222229];
		const result = evaluateRequiredCheckContract(
			{ ...contract, evidence },
			{ strict: true, now: new Date('2026-10-12T14:00:00Z') },
		);
		expect(result.status).toBe('unknown');
		expect(result.findings.map((finding) => finding.code)).toContain(
			'EVIDENCE_MALFORMED',
		);
	});

	test('the collector forces strict evidence validation even without metadata hints', () => {
		const tempRoot = realpathSync(
			mkdtempSync(
				join(realpathSync(tmpdir()), 'required-check-contract-2677-'),
			),
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

	test('collector rejects a changed merge-group type in the workflow surface', () => {
		const tempRoot = realpathSync(
			mkdtempSync(
				join(realpathSync(tmpdir()), 'required-check-contract-2677-'),
			),
		);
		try {
			const workflowDir = join(tempRoot, '.github', 'workflows');
			mkdirSync(workflowDir, { recursive: true });
			const source = readFileSync(
				resolve(repoRoot, '.github/workflows/ci.yml'),
				'utf8',
			);
			const mutated = source.replace(
				'types: [checks_requested]',
				'types: [completed]',
			);
			expect(mutated).not.toBe(source);
			writeFileSync(join(workflowDir, 'ci.yml'), mutated);
			const contractPath = join(tempRoot, 'contract.json');
			const evidencePath = join(tempRoot, 'evidence.json');
			writeFileSync(
				contractPath,
				JSON.stringify({
					schemaVersion: 1,
					requiredContexts: ['quality'],
					workflows: [
						{
							file: '.github/workflows/ci.yml',
							events: ['merge_group'],
							mergeGroupTypes: ['checks_requested'],
						},
					],
				}),
			);
			writeFileSync(evidencePath, '{}');
			const result = collectRequiredCheckContract(tempRoot, {
				contractPath,
				evidencePath,
			});
			expect(result.findings).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: 'PROMISED_CONTEXT_EVENT_SKIPPED',
						message: expect.stringContaining(
							'merge\\_group type checks\\_requested',
						),
					}),
				]),
			);
		} finally {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	});
});

describe('issue #2677 local workflow hash is line-ending independent', () => {
	const WORKFLOWS = [
		'.github/workflows/ci.yml',
		'.github/workflows/pr-standards.yml',
		'.github/workflows/drift-check.yml',
	];

	function git(root: string, ...args: string[]): string {
		const proc = Bun.spawnSync({
			cmd: ['git', ...args],
			cwd: root,
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			timeout: 30_000,
		});
		if (proc.exitCode !== 0) {
			throw new Error(
				`git ${args.join(' ')} failed: ${proc.stderr.toString()}`,
			);
		}
		return proc.stdout.toString().trim();
	}

	// Commits the workflows as LF (the blob the Linux runner checks out), then
	// rewrites the working copy as CRLF exactly the way a Windows checkout with
	// core.autocrlf=true does. Returns the LF hashes the evidence records.
	function crlfCheckoutFixture(): {
		root: string;
		evidence: Record<string, unknown>;
	} {
		const root = realpathSync(
			mkdtempSync(join(realpathSync(tmpdir()), 'required-check-crlf-')),
		);
		git(root, 'init', '-q', '-b', 'main');
		git(root, 'config', 'user.email', 'test@example.com');
		git(root, 'config', 'user.name', 'Test');
		git(root, 'config', 'core.autocrlf', 'false');

		const localWorkflowHashes: Record<string, string> = {};
		const lfBytes: Record<string, string> = {};
		for (const file of WORKFLOWS) {
			const text = readFileSync(resolve(repoRoot, file), 'utf8').replace(
				/\r\n/g,
				'\n',
			);
			lfBytes[file] = text;
			localWorkflowHashes[file] = createHash('sha256')
				.update(text)
				.digest('hex');
			const target = join(root, ...file.split('/'));
			mkdirSync(resolve(target, '..'), { recursive: true });
			writeFileSync(target, text, 'utf8');
		}
		const contractPath = join(root, 'scripts', 'required-check-contract.json');
		mkdirSync(resolve(contractPath, '..'), { recursive: true });
		writeFileSync(
			contractPath,
			readFileSync(
				resolve(repoRoot, 'scripts/required-check-contract.json'),
				'utf8',
			),
			'utf8',
		);
		const evidence = readEvidence();
		evidence.localWorkflowHashes = localWorkflowHashes;
		const evidencePath = join(
			root,
			'docs',
			'ci',
			'required-check-evidence.json',
		);
		mkdirSync(resolve(evidencePath, '..'), { recursive: true });
		writeFileSync(evidencePath, JSON.stringify(evidence), 'utf8');
		git(root, 'add', '-A');
		git(root, 'commit', '-q', '-m', 'capture');

		const captureSha = git(root, 'rev-parse', 'HEAD');
		evidence.captureSha = captureSha;
		const captured = evidence.capturedWorkflowFiles as Record<
			string,
			{ contentsEndpoint: string; blobSha: string }
		>;
		for (const file of WORKFLOWS) {
			captured[file].blobSha = git(root, 'rev-parse', `${captureSha}:${file}`);
		}
		writeFileSync(evidencePath, JSON.stringify(evidence), 'utf8');

		// Now translate the working copy to CRLF, leaving the blob untouched.
		for (const file of WORKFLOWS) {
			writeFileSync(
				join(root, ...file.split('/')),
				lfBytes[file].replace(/\n/g, '\r\n'),
				'utf8',
			);
		}
		return { root, evidence };
	}

	test('a CRLF checkout of unchanged workflows does not trip WORKFLOW_CHANGED_AFTER_CAPTURE', () => {
		const { root, evidence } = crlfCheckoutFixture();
		const evidencePath = join(
			root,
			'docs',
			'ci',
			'required-check-evidence.json',
		);
		try {
			expect(
				collectRequiredCheckContract(root).findings.map(
					(finding) => finding.code,
				),
			).not.toContain('WORKFLOW_CHANGED_AFTER_CAPTURE');
			// A REAL content change still fails closed on every platform.
			evidence.localWorkflowHashes = {
				...(evidence.localWorkflowHashes as Record<string, string>),
				'.github/workflows/ci.yml': '0'.repeat(64),
			};
			writeFileSync(evidencePath, JSON.stringify(evidence), 'utf8');
			expect(
				collectRequiredCheckContract(root).findings.map(
					(finding) => finding.code,
				),
			).toContain('WORKFLOW_CHANGED_AFTER_CAPTURE');
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
