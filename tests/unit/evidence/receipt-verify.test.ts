import { describe, expect, test } from 'bun:test';
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
function toFreshClone(bundleDir: string): string {
	const fresh = canonicalMkdtemp('receipt-fresh-clone-');
	fs.cpSync(bundleDir, path.join(fresh, path.basename(bundleDir)), {
		recursive: true,
	});
	return path.join(fresh, path.basename(bundleDir));
}

function listTree(dir: string): Set<string> {
	const out = new Set<string>();
	for (const entry of fs.readdirSync(dir, { recursive: true }) as string[]) {
		out.add(entry.replaceAll('\\', '/'));
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
			expect(
				(dirForm.result as { checked: { artifacts: number } }).checked
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

	test('fail-closed: deleted artifact yields missing_artifact', async () => {
		const dir = makeProject();
		try {
			const bundleDir = toFreshClone(await buildExportedBundle(dir));
			const { record } = readReceipt(bundleDir);
			const target = path.join(
				bundleDir,
				'artifacts',
				...(record.artifacts as Array<{ path: string }>)[0].path.split('/'),
			);
			fs.unlinkSync(target);
			const outcome = await executeReceiptVerify(bundleDir);
			expect(JSON.stringify(outcome.result)).toContain('missing_artifact');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('fail-closed: unsupported format_version names the found value', async () => {
		const dir = makeProject();
		try {
			const bundleDir = toFreshClone(await buildExportedBundle(dir));
			const { record } = readReceipt(bundleDir);
			record.format_version = '2.0.0';
			rehash(record);
			writeReceipt(bundleDir, record);
			const outcome = await executeReceiptVerify(bundleDir);
			expect(JSON.stringify(outcome.result)).toContain(
				'unsupported_format_version',
			);
			expect(JSON.stringify(outcome.result)).toContain('2.0.0');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('fail-closed: corrupt JSON yields corrupt_json; null and wrong shape yield typed failures', async () => {
		const dir = makeProject();
		try {
			const bundleDir = toFreshClone(await buildExportedBundle(dir));
			fs.writeFileSync(path.join(bundleDir, 'receipt.json'), '{not json');
			const corrupt = await executeReceiptVerify(bundleDir);
			expect(JSON.stringify(corrupt.result)).toContain('corrupt_json');
			fs.writeFileSync(path.join(bundleDir, 'receipt.json'), 'null');
			const nullResult = await executeReceiptVerify(bundleDir);
			expect(nullResult.ok).toBe(false);
			fs.writeFileSync(path.join(bundleDir, 'receipt.json'), '[1,2,3]');
			const arrayResult = await executeReceiptVerify(bundleDir);
			expect(arrayResult.ok).toBe(false);
			// Valid JSON, wrong shape: schema_mismatch
			const { record } = (() => {
				return {
					record: { format_version: RECEIPT_FORMAT_VERSION, bogus: true },
				};
			})();
			writeReceipt(bundleDir, record);
			const wrongShape = await executeReceiptVerify(bundleDir);
			expect(JSON.stringify(wrongShape.result)).toContain('schema_mismatch');
			// Missing receipt file entirely
			fs.unlinkSync(path.join(bundleDir, 'receipt.json'));
			const missing = await executeReceiptVerify(bundleDir);
			expect(missing.ok).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('fail-closed: path escape with a recomputed valid hash reaches path_escape', async () => {
		const dir = makeProject();
		try {
			const bundleDir = toFreshClone(await buildExportedBundle(dir));
			const { record } = readReceipt(bundleDir);
			const artifacts = record.artifacts as Array<{
				path: string;
				sha256: string;
				bytes: number;
			}>;
			artifacts.push({
				path: '../../outside.json',
				sha256: 'd'.repeat(64),
				bytes: 1,
			});
			// Recompute the receipt hash so verification passes the hash gate and
			// the path check is what fires (the AC9 contract).
			rehash(record);
			writeReceipt(bundleDir, record);
			const outcome = await executeReceiptVerify(bundleDir);
			expect(JSON.stringify(outcome.result)).toContain('path_escape');
			// Backslash traversal is rejected identically.
			const { record: bsRecord } = readReceipt(bundleDir);
			(bsRecord.artifacts as Array<{ path: string }>)[
				(bsRecord.artifacts as Array<{ path: string }>).length - 1
			].path = '..\\outside.json';
			rehash(bsRecord);
			writeReceipt(bundleDir, bsRecord);
			const backslash = await executeReceiptVerify(bundleDir);
			expect(JSON.stringify(backslash.result)).toContain('path_escape');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('fail-closed: absolute, drive, UNC, and dot paths are path escapes', async () => {
		const dir = makeProject();
		try {
			const bundleDir = toFreshClone(await buildExportedBundle(dir));
			const { record } = readReceipt(bundleDir);
			const artifacts = record.artifacts as Array<{ path: string }>;
			for (const bad of [
				'/abs.json',
				'C:\\x\\y.json',
				'\\\\srv\\share\\z.json',
				'.',
			]) {
				const clone = JSON.parse(JSON.stringify(record)) as Record<
					string,
					unknown
				>;
				(clone.artifacts as Array<{ path: string }>)[
					artifacts.length - 1
				].path = bad;
				rehash(clone);
				writeReceipt(bundleDir, clone);
				const outcome = verifyReceiptBundle({
					receiptFile: path.join(bundleDir, 'receipt.json'),
					artifactRoot: path.join(bundleDir, 'artifacts'),
				});
				expect(
					outcome.failures.some((failure) => failure.kind === 'path_escape'),
					`expected path_escape for ${JSON.stringify(bad)}`,
				).toBe(true);
			}
			// An EMPTY path dies at the schema gate (min(1)), one step earlier —
			// still fail-closed, with the schema_mismatch kind.
			const clone = JSON.parse(JSON.stringify(record)) as Record<
				string,
				unknown
			>;
			(clone.artifacts as Array<{ path: string }>)[
				(clone.artifacts as Array<{ path: string }>).length - 1
			].path = '';
			rehash(clone);
			writeReceipt(bundleDir, clone);
			const emptyOutcome = verifyReceiptBundle({
				receiptFile: path.join(bundleDir, 'receipt.json'),
				artifactRoot: path.join(bundleDir, 'artifacts'),
			});
			expect(
				emptyOutcome.failures.some(
					(failure) => failure.kind === 'schema_mismatch',
				),
			).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('fail-closed: a symlinked artifact is a path escape (parent-link escape)', async () => {
		const dir = makeProject();
		try {
			const bundleDir = toFreshClone(await buildExportedBundle(dir));
			const { record } = readReceipt(bundleDir);
			const artifacts = record.artifacts as Array<{ path: string }>;
			const firstPath = artifacts[0].path;
			const target = path.join(bundleDir, 'artifacts', ...firstPath.split('/'));
			const linkPath = `${target}.link`;
			try {
				fs.symlinkSync(target, linkPath);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'EPERM') {
					// Windows without developer mode refuses file symlinks; the
					// POSIX CI legs and privileged Windows hosts execute this.
					return;
				}
				throw error;
			}
			artifacts.push({
				path: `${firstPath}.link`,
				sha256: 'e'.repeat(64),
				bytes: 1,
			});
			rehash(record);
			writeReceipt(bundleDir, record);
			const outcome = await executeReceiptVerify(bundleDir);
			expect(JSON.stringify(outcome.result)).toContain('path_escape');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('fail-closed: unknown added field flips receipt_hash (raw-object hashing)', async () => {
		const dir = makeProject();
		try {
			const bundleDir = toFreshClone(await buildExportedBundle(dir));
			const { record } = readReceipt(bundleDir);
			record.extra_field = 'added';
			// Deliberately NOT rehashing: the tampered content must fail the hash.
			writeReceipt(bundleDir, record);
			const outcome = await executeReceiptVerify(bundleDir);
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
			expect([...after].filter((entry) => !before.has(entry))).toHaveLength(0);
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

	test('canonical form round-trips: the bundle receipt.json parses and rehashes identically', async () => {
		const project = makeProject();
		try {
			const bundleDir = toFreshClone(await buildExportedBundle(project));
			const raw = fs.readFileSync(path.join(bundleDir, 'receipt.json'), 'utf8');
			const parsed = JSON.parse(raw);
			const { receipt_hash: _hash, ...rest } = parsed;
			expect(computeReceiptHash(rest)).toBe(parsed.receipt_hash);
			expect(canonicalReceiptJson(parsed).length).toBeGreaterThan(0);
		} finally {
			fs.rmSync(project, { recursive: true, force: true });
		}
	});
});
