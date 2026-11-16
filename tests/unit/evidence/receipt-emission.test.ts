import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	buildVerificationReceipt,
	RECEIPT_FORMAT_VERSION,
	VerificationReceiptSchema,
} from '../../../src/evidence/receipt';
import {
	capturePhaseGateReport,
	_internals as storeInternals,
	writeExportBundle,
	writeReceiptArtifact,
} from '../../../src/evidence/receipt-store';
import {
	executeReceiptEmission,
	handleReceiptCommand,
} from '../../../src/services/receipt-service';
import {
	ensureAgentSession,
	recordPhaseAgentDispatch,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import type { PhaseGateReport } from '../../../src/tools/phase-complete/preflight-report';
import { computePhaseEvidenceSnapshot } from '../../../src/tools/phase-complete/snapshot-identity';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const STATIC_TIME = '2026-11-02T00:00:00.000Z';

function makeDir(): string {
	const dir = canonicalMkdtemp('receipt-emission-');
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	return dir;
}

function snapshotIdentityRefs(dir: string): string[] {
	return [
		`plan-structure:${'a'.repeat(64)}`,
		`policy:${'b'.repeat(64)}`,
		`phase-evidence:${computePhaseEvidenceSnapshot(dir)}`,
	];
}

function makeReport(
	dir: string,
	phase = 1,
	detailMarker?: string,
): PhaseGateReport {
	const entries = [
		{
			id: 'snapshot_identity',
			code: 'SNAP_OK',
			outcome: 'pass' as const,
			detail: detailMarker,
			evidenceRefs: snapshotIdentityRefs(dir),
			responsibleActor: 'architect',
			agentsDispatched: [],
			agentsMissing: [],
			warnings: [],
		},
		{
			id: 'retrospective',
			code: 'RETRO_OK',
			outcome: 'pass' as const,
			evidenceRefs: ['.swarm/evidence/retro-1/evidence.json'],
			responsibleActor: 'architect',
			agentsDispatched: [],
			agentsMissing: [],
			warnings: [],
		},
	];
	return {
		schemaVersion: 1,
		phase,
		outcome: 'pass',
		reportHash: createHash('sha256')
			.update(JSON.stringify({ schemaVersion: 1, phase, entries }))
			.digest('hex'),
		entries: entries as PhaseGateReport['entries'],
	};
}

function seedReferencePhase(dir: string, marker?: string): PhaseGateReport {
	fs.writeFileSync(
		path.join(dir, '.swarm', 'spec.md'),
		'# Spec\n\n## FR-01\nRequirement.\n',
	);
	return makeReport(dir, 1, marker);
}

function listTree(dir: string): Set<string> {
	const out = new Set<string>();
	const walk = (absolute: string): void => {
		for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
			const full = path.join(absolute, entry.name);
			out.add(path.relative(dir, full).replaceAll('\\', '/'));
			if (entry.isDirectory()) walk(full);
		}
	};
	walk(dir);
	return out;
}

