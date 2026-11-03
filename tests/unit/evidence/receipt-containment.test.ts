import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listEvidenceTaskIds } from '../../../src/evidence/manager';
import {
	buildVerificationReceipt,
	hashReceiptArtifact,
} from '../../../src/evidence/receipt';
import {
	capturePhaseGateReport,
	writeExportBundle,
	writeReceiptArtifact,
} from '../../../src/evidence/receipt-store';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * swarm-pr-feedback round (review PRR-001/PRR-004/PRR-012 + FB-008):
 * WRITE-side containment for the receipt family. Every read sink already
 * rejects planted links; these legs pin that every write destination and
 * every export SOURCE component-chain is link-validated against the REAL
 * root, that symlink/junctioned project roots succeed (FB-002), and that
 * the derived `receipts/` entry is not mistaken for a task ID by the
 * evidence listing (/swarm doctor's source).
 *
 * Junctions (fs.symlinkSync(..., 'junction')) are used deliberately: they
 * need no privilege on Windows, so these legs execute on every platform
 * (the TI-002 platform-skip class — no silent EPERM early-returns).
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

function junction(target: string, linkPath: string): void {
	fs.symlinkSync(target, linkPath, 'junction');
}

describe('receipt write-sink containment (FB-001/FB-002/PRR-004)', () => {
	test('FB-001: a planted junction at .swarm/plan-export refuses bundle writes outside the project', async () => {
		const dir = makeDir('receipt-junc-export-');
		const outside = canonicalMkdtemp('receipt-junc-outside-');
		try {
			await seedReport(dir);
			const receipt = await buildVerificationReceipt(dir, 'phase', '1');
			fs.mkdirSync(path.join(dir, '.swarm', 'plan-export'), {
				recursive: true,
			});
			// Replace the directory with a junction to an EXTERNAL tree.
			fs.rmdirSync(path.join(dir, '.swarm', 'plan-export'));
			junction(outside, path.join(dir, '.swarm', 'plan-export'));
			await expect(writeExportBundle(dir, receipt, '# md')).rejects.toThrow(
				'RECEIPT_WRITE_PATH_ESCAPE',
			);
			// Nothing landed outside the project.
			expect(fs.readdirSync(outside)).toHaveLength(0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test('FB-001: a planted junction at .swarm/evidence/receipts refuses receipt emission', async () => {
		const dir = makeDir('receipt-junc-emit-');
		const outside = canonicalMkdtemp('receipt-junc-out2-');
		try {
			await seedReport(dir);
			const receipt = await buildVerificationReceipt(dir, 'phase', '1');
			fs.rmSync(path.join(dir, '.swarm', 'evidence', 'receipts'), {
				recursive: true,
				force: true,
			});
			junction(outside, path.join(dir, '.swarm', 'evidence', 'receipts'));
			await expect(writeReceiptArtifact(dir, receipt)).rejects.toThrow(
				'RECEIPT_WRITE_PATH_ESCAPE',
			);
			expect(fs.readdirSync(outside)).toHaveLength(0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test('FB-001: a planted junction at the capture path refuses the gate-report write', async () => {
		const dir = makeDir('receipt-junc-capture-');
		const outside = canonicalMkdtemp('receipt-junc-out3-');
		try {
			fs.writeFileSync(path.join(dir, '.swarm', 'spec.md'), '# Spec\n');
			const entries = [
				{
					id: 'g',
					code: 'OK',
					outcome: 'pass',
					evidenceRefs: [],
					responsibleActor: 'architect',
					agentsDispatched: [],
					agentsMissing: [],
					warnings: [],
				},
			];
			const report = {
				schemaVersion: 1,
				phase: 1,
				outcome: 'pass',
				reportHash: createHash('sha256')
					.update(JSON.stringify({ schemaVersion: 1, phase: 1, entries }))
					.digest('hex'),
				entries,
			};
			fs.rmSync(path.join(dir, '.swarm', 'evidence', 'receipts'), {
				recursive: true,
				force: true,
			});
			junction(outside, path.join(dir, '.swarm', 'evidence', 'receipts'));
			await expect(
				capturePhaseGateReport(dir, report as never),
			).rejects.toThrow('RECEIPT_WRITE_PATH_ESCAPE');
			expect(fs.readdirSync(outside)).toHaveLength(0);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test('FB-001 round 2: a junction planted DURING the lock wait is rejected by the in-critical-section re-validation', async () => {
		const dir = makeDir('receipt-junc-toctou-');
		const outside = canonicalMkdtemp('receipt-junc-out5-');
		try {
			// Seed a task receipt fixture (evidence/1.1.json with gates).
			fs.writeFileSync(
				path.join(dir, '.swarm', 'evidence', '1.1.json'),
				JSON.stringify({
					taskId: '1.1',
					gates: { g: { sessionId: 's', timestamp: STATIC_TIME, agent: 'a' } },
				}),
			);
			const receipt = await buildVerificationReceipt(dir, 'task', '1.1');
			// Hold the exact unit lock the emission needs, from another writer.
			const { withEvidenceLock } = await import('../../../src/evidence/lock');
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const holder = withEvidenceLock(
				fs.realpathSync(dir),
				path.posix.join('evidence', 'receipts', 'unit-task-1.1.lock'),
				'architect',
				'holder',
				async () => {
					await gate;
					return 1;
				},
			);
			// Let the holder acquire the lock file.
			await new Promise((resolve) => setTimeout(resolve, 250));
			const writing = writeReceiptArtifact(dir, receipt);
			await new Promise((resolve) => setTimeout(resolve, 250));
			// Swap the (real, already-validated) receipts dir for a junction
			// while the emission waits on the lock.
			const receiptsPath = path.join(dir, '.swarm', 'evidence', 'receipts');
			fs.rmSync(receiptsPath, { recursive: true, force: true });
			junction(outside, receiptsPath);
			release();
			await holder;
			await expect(writing).rejects.toThrow('RECEIPT_WRITE_PATH_ESCAPE');
			expect(fs.readdirSync(outside)).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test('FB-001 round 3: a setImmediate swapper cannot land emission bytes outside (same-tick validator)', async () => {
		const dir = makeDir('receipt-swap-emit-');
		const outside = canonicalMkdtemp('receipt-swap-out-');
		try {
			fs.writeFileSync(
				path.join(dir, '.swarm', 'evidence', '1.1.json'),
				JSON.stringify({
					taskId: '1.1',
					gates: { g: { sessionId: 's', timestamp: STATIC_TIME, agent: 'a' } },
				}),
			);
			const receipt = await buildVerificationReceipt(dir, 'task', '1.1');
			const receiptsPath = path.join(dir, '.swarm', 'evidence', 'receipts');
			let swapped = false;
			const swap = (): void => {
				if (swapped) return;
				let stat: fs.Stats | null = null;
				try {
					stat = fs.lstatSync(receiptsPath);
				} catch {
					stat = null;
				}
				if (stat && !stat.isSymbolicLink()) {
					fs.rmSync(receiptsPath, { recursive: true, force: true });
					fs.symlinkSync(outside, receiptsPath, 'junction');
					swapped = true;
					return;
				}
				setImmediate(swap);
			};
			setImmediate(swap);
			await expect(writeReceiptArtifact(dir, receipt)).rejects.toThrow(
				'RECEIPT_WRITE_PATH_ESCAPE',
			);
			// The swapper MUST have fired (non-vacuous): it polls every tick
			// from the emitter's first mkdir, and each write validates on the
			// same tick as its syscall — so the swap always precedes the next
			// validator (setImmediate FIFO ordering).
			expect(swapped).toBe(true);
			expect(fs.readdirSync(outside)).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test('FB-001 round 3: the same swapper cannot land capture bytes outside (validateDestination in-writer)', async () => {
		const dir = makeDir('receipt-swap-cap-');
		const outside = canonicalMkdtemp('receipt-swap-out2-');
		try {
			fs.writeFileSync(path.join(dir, '.swarm', 'spec.md'), '# Spec\n');
			const entries = [
				{
					id: 'g',
					code: 'OK',
					outcome: 'pass',
					evidenceRefs: [],
					responsibleActor: 'architect',
					agentsDispatched: [],
					agentsMissing: [],
					warnings: [],
				},
			];
			const report = {
				schemaVersion: 1,
				phase: 1,
				outcome: 'pass',
				reportHash: createHash('sha256')
					.update(JSON.stringify({ schemaVersion: 1, phase: 1, entries }))
					.digest('hex'),
				entries,
			};
			const receiptsPath = path.join(dir, '.swarm', 'evidence', 'receipts');
			let swapped = false;
			const swap = (): void => {
				if (swapped) return;
				let stat: fs.Stats | null = null;
				try {
					stat = fs.lstatSync(receiptsPath);
				} catch {
					stat = null;
				}
				if (stat && !stat.isSymbolicLink()) {
					fs.rmSync(receiptsPath, { recursive: true, force: true });
					fs.symlinkSync(outside, receiptsPath, 'junction');
					swapped = true;
					return;
				}
				setImmediate(swap);
			};
			setImmediate(swap);
			await expect(
				capturePhaseGateReport(dir, report as never),
			).rejects.toThrow('RECEIPT_WRITE_PATH_ESCAPE');
			expect(swapped).toBe(true);
			expect(fs.readdirSync(outside)).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test('FB-002: --export SUCCEEDS through a junctioned project root (realpath/lexical asymmetry closed)', async () => {
		const real = makeDir('receipt-junc-real-');
		const linkParent = canonicalMkdtemp('receipt-junc-link-');
		try {
			await seedReport(real);
			const alias = path.join(linkParent, 'proj');
			junction(real, alias);
			const receipt = await buildVerificationReceipt(alias, 'phase', '1');
			const bundle = await writeExportBundle(alias, receipt, '# md');
			// The bundle really exists at the physical location.
			const physical = path.join(
				real,
				'.swarm',
				'plan-export',
				path.basename(bundle.bundleDir),
			);
			expect(fs.existsSync(path.join(physical, 'receipt.json'))).toBe(true);
			expect(fs.existsSync(path.join(physical, 'receipt.md'))).toBe(true);
			expect(fs.existsSync(path.join(physical, 'artifacts'))).toBe(true);
		} finally {
			fs.rmSync(real, { recursive: true, force: true });
			fs.rmSync(linkParent, { recursive: true, force: true });
		}
	});

	test('PRR-004: the emitter rejects a junctioned PARENT component when hashing a cited artifact', () => {
		const dir = makeDir('receipt-junc-emit-hash-');
		const outside = canonicalMkdtemp('receipt-junc-out4-');
		try {
			// A real file outside, reachable through a junction inside .swarm.
			fs.writeFileSync(path.join(outside, 'data.json'), '{}');
			junction(outside, path.join(dir, '.swarm', 'evidence', 'linked'));
			expect(() =>
				hashReceiptArtifact(
					fs.realpathSync(dir),
					path.join(dir, '.swarm', 'evidence', 'linked', 'data.json'),
				),
			).toThrow('RECEIPT_ARTIFACT_UNSAFE_PATH');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test('PRR-004: the emitter rejects a non-regular cited artifact (directory leaf)', () => {
		const dir = makeDir('receipt-nonregular-');
		try {
			fs.mkdirSync(path.join(dir, '.swarm', 'evidence', 'adir'), {
				recursive: true,
			});
			expect(() =>
				hashReceiptArtifact(
					fs.realpathSync(dir),
					path.join(dir, '.swarm', 'evidence', 'adir'),
				),
			).toThrow('RECEIPT_ARTIFACT_NON_REGULAR');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('FB-008: listEvidenceTaskIds ignores the derived receipts/ subtree (doctor false-orphan class)', async () => {
		const dir = makeDir('receipt-doctor-');
		try {
			fs.mkdirSync(path.join(dir, '.swarm', 'evidence', '1.1'), {
				recursive: true,
			});
			fs.writeFileSync(
				path.join(dir, '.swarm', 'evidence', '1.1', 'evidence.json'),
				JSON.stringify({
					taskId: '1.1',
					gates: { g: { sessionId: 's', timestamp: STATIC_TIME, agent: 'a' } },
				}),
			);
			await seedReport(dir);
			const ids = await listEvidenceTaskIds(dir);
			expect(ids).not.toContain('receipts');
			expect(ids).toContain('1.1');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
