import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
	abortPrWorkflow,
	completePrWorkflow,
	_test_exports as gateInternals,
	readPrWorkflowGateState,
	readPrWorkflowGateStateForRecovery,
} from '../../../src/hooks/pr-workflow-gate.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

let directory = '';
const originals = {
	resolveCurrentGitHead: gateInternals.resolveCurrentGitHead,
	resolveCurrentGitHeadAsync: gateInternals.resolveCurrentGitHeadAsync,
	resolveIsWorkingTreeClean: gateInternals.resolveIsWorkingTreeClean,
	resolveIsWorkingTreeCleanAsync: gateInternals.resolveIsWorkingTreeCleanAsync,
};

beforeEach(() => {
	directory = canonicalMkdtemp('pr-workflow-corrupt-');
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = () => 'abc123';
	gateInternals.resolveCurrentGitHeadAsync = async () => 'abc123';
	gateInternals.resolveIsWorkingTreeClean = () => true;
	gateInternals.resolveIsWorkingTreeCleanAsync = async () => true;
});

afterEach(async () => {
	gateInternals.resetTrackedStateCache();
	gateInternals.resolveCurrentGitHead = originals.resolveCurrentGitHead;
	gateInternals.resolveCurrentGitHeadAsync =
		originals.resolveCurrentGitHeadAsync;
	gateInternals.resolveIsWorkingTreeClean = originals.resolveIsWorkingTreeClean;
	gateInternals.resolveIsWorkingTreeCleanAsync =
		originals.resolveIsWorkingTreeCleanAsync;
	await fs.rm(directory, { recursive: true, force: true });
});

/** Write arbitrary bytes to the durable gate-state path for `sessionID`. */
async function writeRawBytes(
	sessionID: string,
	bytes: string,
): Promise<string> {
	const absolute = path.join(
		directory,
		'.swarm',
		gateInternals.workflowGateStateRelativePath(sessionID),
	);
	await fs.mkdir(path.dirname(absolute), { recursive: true });
	await fs.writeFile(absolute, bytes, 'utf-8');
	return absolute;
}

const ARMED_RECORD = {
	revisionDigest: 'rev-1',
	localHead: 'def456',
	remoteName: 'origin',
	remoteBranchRef: 'refs/heads/fix/x',
	remoteRef: 'refs/remotes/origin/fix/x',
	validatedAt: '2026-07-19T00:00:00.000Z',
};

const TERMINAL_RECOVERY = {
	code: 'UNMERGED_INDEX',
	retryable: false,
	requiredAction: 'resolve the unmerged index manually',
	evidence: {
		worktreeRoot: null,
		gitDir: null,
		operations: ['merge'],
		unmergedCodes: ['UU'],
		paths: ['src/conflict.ts'],
		trackedCount: 1,
		untrackedCount: 0,
		pathsTruncated: false,
	},
	detectedAt: '2026-07-19T00:00:00.000Z',
};

/**
 * A schema-INVALID but JSON-parseable gate state. The schema is
 * `.passthrough()` (pr-workflow-gate.ts:951), so an unknown field would NOT
 * fail validation — the corruption must hit a KNOWN field. A malformed nested
 * record is the realistic partial-write / interrupted-rename shape.
 */
function corruptState(
	sessionID: string,
	overrides: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		schemaVersion: 1,
		revision: 7,
		sessionID,
		mode: 'PR_REVIEW',
		activatedAt: '2026-07-19T00:00:00.000Z',
		updatedAt: '2026-07-19T00:00:00.000Z',
		prHeadSha: 'abc123',
		// Known field, wrong shape → schema validation fails.
		prReviewValidationBatches: 'not-an-array',
		...overrides,
	});
}

