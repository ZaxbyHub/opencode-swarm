/**
 * Acceptance checks for issue #2486 — AC9 (consent change mid-stream).
 *
 * Frozen contract: .agents/issue-traces/2486-consented-training-vault-export/check-contract.md
 *
 * The capture gate must re-evaluate the CURRENT consent on every observation:
 * after revoke (or expiry, simulated with the frozen test clock) between two
 * observations, the first record keeps its original consent lineage and the
 * second observation is not captured.
 *
 * RED at base: src/training/* does not exist yet.
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { createTrainingCaptureObserver } from '../../../src/training/capture.js';
import {
	grantTrainingConsent,
	readActiveTrainingConsent,
	revokeTrainingConsent,
} from '../../../src/training/consent.js';
import { trainingVaultRecordsPath } from '../../../src/training/paths.js';
import { readTrainingVault } from '../../../src/training/vault.js';
import { withFrozenClockAsync } from '../../helpers/test-clock.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

function rmDir(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function userMessage(sessionId: string, text: string) {
	return {
		info: {
			role: 'user',
			id: `msg-${sessionId}-${text.length}`,
			sessionID: sessionId,
		},
		parts: [{ type: 'text', text }],
	};
}

describe('AC9 mid-stream consent change - revoke between observations', () => {
	test('first record keeps its consent lineage; the second observation is not captured', async () => {
		const dir = canonicalMkdtemp('training-ac9-revoke-');
		try {
			const consent = grantTrainingConsent(dir);
			const observer = createTrainingCaptureObserver(dir);

			await observer.observeMessages({
				messages: [userMessage('sess-m', 'first message')],
			});
			let vault = readTrainingVault(dir);
			expect(vault.records).toHaveLength(1);
			const first = vault.records[0];
			// The captured record froze the consent it was captured under.
			expect(first.consent).toEqual({ id: consent.consent_id, version: 1 });

			const bytesBefore = fs.readFileSync(
				trainingVaultRecordsPath(dir),
				'utf-8',
			);

			revokeTrainingConsent(dir);
			await observer.observeMessages({
				messages: [userMessage('sess-m', 'second message after revoke')],
			});

			vault = readTrainingVault(dir);
			expect(vault.records).toHaveLength(1);
			// The first record is untouched — original consent lineage intact.
			expect(fs.readFileSync(trainingVaultRecordsPath(dir), 'utf-8')).toBe(
				bytesBefore,
			);
			expect(vault.records[0].consent).toEqual({
				id: consent.consent_id,
				version: 1,
			});
		} finally {
			rmDir(dir);
		}
	});
});

describe('AC9 mid-stream consent change - expiry between observations', () => {
	test('capture works before expiry and stops after (frozen clock)', async () => {
		const dir = canonicalMkdtemp('training-ac9-expiry-');
		try {
			const observer = createTrainingCaptureObserver(dir);
			const beforeExpiry = new Date('2026-07-01T09:00:00.000Z');
			const afterExpiry = new Date('2026-07-03T09:00:00.000Z');

			let consentId = '';
			await withFrozenClockAsync(
				async () => {
					const consent = grantTrainingConsent(dir, {
						expiresAt: '2026-07-02T09:00:00.000Z',
					});
					consentId = consent.consent_id;
					await observer.observeMessages({
						messages: [userMessage('sess-e', 'captured before expiry')],
					});
				},
				{ fixedNow: beforeExpiry.getTime() },
			);

			const vaultAfterFirst = readTrainingVault(dir);
			expect(vaultAfterFirst.records).toHaveLength(1);
			expect(vaultAfterFirst.records[0].consent).toEqual({
				id: consentId,
				version: 1,
			});

			await withFrozenClockAsync(
				async () => {
					await observer.observeMessages({
						messages: [userMessage('sess-e', 'not captured after expiry')],
					});
				},
				{ fixedNow: afterExpiry.getTime() },
			);

			expect(readTrainingVault(dir).records).toHaveLength(1);
			// The consent read itself confirms the expiry (not just the observer).
			expect(readActiveTrainingConsent(dir, { now: afterExpiry })).toBeNull();
			expect(
				readActiveTrainingConsent(dir, {
					now: new Date('2026-07-01T12:00:00.000Z'),
				}),
			).not.toBeNull();
		} finally {
			rmDir(dir);
		}
	});
});
