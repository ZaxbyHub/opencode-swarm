/**
 * 3593-R4 defect-class guardrail (follow-up from PR #3593): the no-bump
 * observability append fails CLOSED when the durable append generation sits
 * at the safe-integer ceiling, instead of letting `+1` overflow past it.
 *
 * At the ceiling, a silently stable generation would compare equal on every
 * fresh read and re-open the same-revision stale-append hole the
 * `observabilityRevision` CAS exists to close. Reaching the ceiling takes a
 * hand-tampered durable row (~9 quadrillion appends is not practical), so
 * this pins the fail-closed refusal on exactly that input.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	appendObservabilityStateWhileLocked,
	withSessionStateMutation,
} from '../../../src/pr-review/persistence.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = '2026-11-06T00:00:00.000Z';
const AT_MS = 1_762_273_600_000;

const tempDirs: string[] = [];

function seedCeilingRow(directory: string, session: string): void {
	const stateFile = join(
		directory,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(session)}.json`,
	);
	mkdirSync(dirname(stateFile), { recursive: true });
	writeFileSync(
		stateFile,
		JSON.stringify({
			schemaVersion: 1,
			revision: 0,
			sessionID: session,
			mode: 'PR_REVIEW',
			activatedAt: NOW,
			updatedAt: NOW,
			// Hand-tampered durable row at the safe-integer ceiling (zod
			// accepts it: Number.isInteger(2**53 - 1) is true).
			observabilityRevision: Number.MAX_SAFE_INTEGER,
		}),
		'utf8',
	);
}

afterEach(() => {
	closeAllProjectDbs();
	for (const directory of tempDirs.splice(0)) {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Windows: the SQLite WAL may briefly hold the temp dir; best-effort.
		}
	}
});

test('3593-R4: an append against a ceiling-saturated durable row fails closed with a BLOCKED error', async () => {
	const directory = canonicalMkdtemp('sw3593r4-ceiling-');
	tempDirs.push(directory);
	mkdirSync(join(directory, '.git'), { recursive: true });
	const session = 'session-3593-r4-ceiling';
	seedCeilingRow(directory, session);
	const seeded = await readPrWorkflowGateState(directory, session);
	expect(seeded?.observabilityRevision).toBe(Number.MAX_SAFE_INTEGER);

	let error: unknown = null;
	await withSessionStateMutation(directory, session, async () => {
		try {
			await appendObservabilityStateWhileLocked(directory, {
				...seeded!,
				prReviewSubmitRejections: [
					{
						childSessionId: 'child-3593-r4',
						at: AT_MS,
						message: 'append at the ceiling must be refused',
					},
				],
				updatedAt: NOW,
			});
		} catch (caught) {
			error = caught;
		}
	});

	// Fail closed: a BLOCKED refusal, never a silent overflow past the
	// ceiling (where a stable generation would re-open the same-revision
	// stale-append hole).
	expect(error).toBeInstanceOf(Error);
	expect((error as Error).message.startsWith('BLOCKED')).toBe(true);
	expect((error as Error).message).toContain('safe-integer ceiling');

	// The durable row is untouched: still at the ceiling, revision unchanged,
	// and nothing was written.
	const after = await readPrWorkflowGateState(directory, session);
	expect(after?.observabilityRevision).toBe(Number.MAX_SAFE_INTEGER);
	expect(after?.revision).toBe(0);
	expect(after?.prReviewSubmitRejections ?? []).toHaveLength(0);
});