describe('readPrWorkflowGateStateForRecovery — regression: corrupted gate state defeated even abort (R4/W-5)', () => {
	test('a schema-VALID state reads through unchanged and is not marked salvaged', async () => {
		await writeRawBytes(
			'valid-session',
			JSON.stringify({
				schemaVersion: 1,
				revision: 4,
				sessionID: 'valid-session',
				mode: 'PR_REVIEW',
				activatedAt: '2026-07-19T00:00:00.000Z',
				updatedAt: '2026-07-19T00:00:00.000Z',
				prHeadSha: 'abc123',
			}),
		);

		const read = await readPrWorkflowGateStateForRecovery(
			directory,
			'valid-session',
		);

		expect(read?.salvaged).toBe(false);
		expect(read?.schemaErrors).toEqual([]);
		expect(read?.disclosure).toBeUndefined();
		expect(read?.state.revision).toBe(4);
		expect(read?.state.prHeadSha).toBe('abc123');
	});

	test('a schema-INVALID but parseable state is salvaged with loud disclosure', async () => {
		// Previous behaviour: readPrWorkflowGateStateFileFromDisk threw
		// `BLOCKED: ... is invalid` for every reader, including the one
		// abort_pr_workflow needs — every field became stuck simultaneously and
		// no tool could clear the gate.
		await writeRawBytes('salvage-session', corruptState('salvage-session'));

		const read = await readPrWorkflowGateStateForRecovery(
			directory,
			'salvage-session',
		);

		expect(read?.salvaged).toBe(true);
		expect(read?.state.sessionID).toBe('salvage-session');
		expect(read?.state.mode).toBe('PR_REVIEW');
		expect(read?.state.prHeadSha).toBe('abc123');
		expect(read?.revisionSalvageable).toBe(true);
		expect(read?.state.revision).toBe(7);
		expect(read?.schemaErrors.join(' ')).toContain('prReviewValidationBatches');
		expect(read?.disclosure).toContain('failed schema validation');
		expect(read?.disclosure).toContain('prReviewValidationBatches');
	});

	test('the GENERAL reader still fails on the same bytes', async () => {
		await writeRawBytes('general-session', corruptState('general-session'));

		await expect(
			readPrWorkflowGateState(directory, 'general-session'),
		).rejects.toThrow(/is invalid/i);
	});

	test('unparseable bytes fail EVERYWHERE, recovery reader included', async () => {
		await writeRawBytes('garbage-session', '{ this is not json');

		await expect(
			readPrWorkflowGateStateForRecovery(directory, 'garbage-session'),
		).rejects.toThrow(/not valid JSON/i);
		await expect(
			readPrWorkflowGateState(directory, 'garbage-session'),
		).rejects.toThrow(/not valid JSON/i);
	});

	test('salvage carries the optional triple when each is well-formed', async () => {
		await writeRawBytes(
			'triple-session',
			corruptState('triple-session', {
				mode: 'PR_FEEDBACK',
				prFeedbackReadyToPublish: ARMED_RECORD,
				checkoutRecovery: TERMINAL_RECOVERY,
			}),
		);

		const read = await readPrWorkflowGateStateForRecovery(
			directory,
			'triple-session',
		);

		expect(read?.salvaged).toBe(true);
		expect(read?.state.revision).toBe(7);
		expect(read?.state.prFeedbackReadyToPublish).toMatchObject(ARMED_RECORD);
		expect(read?.state.checkoutRecovery).toMatchObject({
			code: 'UNMERGED_INDEX',
		});
		expect(read?.armedShapeUnreadable).toBe(false);
	});

	test('an unsalvageable revision is reported, not invented', async () => {
		await writeRawBytes(
			'no-revision',
			corruptState('no-revision', { revision: 'not-a-number' }),
		);

		const read = await readPrWorkflowGateStateForRecovery(
			directory,
			'no-revision',
		);

		expect(read?.salvaged).toBe(true);
		expect(read?.revisionSalvageable).toBe(false);
		expect(read?.disclosure).toContain('state revision unsalvageable');
	});

	test('an unsalvageable sessionID/mode is NOT salvaged (identity fails closed)', async () => {
		await writeRawBytes(
			'no-identity',
			JSON.stringify({ schemaVersion: 1, mode: 'NOT_A_MODE' }),
		);

		await expect(
			readPrWorkflowGateStateForRecovery(directory, 'no-identity'),
		).rejects.toThrow(/is invalid/i);
	});

	test('a missing state file is absence, not corruption', async () => {
		expect(
			await readPrWorkflowGateStateForRecovery(directory, 'absent-session'),
		).toBeNull();
	});
});

