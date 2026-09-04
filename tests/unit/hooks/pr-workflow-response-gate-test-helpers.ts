import { mkdtempSync, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
	PrReviewDepthTier,
	PrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import { writeAuthoritativePrWorkflowState } from '../../helpers/pr-workflow-state-authority.js';

/** Create a fresh, symlink-resolved temp directory under a given prefix. */
export function makeTempDir(prefix: string): string {
	return realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** Write a raw gate-state record with a specific revision and optional depth tier. */
export async function writeStateWithRevision(
	directory: string,
	sessionID: string,
	revision: number,
	tier?: PrReviewDepthTier,
): Promise<void> {
	const state: PrWorkflowGateState = {
		schemaVersion: 1,
		revision,
		sessionID,
		mode: 'PR_REVIEW',
		activatedAt: '2026-07-19T00:00:00.000Z',
		updatedAt: '2026-07-19T00:00:00.000Z',
		...(tier !== undefined && { prReviewDepthTier: tier }),
	};
	await writeAuthoritativePrWorkflowState(directory, state);
}

/** Write a raw gate-state record, omitting `prReviewDepthTier` entirely
 * (as opposed to setting it to undefined), so `?? 'L'` fallbacks are
 * genuinely exercised on an absent field rather than an explicit `undefined`
 * key that JSON.stringify would drop anyway. */
export async function writeStateWithoutTier(
	directory: string,
	sessionID: string,
	revision: number,
): Promise<void> {
	const state: Omit<PrWorkflowGateState, 'prReviewDepthTier'> = {
		schemaVersion: 1,
		revision,
		sessionID,
		mode: 'PR_REVIEW',
		activatedAt: '2026-07-19T00:00:00.000Z',
		updatedAt: '2026-07-19T00:00:00.000Z',
	};
	await writeAuthoritativePrWorkflowState(directory, state);
}

export function idleEventFor(sessionID: string): { event: unknown } {
	return {
		event: {
			type: 'session.idle',
			properties: { sessionID },
		},
	};
}
