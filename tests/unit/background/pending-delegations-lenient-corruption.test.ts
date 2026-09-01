import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	readDelegationHealthArtifact,
	writeDelegationHealthArtifact,
} from '../../../src/background/delegation-health.js';
import {
	BACKGROUND_DELEGATIONS_FILE,
	readDelegations,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations.js';
import * as logger from '../../../src/utils/logger.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

async function seedValidRecord(directory: string): Promise<void> {
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	await recordPendingDelegation(directory, {
		correlationId: 'ses_ok',
		jobId: null,
		subagentSessionId: 'ses_ok',
		parentSessionId: 'parent',
		callID: 'call-ok',
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
	});
}

describe('pending delegations lenient corruption visibility (#2384)', () => {
	afterEach(() => {
		mock.restore();
	});

	test('lenient reads surface bounded corruption visibility without failing open to silence (FB-011)', async () => {
		const safe = createSafeTestDir('swarm-bg-lenient-corrupt-');
		const warnSpy = spyOn(logger, 'criticalWarn').mockImplementation(() => {});
		try {
			fs.mkdirSync(path.join(safe.dir, '.git'), { recursive: true });
			await seedValidRecord(safe.dir);
			const ledgerPath = path.join(
				safe.dir,
				'.swarm',
				BACKGROUND_DELEGATIONS_FILE,
			);
			fs.appendFileSync(ledgerPath, 'not json\n');
			fs.appendFileSync(ledgerPath, '{"partial": \n');
			fs.appendFileSync(ledgerPath, `${JSON.stringify({ bogus: true })}\n`);

			expect(
				readDelegations(safe.dir).map((record) => record.correlationId),
			).toEqual(['ses_ok']);
			expect(
				readDelegations(safe.dir).map((record) => record.correlationId),
			).toEqual(['ses_ok']);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(String(warnSpy.mock.calls[0]?.[0])).toContain(
				'skipped 3 malformed/invalid rows during lenient legacy-ledger read',
			);
			const health = readDelegationHealthArtifact(safe.dir);
			expect(health?.lastUncertainty?.source).toBe('lenient-read');
			expect(health?.lastUncertainty?.reason).toContain(
				'skipped 3 malformed/invalid rows during lenient legacy-ledger read',
			);
		} finally {
			safe.cleanup();
		}
	});

	test('lenient visibility does not overwrite a stricter durable uncertainty', async () => {
		const safe = createSafeTestDir('swarm-bg-lenient-preserve-');
		const warnSpy = spyOn(logger, 'criticalWarn').mockImplementation(() => {});
		try {
			fs.mkdirSync(path.join(safe.dir, '.git'), { recursive: true });
			await seedValidRecord(safe.dir);
			writeDelegationHealthArtifact(safe.dir, {
				uncertainty: {
					reason: 'checkpoint is invalid',
					at: 1,
					source: 'mutation',
					repairHint: 'repair the checkpoint first',
				},
			});
			fs.appendFileSync(
				path.join(safe.dir, '.swarm', BACKGROUND_DELEGATIONS_FILE),
				'not json\n',
			);

			expect(
				readDelegations(safe.dir).map((record) => record.correlationId),
			).toEqual(['ses_ok']);
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(readDelegationHealthArtifact(safe.dir)?.lastUncertainty).toEqual({
				reason: 'checkpoint is invalid',
				at: 1,
				source: 'mutation',
				repairHint: 'repair the checkpoint first',
			});
		} finally {
			safe.cleanup();
		}
	});
});