describe('receipt emission (#2968)', () => {
	test('emits a receipt for the reference phase via the command surface', async () => {
		const dir = makeDir();
		try {
			const report = seedReferencePhase(dir);
			await capturePhaseGateReport(dir, report);
			const raw = await handleReceiptCommand(dir, ['phase', '1']);
			expect(typeof raw).toBe('string');
			const summary = raw as string;
			expect(summary).toContain('receipt emitted: phase 1');
			const receiptsDir = path.join(dir, '.swarm', 'evidence', 'receipts');
			const jsonName = fs
				.readdirSync(receiptsDir)
				.find((name) => /^receipt-phase-1-[0-9a-f]{12}\.json$/.test(name));
			expect(jsonName).toBeDefined();
			const receipt = JSON.parse(
				fs.readFileSync(path.join(receiptsDir, jsonName as string), 'utf8'),
			);
			expect(VerificationReceiptSchema.parse(receipt).format_version).toBe(
				RECEIPT_FORMAT_VERSION,
			);
			expect(receipt.snapshot.plan_structure).toBe('a'.repeat(64));
			expect(receipt.snapshot.phase_evidence).toBe(
				computePhaseEvidenceSnapshot(dir),
			);
			expect(receipt.report_hash).toBe(report.reportHash);
			const specRef = receipt.artifacts.find(
				(artifact: { path: string }) => artifact.path === '.swarm/spec.md',
			);
			const specBytes = fs.readFileSync(path.join(dir, '.swarm', 'spec.md'));
			expect(specRef.sha256).toBe(
				createHash('sha256').update(specBytes).digest('hex'),
			);
			expect(
				fs.existsSync(
					path.join(
						receiptsDir,
						(jsonName as string).replace(/\.json$/, '.md'),
					),
				),
			).toBe(true);
		} finally {
			closeAllProjectDbs();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('emits via the receipt tool with identical artifact digests (independent crypto)', async () => {
		const dir = makeDir();
		try {
			await capturePhaseGateReport(dir, seedReferencePhase(dir));
			const outcome = await executeReceiptEmission(dir, 'phase', '1', false);
			expect(outcome.format_version).toBe('1.0.0');
			expect(outcome.artifact_count).toBeGreaterThanOrEqual(1);
			const receipt = JSON.parse(
				fs.readFileSync(path.resolve(dir, outcome.json_path), 'utf8'),
			);
			for (const artifact of receipt.artifacts) {
				const bytes = fs.readFileSync(path.join(dir, artifact.path));
				expect(artifact.bytes).toBe(bytes.byteLength);
				expect(artifact.sha256).toBe(
					createHash('sha256').update(bytes).digest('hex'),
				);
			}
		} finally {
			closeAllProjectDbs();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('emits identical receipt_hash on re-emission (write-once idempotency)', async () => {
		const dir = makeDir();
		try {
			await capturePhaseGateReport(dir, seedReferencePhase(dir));
			const first = await executeReceiptEmission(dir, 'phase', '1', false);
			const second = await executeReceiptEmission(dir, 'phase', '1', false);
			expect(second.receipt_hash).toBe(first.receipt_hash);
			expect(second.already_frozen).toBe(true);
			const jsonFiles = fs
				.readdirSync(path.join(dir, '.swarm', 'evidence', 'receipts'))
				.filter(
					(name) =>
						name.startsWith('receipt-phase-1') && name.endsWith('.json'),
				);
			expect(jsonFiles).toHaveLength(1);
		} finally {
			closeAllProjectDbs();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('tree snapshot: every new path stays under .swarm/ (containment)', async () => {
		const dir = makeDir();
		try {
			seedReferencePhase(dir);
			await capturePhaseGateReport(dir, makeReport(dir));
			const before = listTree(dir);
			await executeReceiptEmission(dir, 'phase', '1', true);
			const after = listTree(dir);
			const added = [...after].filter((entry) => !before.has(entry));
			expect(added.length).toBeGreaterThan(0);
			for (const entry of added) {
				expect(entry.startsWith('.swarm/')).toBe(true);
			}
		} finally {
			closeAllProjectDbs();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('digests only: raw gate detail never reaches the receipt JSON or Markdown', async () => {
		const dir = makeDir();
		try {
			const marker = 'RAW-DETAIL-NEVER-EMIT-9f1e';
			await capturePhaseGateReport(dir, seedReferencePhase(dir, marker));
			await executeReceiptEmission(dir, 'phase', '1', false);
			const receiptsDir = path.join(dir, '.swarm', 'evidence', 'receipts');
			for (const name of fs.readdirSync(receiptsDir)) {
				if (!name.startsWith('receipt-')) continue;
				const content = fs.readFileSync(path.join(receiptsDir, name), 'utf8');
				expect(content).not.toContain(marker);
			}
			const receiptJson = fs.readFileSync(
				path.join(
					receiptsDir,
					fs
						.readdirSync(receiptsDir)
						.find(
							(name) => name.startsWith('receipt-') && name.endsWith('.json'),
						) as string,
				),
				'utf8',
			);
			const receipt = JSON.parse(receiptJson);
			expect(receipt.gates[0].detail_digest).toBe(
				createHash('sha256').update(marker).digest('hex'),
			);
			expect(receipt.gates[0].command).toBeUndefined();
			expect(receipt.gates[0].exit_code).toBeUndefined();
			expect(receipt.gates[0].output_digest).toBeUndefined();
		} finally {
			closeAllProjectDbs();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('bound: a task with more gates than MAX_RECEIPT_GATES fails closed', async () => {
		const dir = makeDir();
		try {
			const gates: Record<
				string,
				{ sessionId: string; timestamp: string; agent: string }
			> = {};
			for (let index = 0; index < 70; index += 1) {
				gates[`gate_${index}`] = {
					sessionId: 's',
					timestamp: STATIC_TIME,
					agent: 'architect',
				};
			}
			fs.writeFileSync(
				path.join(dir, '.swarm', 'evidence', '3.1.json'),
				JSON.stringify({ taskId: '3.1', gates }),
			);
			await expect(
				buildVerificationReceipt(dir, 'task', '3.1'),
			).rejects.toThrow('RECEIPT_GATE_LIMIT');
		} finally {
			closeAllProjectDbs();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('export bundle is self-contained and its copies hash to the recorded digests', async () => {
		const dir = makeDir();
		try {
			await capturePhaseGateReport(dir, seedReferencePhase(dir));
			const outcome = await executeReceiptEmission(dir, 'phase', '1', true);
			expect(outcome.bundle_dir).toContain(
				'.swarm/plan-export/receipt-phase-1-',
			);
			const bundleDir = path.join(dir, outcome.bundle_dir);
			expect(fs.existsSync(path.join(bundleDir, 'receipt.json'))).toBe(true);
			expect(fs.existsSync(path.join(bundleDir, 'receipt.md'))).toBe(true);
			const receipt = JSON.parse(
				fs.readFileSync(path.join(bundleDir, 'receipt.json'), 'utf8'),
			);
			for (const artifact of receipt.artifacts) {
				const copy = fs.readFileSync(
					path.join(bundleDir, 'artifacts', ...artifact.path.split('/')),
				);
				expect(createHash('sha256').update(copy).digest('hex')).toBe(
					artifact.sha256,
				);
			}
		} finally {
			closeAllProjectDbs();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('export failure cleans staging and leaves no partial bundle', async () => {
		const dir = makeDir();
		try {
			await capturePhaseGateReport(dir, seedReferencePhase(dir));
			const receipt = await buildVerificationReceipt(dir, 'phase', '1');
			const originalCopy = storeInternals.copyFile;
			storeInternals.copyFile = async () => {
				throw new Error('INJECTED_COPY_FAILURE');
			};
			try {
				await expect(writeExportBundle(dir, receipt, '# x')).rejects.toThrow(
					'INJECTED_COPY_FAILURE',
				);
			} finally {
				storeInternals.copyFile = originalCopy;
			}
			const exportDir = path.join(dir, '.swarm', 'plan-export');
			const leftovers = fs.existsSync(exportDir)
				? fs
						.readdirSync(exportDir)
						.filter((name) => name.includes('receipt-phase-1'))
				: [];
			expect(leftovers).toHaveLength(0);
		} finally {
			closeAllProjectDbs();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('prune blast radius: retention removes only the exact unit excess', async () => {
		const dir = makeDir();
		try {
			seedReferencePhase(dir);
			await capturePhaseGateReport(dir, makeReport(dir));
			const receiptsDir = path.join(dir, '.swarm', 'evidence', 'receipts');
			// 9 stale receipts for unit foo + 2 for sibling unit foo-bar + an unrelated file
			for (let index = 0; index < 9; index += 1) {
				fs.writeFileSync(
					path.join(
						receiptsDir,
						`receipt-task-foo-${String(index).padStart(12, '0')}.json`,
					),
					'{}',
				);
			}
			fs.writeFileSync(
				path.join(receiptsDir, 'receipt-task-foo-bar-aaaaaaaaaaaa.json'),
				'{}',
			);
			fs.writeFileSync(
				path.join(receiptsDir, 'receipt-task-foo-bar-bbbbbbbbbbbb.json'),
				'{}',
			);
			fs.writeFileSync(path.join(receiptsDir, 'unrelated.txt'), 'keep me');
			const receipt = await buildVerificationReceipt(dir, 'phase', '1');
			await writeReceiptArtifact(dir, {
				...receipt,
				kind: 'task',
				unit_id: 'foo',
				receipt_hash: 'c'.repeat(64),
			} as never);
			const names = fs.readdirSync(receiptsDir);
			const fooFiles = names.filter((name) =>
				/^receipt-task-foo-[0-9a-f]{12}\.json$/.test(name),
			);
			const fooBarFiles = names.filter((name) =>
				name.startsWith('receipt-task-foo-bar'),
			);
			expect(fooFiles).toHaveLength(8);
			expect(fooBarFiles).toHaveLength(2);
			expect(names).toContain('unrelated.txt');
		} finally {
			closeAllProjectDbs();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('hash stability: emitting receipts never changes the phase-evidence snapshot', async () => {
		const dir = makeDir();
		try {
			seedReferencePhase(dir);
			const before = computePhaseEvidenceSnapshot(dir);
			await capturePhaseGateReport(dir, makeReport(dir));
			await executeReceiptEmission(dir, 'phase', '1', true);
			await executeReceiptEmission(dir, 'phase', '1', true);
			expect(computePhaseEvidenceSnapshot(dir)).toBe(before);
			// Retained receipts also cannot exhaust the source-evidence file cap.
			const receiptsDir = path.join(dir, '.swarm', 'evidence', 'receipts');
			// report + receipt.json + receipt.md — idempotent re-emission and the
			// capped retention keep the derived subtree tiny by construction.
			expect(fs.readdirSync(receiptsDir)).toHaveLength(3);
		} finally {
			closeAllProjectDbs();
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
