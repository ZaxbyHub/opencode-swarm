import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildVerificationReceipt,
	computeReceiptHash,
} from '../../../src/evidence/receipt';
import { writeExportBundle } from '../../../src/evidence/receipt-store';
import { verifyReceiptBundle } from '../../../src/evidence/receipt-verify';
import { stableReportHash } from '../../../src/tools/phase-complete/preflight-report';
import {
	makeDir,
	naEntry,
	passEntry,
	reportBytes,
	seedAndReceipt,
} from '../../helpers/receipt-review-fixtures';

/**
 * Report-digest integrity legs (swarm-pr-feedback PR #3550, split from
 * receipt-review-round2 at the FR-006 500-line cap): the persisted phase
 * gate report is RE-DERIVED (never trusted) at build and verify time
 * (FB-004), and the verifier imports the SHARED path normalizer so emission
 * and verification cannot drift (FB-010 / issue #2970 step 5).
 */

describe('receipt report integrity (FB-004 / FB-010)', () => {
	test('FB-004 build: edited gate entries under a stale reportHash are refused', async () => {
		const dir = makeDir('r2-fb004-build-');
		try {
			// Filename + embedded reportHash agree with the ORIGINAL entries;
			// the on-disk entries were then flipped not_applicable→pass.
			const honest = [naEntry()];
			const { reportHash, file } = reportBytes(1, honest);
			const receipts = path.join(dir, '.swarm', 'evidence', 'receipts');
			fs.mkdirSync(receipts, { recursive: true });
			fs.writeFileSync(
				path.join(receipts, file),
				JSON.stringify({
					schemaVersion: 1,
					phase: 1,
					outcome: 'pass',
					reportHash,
					entries: [passEntry()], // LAUNDERED
				}),
			);
			fs.writeFileSync(path.join(dir, '.swarm', 'spec.md'), '# Spec\n');
			await expect(buildVerificationReceipt(dir, 'phase', '1')).rejects.toThrow(
				'RECEIPT_REPORT_HASH_MISMATCH',
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('FB-004 read: a report whose name disagrees with its embedded digest is not a capture', async () => {
		const dir = makeDir('r2-fb004-stem-');
		try {
			const receipts = path.join(dir, '.swarm', 'evidence', 'receipts');
			fs.mkdirSync(receipts, { recursive: true });
			const entries = [passEntry()];
			const real = stableReportHash(1, entries as never);
			fs.writeFileSync(
				path.join(receipts, `phase-1-${'f'.repeat(64)}.json`),
				JSON.stringify({
					schemaVersion: 1,
					phase: 1,
					outcome: 'pass',
					reportHash: real,
					entries,
				}),
			);
			fs.writeFileSync(path.join(dir, '.swarm', 'spec.md'), '# Spec\n');
			await expect(buildVerificationReceipt(dir, 'phase', '1')).rejects.toThrow(
				'RECEIPT_NO_PERSISTED_REPORT',
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('FB-004 verify: a self-consistent forger of the bundled report is caught by digest RE-DERIVATION', async () => {
		const dir = makeDir('r2-fb004-verify-');
		try {
			await seedAndReceipt(dir, [naEntry()]);
			const receipt = await buildVerificationReceipt(dir, 'phase', '1');
			const bundle = await writeExportBundle(dir, receipt, '# md\n');
			// Forge: flip the bundled report's not_applicable→pass AND fix the
			// embedded digest AND recompute the receipt's artifact sha AND the
			// receipt_hash — everything except the receipt's ORIGINAL
			// report_hash, which still attests the genuine digest.
			const reportRel = receipt.artifacts.find((a) =>
				a.path.includes('phase-1-'),
			);
			expect(reportRel).toBeDefined();
			const reportPath = path.join(
				bundle.bundleDir,
				'artifacts',
				...reportRel!.path.split('/'),
			);
			const stored = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as {
				entries: Array<Record<string, unknown>>;
				reportHash: string;
			};
			stored.entries = [passEntry()];
			stored.reportHash = stableReportHash(1, stored.entries as never);
			const forgedBytes = Buffer.from(JSON.stringify(stored), 'utf8');
			fs.writeFileSync(reportPath, forgedBytes);
			const receiptFile = path.join(bundle.bundleDir, 'receipt.json');
			const record = JSON.parse(fs.readFileSync(receiptFile, 'utf8')) as Record<
				string,
				unknown
			>;
			(record.artifacts as Array<Record<string, unknown>>).forEach(
				(artifact) => {
					if (artifact.path === reportRel!.path) {
						artifact.sha256 = createHash('sha256')
							.update(forgedBytes)
							.digest('hex');
						artifact.bytes = forgedBytes.byteLength;
					}
				},
			);
			const { receipt_hash: _drop, ...rest } = record;
			record.receipt_hash = computeReceiptHash(rest);
			fs.writeFileSync(receiptFile, `${JSON.stringify(record, null, 2)}\n`);
			const result = verifyReceiptBundle({
				receiptFile,
				artifactRoot: path.join(bundle.bundleDir, 'artifacts'),
			});
			expect(result.ok).toBe(false);
			expect(
				result.failures.some(
					(f) =>
						f.kind === 'digest_mismatch' && f.expected === receipt.report_hash,
				),
				`expected report-digest re-derivation failure, got ${JSON.stringify(result.failures)}`,
			).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('FB-010: the verifier imports the SHARED normalizer (issue #2970 step 5 import contract)', () => {
		const source = fs.readFileSync(
			path.join(import.meta.dir, '../../../src/evidence/receipt-verify.ts'),
			'utf8',
		);
		expect(source).toContain(
			"from '../tools/phase-complete/snapshot-identity'",
		);
		expect(source).toContain('toPortableRelativePath(');
		// Containment comparisons go through the normalizer, not ad-hoc
		// path.relative against the real root.
		expect(source).not.toContain('path.relative(rootResolved');
	});
});
