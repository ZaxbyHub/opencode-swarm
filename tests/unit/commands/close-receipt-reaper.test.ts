import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { reapPlanExportReceiptBundles } from '../../../src/commands/close/clean-stage';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * FB-003 (swarm-pr-review PR #3550): the close plan-export sweep is the
 * reaper the retention registry's `verification-receipts` row cites as its
 * keyspaceBound. It must remove published receipt bundle directories and
 * crashed-export staging trees — while preserving non-matching entries
 * (SWARM_PLAN artifacts, foreign names) and never following a planted
 * symlink at a grammar-matching name.
 */

function makeExportDir(): string {
	const dir = canonicalMkdtemp('receipt-reaper-');
	fs.mkdirSync(path.join(dir, '.swarm', 'plan-export'), { recursive: true });
	return dir;
}

function touchBundle(dir: string, name: string): string {
	const target = path.join(dir, '.swarm', 'plan-export', name);
	fs.mkdirSync(target, { recursive: true });
	fs.writeFileSync(
		path.join(target, 'receipt.json'),
		JSON.stringify({ format_version: '1.0.0' }),
	);
	return target;
}

describe('close plan-export receipt-bundle reaper (FB-003)', () => {
	test('removes published bundles and staging residue, keeps everything else', async () => {
		const dir = makeExportDir();
		const warnings: string[] = [];
		try {
			const bundle = touchBundle(dir, 'receipt-phase-1-0123456789ab');
			const taskBundle = touchBundle(dir, 'receipt-task-1.1-abcdef012345');
			const staging = touchBundle(
				dir,
				'.receipt-phase-1-0123456789ac.tmp-4242-1730000000000',
			);
			// Non-grammar entries must survive untouched.
			fs.writeFileSync(
				path.join(dir, '.swarm', 'plan-export', 'SWARM_PLAN.json'),
				'{}',
			);
			const foreign = touchBundle(dir, 'receipt-not-a-bundle');
			fs.mkdirSync(path.join(dir, '.swarm', 'plan-export', 'evidence-x'));

			const removed = await reapPlanExportReceiptBundles(dir, (m) =>
				warnings.push(m),
			);
			expect(removed).toBe(3);
			expect(fs.existsSync(bundle)).toBe(false);
			expect(fs.existsSync(taskBundle)).toBe(false);
			expect(fs.existsSync(staging)).toBe(false);
			expect(
				fs.existsSync(
					path.join(dir, '.swarm', 'plan-export', 'SWARM_PLAN.json'),
				),
			).toBe(true);
			expect(fs.existsSync(foreign)).toBe(true);
			expect(warnings).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('a planted symlink at a grammar-matching name is preserved, never followed or deleted through', async () => {
		const dir = makeExportDir();
		const outside = canonicalMkdtemp('receipt-reaper-outside-');
		const warnings: string[] = [];
		try {
			// A real directory outside the project masquerading under a
			// bundle-shaped name via symlink — deletion must refuse to recurse
			// through the link (same containment doctrine as the write sinks).
			fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep me');
			fs.symlinkSync(
				outside,
				path.join(dir, '.swarm', 'plan-export', 'receipt-phase-1-000000000000'),
				'junction',
			);
			const removed = await reapPlanExportReceiptBundles(dir, (m) =>
				warnings.push(m),
			);
			expect(removed).toBe(0);
			expect(fs.existsSync(path.join(outside, 'precious.txt'))).toBe(true);
			expect(warnings.some((w) => w.includes('Preserved symlinked'))).toBe(
				true,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	test('absent plan-export directory is a silent no-op', async () => {
		const dir = canonicalMkdtemp('receipt-reaper-missing-');
		try {
			const warnings: string[] = [];
			const removed = await reapPlanExportReceiptBundles(dir, (m) =>
				warnings.push(m),
			);
			expect(removed).toBe(0);
			expect(warnings).toEqual([]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
