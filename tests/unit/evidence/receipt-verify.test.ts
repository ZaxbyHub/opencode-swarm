import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	buildVerificationReceipt,
	canonicalReceiptJson,
	computeReceiptHash,
	RECEIPT_FORMAT_VERSION,
	renderReceiptMarkdown,
} from '../../../src/evidence/receipt';
import {
	capturePhaseGateReport,
	writeExportBundle,
} from '../../../src/evidence/receipt-store';
import { verifyReceiptBundle } from '../../../src/evidence/receipt-verify';
import {
	executeReceiptVerify,
	handleReceiptCommand,
} from '../../../src/services/receipt-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..');

function makeProject(): string {
	const dir = canonicalMkdtemp('receipt-verify-');
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	return dir;
}

async function seedReport(dir: string): Promise<void> {
	fs.writeFileSync(
		path.join(dir, '.swarm', 'spec.md'),
		'# Spec\n\n## FR-01\nRequirement.\n',
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
		phase: 1,
		outcome: 'pass' as const,
		reportHash: createHash('sha256')
			.update(JSON.stringify({ schemaVersion: 1, phase: 1, entries }))
			.digest('hex'),
		entries,
	};
	await capturePhaseGateReport(dir, report as never);
}

async function buildExportedBundle(dir: string): Promise<string> {
	await seedReport(dir);
	const receipt = await buildVerificationReceipt(dir, 'phase', '1');
	await writeExportBundle(dir, receipt, renderReceiptMarkdown(receipt));
	const shorthash = receipt.receipt_hash.slice(0, 12);
	return path.join(
		dir,
		'.swarm',
		'plan-export',
		`receipt-phase-1-${shorthash}`,
	);
}

/** Copy a bundle into a bare scratch dir with no .swarm/ anywhere (fresh clone). */
const freshCloneParents: string[] = [];
function toFreshClone(bundleDir: string): string {
	const fresh = canonicalMkdtemp('receipt-fresh-clone-');
	freshCloneParents.push(fresh);
	fs.cpSync(bundleDir, path.join(fresh, path.basename(bundleDir)), {
		recursive: true,
	});
	return path.join(fresh, path.basename(bundleDir));
}

// PRR-030: the mkdtemp PARENT (and everything copied under it) is removed
// after each test — previously only the returned bundle dir was cleaned and
// the parent leaked into os.tmpdir.
afterEach(() => {
	for (const parent of freshCloneParents.splice(0)) {
		fs.rmSync(parent, { recursive: true, force: true });
	}
});

function listTree(dir: string): Set<string> {
	// FB-017 (swarm-pr-review): entries carry a content digest, not just the
	// path name — a write that preserves the path set (in-place rewrite) or
	// deletes a file is then detectable, closing the name-only evasion.
	const out = new Set<string>();
	for (const entry of fs.readdirSync(dir, { recursive: true }) as string[]) {
		const normalized = entry.replaceAll('\\', '/');
		const full = path.join(dir, entry);
		let digest = '<dir>';
		try {
			const stat = fs.lstatSync(full);
			if (stat.isFile()) {
				digest = createHash('sha256')
					.update(fs.readFileSync(full))
					.digest('hex');
			} else if (stat.isSymbolicLink()) {
				digest = `<link:${fs.readlinkSync(full)}>`;
			}
		} catch {
			digest = '<unreadable>';
		}
		out.add(`${normalized} @@ ${digest}`);
	}
	return out;
}

function readReceipt(bundleDir: string): {
	record: Record<string, unknown>;
	raw: string;
} {
	const raw = fs.readFileSync(path.join(bundleDir, 'receipt.json'), 'utf8');
	return { record: JSON.parse(raw) as Record<string, unknown>, raw };
}

function writeReceipt(
	bundleDir: string,
	record: Record<string, unknown>,
): void {
	fs.writeFileSync(
		path.join(bundleDir, 'receipt.json'),
		`${JSON.stringify(record)}\n`,
	);
}

function rehash(record: Record<string, unknown>): void {
	const { receipt_hash: _hash, ...rest } = record;
	record.receipt_hash = computeReceiptHash(rest);
}

