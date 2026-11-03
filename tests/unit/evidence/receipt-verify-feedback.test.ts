import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { computeReceiptHash } from '../../../src/evidence/receipt';
import { verifyReceiptBundle } from '../../../src/evidence/receipt-verify';
import {
	handleReceiptCommand,
	resolveVerifyTarget,
} from '../../../src/services/receipt-service';
import { receipt as receiptTool } from '../../../src/tools/receipt';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Verify-path feedback legs (swarm-pr-review PR #3550, split from
 * receipt-review-round2 at the FR-006 500-line cap): verify-side budgets
 * (FB-006), typed taxonomy for hostile structure (FB-006b), strict
 * invocation shapes (FB-007/016), and project-directory resolution
 * (FB-021).
 */

const STATIC_TIME = '2026-11-02T00:00:00.000Z';

function makeDir(prefix: string): string {
	const dir = canonicalMkdtemp(prefix);
	fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.swarm', 'evidence'), { recursive: true });
	return dir;
}

describe('receipt verify feedback legs', () => {
	test('FB-006: verify-side budgets reject receipts no emitter could produce', async () => {
		const dir = makeDir('r2-fb006-budget-');
		try {
			const bundleDir = path.join(dir, 'bundle');
			const artifactsDir = path.join(bundleDir, 'artifacts');
			fs.mkdirSync(artifactsDir, { recursive: true });
			fs.writeFileSync(path.join(artifactsDir, 'a.json'), '{}');
			const manyArtifacts = Array.from({ length: 600 }, () => ({
				path: 'a.json',
				sha256: createHash('sha256').update('{}').digest('hex'),
				bytes: 2,
			}));
			const base = {
				format_version: '1.0.0',
				kind: 'task',
				unit_id: '1.1',
				generated_at: STATIC_TIME,
				plugin_version: '0.0.0-test',
				snapshot: {},
				gates: [
					{
						gate_id: 'g',
						outcome: 'pass',
						responsible_actor: 'swarm',
						evidence_refs: [],
					},
				],
			};
			const withOver = { ...base, artifacts: manyArtifacts };
			const record = {
				...withOver,
				receipt_hash: computeReceiptHash(withOver),
			};
			const receiptFile = path.join(bundleDir, 'receipt.json');
			fs.writeFileSync(receiptFile, JSON.stringify(record));
			const overCount = verifyReceiptBundle({
				receiptFile,
				artifactRoot: artifactsDir,
			});
			expect(
				overCount.failures[0]?.kind,
				`600 artifact refs must be schema_mismatch, got ${JSON.stringify(overCount.failures)}`,
			).toBe('schema_mismatch');
			// Aggregate claimed bytes over 16 MiB (512 refs x 32 MiB each).
			const huge = Array.from({ length: 512 }, () => ({
				path: 'a.json',
				sha256: '0'.repeat(64),
				bytes: 32 * 1024 * 1024,
			}));
			const withHuge = { ...base, artifacts: huge };
			const hugeRecord = {
				...withHuge,
				receipt_hash: computeReceiptHash(withHuge),
			};
			fs.writeFileSync(receiptFile, JSON.stringify(hugeRecord));
			const overBytes = verifyReceiptBundle({
				receiptFile,
				artifactRoot: artifactsDir,
			});
			expect(overBytes.failures[0]?.kind).toBe('schema_mismatch');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('FB-006: hostile JSON nesting yields a typed failure, not an escaping RangeError', async () => {
		const dir = makeDir('r2-fb006-deep-');
		try {
			const bundleDir = path.join(dir, 'bundle');
			fs.mkdirSync(path.join(bundleDir, 'artifacts'), { recursive: true });
			// 40k-deep nested array as an UNKNOWN extra field (schema pass
			// ignores unknowns; the RAW-object canonicalizer must not overflow).
			const deep = '['.repeat(40_000) + ']'.repeat(40_000);
			const receiptText = `{"format_version":"1.0.0","kind":"task","unit_id":"1.1","generated_at":"${STATIC_TIME}","plugin_version":"x","snapshot":{},"gates":[],"artifacts":[],"deep":${deep},"receipt_hash":"${'0'.repeat(64)}"}`;
			const receiptFile = path.join(bundleDir, 'receipt.json');
			fs.writeFileSync(receiptFile, receiptText);
			const result = verifyReceiptBundle({
				receiptFile,
				artifactRoot: path.join(bundleDir, 'artifacts'),
			});
			expect(result.ok).toBe(false);
			expect(['corrupt_json', 'schema_mismatch']).toContain(
				result.failures[0]?.kind,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('FB-007/016: strict tool invocation shapes — any emission field with verify fails; empty verify refused', async () => {
		const dir = makeDir('r2-fb007-shapes-');
		try {
			const call = async (args: Record<string, unknown>): Promise<string> => {
				const outcome = await receiptTool.execute(args, {
					directory: dir,
				} as never);
				return typeof outcome === 'string' ? outcome : JSON.stringify(outcome);
			};
			expect(await call({ verify: 'x', export: true })).toContain(
				'mutually exclusive',
			);
			expect(await call({ verify: 'x', unit: 'task' })).toContain(
				'mutually exclusive',
			);
			expect(await call({ verify: 'x', id: '1' })).toContain(
				'mutually exclusive',
			);
			expect(await call({ verify: '   ' })).toContain('must not be empty');
			expect(await call({ unit: 'phase' })).toContain('provide either');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('FB-007 CLI: the verify arm rejects trailing emission arguments', async () => {
		const dir = makeDir('r2-fb007-cli-');
		try {
			const outcome = await handleReceiptCommand(dir, [
				'--verify',
				path.join(dir, 'missing-bundle'),
				'--export',
			]);
			expect(outcome).toBeObject();
			expect((outcome as { exitCode?: number }).exitCode).toBe(1);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('FB-021: relative verify targets resolve against the injected project directory', () => {
		const base = canonicalMkdtemp('r2-fb021-');
		try {
			fs.mkdirSync(path.join(base, 'bundle', 'artifacts'), {
				recursive: true,
			});
			fs.writeFileSync(path.join(base, 'bundle', 'receipt.json'), '{}');
			const resolved = resolveVerifyTarget('bundle', base);
			expect(resolved.receiptFile).toBe(
				path.join(base, 'bundle', 'receipt.json'),
			);
			expect(resolved.receiptFile.startsWith(process.cwd())).toBe(false);
		} finally {
			fs.rmSync(base, { recursive: true, force: true });
		}
	});
});
