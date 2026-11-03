/**
 * Issue #3199 review-round guard tests (PR #3226 feedback closure). These pin
 * the branches the frozen acceptance checks do not reach:
 *
 *   - the append path's runtime-enforced contract: a payload that mutates a
 *     state-machine field alongside an observability field is rejected with
 *     BLOCKED and the durable state is unchanged;
 *   - a stale-revision append on the no-bump path is still rejected by the
 *     revision guard;
 *   - a workflow-instance replacement (PR_REVIEW→PR_FEEDBACK handoff shape)
 *     starts the new instance with CLEAN observability state — the durable-
 *     wins merge does not carry the previous instance's entries forward;
 *   - the durable-absent drop branch: an incoming snapshot carrying an
 *     observability entry the durable state lacks cannot resurrect it;
 *   - the merge's disk-fallback: when no coordination row exists yet, the
 *     merge sources durable fields from the legacy JSON import;
 *   - a registry ratchet: the codec binding registers exactly the three
 *     observability field names.
 *
 * Seeding pattern: hand-written legacy gate-state JSON, matching
 * tests/unit/pr-review/journal-revision-cas-3199.test.ts. GREEN at base of
 * this fix round (they pin the already-landed #3199 mechanism plus this
 * round's hardening); each guards a branch a later regression could silently
 * break.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import {
	prWorkflowSessionFileStem,
	readPrWorkflowGateState,
} from '../../../src/hooks/pr-workflow-gate.js';
import {
	appendObservabilityStateWhileLocked,
	writeStateWhileLocked,
} from '../../../src/pr-review/persistence.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const NOW = '2026-10-13T00:00:00.000Z';
const tempDirs: string[] = [];

function freshProject(prefix: string): string {
	const directory = canonicalMkdtemp(`sw3199-guard-${prefix}-`);
	tempDirs.push(directory);
	mkdirSync(join(directory, '.git'), { recursive: true });
	return directory;
}

function stateFile(directory: string, session: string): string {
	return join(
		directory,
		'.swarm',
		'pr-workflow-gates',
		`${prWorkflowSessionFileStem(session)}.json`,
	);
}

function seedGateState(
	directory: string,
	session: string,
	extra: Record<string, unknown> = {},
): void {
	const file = stateFile(directory, session);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		JSON.stringify({
			schemaVersion: 1,
			revision: 0,
			sessionID: session,
			mode: 'PR_REVIEW',
			activatedAt: NOW,
			updatedAt: NOW,
			...extra,
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

test('the append path rejects a payload that also mutates a state-machine field', async () => {
	const directory = freshProject('contract');
	const session = 'session-3199-guard-contract';
	seedGateState(directory, session);
	const fresh = await readPrWorkflowGateState(directory, session);
	expect(fresh).not.toBeNull();

	let thrown: unknown = null;
	try {
		await appendObservabilityStateWhileLocked(directory, {
			...fresh!,
			// State-machine mutation smuggled alongside the observability write:
			mode: 'PR_FEEDBACK',
			prReviewVerdictRejections: [
				{
					sessionId: session,
					at: 1,
					message: '3199 guard: smuggled state-machine mutation',
				},
			],
			updatedAt: NOW,
		});
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(Error);
	expect((thrown as Error).message).toContain('BLOCKED');
	expect((thrown as Error).message).toContain(
		'appendObservabilityStateWhileLocked',
	);
	// The durable state is unchanged after the rejection.
	const after = await readPrWorkflowGateState(directory, session);
	expect(after?.mode).toBe('PR_REVIEW');
	expect(after?.prReviewVerdictRejections).toBeUndefined();
});

test('a stale-revision append on the no-bump path is rejected by the revision guard', async () => {
	const directory = freshProject('stale-append');
	const session = 'session-3199-guard-stale-append';
	seedGateState(directory, session);
	const stale = await readPrWorkflowGateState(directory, session);
	expect(stale).not.toBeNull();

	// A real state-machine write bumps the durable revision 0 -> 1.
	await writeStateWhileLocked(directory, {
		...(await readPrWorkflowGateState(directory, session))!,
		updatedAt: NOW,
	});

	// The append built from the pre-bump snapshot must be refused...
	let thrown: unknown = null;
	try {
		await appendObservabilityStateWhileLocked(directory, {
			...stale!,
			prReviewVerdictRejections: [
				{
					sessionId: session,
					at: 1,
					message: '3199 guard: stale-revision append',
				},
			],
			updatedAt: NOW,
		});
	} catch (error) {
		thrown = error;
	}
	expect(thrown).toBeInstanceOf(Error);
	expect((thrown as Error).message).toContain('BLOCKED');
	expect((thrown as Error).message).toContain('changed concurrently');
	// ...and the durable state carries neither the entry nor a journal written
	// from the stale generation.
	const after = await readPrWorkflowGateState(directory, session);
	expect(after?.revision).toBe(1);
	expect(after?.prReviewVerdictRejections).toBeUndefined();
});

test('a workflow-instance replacement starts the new instance with clean observability state', async () => {
	const directory = freshProject('instance-replace');
	const session = 'session-3199-guard-instance';
	const oldInstance = 'instance-3199-old';
	seedGateState(directory, session, {
		workflowInstanceId: oldInstance,
		prReviewSubmitRejections: [
			{
				childSessionId: 'child-3199-old',
				at: 1,
				message: '3199 guard: entry belonging to the OLD instance',
			},
		],
	});
	const current = await readPrWorkflowGateState(directory, session);
	expect(current?.workflowInstanceId).toBe(oldInstance);

	// The handoff shape: a fresh state object with a NEW workflowInstanceId and
	// no observability fields, persisted with the explicit replacement opt-in.
	const newInstance = 'instance-3199-new';
	const post = await writeStateWhileLocked(
		directory,
		{
			schemaVersion: 1,
			revision: current!.revision,
			sessionID: session,
			workflowInstanceId: newInstance,
			mode: 'PR_FEEDBACK',
			activatedAt: current!.activatedAt,
			updatedAt: NOW,
		},
		{ replaceWorkflowInstanceId: oldInstance },
	);
	expect(post.workflowInstanceId).toBe(newInstance);
	// The old instance's journals/advisories must NOT ride into the new one.
	expect(post.prReviewSubmitRejections).toBeUndefined();
	expect(post.prReviewVerdictRejections).toBeUndefined();
	expect(post.skillContractAdvisories).toBeUndefined();
	const durable = await readPrWorkflowGateState(directory, session);
	expect(durable?.workflowInstanceId).toBe(newInstance);
	expect(durable?.prReviewSubmitRejections).toBeUndefined();
});

test('an incoming snapshot cannot resurrect an observability entry the durable state lacks', async () => {
	const directory = freshProject('no-resurrect');
	const session = 'session-3199-guard-no-resurrect';
	seedGateState(directory, session);
	// Create the authoritative row WITHOUT any observability field.
	await writeStateWhileLocked(directory, {
		...(await readPrWorkflowGateState(directory, session))!,
		updatedAt: NOW,
	});
	const fresh = await readPrWorkflowGateState(directory, session);
	expect(fresh?.skillContractAdvisories).toBeUndefined();

	// A snapshot that carries a stale advisory entry (durable-absent) must not
	// resurrect it: the durable-absent branch drops the field entirely.
	await writeStateWhileLocked(directory, {
		...fresh!,
		skillContractAdvisories: [
			'3199 guard: stale entry that must not resurrect',
		],
		updatedAt: NOW,
	});
	const after = await readPrWorkflowGateState(directory, session);
	expect(after?.skillContractAdvisories).toBeUndefined();
});

test('the durable-wins merge sources fields from the legacy import when no coordination row exists', async () => {
	const directory = freshProject('legacy-fallback');
	const session = 'session-3199-guard-legacy';
	// Seed the legacy JSON WITH a journal entry and never read it first, so
	// the coordination row does not exist until the write itself imports it.
	seedGateState(directory, session, {
		prReviewSubmitRejections: [
			{
				childSessionId: 'child-3199-legacy',
				at: 1,
				message: '3199 guard: entry imported from the legacy projection',
			},
		],
	});

	// A direct state-machine write whose snapshot does NOT carry the field:
	// the merge must source the journal from the disk-imported durable state.
	await writeStateWhileLocked(directory, {
		schemaVersion: 1,
		revision: 0,
		sessionID: session,
		mode: 'PR_REVIEW',
		activatedAt: NOW,
		updatedAt: NOW,
	});
	const after = await readPrWorkflowGateState(directory, session);
	expect(
		after?.prReviewSubmitRejections?.some((entry) =>
			entry.message.includes('entry imported from the legacy projection'),
		),
	).toBe(true);
});

test('registry ratchet: the codec binding registers exactly the four observability fields', () => {
	const source = readFileSync(
		join(process.cwd(), 'src', 'hooks', 'pr-workflow-gate.ts'),
		'utf8',
	);
	const matches = source.match(
		/\[\s*'prReviewSubmitRejections',(?:\s|\/\/[^\n]*)*'prReviewVerdictRejections',(?:\s|\/\/[^\n]*)*'skillContractAdvisories',(?:\s|\/\/[^\n]*)*'prFeedbackStageABaseMismatch',?\s*\]/g,
	);
	// Exactly one binding site carrying exactly these names in order —
	// adding, removing, or renaming a registered field must force this
	// ratchet to be revisited (the durable-wins merge and the append contract
	// are keyed on this list). #3396 feedback (PRR-014): the binding-mismatch
	// marker joined as the fourth observability field — evidence written
	// concurrently with Stage A state transitions, durable-wins against
	// stale-snapshot clobbering, appendable without advancing the revision.
	expect(matches).toHaveLength(1);
	const names = matches![0]!.match(/'[A-Za-z0-9]+'/g) ?? [];
	expect(names).toEqual([
		"'prReviewSubmitRejections'",
		"'prReviewVerdictRejections'",
		"'skillContractAdvisories'",
		"'prFeedbackStageABaseMismatch'",
	]);
});
