import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildVerificationReceipt,
	RECEIPT_FORMAT_VERSION,
	renderReceiptMarkdown,
} from '../../../src/evidence/receipt';
import {
	capturePhaseGateReport,
	_internals as storeInternals,
	writeExportBundle,
	writeReceiptArtifact,
} from '../../../src/evidence/receipt-store';
import {
	executeReceiptEmission,
	executeReceiptVerify,
} from '../../../src/services/receipt-service';
import { computePhaseEvidenceSnapshot } from '../../../src/tools/phase-complete/snapshot-identity';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Review-hardening suite (implementation-review round 1, finding F6 + F2 +
 * F5 legs): the plan-required cases the first implementation shipped
 * without — parallel emission, retention totals across json+md, typed
 * I/O failures, export digest-mismatch injection, task-kind positive
 * emission, and the no-receipt golden byte-compat.
 */

const STATIC_TIME = '2026-11-02T00:00:00.000Z';

function makeDir(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	return dir;
}

function seedReport(dir: string, phase = 1): Promise<void> {
	fs.writeFileSync(
		path.join(dir, '.swarm', 'spec.md'),
		`# Spec ${phase}\n\n## FR-0${phase}\nRequirement.\n`,
	);
	const entries = [
		{
			id: 'snapshot_identity',
			code: 'SNAP_OK',
			outcome: 'pass' as const,
			evidenceRefs: [
				`plan-structure:${'a'.repeat(64)}`,
				`policy:${'b'.repeat(64)}`,
				`phase-evidence:${'c'.repeat(64)}`,
			],
			responsibleActor: 'architect',
			agentsDispatched: [],
			agentsMissing: [],
			warnings: [],
		},
	];
	const report = {
		schemaVersion: 1,
		phase,
		outcome: 'pass' as const,
		reportHash: createHash('sha256')
			.update(JSON.stringify({ schemaVersion: 1, phase, entries }))
			.digest('hex'),
		entries,
	};
	return capturePhaseGateReport(dir, report as never);
}

function seedTask(dir: string, id: string): void {
	fs.writeFileSync(
		path.join(dir, '.swarm', 'evidence', `${id}.json`),
		JSON.stringify({
			taskId: id,
			gates: {
				gate_a: { sessionId: 's', timestamp: STATIC_TIME, agent: 'architect' },
				gate_b: { sessionId: 's', timestamp: STATIC_TIME, agent: 'reviewer' },
			},
		}),
	);
}

