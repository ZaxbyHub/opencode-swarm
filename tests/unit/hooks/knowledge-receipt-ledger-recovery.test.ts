import { afterEach, describe, expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	commitDisplayedMembership,
	commitPhaseClosed,
	ensureLegacyCutover,
	queryHistoricalOutcomes,
	queryLiveMemberships,
	type ReceiptLedgerResult,
	validateAndCommitTerminalBatch,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { resolveReceiptLedgerPaths } from '../../../src/hooks/knowledge-receipt-ledger-storage.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
	while (cleanups.length > 0) cleanups.pop()?.();
});

function project(prefix: string): string {
	const fixture = createSafeTestDir(prefix);
	cleanups.push(fixture.cleanup);
	fs.mkdirSync(path.join(fixture.dir, '.git'));
	return fixture.dir;
}

function unwrap<T>(result: ReceiptLedgerResult<T>): T {
	if (!result.ok) throw new Error(`${result.code}: ${result.detail}`);
	return result;
}

async function seedMembership(directory: string): Promise<void> {
	unwrap(
		await commitDisplayedMembership(directory, {
			trace_id: 'trace-a',
			session_id: 'session-a',
			phase: 'phase-a',
			entries: [{ entry_id: 'entry-a', critical: true }],
		}),
	);
}

async function childTerminal(
	directory: string,
	outcome: 'applied' | 'violated',
) {
	const moduleUrl = pathToFileURL(
		path.resolve(
			import.meta.dir,
			'../../../src/hooks/knowledge-receipt-ledger.ts',
		),
	).href;
	const script = [
		'const ledger = await import(process.env.RECEIPT_LEDGER_MODULE_URL);',
		"const result = await ledger.validateAndCommitTerminalBatch(process.env.RECEIPT_TEST_DIRECTORY, { trace_id: 'trace-a', session_id: 'session-a', items: [{ entry_id: 'entry-a', outcome: process.env.RECEIPT_TEST_OUTCOME }] });",
		'process.stdout.write(JSON.stringify(result));',
	].join('\n');
	const child = spawn(process.execPath, ['-e', script], {
		cwd: path.resolve(import.meta.dir, '../../..'),
		stdin: 'ignore',
		stdio: ['ignore', 'pipe', 'pipe'],
		timeout: 10_000,
		windowsHide: true,
		env: {
			...process.env,
			RECEIPT_LEDGER_MODULE_URL: moduleUrl,
			RECEIPT_TEST_DIRECTORY: directory,
			RECEIPT_TEST_OUTCOME: outcome,
		},
	});
	let stdout = '';
	let stderr = '';
	child.stdout?.on('data', (chunk) => {
		if (stdout.length < 64 * 1024) stdout += String(chunk);
	});
	child.stderr?.on('data', (chunk) => {
		if (stderr.length < 64 * 1024) stderr += String(chunk);
	});
	try {
		const code = await new Promise<number | null>((resolve, reject) => {
			child.once('error', reject);
			child.once('close', resolve);
		});
		if (code !== 0) throw new Error(`child exit ${code}: ${stderr}`);
		return JSON.parse(stdout) as {
			ok: boolean;
			accepted: unknown[];
			idempotent: string[];
			rejected: Array<{ reason: string }>;
		};
	} finally {
		child.kill();
	}
}

