import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildVerificationReceipt,
	canonicalReceiptJson,
	computeReceiptHash,
	MAX_RECEIPT_JSON_BYTES,
	type VerificationReceipt,
} from '../../../src/evidence/receipt';
import {
	capturePhaseGateReport,
	_internals as storeInternals,
	writeExportBundle,
	writeReceiptArtifact,
} from '../../../src/evidence/receipt-store';
import { stableReportHash } from '../../../src/tools/phase-complete/preflight-report';
import {
	makeDir,
	passEntry,
	STATIC_TIME,
	seedAndReceipt,
} from '../../helpers/receipt-review-fixtures';

/**
 * swarm-pr-feedback round-2 legs (swarm-pr-review PR #3550): idempotent-
 * adoption re-validation + Markdown healing (FB-005), prune ENOENT tolerance
 * (FB-009), retention survivor IDENTITY (FB-012), pre-copy size gating
 * (PRR-017), newline-inclusive byte bound (FB-018), bounded capture lock
 * (PRR-019). The report-digest re-derivation legs (FB-004) and the shared-
 * normalizer import contract (FB-010) live in receipt-report-integrity
 * .test.ts (FR-006 split); shared fixtures in tests/helpers/
 * receipt-review-fixtures.ts.
 */

describe('receipt review round 2', () => {
	test('FB-005: a tampered-hash persisted receipt is never adopted as frozen', async () => {
		const dir = makeDir('r2-fb005-tamper-');
		try {
			await seedAndReceipt(dir, [passEntry()]);
			const first = await buildVerificationReceipt(dir, 'phase', '1');
			await writeReceiptArtifact(dir, first);
			// Corrupt ONLY the hash field of the persisted file.
			const receipts = path.join(dir, '.swarm', 'evidence', 'receipts');
			const name = `receipt-phase-1-${first.receipt_hash.slice(0, 12)}.json`;
			const tampered = JSON.parse(
				fs.readFileSync(path.join(receipts, name), 'utf8'),
			) as Record<string, unknown>;
			tampered.receipt_hash = '0'.repeat(64);
			fs.writeFileSync(path.join(receipts, name), JSON.stringify(tampered));
			const again = await buildVerificationReceipt(dir, 'phase', '1');
			const result = await writeReceiptArtifact(dir, again);
			expect(result.alreadyFrozen).toBe(false);
			// The tampered file was skipped; the fresh write carries a valid hash.
			const stored = fs.readFileSync(
				path.join(
					receipts,
					`receipt-phase-1-${again.receipt_hash.slice(0, 12)}.json`,
				),
				'utf8',
			);
			expect(JSON.parse(stored).receipt_hash).toBe(again.receipt_hash);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('FB-005: re-emission heals a JSON-only orphan instead of reporting a missing md_path', async () => {
		const dir = makeDir('r2-fb005-heal-');
		try {
			await seedAndReceipt(dir, [passEntry()]);
			const receipt = await buildVerificationReceipt(dir, 'phase', '1');
			await writeReceiptArtifact(dir, receipt);
			const receipts = path.join(dir, '.swarm', 'evidence', 'receipts');
			const stem = `receipt-phase-1-${receipt.receipt_hash.slice(0, 12)}`;
			fs.rmSync(path.join(receipts, `${stem}.md`));
			// A production re-emission rebuilds (new generated_at) — the same
			// durable content keeps the identical content signature but a
			// different filename hash, so the adoption branch is the one taken.
			const rebuilt = await buildVerificationReceipt(dir, 'phase', '1');
			const again = await writeReceiptArtifact(dir, rebuilt);
			expect(again.alreadyFrozen).toBe(true);
			expect(fs.existsSync(again.mdPath)).toBe(true);
			expect(fs.readFileSync(again.mdPath, 'utf8')).toContain(
				'# Verification receipt',
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('FB-005 round 2: adoption heals a DRIFTED markdown sibling, not only a missing one', async () => {
		const dir = makeDir('r2-fb005-drift-');
		try {
			await seedAndReceipt(dir, [passEntry()]);
			const first = await buildVerificationReceipt(dir, 'phase', '1');
			await writeReceiptArtifact(dir, first);
			const receipts = path.join(dir, '.swarm', 'evidence', 'receipts');
			const stem = `receipt-phase-1-${first.receipt_hash.slice(0, 12)}`;
			fs.writeFileSync(
				path.join(receipts, `${stem}.md`),
				'CORRUPTED MARKDOWN CONTENT',
			);
			const rebuilt = await buildVerificationReceipt(dir, 'phase', '1');
			const again = await writeReceiptArtifact(dir, rebuilt);
			expect(again.alreadyFrozen).toBe(true);
			expect(fs.readFileSync(again.mdPath, 'utf8')).not.toBe(
				'CORRUPTED MARKDOWN CONTENT',
			);
			expect(fs.readFileSync(again.mdPath, 'utf8')).toContain(
				'# Verification receipt',
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('FB-009: prune survives an entry vanishing mid-enumeration', async () => {
		const dir = makeDir('r2-fb009-prune-');
		try {
			await seedAndReceipt(dir, [passEntry()]);
			// Seed 9 receipts first (retention active), then inject a phantom.
			for (let index = 0; index < 8; index += 1) {
				fs.writeFileSync(
					path.join(dir, '.swarm', 'spec.md'),
					`# Spec ${index}\n`,
				);
				const receipt = await buildVerificationReceipt(dir, 'phase', '1');
				await writeReceiptArtifact(dir, {
					...receipt,
					generated_at: new Date(
						Date.parse(STATIC_TIME) + index * 5000,
					).toISOString(),
				} as VerificationReceipt);
			}
			const receipts = path.join(dir, '.swarm', 'evidence', 'receipts');
			const ghost = path.join(receipts, 'receipt-phase-1-000000000000.json');
			const originalPruneLstat = storeInternals.pruneLstat;
			storeInternals.pruneLstat = (target: string) => {
				if (target === ghost) {
					const err = new Error('ENOENT: vanished') as NodeJS.ErrnoException;
					err.code = 'ENOENT';
					throw err;
				}
				return originalPruneLstat(target);
			};
			try {
				fs.writeFileSync(ghost, '{}'); // readdir sees it; pruneLstat throws
				fs.writeFileSync(path.join(dir, '.swarm', 'spec.md'), '# Spec final\n');
				const receipt = await buildVerificationReceipt(dir, 'phase', '1');
				await expect(writeReceiptArtifact(dir, receipt)).resolves.toBeObject();
			} finally {
				storeInternals.pruneLstat = originalPruneLstat;
				fs.rmSync(ghost, { force: true });
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('FB-012: newest-8 retention evicts the OLDEST survivors (identity, not just count)', async () => {
		const dir = makeDir('r2-fb012-identity-');
		try {
			await seedAndReceipt(dir, [passEntry()]);
			const receipts = path.join(dir, '.swarm', 'evidence', 'receipts');
			const stems: string[] = [];
			for (let index = 0; index < 9; index += 1) {
				fs.writeFileSync(
					path.join(dir, '.swarm', 'spec.md'),
					`# Spec ${index}\n\nFR-0${index}.\n`,
				);
				const receipt = await buildVerificationReceipt(dir, 'phase', '1');
				await writeReceiptArtifact(dir, {
					...receipt,
					generated_at: new Date(
						Date.parse(STATIC_TIME) + index * 5000,
					).toISOString(),
				} as VerificationReceipt);
				const writtenStem = `receipt-phase-1-${receipt.receipt_hash.slice(0, 12)}`;
				stems.push(writtenStem);
				// Force strictly increasing per-stem mtimes so retention order is
				// deterministic (write order, not filesystem clock resolution).
				for (const suffix of ['.json', '.md']) {
					const file = path.join(receipts, writtenStem + suffix);
					if (fs.existsSync(file)) {
						const t = index + 100;
						fs.utimesSync(file, t, t);
					}
				}
			}
			const survivors = new Set(
				fs
					.readdirSync(receipts)
					.filter(
						(n) => n.startsWith('receipt-phase-1-') && n.endsWith('.json'),
					)
					.map((n) => n.replace(/\.json$/, '')),
			);
			expect(survivors.size).toBe(8);
			// The FIRST (oldest) stem is gone; the LAST (newest) survives.
			expect(survivors.has(stems[0])).toBe(false);
			expect(survivors.has(stems[8])).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('PRR-017: a source grown since emission is rejected BEFORE copying', async () => {
		const dir = makeDir('r2-prr017-grow-');
		try {
			// snapshot_identity refs make spec.md a cited artifact — the one
			// the growth tamper targets.
			await seedAndReceipt(dir, [
				{
					...passEntry('snapshot_identity'),
					evidenceRefs: [
						`plan-structure:${'a'.repeat(64)}`,
						`policy:${'b'.repeat(64)}`,
						`phase-evidence:${'c'.repeat(64)}`,
					],
				},
			]);
			const receipt = await buildVerificationReceipt(dir, 'phase', '1');
			expect(
				receipt.artifacts.some((a) => a.path.endsWith('spec.md')),
				'fixture must cite spec.md',
			).toBe(true);
			fs.writeFileSync(
				path.join(dir, '.swarm', 'spec.md'),
				`# Spec grown\n${'x'.repeat(4096)}\n`,
			);
			await expect(writeExportBundle(dir, receipt, '# md')).rejects.toThrow(
				'RECEIPT_BUNDLE_DIGEST_MISMATCH',
			);
			const exportRoot = path.join(dir, '.swarm', 'plan-export');
			const leftovers = fs.existsSync(exportRoot)
				? fs.readdirSync(exportRoot).filter((n) => n.includes('.tmp-'))
				: [];
			expect(leftovers).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('FB-018: the persisted payload (canonical + trailing newline) respects the 256 KiB bound', async () => {
		const dir = makeDir('r2-fb018-newline-');
		try {
			// Pad a synthetic task receipt's refs until the canonical JSON is
			// EXACTLY at the cap: bounds-only checks pass, the write arm must
			// reject because the on-disk payload adds the appended newline.
			const build = (pad: number): VerificationReceipt => {
				const record = {
					format_version: '1.0.0',
					kind: 'task',
					unit_id: '1.1',
					generated_at: STATIC_TIME,
					plugin_version: 'x',
					snapshot: {},
					gates: [
						{
							gate_id: 'g',
							outcome: 'pass',
							responsible_actor: 'swarm',
							evidence_refs: [`ref-${'p'.repeat(pad)}`],
						},
					],
					artifacts: [] as unknown[],
				};
				return {
					...record,
					receipt_hash: computeReceiptHash(record),
				} as unknown as VerificationReceipt;
			};
			let low = 0;
			let high = 300_000;
			while (low < high) {
				const mid = Math.ceil((low + high) / 2);
				const size = Buffer.byteLength(
					canonicalReceiptJson(build(mid)),
					'utf8',
				);
				if (size <= MAX_RECEIPT_JSON_BYTES) low = mid;
				else high = mid - 1;
			}
			const atCap = build(low);
			expect(
				Buffer.byteLength(canonicalReceiptJson(atCap), 'utf8'),
			).toBeLessThanOrEqual(MAX_RECEIPT_JSON_BYTES);
			await expect(writeReceiptArtifact(dir, atCap)).rejects.toThrow(
				'RECEIPT_JSON_BYTE_LIMIT',
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('PRR-019: the fail-open capture waits on the evidence lock for a bounded second budget, not 60 s', async () => {
		const dir = makeDir('r2-prr019-timeout-');
		const original = storeInternals.writeImmutableArtifact;
		try {
			let seen: number | undefined;
			storeInternals.writeImmutableArtifact = ((options: {
				lockTimeoutMs?: number;
			}) => {
				seen = options.lockTimeoutMs;
				return Promise.resolve(undefined as never);
			}) as typeof original;
			const entries = [passEntry()];
			await capturePhaseGateReport(dir, {
				schemaVersion: 1,
				phase: 1,
				outcome: 'pass',
				reportHash: stableReportHash(1, entries as never),
				entries,
			} as never);
			expect(seen).toBeDefined();
			expect(seen! as number).toBeGreaterThan(0);
			expect(seen! as number).toBeLessThan(60_000);
		} finally {
			storeInternals.writeImmutableArtifact = original;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