describe('receipt hardening (review round 1)', () => {
	test('parallel same-content emission yields ONE receipt file with one hash', async () => {
		const dir = makeDir('receipt-par1-');
		try {
			await seedReport(dir);
			const [a, b, c] = await Promise.all([
				executeReceiptEmission(dir, 'phase', '1', false),
				executeReceiptEmission(dir, 'phase', '1', false),
				executeReceiptEmission(dir, 'phase', '1', false),
			]);
			expect(new Set([a, b, c].map((o) => o.receipt_hash)).size).toBe(1);
			const names = fs.readdirSync(
				path.join(dir, '.swarm', 'evidence', 'receipts'),
			);
			expect(names.filter((n) => n.startsWith('receipt-phase-1'))).toHaveLength(
				2,
			); // json + md
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('parallel changed-content emission stays serialized and within retention (R2-F2)', async () => {
		const dir = makeDir('receipt-par2-');
		try {
			await seedReport(dir);
			// R2-F2 (review round 2): vary an artifact the builder actually
			// re-hashes (spec.md) per emission — the earlier extra-*.json
			// fixture was never read, so content never changed.
			const writers = Array.from({ length: 10 }, (_unused, index) => {
				fs.writeFileSync(
					path.join(dir, '.swarm', 'spec.md'),
					`# Spec parallel-${index}\n`,
				);
				return executeReceiptEmission(dir, 'phase', '1', false);
			});
			const results = await Promise.all(writers);
			// Every emission SUCCEEDED (serialized under the per-unit lock) and
			// produced DISTINCT content — no two emission hashes equal.
			const hashes = new Set(results.map((r) => r.receipt_hash));
			expect(hashes.size).toBe(10);
			const names = fs
				.readdirSync(path.join(dir, '.swarm', 'evidence', 'receipts'))
				.filter((n) => /^receipt-phase-1-[0-9a-f]{12}\.(json|md)$/.test(n));
			const json = names.filter((n) => n.endsWith('.json'));
			const md = names.filter((n) => n.endsWith('.md'));
			expect(json).toHaveLength(8); // retention capped the unit mid-race
			expect(md).toHaveLength(8);
			const stems = new Set(json.map((n) => n.replace(/\.json$/, '')));
			for (const name of md) {
				expect(stems.has(name.replace(/\.md$/, ''))).toBe(true);
			}
			for (const name of json) {
				expect(() =>
					JSON.parse(
						fs.readFileSync(
							path.join(dir, '.swarm', 'evidence', 'receipts', name),
							'utf8',
						),
					),
				).not.toThrow();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('concurrent same-content export is idempotent: every caller gets the published bundle (R2-F3)', async () => {
		const dir = makeDir('receipt-par3-');
		try {
			await seedReport(dir);
			const receipt = await buildVerificationReceipt(dir, 'phase', '1');
			const markdown = renderReceiptMarkdown(receipt);
			const results = await Promise.all([
				writeExportBundle(dir, receipt, markdown),
				writeExportBundle(dir, receipt, markdown),
				writeExportBundle(dir, receipt, markdown),
			]);
			const dirs = new Set(results.map((r) => r.bundleDir));
			expect(dirs.size).toBe(1);
			expect(
				fs.existsSync(path.join(results[0].bundleDir, 'receipt.json')),
			).toBe(true);
			const exportDir = path.join(dir, '.swarm', 'plan-export');
			const published = fs
				.readdirSync(exportDir)
				.filter((n) => n.startsWith('receipt-phase-1') && !n.startsWith('.'));
			expect(published).toHaveLength(1); // no stray staging leftovers
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('verify stays green through a symlinked path to an untampered bundle (R2-F1)', async () => {
		const dir = makeDir('receipt-link-');
		try {
			await seedReport(dir);
			const receipt = await buildVerificationReceipt(dir, 'phase', '1');
			const bundle = await writeExportBundle(
				dir,
				receipt,
				renderReceiptMarkdown(receipt),
			);
			// macOS /tmp→/private/tmp analog: reach the SAME bundle through a
			// directory junction alias of its parent.
			const aliasParent = path.join(
				path.dirname(bundle.bundleDir),
				'alias-parent',
			);
			fs.symlinkSync(path.dirname(bundle.bundleDir), aliasParent, 'junction');
			const viaLink = await executeReceiptVerify(
				path.join(aliasParent, path.basename(bundle.bundleDir)),
			);
			expect(viaLink.ok).toBe(true);
			expect(viaLink.summary).toContain('receipt verify OK');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('retention caps the unit TOTAL: 9 distinct emissions leave 8 json + 8 md (review F2)', async () => {
		const dir = makeDir('receipt-ret2-');
		try {
			await seedReport(dir);
			for (let index = 0; index < 9; index += 1) {
				// Vary an artifact the builder re-hashes (spec.md) so each
				// emission has a DIFFERENT content signature and produces a
				// distinct receipt — the retention cap is what bounds the unit.
				fs.writeFileSync(
					path.join(dir, '.swarm', 'spec.md'),
					`# Spec ${index}\n`,
				);
				await executeReceiptEmission(dir, 'phase', '1', false);
			}
			const names = fs.readdirSync(
				path.join(dir, '.swarm', 'evidence', 'receipts'),
			);
			const json = names.filter((n) =>
				/^receipt-phase-1-[0-9a-f]{12}\.json$/.test(n),
			);
			const md = names.filter((n) =>
				/^receipt-phase-1-[0-9a-f]{12}\.md$/.test(n),
			);
			expect(json).toHaveLength(8);
			expect(md).toHaveLength(8);
			// Every surviving md pairs with a surviving json stem.
			const stems = new Set(json.map((n) => n.replace(/\.json$/, '')));
			for (const name of md)
				expect(stems.has(name.replace(/\.md$/, ''))).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('no-receipt golden byte-compat: an empty receipts dir leaves the snapshot hash unchanged', async () => {
		const dir = makeDir('receipt-golden-');
		try {
			fs.writeFileSync(path.join(dir, '.swarm', 'spec.md'), '# Spec\n');
			fs.mkdirSync(path.join(dir, '.swarm', 'evidence', 'retro-1'), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(dir, '.swarm', 'evidence', 'retro-1', 'evidence.json'),
				'{}',
			);
			const before = computePhaseEvidenceSnapshot(dir);
			fs.mkdirSync(path.join(dir, '.swarm', 'evidence', 'receipts'));
			expect(computePhaseEvidenceSnapshot(dir)).toBe(before);
			fs.writeFileSync(
				path.join(
					dir,
					'.swarm',
					'evidence',
					'receipts',
					'phase-1-' + '0'.repeat(64) + '.json',
				),
				'{}',
			);
			expect(computePhaseEvidenceSnapshot(dir)).toBe(before);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('task-kind positive emission: gates come from the durable task record', async () => {
		const dir = makeDir('receipt-task-');
		try {
			seedTask(dir, '2.1');
			const outcome = await executeReceiptEmission(dir, 'task', '2.1', false);
			expect(outcome.format_version).toBe(RECEIPT_FORMAT_VERSION);
			expect(outcome.gate_count).toBe(2);
			const receipt = JSON.parse(
				fs.readFileSync(path.resolve(dir, outcome.json_path), 'utf8'),
			);
			expect(
				receipt.gates.map((g: { gate_id: string }) => g.gate_id).sort(),
			).toEqual(['gate_a', 'gate_b']);
			for (const gate of receipt.gates) {
				expect(gate.command).toBeUndefined();
				expect(gate.exit_code).toBeUndefined();
				expect(gate.output_digest).toBeUndefined();
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('unreadable receipt target maps to a typed failure, never a crash', async () => {
		const dir = makeDir('receipt-unread-');
		try {
			const fresh = canonicalMkdtemp('receipt-unread-bundle-');
			fs.mkdirSync(path.join(fresh, 'artifacts'), { recursive: true });
			// A DIRECTORY where receipt.json should be: stat sees non-file.
			fs.mkdirSync(path.join(fresh, 'receipt.json'));
			const outcome = await executeReceiptVerify(fresh);
			expect(outcome.ok).toBe(false);
			expect(JSON.stringify(outcome.result)).toContain('corrupt_json');
			fs.rmSync(fresh, { recursive: true, force: true });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('permission-denied receipt maps to a typed failure (POSIX chmod leg)', async () => {
		const dir = makeDir('receipt-perm-');
		try {
			const fresh = canonicalMkdtemp('receipt-perm-bundle-');
			fs.mkdirSync(path.join(fresh, 'artifacts'), { recursive: true });
			const receiptPath = path.join(fresh, 'receipt.json');
			fs.writeFileSync(receiptPath, '{}');
			fs.chmodSync(receiptPath, 0o000);
			try {
				const outcome = await executeReceiptVerify(fresh);
				expect(outcome.ok).toBe(false);
				// POSIX: EACCES -> corrupt_json. Windows chmod is advisory, so
				// the '{}' content fails a later typed gate instead — the
				// contract under test is a TYPED failure, never a crash.
				expect(outcome.result.failures.length).toBeGreaterThan(0);
			} finally {
				fs.chmodSync(receiptPath, 0o644);
				fs.rmSync(fresh, { recursive: true, force: true });
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('oversized receipt.json hits the bounded read cap with a typed failure', async () => {
		const dir = makeDir('receipt-huge-');
		try {
			const fresh = canonicalMkdtemp('receipt-huge-bundle-');
			fs.mkdirSync(path.join(fresh, 'artifacts'), { recursive: true });
			fs.writeFileSync(
				path.join(fresh, 'receipt.json'),
				'{"pad":"' + 'x'.repeat(2 * 1024 * 1024) + '"}',
			);
			const outcome = await executeReceiptVerify(fresh);
			expect(outcome.ok).toBe(false);
			expect(JSON.stringify(outcome.result)).toContain('schema_mismatch');
			fs.rmSync(fresh, { recursive: true, force: true });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('export digest-mismatch injection cleans staging and leaves no partial bundle', async () => {
		const dir = makeDir('receipt-xdig-');
		try {
			await seedReport(dir);
			const receipt = await buildVerificationReceipt(dir, 'phase', '1');
			const original = storeInternals.sha256;
			storeInternals.sha256 = async () => '0'.repeat(64);
			try {
				await expect(
					writeExportBundle(dir, receipt, renderReceiptMarkdown(receipt)),
				).rejects.toThrow('RECEIPT_BUNDLE_DIGEST_MISMATCH');
			} finally {
				storeInternals.sha256 = original;
			}
			const exportDir = path.join(dir, '.swarm', 'plan-export');
			const leftovers = fs.existsSync(exportDir)
				? fs.readdirSync(exportDir).filter((n) => n.includes('receipt-phase-1'))
				: [];
			expect(leftovers).toHaveLength(0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('aggregate 16 MiB hashing budget is enforced across artifacts (review F5)', async () => {
		const dir = makeDir('receipt-agg-');
		try {
			// Phase-kind artifacts = persisted report + spec.md. Inflate BOTH
			// past 8.5 MiB: each passes the per-file cap, the pair busts the
			// 16 MiB aggregate budget (the frozen C4 bound).
			const bigDetail = 'd'.repeat(9 * 1024 * 1024);
			fs.writeFileSync(
				path.join(dir, '.swarm', 'spec.md'),
				`# Spec${'\n'}` + 's'.repeat(9 * 1024 * 1024),
			);
			const entries = [
				{
					id: 'snapshot_identity',
					outcome: 'pass' as const,
					detail: bigDetail,
					evidenceRefs: [`phase-evidence:${'c'.repeat(64)}`],
					responsibleActor: 'architect',
					agentsDispatched: [],
					agentsMissing: [],
					warnings: [],
				},
			];
			const reportHash = createHash('sha256')
				.update(JSON.stringify({ schemaVersion: 1, phase: 1, entries }))
				.digest('hex');
			const receiptsDir = path.join(dir, '.swarm', 'evidence', 'receipts');
			fs.mkdirSync(receiptsDir, { recursive: true });
			fs.writeFileSync(
				path.join(receiptsDir, `phase-1-${reportHash}.json`),
				JSON.stringify({
					schemaVersion: 1,
					phase: 1,
					outcome: 'pass',
					reportHash,
					entries,
				}),
			);
			await expect(buildVerificationReceipt(dir, 'phase', '1')).rejects.toThrow(
				'RECEIPT_ARTIFACT_BYTE_LIMIT',
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('writeReceiptArtifact idempotent-return still reports an existing md sibling', async () => {
		const dir = makeDir('receipt-mdpair-');
		try {
			await seedReport(dir);
			const first = await executeReceiptEmission(dir, 'phase', '1', false);
			expect(fs.existsSync(path.resolve(dir, first.md_path))).toBe(true);
			const second = await executeReceiptEmission(dir, 'phase', '1', false);
			expect(second.already_frozen).toBe(true);
			expect(fs.existsSync(path.resolve(dir, second.md_path))).toBe(true);
			void writeReceiptArtifact;
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