describe('knowledge receipt ledger recovery and isolation', () => {
	test('serializes competing processes and preserves a valid authoritative chain', async () => {
		const sameDirectory = project('receipt-ledger-process-same-');
		await seedMembership(sameDirectory);
		const same = await Promise.all([
			childTerminal(sameDirectory, 'applied'),
			childTerminal(sameDirectory, 'applied'),
		]);
		expect(same.flatMap((result) => result.accepted)).toHaveLength(1);
		expect(same.flatMap((result) => result.idempotent)).toEqual(['entry-a']);
		expect(
			unwrap(await queryLiveMemberships(sameDirectory)).memberships[0]?.terminal
				?.outcome,
		).toBe('applied');

		const conflictDirectory = project('receipt-ledger-process-conflict-');
		await seedMembership(conflictDirectory);
		const conflict = await Promise.all([
			childTerminal(conflictDirectory, 'applied'),
			childTerminal(conflictDirectory, 'violated'),
		]);
		expect(conflict.flatMap((result) => result.accepted)).toHaveLength(1);
		expect(
			conflict.flatMap((result) => result.rejected).map((row) => row.reason),
		).toEqual(['duplicate_conflicting_terminal']);
		expect(
			unwrap(await queryLiveMemberships(conflictDirectory)).memberships,
		).toHaveLength(1);
	});
	test('recovers only an invalid partial final tail and preserves restart state', async () => {
		const directory = project('receipt-ledger-tail-');
		await seedMembership(directory);
		const journal = path.join(
			directory,
			'.swarm',
			'knowledge-receipts-v2.jsonl',
		);
		fs.appendFileSync(journal, '{"schema_version":2,"seq":');

		const live = unwrap(await queryLiveMemberships(directory));
		expect(live.memberships).toHaveLength(1);
		const recovered = fs.readFileSync(journal, 'utf8');
		expect(recovered).not.toContain('\n{"schema_version":2,"seq":');
		expect(recovered.endsWith('\n')).toBe(true);
		expect(
			fs.readFileSync(
				path.join(directory, '.swarm', 'knowledge-receipts-v2-quarantine.json'),
				'utf8',
			),
		).toContain('partial_tail');
	});

	test('fails closed on middle corruption instead of skipping it', async () => {
		const directory = project('receipt-ledger-middle-');
		await seedMembership(directory);
		const journal = path.join(
			directory,
			'.swarm',
			'knowledge-receipts-v2.jsonl',
		);
		const original = fs.readFileSync(journal, 'utf8');
		const firstBreak = original.indexOf('\n') + 1;
		fs.writeFileSync(
			journal,
			`${original.slice(0, firstBreak)}{not-json}\n${original.slice(firstBreak)}`,
		);

		const result = await queryLiveMemberships(directory);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected corrupt store failure');
		expect(result.code).toBe('store_corrupt');
		expect(result.detail).toContain('line 2');
	});

	test('treats the snapshot as rebuildable non-authority', async () => {
		const directory = project('receipt-ledger-snapshot-');
		await seedMembership(directory);
		const snapshot = path.join(
			directory,
			'.swarm',
			'knowledge-receipts-v2.snapshot.json',
		);
		fs.writeFileSync(snapshot, '{corrupt snapshot');

		const live = unwrap(await queryLiveMemberships(directory));
		expect(live.memberships[0]).toMatchObject({
			trace_id: 'trace-a',
			entry_id: 'entry-a',
		});
		expect(() => JSON.parse(fs.readFileSync(snapshot, 'utf8'))).not.toThrow();
	});

	test('never serializes nonTransientCircuit into journal, snapshot, or archive', async () => {
		const directory = project('receipt-ledger-private-state-');
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-private',
				session_id: 'session-private',
				phase: 'phase-private',
				grace_days: 0,
				entries: [{ entry_id: 'entry-private', critical: true }],
				nonTransientCircuit: { stopped: true },
			} as Parameters<typeof commitDisplayedMembership>[1]),
		);
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-private',
				session_id: 'session-private',
				items: [{ entry_id: 'entry-private', outcome: 'violated' }],
			}),
		);
		unwrap(await commitPhaseClosed(directory, 'phase-private'));
		unwrap(await queryHistoricalOutcomes(directory));

		for (const filename of [
			'knowledge-receipts-v2.jsonl',
			'knowledge-receipts-v2.snapshot.json',
			'knowledge-receipts-v2-archive.jsonl',
		]) {
			expect(
				fs.readFileSync(path.join(directory, '.swarm', filename), 'utf8'),
			).not.toContain('nonTransientCircuit');
		}
	});

	test('returns typed lock_timeout and never falls back to unlocked reads', async () => {
		const directory = project('receipt-ledger-lock-');
		unwrap(await ensureLegacyCutover(directory));
		const paths = resolveReceiptLedgerPaths(directory);
		fs.writeFileSync(
			paths.lockTarget,
			JSON.stringify({
				owner_token: 'live-owner',
				pid: process.pid,
				created_at_ms: Date.now(),
				root_identity: fs.realpathSync(directory),
			}),
		);
		const old = new Date(0);
		fs.utimesSync(paths.lockTarget, old, old);
		try {
			const result = await queryLiveMemberships(directory);
			expect(result.ok).toBe(false);
			if (result.ok) throw new Error('expected lock timeout');
			expect(result.code).toBe('lock_timeout');
			expect(result.uncertainty).toContain(
				'receipt correctness lock unavailable',
			);
		} finally {
			fs.rmSync(paths.lockTarget, { force: true });
		}
	});

	test('recovers a dead owner lock but rejects a reparse-point swarm directory', async () => {
		const deadOwnerDirectory = project('receipt-ledger-dead-lock-');
		const deadPaths = resolveReceiptLedgerPaths(deadOwnerDirectory);
		fs.mkdirSync(deadPaths.swarmDir);
		fs.writeFileSync(
			deadPaths.lockTarget,
			JSON.stringify({
				owner_token: 'dead-owner',
				pid: 2_147_483_647,
				created_at_ms: Date.now(),
				root_identity: fs.realpathSync(deadOwnerDirectory),
			}),
		);
		expect(
			unwrap(await ensureLegacyCutover(deadOwnerDirectory)).completed,
		).toBe(true);

		const linkedDirectory = project('receipt-ledger-reparse-');
		const escaped = path.join(linkedDirectory, 'escaped-state');
		fs.mkdirSync(escaped);
		fs.symlinkSync(escaped, path.join(linkedDirectory, '.swarm'), 'junction');
		const result = await queryLiveMemberships(linkedDirectory);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('store_unavailable');
	});

	test('fails typed on oversized active authority and malformed archived authority', async () => {
		const directory = project('receipt-ledger-bounds-');
		await seedMembership(directory);
		const paths = resolveReceiptLedgerPaths(directory);
		fs.truncateSync(paths.journal, 32 * 1024 * 1024 + 1);
		const oversized = await queryLiveMemberships(directory);
		expect(oversized.ok).toBe(false);
		if (!oversized.ok) expect(oversized.code).toBe('store_corrupt');

		const archiveDirectory = project('receipt-ledger-archive-corrupt-');
		await seedMembership(archiveDirectory);
		const archivePaths = resolveReceiptLedgerPaths(archiveDirectory);
		fs.writeFileSync(archivePaths.archive, '{bad archive}\n');
		const historical = await queryHistoricalOutcomes(archiveDirectory);
		expect(historical.ok).toBe(false);
		if (!historical.ok) expect(historical.code).toBe('store_corrupt');
	});

	test('preserves authorized terminal history through archive compaction', async () => {
		const directory = project('receipt-ledger-authorized-history-');
		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-history',
				session_id: 'session-history',
				phase: 'phase-history',
				grace_days: 0,
				entries: [{ entry_id: 'entry-history', critical: true }],
			}),
		);
		const first = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-history',
				session_id: 'session-history',
				items: [{ entry_id: 'entry-history', outcome: 'violated' }],
			}),
		);
		unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'trace-history',
				session_id: 'session-history',
				items: [{ entry_id: 'entry-history', outcome: 'applied' }],
				authorization: {
					actor: 'reviewer-remediation',
					reason: 'fixed',
					expected_event_id: first.accepted[0].event_id,
				},
			}),
		);
		unwrap(await commitPhaseClosed(directory, 'phase-history'));
		const archived = unwrap(
			await queryHistoricalOutcomes(directory, ['entry-history']),
		).memberships[0];
		expect(archived?.terminal?.outcome).toBe('applied');
		expect(
			archived?.terminal_history?.map((terminal) => terminal.outcome),
		).toEqual(['violated', 'applied']);
	});

	test('marks linked legacy state unverifiable and does not import it', async () => {
		const directory = project('receipt-ledger-linked-legacy-');
		const swarmDir = path.join(directory, '.swarm');
		fs.mkdirSync(swarmDir);
		fs.writeFileSync(
			path.join(swarmDir, 'link.json'),
			JSON.stringify({ cohort_id: 'linked', target: 'outside' }),
		);
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge-events.jsonl'),
			`${JSON.stringify({
				type: 'retrieved',
				event_id: 'legacy-retrieval',
				trace_id: 'legacy-trace',
				timestamp: new Date().toISOString(),
				session_id: 'legacy-session',
				result_ids: ['legacy-entry'],
			})}\n`,
		);

		unwrap(await ensureLegacyCutover(directory));
		expect(unwrap(await queryLiveMemberships(directory)).memberships).toEqual(
			[],
		);
		const rows = fs
			.readFileSync(path.join(swarmDir, 'knowledge-receipts-v2.jsonl'), 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { kind: string; payload: unknown });
		expect(rows.some((row) => row.kind === 'legacy_unverifiable')).toBe(true);
		expect(rows.some((row) => row.kind === 'legacy_imported')).toBe(false);
		expect(rows.at(-1)?.kind).toBe('cutover_completed');
	});

	test('imports a fully terminalized correlated legacy trace and preserves its identity', async () => {
		const directory = project('receipt-ledger-legacy-terminal-');
		const swarmDir = path.join(directory, '.swarm');
		fs.mkdirSync(swarmDir);
		const timestamp = new Date().toISOString();
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge-events.jsonl'),
			[
				JSON.stringify({
					type: 'retrieved',
					event_id: 'legacy-membership',
					trace_id: 'legacy-trace',
					timestamp,
					session_id: 'legacy-session',
					result_ids: ['legacy-entry'],
				}),
				JSON.stringify({
					type: 'applied',
					event_id: 'legacy-terminal',
					trace_id: 'legacy-trace',
					knowledge_id: 'legacy-entry',
					timestamp,
					session_id: 'legacy-session',
					source: 'legacy-reviewer',
				}),
			].join('\n') + '\n',
		);
		unwrap(await ensureLegacyCutover(directory));
		const live = unwrap(await queryLiveMemberships(directory)).memberships[0];
		expect(live).toMatchObject({
			critical: true,
			terminal: { event_id: 'legacy-terminal', outcome: 'applied' },
		});
		expect(live?.terminal_history).toHaveLength(1);
		const retry = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'legacy-trace',
				session_id: 'legacy-session',
				items: [{ entry_id: 'legacy-entry', outcome: 'applied' }],
			}),
		);
		expect(retry.idempotent_events[0]?.event_id).toBe('legacy-terminal');
		const conflict = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'legacy-trace',
				session_id: 'legacy-session',
				items: [{ entry_id: 'legacy-entry', outcome: 'violated' }],
			}),
		);
		expect(conflict.rejected[0]?.reason).toBe('duplicate_conflicting_terminal');
	});

	test('keeps unknown traces typed uncertain when a legacy baseline proves unattributable history', async () => {
		const directory = project('receipt-ledger-legacy-baseline-');
		const swarmDir = path.join(directory, '.swarm');
		fs.mkdirSync(swarmDir);
		fs.writeFileSync(
			path.join(swarmDir, 'knowledge-counter-baseline.json'),
			JSON.stringify({ retrieved: 1 }),
		);
		unwrap(await ensureLegacyCutover(directory));
		const result = unwrap(
			await validateAndCommitTerminalBatch(directory, {
				trace_id: 'missing',
				session_id: 'legacy-session',
				items: [{ entry_id: 'missing-entry', outcome: 'applied' }],
			}),
		);
		expect(result.rejected[0]?.reason).toBe('legacy_unverifiable');
	});
});
