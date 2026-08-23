import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	commitDisplayedMembership,
	commitEmptyRetrieval,
	_internals as ledgerInternals,
	queryLiveMemberships,
	type ReceiptLedgerResult,
	repairKnowledgeReceiptLedger,
} from '../../../src/hooks/knowledge-receipt-ledger.js';
import { createSafeTestDir } from '../../helpers/safe-test-dir.js';

const cleanups: Array<() => void> = [];
let restoreAppend: typeof ledgerInternals.appendFsynced | undefined;

afterEach(() => {
	if (restoreAppend) {
		ledgerInternals.appendFsynced = restoreAppend;
		restoreAppend = undefined;
	}
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
			task_id: 'task-a',
			entries: [{ entry_id: 'entry-a', critical: true }],
		}),
	);
}

describe('repairKnowledgeReceiptLedger', () => {
	test('validates readable authority and rebuilds the derived snapshot', async () => {
		const directory = project('receipt-ledger-repair-readable-');
		await seedMembership(directory);
		const snapshot = path.join(
			directory,
			'.swarm',
			'knowledge-receipts-v2.snapshot.json',
		);
		fs.writeFileSync(snapshot, '{bad snapshot');

		const result = await repairKnowledgeReceiptLedger(directory, {
			phase: 'phase-a',
			session_id: 'session-a',
			task_id: 'task-a',
			reason: 'rebuild derived projection',
		});

		expect(result).toMatchObject({
			ok: true,
			status: 'validated_projection',
			pending_re_evaluation: false,
		});
		expect(JSON.parse(fs.readFileSync(snapshot, 'utf8'))).toMatchObject({
			rebuildable: true,
			through_seq: expect.any(Number),
			memberships: [expect.objectContaining({ trace_id: 'trace-a' })],
		});
	});

	test('repairs a corrupt partial tail, quarantines the original, and blocks overlapping live reads until re-evaluation', async () => {
		const directory = project('receipt-ledger-repair-tail-');
		await seedMembership(directory);
		const journal = path.join(
			directory,
			'.swarm',
			'knowledge-receipts-v2.jsonl',
		);
		fs.appendFileSync(journal, '{"schema_version":2,"seq":');

		const repaired = await repairKnowledgeReceiptLedger(directory, {
			phase: 'phase-a',
			session_id: 'session-a',
			task_id: 'task-a',
			reason: 'repair corrupt tail',
		});
		expect(repaired).toMatchObject({
			ok: true,
			status: 'repaired_authority',
			pending_re_evaluation: true,
			salvage_through_seq: expect.any(Number),
		});

		const quarantinePath = path.join(
			directory,
			'.swarm',
			'knowledge-receipts-v2-quarantine.json',
		);
		const quarantine = fs
			.readFileSync(quarantinePath, 'utf8')
			.trim()
			.split('\n')
			.map((line) => JSON.parse(line) as { original_journal_base64: string });
		expect(quarantine).toHaveLength(1);
		expect(
			Buffer.from(quarantine[0].original_journal_base64, 'base64').toString(
				'utf8',
			),
		).toContain('{"schema_version":2,"seq":');

		const blocked = await queryLiveMemberships(directory, {
			phase: 'phase-a',
			session_id: 'session-a',
			include_terminal: true,
		});
		expect(blocked.ok).toBe(false);
		if (blocked.ok) throw new Error('expected blocked live read');
		expect(blocked.code).toBe('store_unavailable');
		expect(blocked.detail).toContain('pending re-evaluation');

		const rerun = await repairKnowledgeReceiptLedger(directory, {
			phase: 'phase-a',
			session_id: 'session-a',
			task_id: 'task-a',
			reason: 'repeat repair must be idempotent',
		});
		expect(rerun).toMatchObject({
			ok: true,
			status: 'pending_re_evaluation',
			pending_re_evaluation: true,
		});
		expect(
			fs.readFileSync(quarantinePath, 'utf8').trim().split('\n'),
		).toHaveLength(1);
	});

	test('quarantines invalid UTF-8 as the exact original bytes and digest', async () => {
		const directory = project('receipt-ledger-repair-invalid-utf8-');
		await seedMembership(directory);
		const journal = path.join(
			directory,
			'.swarm',
			'knowledge-receipts-v2.jsonl',
		);
		fs.appendFileSync(journal, Buffer.from([0xff, 0xfe, 0xfd]));
		const original = fs.readFileSync(journal);

		const repaired = unwrap(
			await repairKnowledgeReceiptLedger(directory, {
				phase: 'phase-a',
				session_id: 'session-a',
				task_id: 'task-a',
				reason: 'preserve invalid utf8 authority exactly',
			}),
		);
		expect(repaired.status).toBe('repaired_authority');

		const quarantine = JSON.parse(
			fs
				.readFileSync(
					path.join(
						directory,
						'.swarm',
						'knowledge-receipts-v2-quarantine.json',
					),
					'utf8',
				)
				.trim(),
		) as {
			original_journal_sha256: string;
			original_journal_bytes: number;
			original_journal_base64: string;
		};
		expect(Buffer.from(quarantine.original_journal_base64, 'base64')).toEqual(
			original,
		);
		expect(quarantine.original_journal_bytes).toBe(original.byteLength);
		expect(quarantine.original_journal_sha256).toBe(
			createHash('sha256').update(original).digest('hex'),
		);
	});

	test('requires an exact complete repair proof before displayed membership clears uncertainty', async () => {
		const directory = project('receipt-ledger-repair-clear-membership-');
		await seedMembership(directory);
		const journal = path.join(
			directory,
			'.swarm',
			'knowledge-receipts-v2.jsonl',
		);
		fs.appendFileSync(journal, '{"schema_version":2,"seq":');
		const repaired = unwrap(
			await repairKnowledgeReceiptLedger(directory, {
				phase: 'phase-a',
				session_id: 'session-a',
				task_id: 'task-a',
				reason: 'repair before re-exposure',
			}),
		);
		expect(repaired.repair_id).toEqual(expect.any(String));

		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-b',
				session_id: 'session-a',
				phase: 'phase-a',
				task_id: 'task-a',
				entries: [{ entry_id: 'entry-b', critical: false }],
			}),
		);
		expect(
			(
				await queryLiveMemberships(directory, {
					phase: 'phase-a',
					session_id: 'session-a',
					include_terminal: true,
				})
			).ok,
		).toBe(false);

		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-wrong-repair',
				session_id: 'session-a',
				phase: 'phase-a',
				task_id: 'task-a',
				repair_re_evaluation: {
					repair_id: '00000000-0000-4000-8000-000000000000',
					scope_complete: true,
				},
				entries: [{ entry_id: 'entry-wrong-repair', critical: false }],
			}),
		);
		expect(
			(
				await queryLiveMemberships(directory, {
					phase: 'phase-a',
					session_id: 'session-a',
				})
			).ok,
		).toBe(false);

		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-partial',
				session_id: 'session-a',
				phase: 'phase-a',
				task_id: 'task-a',
				repair_re_evaluation: {
					repair_id: repaired.repair_id!,
					scope_complete: false,
				},
				entries: [{ entry_id: 'entry-partial', critical: false }],
			}),
		);
		expect(
			(
				await queryLiveMemberships(directory, {
					phase: 'phase-a',
					session_id: 'session-a',
				})
			).ok,
		).toBe(false);

		unwrap(
			await commitDisplayedMembership(directory, {
				trace_id: 'trace-complete',
				session_id: 'session-a',
				phase: 'phase-a',
				task_id: 'task-a',
				repair_re_evaluation: {
					repair_id: repaired.repair_id!,
					scope_complete: true,
				},
				entries: [{ entry_id: 'entry-complete', critical: false }],
			}),
		);

		const live = unwrap(
			await queryLiveMemberships(directory, {
				phase: 'phase-a',
				session_id: 'session-a',
				include_terminal: true,
			}),
		);
		expect(
			live.memberships.map((membership) => membership.trace_id).sort(),
		).toEqual([
			'trace-a',
			'trace-b',
			'trace-complete',
			'trace-partial',
			'trace-wrong-repair',
		]);
	});

	test('requires an exact complete repair proof before an empty retrieval clears uncertainty', async () => {
		const directory = project('receipt-ledger-repair-clear-empty-');
		await seedMembership(directory);
		const journal = path.join(
			directory,
			'.swarm',
			'knowledge-receipts-v2.jsonl',
		);
		fs.appendFileSync(journal, '{"schema_version":2,"seq":');
		const repaired = unwrap(
			await repairKnowledgeReceiptLedger(directory, {
				phase: 'phase-a',
				session_id: 'session-a',
				task_id: 'task-a',
				reason: 'repair before empty retrieval re-evaluation',
			}),
		);

		unwrap(
			await commitEmptyRetrieval(directory, {
				trace_id: 'trace-empty-unrelated',
				session_id: 'session-a',
				phase: 'phase-a',
				task_id: 'task-a',
			}),
		);
		expect(
			(
				await queryLiveMemberships(directory, {
					phase: 'phase-a',
					session_id: 'session-a',
				})
			).ok,
		).toBe(false);

		unwrap(
			await commitEmptyRetrieval(directory, {
				trace_id: 'trace-empty-complete',
				session_id: 'session-a',
				phase: 'phase-a',
				task_id: 'task-a',
				repair_re_evaluation: {
					repair_id: repaired.repair_id!,
					scope_complete: true,
				},
			}),
		);

		const live = unwrap(
			await queryLiveMemberships(directory, {
				phase: 'phase-a',
				session_id: 'session-a',
				include_terminal: true,
			}),
		);
		expect(live.memberships[0]?.trace_id).toBe('trace-a');
	});

	test('fails closed when quarantine persistence hits a permission error and leaves the corrupt journal unchanged', async () => {
		const directory = project('receipt-ledger-repair-permission-');
		await seedMembership(directory);
		const journal = path.join(
			directory,
			'.swarm',
			'knowledge-receipts-v2.jsonl',
		);
		fs.appendFileSync(journal, '{"schema_version":2,"seq":');
		const before = fs.readFileSync(journal, 'utf8');

		restoreAppend = ledgerInternals.appendFsynced;
		ledgerInternals.appendFsynced = async (targetPath, content) => {
			if (targetPath.endsWith('knowledge-receipts-v2-quarantine.json')) {
				const error = new Error('EPERM: quarantine write denied');
				(error as NodeJS.ErrnoException).code = 'EPERM';
				throw error;
			}
			return restoreAppend!(targetPath, content);
		};

		const result = await repairKnowledgeReceiptLedger(directory, {
			phase: 'phase-a',
			session_id: 'session-a',
			task_id: 'task-a',
			reason: 'permission failure path',
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('store_unavailable');
		expect(fs.readFileSync(journal, 'utf8')).toBe(before);
	});

	test('preserves immutable quarantine history and fails closed at the record cap', async () => {
		const directory = project('receipt-ledger-repair-cap-');
		await seedMembership(directory);
		const journal = path.join(
			directory,
			'.swarm',
			'knowledge-receipts-v2.jsonl',
		);
		const quarantine = path.join(
			directory,
			'.swarm',
			'knowledge-receipts-v2-quarantine.json',
		);

		for (
			let index = 0;
			index < ledgerInternals.maxRepairQuarantineRecords;
			index++
		) {
			fs.appendFileSync(journal, `corrupt-tail-${index}`);
			unwrap(
				await repairKnowledgeReceiptLedger(directory, {
					phase: 'phase-a',
					session_id: 'session-a',
					task_id: 'task-a',
					reason: `preserve quarantine record number ${index}`,
				}),
			);
			const repaired = unwrap(
				await repairKnowledgeReceiptLedger(directory, {
					phase: 'phase-a',
					session_id: 'session-a',
					task_id: 'task-a',
					reason: `read repair identity for record number ${index}`,
				}),
			);
			unwrap(
				await commitEmptyRetrieval(directory, {
					trace_id: `trace-clear-${index}`,
					session_id: 'session-a',
					phase: 'phase-a',
					task_id: 'task-a',
					repair_re_evaluation: {
						repair_id: repaired.repair_id!,
						scope_complete: true,
					},
				}),
			);
		}

		const preserved = fs.readFileSync(quarantine, 'utf8');
		expect(preserved.trim().split('\n')).toHaveLength(
			ledgerInternals.maxRepairQuarantineRecords,
		);
		fs.appendFileSync(journal, 'corrupt-tail-over-cap');
		const corruptBefore = fs.readFileSync(journal, 'utf8');
		const overCap = await repairKnowledgeReceiptLedger(directory, {
			phase: 'phase-a',
			session_id: 'session-a',
			task_id: 'task-a',
			reason: 'capacity exhaustion must preserve every prior record',
		});

		expect(overCap.ok).toBe(false);
		expect(fs.readFileSync(quarantine, 'utf8')).toBe(preserved);
		expect(fs.readFileSync(journal, 'utf8')).toBe(corruptBefore);
	});

	test('fails closed when .swarm is a reparse point outside the project root', async () => {
		const directory = project('receipt-ledger-repair-containment-');
		const escaped = path.join(directory, 'escaped-state');
		fs.mkdirSync(escaped);
		fs.symlinkSync(escaped, path.join(directory, '.swarm'), 'junction');

		const result = await repairKnowledgeReceiptLedger(directory, {
			phase: 'phase-a',
			session_id: 'session-a',
			task_id: 'task-a',
			reason: 'containment must fail closed',
		});

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.code).toBe('store_unavailable');
	});
});