describe('abortPrWorkflow on salvaged state — regression: abort must survive gate-state corruption (R4/W-5)', () => {
	test('abort SUCCEEDS on a salvaged state and discloses the salvage', async () => {
		await writeRawBytes('abort-salvage', corruptState('abort-salvage'));

		const summary = await abortPrWorkflow(directory, 'abort-salvage', {
			kind: 'recovery',
			reason: 'gate state corrupted; no other exit',
		});

		expect(summary.mode).toBe('PR_REVIEW');
		expect(summary.prHeadSha).toBe('abc123');
		expect(summary.stateSalvaged).toBe(true);
		expect(summary.stateSalvageDisclosure).toContain(
			'failed schema validation',
		);
		expect(
			await readPrWorkflowGateStateForRecovery(directory, 'abort-salvage'),
		).toBeNull();
	});

	test('a salvaged state WITH a well-formed revision aborts via normal CAS', async () => {
		await writeRawBytes('cas-normal', corruptState('cas-normal'));

		const summary = await abortPrWorkflow(directory, 'cas-normal', {
			kind: 'recovery',
			reason: 'corrupt but revision intact',
		});

		expect(summary.stateSalvaged).toBe(true);
		// The CAS escape must NOT be taken when the revision was salvageable.
		expect(summary.casEscapeDisclosure).toBeUndefined();
		expect(summary.stateSalvageDisclosure).not.toContain(
			'cleared without compare-and-swap',
		);
	});

	test('an unsalvageable revision aborts via the documented CAS escape, disclosed', async () => {
		await writeRawBytes(
			'cas-escape',
			corruptState('cas-escape', { revision: 'not-a-number' }),
		);

		const summary = await abortPrWorkflow(directory, 'cas-escape', {
			kind: 'recovery',
			reason: 'revision unsalvageable',
		});

		expect(summary.casEscapeDisclosure).toBe(
			'state revision unsalvageable; cleared without compare-and-swap',
		);
		expect(
			await readPrWorkflowGateStateForRecovery(directory, 'cas-escape'),
		).toBeNull();
	});

	test('a WELL-FORMED armed marker still refuses abort on salvaged state', async () => {
		await writeRawBytes(
			'armed-salvage',
			corruptState('armed-salvage', {
				mode: 'PR_FEEDBACK',
				prFeedbackReadyToPublish: ARMED_RECORD,
			}),
		);

		await expect(
			abortPrWorkflow(directory, 'armed-salvage', {
				kind: 'force',
				reason: 'x',
			}),
		).rejects.toThrow(/armed for publication; abort is blocked/i);
	});

	test('an UNREADABLE armed marker still refuses abort (fail-closed, not bypass)', async () => {
		// Salvage must never turn "corrupt the armed record" into a way to bypass
		// the armed-abort refusal. A present-but-unreadable marker is treated as
		// armed.
		await writeRawBytes(
			'armed-corrupt',
			corruptState('armed-corrupt', {
				mode: 'PR_FEEDBACK',
				prFeedbackReadyToPublish: { revisionDigest: 'rev-1' },
			}),
		);

		const read = await readPrWorkflowGateStateForRecovery(
			directory,
			'armed-corrupt',
		);
		expect(read?.armedShapeUnreadable).toBe(true);
		expect(read?.state.prFeedbackReadyToPublish).toBeUndefined();

		await expect(
			abortPrWorkflow(directory, 'armed-corrupt', {
				kind: 'force',
				reason: 'x',
			}),
		).rejects.toThrow(/armed for publication; abort is blocked/i);
	});

	test('a NULL armed marker still refuses abort (fail-closed, not bypass)', async () => {
		// Previous code required `!== null` for the marker to count as present,
		// so `prFeedbackReadyToPublish: null` — the most likely nested-record
		// corruption — silently read as UNARMED on the salvage path and abort
		// cleared the gate (4.5-review finding). The schema is `.optional()`,
		// never `.nullable()`: null is corruption and must be treated as armed.
		await writeRawBytes(
			'armed-null',
			corruptState('armed-null', {
				mode: 'PR_FEEDBACK',
				prFeedbackReadyToPublish: null,
			}),
		);

		const read = await readPrWorkflowGateStateForRecovery(
			directory,
			'armed-null',
		);
		expect(read?.armedShapeUnreadable).toBe(true);
		expect(read?.state.prFeedbackReadyToPublish).toBeUndefined();

		await expect(
			abortPrWorkflow(directory, 'armed-null', {
				kind: 'force',
				reason: 'x',
			}),
		).rejects.toThrow(/armed for publication; abort is blocked/i);
	});

	test('abort on an absent gate still reports "no active gate"', async () => {
		await expect(
			abortPrWorkflow(directory, 'nothing-here', {
				kind: 'recovery',
				reason: 'x',
			}),
		).rejects.toThrow(/no active PR workflow gate/i);
	});
});

