/**
 * Issue #2034 — checkpoint publication crash matrix. Publication order is
 * checkpoint → manifest → rolled tail. Each test simulates a crash at a
 * specific point (via the `_checkpointInternals.renameWithRetry` seam or file
 * manipulation) and asserts recovery reconstructs correct state or fails
 * closed with a stable reason — never partial/corrupt state.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_checkpointInternals,
	BACKGROUND_DELEGATIONS_CHECKPOINT_FILE,
	BACKGROUND_DELEGATIONS_FILE,
	BACKGROUND_DELEGATIONS_MANIFEST_FILE,
	type BackgroundDelegationRecord,
	claimTerminalResult,
	compactBackgroundDelegations,
	type RecordPendingInput,
	readDelegations,
	recordPendingDelegation,
	scanDelegationsForRecovery,
} from '../../../src/background/pending-delegations';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { dir, cleanup } = createSafeTestDir('swarm-bg-ckptcrash-');
afterEach(cleanup);
// Restore the PRODUCTION seam members (never replace the retry wrapper — the
// module-level seam object is shared across every test file in this bun
// process, and a clobbered wrapper silently bypasses renameOnce injections in
// sibling suites).
const originalRenameWithRetry = _checkpointInternals.renameWithRetry;
const originalRenameOnce = _checkpointInternals.renameOnce;
const originalSyncSleep = _checkpointInternals.syncSleep;
beforeEach(() => {
	fs.rmSync(path.join(dir, '.swarm'), { recursive: true, force: true });
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	_checkpointInternals.renameWithRetry = originalRenameWithRetry;
	_checkpointInternals.renameOnce = originalRenameOnce;
	_checkpointInternals.syncSleep = originalSyncSleep;
});

function pendingInput(correlationId: string): RecordPendingInput {
	return {
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'sess_parent',
		callID: `call_${correlationId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
	};
}

function ledgerPath(): string {
	return path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_FILE);
}
function checkpointPath(): string {
	return path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_CHECKPOINT_FILE);
}
function manifestPath(): string {
	return path.join(dir, '.swarm', BACKGROUND_DELEGATIONS_MANIFEST_FILE);
}

function readManifest(): Record<string, unknown> {
	return JSON.parse(fs.readFileSync(manifestPath(), 'utf-8')) as Record<
		string,
		unknown
	>;
}

function writeManifest(manifest: Record<string, unknown>): void {
	fs.writeFileSync(manifestPath(), `${JSON.stringify(manifest)}\n`);
}

function minimal(correlationId: string): BackgroundDelegationRecord {
	return {
		schemaVersion: 1,
		correlationId,
		jobId: null,
		subagentSessionId: correlationId,
		parentSessionId: 'sess_parent',
		callID: `call_${correlationId}`,
		normalizedAgent: 'reviewer',
		swarmPrefixedAgent: 'reviewer',
		planTaskId: null,
		evidenceTaskId: null,
		status: 'pending',
		createdAt: 1,
		updatedAt: 2,
	};
}

describe('issue #2034 crash matrix', () => {
	it('payload checksum mismatch on a schema-valid checkpoint → uncertain', async () => {
		await recordPendingDelegation(dir, pendingInput('live-1'));
		await compactBackgroundDelegations(dir, { force: true });
		// Bit-flip a schema-valid field: createdAt changes but the embedded
		// payloadChecksum no longer covers the payload.
		const checkpoint = JSON.parse(
			fs.readFileSync(checkpointPath(), 'utf-8'),
		) as { createdAt: number; payloadChecksum: string };
		checkpoint.createdAt += 1;
		fs.writeFileSync(checkpointPath(), JSON.stringify(checkpoint));

		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('uncertain');
		if (scan.status === 'uncertain') {
			expect(scan.reason).toContain('payload checksum mismatch');
		}
	});

	it('manifest checksum pointing at a different checkpoint → uncertain', async () => {
		await recordPendingDelegation(dir, pendingInput('live-1'));
		await compactBackgroundDelegations(dir, { force: true });
		const checkpoint = JSON.parse(
			fs.readFileSync(checkpointPath(), 'utf-8'),
		) as { payloadChecksum: string };
		const manifest = readManifest();
		// Provably-unequal mutation: flipping the first hex nibble always
		// differs from the original digest (a plain replace(/^./, 'f') would be
		// a no-op ~1/16 runs and flake CI).
		const first = checkpoint.payloadChecksum[0]!;
		const flipped = first === '0' ? '1' : '0';
		writeManifest({
			...manifest,
			checkpointChecksum: flipped + checkpoint.payloadChecksum.slice(1),
		});

		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('uncertain');
		if (scan.status === 'uncertain') {
			expect(scan.reason).toContain(
				'manifest checksum does not match its checkpoint',
			);
		}
	});

	it('uncertain scan reports an honest source: unknown for manifest-present stores', async () => {
		await recordPendingDelegation(dir, pendingInput('live-1'));
		await compactBackgroundDelegations(dir, { force: true });
		fs.writeFileSync(checkpointPath(), '{"schemaVersion":1,"corrupt":true}');
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('uncertain');
		if (scan.status === 'uncertain') {
			expect(scan.source).toBe('unknown');
			// The repair hint rides along so durable observations stay actionable.
			expect(scan.repairHint).toBeTruthy();
		}

		// Manifest-less failure keeps the legacy label (and no repair hint:
		// a legacy ledger needs no checkpoint repair).
		fs.rmSync(manifestPath(), { force: true });
		fs.appendFileSync(ledgerPath(), '{"torn json');
		const legacy = scanDelegationsForRecovery(dir);
		expect(legacy.status).toBe('uncertain');
		if (legacy.status === 'uncertain') {
			expect(legacy.source).toBe('legacy-ledger');
		}
	});

	it('the manifest-behind-by-one publication window is accepted (sequence+1)', async () => {
		await recordPendingDelegation(dir, pendingInput('live-1'));
		await compactBackgroundDelegations(dir, { force: true });
		// Simulate a second compaction whose checkpoint rename landed but whose
		// manifest write did not: on-disk checkpoint is N+1 under manifest N.
		// Deterministically fabricated below (the second compaction normally
		// completes fully), exercising the exact loader branch: the +1 window
		// accepts the newer self-checksummed checkpoint under the older
		// manifest WITHOUT the manifest checksum cross-check.
		await recordPendingDelegation(dir, pendingInput('post-cut-1'));
		await compactBackgroundDelegations(dir, { force: true });
		const checkpoint = JSON.parse(
			fs.readFileSync(checkpointPath(), 'utf-8'),
		) as { sequence: number };
		writeManifest({
			...readManifest(),
			sequence: checkpoint.sequence - 1,
			checkpointChecksum: '0'.repeat(64),
		});

		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.owners.some((r) => r.correlationId === 'live-1')).toBe(true);
			expect(scan.owners.some((r) => r.correlationId === 'post-cut-1')).toBe(
				true,
			);
		}
	});

	it('crash before manifest publication: orphan checkpoint ignored, legacy fold correct', async () => {
		await recordPendingDelegation(dir, pendingInput('live-1'));
		await compactBackgroundDelegations(dir, { force: true });
		// Simulate the pre-manifest crash: remove the manifest and restore the
		// unrolled ledger content (the roll "never happened").
		fs.rmSync(manifestPath(), { force: true });
		fs.writeFileSync(
			ledgerPath(),
			`${JSON.stringify({ ...minimal('live-1'), status: 'pending' })}\n`,
		);

		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.source).toBe('legacy-ledger');
			expect(scan.owners).toHaveLength(1);
			expect(scan.owners[0]!.correlationId).toBe('live-1');
		}
	});

	it('crash between manifest and roll (rename seam): unrolled ledger recovers via verified suffix', async () => {
		await recordPendingDelegation(dir, pendingInput('live-1'));
		const before = fs.readFileSync(ledgerPath());

		// Fail the ledger-roll rename once: checkpoint + manifest are published,
		// the ledger stays unrolled — exactly the crash window.
		let failedOnce = false;
		const realRename = _checkpointInternals.renameWithRetry;
		_checkpointInternals.renameWithRetry = (from: string, to: string) => {
			if (!failedOnce && to === ledgerPath()) {
				failedOnce = true;
				fs.rmSync(from, { force: true });
				throw Object.assign(new Error('simulated crash during roll'), {
					code: 'EPERM',
				});
			}
			return realRename(from, to);
		};
		const compact = await compactBackgroundDelegations(dir, { force: true });
		_checkpointInternals.renameWithRetry = realRename;
		expect(compact.status).toBe('uncertain');
		expect(failedOnce).toBe(true);

		// The unrolled ledger is byte-identical to the pre-compaction state.
		expect(fs.readFileSync(ledgerPath()).equals(before)).toBe(true);

		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.owners).toHaveLength(1);
			expect(scan.owners[0]!.correlationId).toBe('live-1');
		}

		// Mutations continue against the unrolled ledger and a later compaction
		// publishes a fresh pair (self-heal of the window).
		await recordPendingDelegation(dir, pendingInput('post-crash-1'));
		const rescan = scanDelegationsForRecovery(dir);
		expect(rescan.status).toBe('ok');
		const recompact = await compactBackgroundDelegations(dir, { force: true });
		expect(recompact.status).toBe('compacted');
	});

	it('rolled tail that grows past the old cut size still recovers (no ambiguous-cut window)', async () => {
		await recordPendingDelegation(dir, pendingInput('live-1'));
		const compacted = await compactBackgroundDelegations(dir, { force: true });
		expect(compacted.status).toBe('compacted');
		// Grow the rolled tail well past the (tiny) cut with fresh records.
		for (let i = 0; i < 12; i += 1) {
			await recordPendingDelegation(dir, pendingInput(`grown-${i}`));
		}
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.owners.some((r) => r.correlationId === 'live-1')).toBe(true);
			expect(scan.owners.some((r) => r.correlationId === 'grown-11')).toBe(
				true,
			);
		}
	});

	it('rewritten history with old timestamps cannot corrupt recovery: checkpoint state wins the merge', async () => {
		await recordPendingDelegation(dir, pendingInput('live-1'));
		await compactBackgroundDelegations(dir, { force: true });
		const checkpoint = JSON.parse(
			fs.readFileSync(checkpointPath(), 'utf-8'),
		) as { cutLedgerBytes: number };
		// Rewrite the ledger larger than the cut with tampered old-timestamp
		// records; the merge rule must keep the checkpoint's live state.
		const tampered = `${JSON.stringify({
			...minimal('tampered-1'),
			promptHash: 'z'.repeat(80),
		})}\n`;
		fs.writeFileSync(
			ledgerPath(),
			tampered.repeat(
				Math.ceil(
					(checkpoint.cutLedgerBytes + 1) / Buffer.byteLength(tampered),
				),
			),
		);
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			// The checkpoint's live state must survive the rewrite untouched.
			const live = scan.owners.find((r) => r.correlationId === 'live-1');
			expect(live).toBeDefined();
			expect(live!.status).toBe('pending');
			// Fresh epoch-ms timestamp, not the tampered record's updatedAt of 2.
			expect(live!.updatedAt).toBeGreaterThan(1_700_000_000_000);
		}
	});

	it('malformed tail line → strict recovery fails closed', async () => {
		await recordPendingDelegation(dir, pendingInput('live-1'));
		await compactBackgroundDelegations(dir, { force: true });
		fs.appendFileSync(ledgerPath(), '{"corrupt json without close');
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('uncertain');
		if (scan.status === 'uncertain') {
			expect(scan.reason).toContain('malformed JSON');
		}
		// The lenient reader still skips the torn line (pinned behavior).
		expect(readDelegations(dir).length).toBe(1);
	});

	it('truncated manifest → uncertain (no legacy fallback)', async () => {
		await recordPendingDelegation(dir, pendingInput('live-1'));
		await compactBackgroundDelegations(dir, { force: true });
		fs.writeFileSync(manifestPath(), '{"schemaVersion":1,"sequ');
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('uncertain');
		if (scan.status === 'uncertain') {
			expect(scan.reason).toContain('manifest is invalid');
		}
	});

	it('corrupt checkpoint with a published manifest fails closed and refuses mutations', async () => {
		await recordPendingDelegation(dir, pendingInput('live-1'));
		await compactBackgroundDelegations(dir, { force: true });
		fs.writeFileSync(checkpointPath(), '{"schemaVersion":1,"corrupt":true}');

		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('uncertain');
		if (scan.status === 'uncertain') {
			expect(scan.reason).toContain('checkpoint is invalid');
		}

		// Mutations refuse rather than appending state derived from partial truth.
		const before = fs.readFileSync(ledgerPath());
		await recordPendingDelegation(dir, pendingInput('must-not-record'));
		expect(fs.readFileSync(ledgerPath()).equals(before)).toBe(true);
		expect(
			readDelegations(dir).some((r) => r.correlationId === 'must-not-record'),
		).toBe(false);

		// The durable health artifact carries the uncertainty + repair hint.
		const health = JSON.parse(
			fs.readFileSync(
				path.join(dir, '.swarm', 'background-delegations-health.json'),
				'utf-8',
			),
		) as { lastUncertainty?: { reason: string; repairHint?: string } };
		expect(health.lastUncertainty?.reason).toContain('checkpoint is invalid');
		expect(health.lastUncertainty?.repairHint).toBeTruthy();
	});

	it('orphan checkpoint without a manifest never blocks the store', async () => {
		await recordPendingDelegation(dir, pendingInput('live-1'));
		const unrolled = fs.readFileSync(ledgerPath());
		await compactBackgroundDelegations(dir, { force: true });
		// Simulate a crash during the checkpoint write: corrupt checkpoint, no
		// manifest, and the roll never happened (ledger restored to pre-cut).
		fs.writeFileSync(checkpointPath(), '{"schemaVersion":1,"corrupt":true}');
		fs.rmSync(manifestPath(), { force: true });
		fs.writeFileSync(ledgerPath(), unrolled);

		expect(readDelegations(dir).length).toBe(1);
		await recordPendingDelegation(dir, pendingInput('orphan-ok-1'));
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('ok');
		if (scan.status === 'ok') {
			expect(scan.owners.some((r) => r.correlationId === 'orphan-ok-1')).toBe(
				true,
			);
		}
	});

	it('sequence regression (mixed files) → uncertain', async () => {
		await recordPendingDelegation(dir, pendingInput('live-1'));
		await compactBackgroundDelegations(dir, { force: true });
		const manifest = readManifest();
		writeManifest({ ...manifest, sequence: 99 });
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('uncertain');
		if (scan.status === 'uncertain') {
			expect(scan.reason).toContain('sequence mismatch');
		}
	});

	it('copied trio bound to a different project root → uncertain with rebind hint', async () => {
		await recordPendingDelegation(dir, pendingInput('live-1'));
		await compactBackgroundDelegations(dir, { force: true });
		const manifest = readManifest();
		writeManifest({ ...manifest, rootPath: 'E:\\definitely\\another\\root' });
		const scan = scanDelegationsForRecovery(dir);
		expect(scan.status).toBe('uncertain');
		if (scan.status === 'uncertain') {
			expect(scan.reason).toContain('different project root');
		}
	});

	it('late terminal for a closed correlation after compaction is rejected, not re-claimed', async () => {
		await recordPendingDelegation(dir, pendingInput('late-1'));
		const first = {
			eventId: 'bgc1:' + 'a'.repeat(64),
			status: 'completed' as const,
			recordedAt: 42,
			result: { chars: 1, truncated: false, digest: 'd'.repeat(64) },
		};
		await claimTerminalResult(dir, 'late-1', first);
		await compactBackgroundDelegations(dir, { force: true });

		// Identical replay → duplicate disposition, not a second claim.
		const replay = await claimTerminalResult(dir, 'late-1', first);
		expect(replay?.disposition).toBe('duplicate');

		// Different terminal for the claimed correlation → rejected.
		const conflicting = await claimTerminalResult(dir, 'late-1', {
			eventId: 'bgc1:' + 'b'.repeat(64),
			status: 'error',
			recordedAt: 99,
			result: { chars: 2, truncated: false, digest: 'e'.repeat(64) },
		});
		expect(conflicting).toBeNull();
	});
});
