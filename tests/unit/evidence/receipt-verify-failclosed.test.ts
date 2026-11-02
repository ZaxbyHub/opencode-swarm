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
import { capturePhaseGateReport } from '../../../src/evidence/receipt-store';
import { verifyReceiptBundle } from '../../../src/evidence/receipt-verify';
import { executeReceiptVerify } from '../../../src/services/receipt-service';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Fail-closed taxonomy family for receipt verification (#2970), split from
 * receipt-verify.test.ts at the FR-006 500-line cap (final-critic round 1);
 * one compact fail-closed leg remains in the original file so the frozen
 * `-t "fail-closed"` replay target keeps matching there — the family lives
 * on here unchanged.
 */

const REPO_ROOT = path.resolve(import.meta.dir, '..', '..', '..');

function makeProject(): string {
	const dir = canonicalMkdtemp('receipt-verify-fc-');
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
	const { writeExportBundle } = await import(
		'../../../src/evidence/receipt-store'
	);
	await writeExportBundle(dir, receipt, renderReceiptMarkdown(receipt));
	return path.join(
		dir,
		'.swarm',
		'plan-export',
		`receipt-phase-1-${receipt.receipt_hash.slice(0, 12)}`,
	);
}

function toFreshClone(bundleDir: string): string {
	const fresh = canonicalMkdtemp('receipt-fc-clone-');
	fs.cpSync(bundleDir, path.join(fresh, path.basename(bundleDir)), {
		recursive: true,
	});
	return path.join(fresh, path.basename(bundleDir));
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

void REPO_ROOT;
void RECEIPT_FORMAT_VERSION;
void spawnSync;
void verifyReceiptBundle;
void readReceipt;
void writeReceipt;
void rehash;

describe('receipt verify fail-closed family (#2970)', () => {
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

	test('fail-closed: a symlinked PARENT directory is a path escape (junction probe, review F1)', async () => {
		const dir = makeProject();
		try {
			const bundleDir = toFreshClone(await buildExportedBundle(dir));
			// Outside-the-bundle directory with a real, correctly-hashed file.
			const outside = path.join(path.dirname(bundleDir), 'outside-store');
			fs.mkdirSync(outside, { recursive: true });
			const evilBytes = Buffer.from('evil-but-correctly-hashed\n');
			fs.writeFileSync(path.join(outside, 'evil.txt'), evilBytes);
			// artifacts/link -> outside: a junction on Windows (no privilege
			// needed) / a directory symlink on POSIX. lstat on the LEAF cannot
			// see it — the parent-component walk must.
			fs.symlinkSync(
				outside,
				path.join(bundleDir, 'artifacts', 'link'),
				'junction',
			);
			const { record } = readReceipt(bundleDir);
			(
				record.artifacts as Array<{
					path: string;
					sha256: string;
					bytes: number;
				}>
			).push({
				path: 'link/evil.txt',
				sha256: createHash('sha256').update(evilBytes).digest('hex'),
				bytes: evilBytes.byteLength,
			});
			rehash(record);
			writeReceipt(bundleDir, record);
			const outcome = await executeReceiptVerify(bundleDir);
			expect(outcome.ok).toBe(false);
			expect(JSON.stringify(outcome.result)).toContain('path_escape');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('fail-closed: a leaf symlinked artifact is a path escape', async () => {
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
