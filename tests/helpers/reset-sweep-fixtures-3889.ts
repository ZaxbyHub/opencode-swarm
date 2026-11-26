import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleResetSessionCommand } from '../../src/commands/reset-session';
import type { Plan } from '../../src/config/plan-schema';
import {
	listCoordinationStateRowsRaw,
	transitionCoordinationState,
} from '../../src/db';
import { createScopeBinding } from '../../src/scope/scope-binding';
import { _scopePersistenceInternals } from '../../src/scope/scope-persistence';
import { canonicalMkdtemp, removeTreeWithRetry } from './tmpdir';

/**
 * Fixtures for the reset-session durable scope sweep suites (#3889): a
 * project root with durable `scope-binding` rows, concurrent-writer seams on
 * the sweep's enumeration and its final read, and cleanup. Shared by
 * scope-reset-sweep-reconcile-3889 and scope-reset-sweep-buckets-3889 so that
 * each suite stays under the FR-006 test-file cap.
 */

export const RACED = 'fffffff0-0000-4000-a000-000000000000';
export const OTHER = 'fffffff1-0000-4000-a000-000000000001';

/** A payload that parses but carries no session id: no session can claim it. */
export const UNCLAIMABLE_PAYLOAD = '{"corrupt":true}';

const plan: Plan = {
	schema_version: '1.0.0',
	title: 'sweep-reconcile',
	swarm: 'test',
	current_phase: 1,
	phases: [
		{
			id: 1,
			name: 'P',
			status: 'in_progress',
			tasks: [
				{
					id: '1.1',
					phase: 1,
					status: 'pending',
					size: 'small',
					description: 'd',
					depends: [],
					files_touched: ['src/a.ts'],
				},
			],
		},
	],
};

export type RawSweepRow = ReturnType<
	typeof listCoordinationStateRowsRaw
>[number];

// Captured at module load, before any leg replaces a seam.
export const listRowsUnseamed = _scopePersistenceInternals.listResetSweepRows;
export const readRowUnseamed = _scopePersistenceInternals.readResetSweepRow;
const originalScanCapacity = _scopePersistenceInternals.bindingFileScanCapacity;
const roots: string[] = [];

/** Write one durable row: an insert, or a compare-and-swap when a revision
 * is given. */
export function writeRow(
	root: string,
	generationId: string,
	payload: string,
	expectedRevision?: number,
): void {
	const applied = transitionCoordinationState(root, {
		namespace: 'scope-binding',
		entityKey: generationId,
		expectedRevision,
		generation: 1,
		status: 'live',
		payload,
	});
	if (applied.outcome !== 'applied')
		throw new Error(`fixture: write failed: ${applied.outcome}`);
}

/** A project root the reset-session command accepts. */
export function newSweepRoot(): string {
	const root = canonicalMkdtemp('sweep-reconcile-');
	roots.push(root);
	fs.mkdirSync(path.join(root, '.swarm', 'session'), { recursive: true });
	return root;
}

/** A deny ledger the sink cannot update (valid JSON, wrong shape): every
 * retirement then fails inside its own transaction. */
export function corruptDenyLedger(root: string): void {
	const seeded = transitionCoordinationState(root, {
		namespace: 'scope-binding-deny',
		entityKey: 'deny-ledger',
		generation: 1,
		status: 'active',
		payload: '{"version":2,"entries":{}}',
	});
	if (seeded.outcome !== 'applied')
		throw new Error(`fixture: ledger seed failed: ${seeded.outcome}`);
}

/** The reset-session command's full output for the `victim` session. */
export async function resetText(root: string): Promise<string> {
	const results = await handleResetSessionCommand(root, [], 'victim');
	return Array.isArray(results) ? results.join('\n') : String(results);
}

/** One durable row (a well-formed binding) of the given session. */
export function seedVictimRow(
	root: string,
	generationId: string,
	owner = 'victim',
): void {
	const binding = createScopeBinding({
		directory: root,
		plan,
		taskId: '1.1',
		files: ['src/a.ts'],
		ownerSessionId: owner,
		ownerMessageId: `msg-${generationId}`,
		source: 'declare_scope',
	});
	if (!binding) throw new Error('fixture failed');
	writeRow(root, generationId, JSON.stringify({ ...binding, generationId }));
}

/** A concurrent writer replaces one row's whole payload in place. */
export function rewriteRowPayload(
	root: string,
	generationId: string,
	payload: string,
): void {
	const current = readRowUnseamed(root, generationId);
	if (!current) throw new Error('fixture: the row is not in the store');
	writeRow(root, generationId, payload, current.revision);
}

/** A concurrent writer rewrites one listed row (optionally re-attributing
 * it). The page the sweep already read is now stale. */
export function rewriteListedRow(
	root: string,
	page: readonly RawSweepRow[],
	generationId: string,
	patch: Record<string, unknown> = {},
): void {
	const listed = page.find((row) => row.entityKey === generationId);
	if (!listed) throw new Error('fixture: the row is not on the page');
	const applied = transitionCoordinationState(root, {
		namespace: 'scope-binding',
		entityKey: generationId,
		expectedRevision: listed.revision,
		generation: 1,
		status: 'live',
		payload: JSON.stringify({
			...(JSON.parse(listed.payload) as Record<string, unknown>),
			...patch,
			revision: listed.revision + 1,
		}),
	});
	if (applied.outcome !== 'applied')
		throw new Error(`fixture: rewrite failed: ${applied.outcome}`);
}

/** Every `scope-binding` key left in the store, in key order. */
export function survivingKeys(root: string): string[] {
	return listCoordinationStateRowsRaw(root, 'scope-binding', 50).map(
		(row) => row.entityKey,
	);
}

/** Restore every seam and remove every root. Call from afterEach. */
export function restoreSweepFixtures(): void {
	_scopePersistenceInternals.listResetSweepRows = listRowsUnseamed;
	_scopePersistenceInternals.readResetSweepRow = readRowUnseamed;
	_scopePersistenceInternals.bindingFileScanCapacity = originalScanCapacity;
	for (const root of roots.splice(0)) removeTreeWithRetry(root);
}