describe('write paths never see a salvaged view (R4/W-5)', () => {
	test('completePrWorkflow is refused on a salvaged state', async () => {
		await writeRawBytes('complete-salvage', corruptState('complete-salvage'));

		await expect(
			completePrWorkflow(directory, 'complete-salvage', 'PR_REVIEW', 'abc123'),
		).rejects.toThrow(/is invalid/i);
	});
});

describe('pr_workflow_status reads through the recovery view (R4/W-5)', () => {
	test('status reports a salvaged gate instead of throwing', async () => {
		const { _internals: statusInternals, pr_workflow_status } = await import(
			'../../../src/tools/pr-workflow-status.js'
		);
		const saved = {
			runGitCapture: statusInternals.runGitCapture,
			resolveCurrentGitHeadAsync: statusInternals.resolveCurrentGitHeadAsync,
			resolveIsWorkingTreeCleanAsync:
				statusInternals.resolveIsWorkingTreeCleanAsync,
			classifyGitState: statusInternals.classifyGitState,
		};
		statusInternals.runGitCapture = async () => null;
		statusInternals.resolveCurrentGitHeadAsync = async () => 'abc123';
		statusInternals.resolveIsWorkingTreeCleanAsync = async () => true;
		statusInternals.classifyGitState = async () => ({
			kind: 'clean',
			code: 'CLEAN',
			retryable: true,
			requiredAction: 'No checkout recovery is required.',
			evidence: {
				worktreeRoot: directory,
				gitDir: `${directory}/.git`,
				operations: [],
				unmergedCodes: [],
				paths: [],
				trackedCount: 0,
				untrackedCount: 0,
				pathsTruncated: false,
			},
		});
		try {
			await writeRawBytes('status-salvage', corruptState('status-salvage'));
			const raw = await (
				pr_workflow_status as unknown as {
					execute: (args: unknown, ctx: unknown) => Promise<unknown>;
				}
			).execute({}, { directory, sessionID: 'status-salvage' });
			const parsed = JSON.parse(
				typeof raw === 'string' ? raw : (raw as { output: string }).output,
			);
			expect(parsed.gate.active).toBe(true);
			expect(parsed.gate.stateSalvaged).toBe(true);
			expect(parsed.gate.stateSalvageDisclosure).toContain(
				'failed schema validation',
			);
		} finally {
			Object.assign(statusInternals, saved);
		}
	});
});
