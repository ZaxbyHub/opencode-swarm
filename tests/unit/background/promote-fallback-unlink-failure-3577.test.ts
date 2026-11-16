/**
 * Issue #3577 (PRR-004) — promoteDelegationFallback must NEVER return null
 * after the fallback record has been durably appended to the primary ledger.
 *
 * The pre-fix behavior: a non-ENOENT unlink failure (e.g. the artifact path
 * momentarily locked or replaced) returned null AFTER appendRecord had landed
 * a LIVE pending record, so the completion observer's promotion-failure arm
 * flushed the call's route-invalidation marker for that live record —
 * skipping its Stage-B route consult on a later delivery. The fix: the
 * promotion succeeded once the record is in the primary ledger; the stale
 * artifact is inert (reads prefer the primary) and its cleanup is best-effort.
 *
 * Also pins the genuine-failure shape that the observer's promotion-failure
 * flush is FOR: with no fallback artifact and no primary record, promotion
 * returns null (nothing was appended), which is the only state where the
 * observer's flush is correct.
 */
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	BACKGROUND_DELEGATION_FALLBACK_DIR,
	findByCorrelationId,
	promoteDelegationFallback,
	writeDelegationFallback,
} from '../../../src/background/pending-delegations';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

let directory = '';
let cleanupDirectory = (): void => {};

const HEAD = 'a'.repeat(40);

const baseInput = () => ({
	correlationId: 'child-3577',
	jobId: 'job-3577',
	subagentSessionId: 'child-3577',
	parentSessionId: 'parent-3577',
	callID: 'call-3577',
	normalizedAgent: 'reviewer',
	swarmPrefixedAgent: 'reviewer',
	planTaskId: null,
	evidenceTaskId: '1.1',
	workspace: {
		directory,
		gitHead: HEAD,
		dirtyHash: null,
		prHeadSha: HEAD,
		scope: null,
	},
});

const fallbackArtifactPath = (correlationId: string): string =>
	path.join(
		directory,
		'.swarm',
		BACKGROUND_DELEGATION_FALLBACK_DIR,
		`${createHash('sha256').update(correlationId).digest('hex')}.json`,
	);

beforeEach(() => {
	const safe = createSafeTestDir('promote-unlink-3577-');
	directory = safe.dir;
	cleanupDirectory = safe.cleanup;
	fs.mkdirSync(path.join(directory, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
});

afterEach(() => {
	cleanupDirectory();
});

describe('promoteDelegationFallback unlink failure (#3577 PRR-004)', () => {
	it('returns the promoted record (not null) when the artifact unlink fails after the primary append', async () => {
		const written = await writeDelegationFallback(directory, baseInput());
		expect(written).not.toBeNull();

		// Force a non-ENOENT unlink failure with the artifact still READABLE
		// (a scoped spy on the shared fs.promises object — the artifact must
		// parse successfully so promotion reaches the post-append unlink).
		const artifactPath = fallbackArtifactPath('child-3577');
		expect(fs.existsSync(artifactPath)).toBe(true);
		const unlinkSpy = spyOn(fs.promises, 'unlink').mockImplementationOnce(
			async (target: never) => {
				const err = new Error(
					`EPERM: operation not permitted, unlink '${String(target)}'`,
				) as NodeJS.ErrnoException;
				err.code = 'EPERM';
				throw err;
			},
		);
		try {
			const promoted = await promoteDelegationFallback(directory, 'child-3577');
			// Pre-fix this was null — the exact live-marker-retirement shape.
			expect(promoted).not.toBeNull();
			expect(promoted?.record.correlationId).toBe('child-3577');
			expect(promoted?.record.parentSessionId).toBe('parent-3577');
			// The record is durably in the primary ledger.
			expect(findByCorrelationId(directory, 'child-3577')?.callID).toBe(
				'call-3577',
			);
		} finally {
			unlinkSpy.mockRestore();
		}
	});

	it('still returns null on a genuine failure (no artifact, no primary record) — the observer-flush precondition', async () => {
		// Nothing written: no fallback artifact, empty primary ledger.
		const promoted = await promoteDelegationFallback(directory, 'child-3577');
		expect(promoted).toBeNull();
		expect(findByCorrelationId(directory, 'child-3577')).toBeNull();
	});
});
