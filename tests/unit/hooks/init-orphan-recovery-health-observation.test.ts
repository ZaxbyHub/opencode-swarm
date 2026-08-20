/**
 * Issue #2034 / #1659 — init-orphan-recovery records a durable recovery
 * observation (source + outcome) after its primary ownership scan, so ledger
 * health is user-visible in /swarm status after startup. Covers both the seam
 * contract and a real hook run end-to-end.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	BACKGROUND_DELEGATIONS_HEALTH_FILE,
	readDelegationHealthArtifact,
} from '../../../src/background/delegation-health';
import {
	_internals,
	runInitOrphanRecovery,
} from '../../../src/hooks/init-orphan-recovery';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { dir, cleanup } = createSafeTestDir('swarm-orphan-health-');
afterEach(cleanup);

describe('init-orphan-recovery health observation', () => {
	it('successful observation is recorded with the scan source', () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		_internals.recordDelegationRecoveryObservation(dir, {
			source: 'checkpoint+tail',
			ok: true,
		});
		const artifact = readDelegationHealthArtifact(dir);
		expect(artifact?.recovery?.source).toBe('checkpoint+tail');
		expect(artifact?.recovery?.ok).toBe(true);
		expect(artifact?.lastUncertainty).toBeNull();
	});

	it('uncertain scan observation persists as lastUncertainty', () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		_internals.recordDelegationRecoveryObservation(dir, {
			source: 'legacy-ledger',
			ok: false,
			reason:
				'background delegation ledger exceeds the 4194304-byte recovery bound',
		});
		const artifact = readDelegationHealthArtifact(dir);
		expect(artifact?.recovery?.ok).toBe(false);
		expect(artifact?.lastUncertainty?.reason).toContain('4194304');
		expect(artifact?.lastUncertainty?.source).toBe('recovery');
		expect(
			fs.existsSync(
				path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_HEALTH_FILE),
			),
		).toBe(true);
	});

	it('a real hook run records the observation end-to-end (uncertain oversized legacy ledger)', async () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		// Oversized manifest-less ledger → the real scan path fails closed and
		// the hook must durably record it before aborting cleanup.
		const ledger = path.join(dir, '.swarm', 'background-delegations.jsonl');
		fs.writeFileSync(ledger, 'x'.repeat(4 * 1024 * 1024 + 1));

		const result = await runInitOrphanRecovery(dir);
		expect(result.attempted).toBe(false);

		const artifact = readDelegationHealthArtifact(dir);
		expect(artifact).not.toBeNull();
		expect(artifact?.recovery?.ok).toBe(false);
		expect(artifact?.recovery?.source).toBe('legacy-ledger');
		expect(artifact?.recovery?.reason).toContain('4194304');
		expect(artifact?.lastUncertainty?.reason).toContain('4194304');

		fs.rmSync(ledger);
		// A healthy empty store records a successful observation on the next run.
		const okResult = await runInitOrphanRecovery(dir);
		expect(okResult.attempted).toBe(true);
		const after = readDelegationHealthArtifact(dir);
		expect(after?.recovery?.ok).toBe(true);
		// The earlier uncertainty stays durable (#1659: visible after the incident).
		expect(after?.lastUncertainty).not.toBeNull();
	});
});
