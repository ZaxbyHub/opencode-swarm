import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { handleGateAuditCommand } from '../../../src/commands/gate-audit.js';
import { _gateAuditInternals } from '../../../src/evaluation/gate-audit.js';
import { readGateGroundTruth } from '../../../src/evaluation/gate-ground-truth.js';
import { computeGateStatistics } from '../../../src/evaluation/gate-stats.js';

const packageRoot = path.resolve(import.meta.dir, '../../..');
const originalFingerprint = _gateAuditInternals.captureWorkingTreeFingerprint;

afterEach(() => {
	_gateAuditInternals.captureWorkingTreeFingerprint = originalFingerprint;
});

describe('gate-audit test-impact production correlation', () => {
	test('classifies real bounded baseline and defect output and persists exact joins', async () => {
		const root = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'gate-test-impact-')),
		);
		try {
			_gateAuditInternals.captureWorkingTreeFingerprint = async () => ({
				head: 'a'.repeat(40),
				porcelainHash: 'b'.repeat(64),
			});
			const runId = 'audit-real-test-impact';
			await handleGateAuditCommand(
				root,
				[
					'--run-id',
					runId,
					'--gates',
					'mutation',
					'--tasks',
					'mutation-off-by-one',
					'--runs',
					'1',
					'--max-time-ms',
					'60000',
					'--json',
				],
				{ packageRoot },
			);

			const truth = await readGateGroundTruth(root, runId);
			const testImpact = truth.events.filter(
				(event) => event.source === 'test-impact',
			);
			expect(testImpact).toHaveLength(2);
			expect(
				testImpact.find((event) => event.candidateId.startsWith('defect-')),
			).toMatchObject({
				classification: 'new_regression',
				confidence: 0.5,
			});
			expect(
				testImpact.find((event) => event.candidateId.startsWith('clean-')),
			).toMatchObject({ classification: 'clean', confidence: 1 });

			const stats = await computeGateStatistics(root, 1, runId);
			expect(stats.groundTruth).toEqual({
				parsed: 4,
				malformed: 0,
				ambiguous: 0,
				unjoined: 0,
			});
			expect(stats.models[0]?.catchRate).toBe(1);
			expect(stats.models[0]?.falseRejectionRate).toBe(0);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
