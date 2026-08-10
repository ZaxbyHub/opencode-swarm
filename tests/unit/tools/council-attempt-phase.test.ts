import { describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { canonicalTmpDir } from '../../helpers/tmpdir.js';

function writeConfig(dir: string): void {
	mkdirSync(join(dir, '.opencode'), { recursive: true });
	writeFileSync(
		join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({ council: { enabled: true } }),
	);
}

function writeMutationGateEvidence(dir: string, phaseNumber: number): void {
	const evidenceDir = join(dir, '.swarm', 'evidence', String(phaseNumber));
	mkdirSync(evidenceDir, { recursive: true });
	writeFileSync(
		join(evidenceDir, 'mutation-gate.json'),
		JSON.stringify({
			entries: [
				{
					type: 'mutation-gate',
					verdict: 'pass',
					timestamp: '2026-08-09T00:00:00.000Z',
				},
			],
		}),
	);
}

function makeVerdict(
	agent: 'critic' | 'reviewer' | 'sme' | 'test_engineer' | 'explorer',
	verdict: 'APPROVE' | 'CONCERNS' | 'REJECT' = 'APPROVE',
) {
	return {
		agent,
		verdict,
		confidence: 0.9,
		findings:
			verdict === 'CONCERNS'
				? [
						{
							severity: 'HIGH',
							category: 'logic',
							location: 'src/phase.ts:10',
							detail: 'Phase cannot close yet.',
							evidence: 'regression fixture',
						},
					]
				: [],
		criteriaAssessed: [],
		criteriaUnmet: [],
		durationMs: 25,
	};
}

function collectAttemptJsonlFiles(dir: string): string[] {
	const root = join(dir, '.swarm', 'council', 'attempts');
	if (!existsSync(root)) {
		return [];
	}

	const files: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) {
			continue;
		}
		for (const entry of readdirSync(current, { withFileTypes: true })) {
			const fullPath = join(current, entry.name);
			if (entry.isDirectory()) {
				stack.push(fullPath);
				continue;
			}
			if (entry.isFile() && fullPath.endsWith('.jsonl')) {
				files.push(fullPath);
			}
		}
	}

	return files.sort();
}

function finalizedDispositions(dir: string): string[] {
	return collectAttemptJsonlFiles(dir).flatMap((file) =>
		readFileSync(file, 'utf8')
			.trim()
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { event: string; disposition: string })
			.filter((record) => record.event === 'finalized')
			.map((record) => record.disposition),
	);
}

describe('submit_phase_council_verdicts — issue #2022 phase parity', () => {
	test('records the disabled-feature early return without advancing the round', async () => {
		const tempDir = mkdtempSync(
			join(canonicalTmpDir(), 'council-attempt-phase-disabled-'),
		);
		try {
			const { submit_phase_council_verdicts } = await import(
				'../../../src/tools/submit-phase-council-verdicts'
			);
			const disabled = JSON.parse(
				await submit_phase_council_verdicts.execute(
					{
						phaseNumber: 1,
						swarmId: 'swarm-a',
						phaseSummary: 'Disabled council attempt.',
						verdicts: [
							makeVerdict('critic'),
							makeVerdict('reviewer'),
							makeVerdict('sme'),
						],
						working_directory: tempDir,
					},
					{ directory: tempDir },
				),
			);
			expect(disabled.reason).toContain('council feature is disabled');
			expect(disabled.authoritativeRound).toBe(1);
			expect(disabled.nextRound).toBe(1);
			const audit = collectAttemptJsonlFiles(tempDir)
				.map((file) => readFileSync(file, 'utf8'))
				.join('\n');
			expect(audit).toContain('council_disabled');
			expect(finalizedDispositions(tempDir)).toContain('council_disabled');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('blocking phase submissions are durably audited before the early return', async () => {
		const tempDir = mkdtempSync(
			join(canonicalTmpDir(), 'council-attempt-phase-'),
		);
		try {
			writeConfig(tempDir);
			writeMutationGateEvidence(tempDir, 2);
			const { submit_phase_council_verdicts } = await import(
				'../../../src/tools/submit-phase-council-verdicts'
			);

			const blocked = JSON.parse(
				await submit_phase_council_verdicts.execute(
					{
						phaseNumber: 2,
						swarmId: 'swarm-a',
						phaseSummary: 'Phase 2 summary.',
						roundNumber: 1,
						verdicts: [
							makeVerdict('critic'),
							makeVerdict('reviewer'),
							makeVerdict('sme', 'CONCERNS'),
						],
						working_directory: tempDir,
					},
					{ directory: tempDir },
				),
			);

			expect(blocked.success).toBe(false);
			expect(blocked.reason).toBe('blocking_concerns_unresolved');

			const attemptFiles = collectAttemptJsonlFiles(tempDir);
			expect(attemptFiles.length).toBeGreaterThan(0);
			expect(
				readFileSync(attemptFiles[0], 'utf8').trim().length,
			).toBeGreaterThan(0);
			expect(finalizedDispositions(tempDir)).toContain(
				'blocking_concerns_unresolved',
			);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test('phase submissions reject a stale client round after a prior blocked round advanced server state', async () => {
		const tempDir = mkdtempSync(
			join(canonicalTmpDir(), 'council-phase-round-mismatch-'),
		);
		try {
			writeConfig(tempDir);
			writeMutationGateEvidence(tempDir, 2);
			const { submit_phase_council_verdicts } = await import(
				'../../../src/tools/submit-phase-council-verdicts'
			);

			await submit_phase_council_verdicts.execute(
				{
					phaseNumber: 2,
					swarmId: 'swarm-a',
					phaseSummary: 'Phase 2 summary.',
					roundNumber: 1,
					verdicts: [
						makeVerdict('critic'),
						makeVerdict('reviewer'),
						makeVerdict('sme', 'CONCERNS'),
					],
					working_directory: tempDir,
				},
				{ directory: tempDir },
			);

			const mismatch = JSON.parse(
				await submit_phase_council_verdicts.execute(
					{
						phaseNumber: 2,
						swarmId: 'swarm-a',
						phaseSummary: 'Phase 2 summary.',
						roundNumber: 1,
						verdicts: [
							makeVerdict('critic'),
							makeVerdict('reviewer'),
							makeVerdict('sme'),
						],
						working_directory: tempDir,
					},
					{ directory: tempDir },
				),
			);

			expect(mismatch.success).toBe(false);
			expect(mismatch.reason).toBe('council_round_mismatch');
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