describe('receipt verify (#2970)', () => {
	test('green: a fresh-clone bundle verifies ok via bundle-dir and receipt.json forms', async () => {
		const dir = makeProject();
		try {
			const bundleDir = toFreshClone(await buildExportedBundle(dir));
			const dirForm = await executeReceiptVerify(bundleDir);
			expect(dirForm.ok).toBe(true);
			expect(dirForm.summary).toContain('receipt verify OK');
			const fileForm = await executeReceiptVerify(
				path.join(bundleDir, 'receipt.json'),
			);
			expect(fileForm.ok).toBe(true);
			// F4 (implementation review): compare the TWO forms, not a value to
			// itself — both surfaces must agree on the checked artifact count.
			expect(
				(fileForm.result as { checked: { artifacts: number } }).checked
					.artifacts,
			).toBe(
				(dirForm.result as { checked: { artifacts: number } }).checked
					.artifacts,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('green: the CLI verifies a bundle and exits 0 (run receipt --verify)', async () => {
		const dir = makeProject();
		try {
			const bundleDir = await buildExportedBundle(dir);
			const run = spawnSync(
				'bun',
				['run', 'src/cli/index.ts', 'run', 'receipt', '--verify', bundleDir],
				{ cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 },
			);
			expect(run.status).toBe(0);
			expect(run.stdout).toContain('receipt verify OK');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('flip: any single flipped byte in any cited artifact exits 1 with digest_mismatch', async () => {
		const dir = makeProject();
		try {
			const bundleDir = toFreshClone(await buildExportedBundle(dir));
			const { record } = readReceipt(bundleDir);
			const artifacts = record.artifacts as Array<{ path: string }>;
			expect(artifacts.length).toBeGreaterThan(0);
			for (const artifact of artifacts) {
				const target = path.join(
					bundleDir,
					'artifacts',
					...artifact.path.split('/'),
				);
				const original = fs.readFileSync(target);
				const flipped = Buffer.from(original);
				flipped[0] = flipped[0]! ^ 0x01;
				fs.writeFileSync(target, flipped);
				const outcome = await executeReceiptVerify(bundleDir);
				expect(outcome.ok).toBe(false);
				const text = JSON.stringify(outcome.result);
				expect(text).toContain('digest_mismatch');
				expect(text).toContain(artifact.path);
				const command = await handleReceiptCommand(REPO_ROOT, [
					'--verify',
					bundleDir,
				]);
				expect(typeof command).toBe('object');
				expect((command as { exitCode?: number }).exitCode).toBe(1);
				fs.writeFileSync(target, original);
			}
			const restored = await executeReceiptVerify(bundleDir);
			expect(restored.ok).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('flip: one flipped byte in the CLI child process exits 1 (red CLI leg)', async () => {
		const dir = makeProject();
		try {
			const bundleDir = await buildExportedBundle(dir);
			const target = path.join(bundleDir, 'artifacts', '.swarm', 'spec.md');
			const original = fs.readFileSync(target);
			const flipped = Buffer.from(original);
			flipped[0] = flipped[0]! ^ 0x01;
			fs.writeFileSync(target, flipped);
			const run = spawnSync(
				'bun',
				['run', 'src/cli/index.ts', 'run', 'receipt', '--verify', bundleDir],
				{ cwd: REPO_ROOT, encoding: 'utf8', timeout: 120_000 },
			);
			expect(run.status).toBe(1);
			expect(run.stdout).toContain('digest_mismatch');
			fs.writeFileSync(target, original);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('fail-closed: receipt-body tamper yields receipt_hash_mismatch', async () => {
		const dir = makeProject();
		try {
			const bundleDir = toFreshClone(await buildExportedBundle(dir));
			const { record } = readReceipt(bundleDir);
			const gates = record.gates as Array<{ gate_id: string }>;
			gates[0].gate_id = 'tampered';
			writeReceipt(bundleDir, record);
			const outcome = await executeReceiptVerify(bundleDir);
			expect(outcome.ok).toBe(false);
			expect(JSON.stringify(outcome.result)).toContain('receipt_hash_mismatch');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
	test('purity: a full verify run writes nothing and needs no repo-local state', async () => {
		const project = makeProject();
		try {
			const bundleDir = toFreshClone(await buildExportedBundle(project));
			const before = listTree(path.dirname(bundleDir));
			const outcome = await executeReceiptVerify(bundleDir);
			expect(outcome.ok).toBe(true);
			const after = listTree(path.dirname(bundleDir));
			// FB-017: full content-hash tree equality — additions, deletions,
			// in-place rewrites (same path set) and symlink swaps all fail
			// this, where the old name-only filter detected none of them.
			expect([...after].sort()).toEqual([...before].sort());
			// Fresh-clone purity: the bundle needs no repo-local state — the
			// fresh root contains ONLY the bundle (the .swarm/ paths INSIDE
			// artifacts/ are the bundle's own portable content, by design).
			const freshRoot = path.dirname(bundleDir);
			const entries = fs.readdirSync(freshRoot);
			expect(entries).toEqual([path.basename(bundleDir)]);
			expect(fs.existsSync(path.join(freshRoot, '.swarm'))).toBe(false);
		} finally {
			fs.rmSync(project, { recursive: true, force: true });
		}
	});
});
