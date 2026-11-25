/**
 * Issue #3836 D3 — render neutralization at the mutation-path surfaces:
 *   - doctor --quarantine-residue PRESERVED list (entry line),
 *   - doctor --rollback-residue-quarantine skip reporting (command contract),
 *   - close preserved-residue warning + the text persisted into
 *     .swarm/close-summary.md,
 *   - close dry-run ARCHIVE CANDIDATE list (entry line).
 *
 * DEL (0x7F) is the control byte creatable in a Win32 file name; each leg
 * asserts the rendered ENTRY LINE (not the whole multiline output) carries no
 * raw control byte, and that the fixture name survives as exactly one line.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
	existsSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { runFinalizeDryRun } from '../../../src/commands/close/dry-run';
import { handleDoctorCommand } from '../../../src/commands/doctor';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader.js';
import { initLedger } from '../../../src/plan/ledger.js';
import { derivePlanId } from '../../../src/plan/utils.js';
import { _internals as residueInternals } from '../../../src/services/swarm-residue';
import { installCloseCommandMocks } from '../../helpers/close-command-mocks';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const DEL = String.fromCharCode(0x7f);
const CONTROL_BYTE = /[\u0000-\u001f\u007f-\u009f]/;

installCloseCommandMocks();

const { handleCloseCommand } = await import('../../../src/commands/close.js');
const { _internals: swarmResidueInternals } = await import(
	'../../../src/services/swarm-residue.js'
);

const realQueryTracked = residueInternals.queryTracked;

afterEach(() => {
	residueInternals.queryTracked = realQueryTracked;
});

describe('doctor preserved list renders a neutralized name (#3836 D3)', () => {
	test('the preserved entry line carries no raw control byte', async () => {
		const projectDir = canonicalMkdtemp('residue-render-doctor-preserved-');
		const swarmDir = path.join(projectDir, '.swarm');
		mkdirSync(swarmDir, { recursive: true });
		residueInternals.queryTracked = () => ({ tracked: new Set<string>() });
		try {
			// RECENT residue (age < 30m) → PRESERVED, rendered by the doctor's
			// preserved list. The basename carries a DEL byte.
			const poisonedName = `evil${DEL}-context.md.tmp.1710000000.abcdef`;
			writeFileSync(
				path.join(swarmDir, poisonedName),
				'fresh payload',
				'utf-8',
			);

			const out = await handleDoctorCommand(projectDir, [
				'--quarantine-residue',
			]);

			expect(out).toContain('Preserved in place');
			const entryLine = out.split('\n').find((l) => l.includes('evil'));
			expect(entryLine).not.toBeUndefined();
			expect(entryLine).toContain('evil');
			expect(entryLine).toContain('context.md.tmp.1710000000.abcdef');
			// The rendered ENTRY LINE (the untrusted name segment) is clean.
			expect(CONTROL_BYTE.test(entryLine ?? '')).toBe(false);
			// The name's own control byte did not inject extra lines.
			expect(out.split('\n').filter((l) => l.includes('evil'))).toHaveLength(1);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});
});

describe('doctor rollback output reports skipped entries (#3836 command contract)', () => {
	test('a poisoned manifest entry renders as a skip line, not a whole-call failure', async () => {
		const projectDir = canonicalMkdtemp('residue-render-doctor-rollback-');
		const swarmDir = path.join(projectDir, '.swarm');
		const batchId = 'batch-render';
		const batchAbs = path.join(swarmDir, 'quarantine', batchId);
		mkdirSync(batchAbs, { recursive: true });
		residueInternals.queryTracked = () => ({ tracked: new Set<string>() });
		try {
			// Valid entry (stored copy present).
			const validRel = 'nested/valid.tmp.txt';
			mkdirSync(path.join(batchAbs, 'nested'), { recursive: true });
			writeFileSync(
				path.join(batchAbs, 'nested', 'valid.tmp.txt'),
				'payload',
				'utf-8',
			);
			// Poisoned entry: LF inside original_rel_path.
			writeFileSync(path.join(batchAbs, 'poison-copy.bin'), 'x', 'utf-8');
			const manifest = {
				schema_version: 1,
				batch_id: batchId,
				created_at: new Date().toISOString(),
				trigger: 'test',
				entries: [
					{
						original_rel_path: validRel,
						stored_rel_path: `quarantine/${batchId}/nested/valid.tmp.txt`,
						sha256: 'irrelevant',
						bytes: 7,
						mtime_ms: 0,
						grammar_id: 'target-suffix-tmp-num-alnum',
						reason: 'stale-atomic-write-temp',
					},
					{
						original_rel_path: 'poison\ninjected.tmp.txt',
						stored_rel_path: `quarantine/${batchId}/poison-copy.bin`,
						sha256: 'irrelevant',
						bytes: 1,
						mtime_ms: 0,
						grammar_id: 'target-suffix-tmp-num-alnum',
						reason: 'stale-atomic-write-temp',
					},
				],
			};
			writeFileSync(
				path.join(batchAbs, 'manifest.json'),
				JSON.stringify(manifest),
				'utf-8',
			);

			const out = await handleDoctorCommand(projectDir, [
				'--rollback-residue-quarantine',
			]);

			expect(out).toContain('Residue Quarantine Rollback');
			expect(out).toContain('1 restored');
			expect(out).not.toContain('rollback failed');
			expect(out.toLowerCase()).toContain('skip');
			// Exactly ONE line names the poisoned entry; it carries the skip
			// wording and no control bytes.
			const entryLines = out.split('\n').filter((l) => l.includes('poison'));
			expect(entryLines).toHaveLength(1);
			expect(entryLines[0]?.toLowerCase()).toContain('skip');
			expect(CONTROL_BYTE.test(entryLines[0] ?? '')).toBe(false);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});
});

describe('close preserved-residue warning + close-summary.md are neutralized (#3836 D3)', () => {
	let testDir: string;

	beforeEach(() => {
		testDir = canonicalMkdtemp('residue-render-close-');
		void loadDatabaseCtor;
	});

	afterEach(() => {
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			/* best-effort cleanup */
		}
	});

	async function runCloseWithPoisonedResidue(): Promise<string> {
		const realQueryTracked = swarmResidueInternals.queryTracked;
		swarmResidueInternals.queryTracked = () => ({
			tracked: new Set<string>(),
		});
		try {
			const plan = {
				title: 'Residue render neutralization project',
				schema_version: '1.0.0',
				swarm: 'lowtier',
				current_phase: 1,
				phases: [
					{
						id: 1,
						name: 'Phase 1',
						status: 'in_progress',
						tasks: [
							{
								id: '1.1',
								phase: 1,
								status: 'in_progress',
								size: 'small',
								description: 'Task A',
								depends: [],
								files_touched: [],
							},
						],
					},
				],
			};
			const swarmDir = path.join(testDir, '.swarm');
			mkdirSync(swarmDir, { recursive: true });
			writeFileSync(path.join(swarmDir, 'plan.json'), JSON.stringify(plan));
			await initLedger(testDir, derivePlanId(plan), undefined, plan);
			// RECENT residue → PRESERVED; basename carries a DEL byte.
			const poisonedName = `evil${DEL}-context.md.tmp.1710000000.abcdef`;
			writeFileSync(
				path.join(swarmDir, poisonedName),
				'fresh residue payload',
				'utf-8',
			);
			return await handleCloseCommand(testDir, []);
		} finally {
			swarmResidueInternals.queryTracked = realQueryTracked;
		}
	}

	test('the operator-visible warning names the entry on one clean line', async () => {
		const output = await runCloseWithPoisonedResidue();
		expect(output).toContain('Preserved');
		const warnLine = output.split('\n').find((l) => l.includes('evil'));
		expect(warnLine).not.toBeUndefined();
		expect(warnLine).toContain('context.md.tmp.1710000000.abcdef');
		expect(CONTROL_BYTE.test(warnLine ?? '')).toBe(false);
		expect(output.includes(DEL)).toBe(false);
		expect(output.split('\n').filter((l) => l.includes('evil'))).toHaveLength(
			1,
		);
	});

	test('the persisted close-summary.md names the entry on one clean line', async () => {
		await runCloseWithPoisonedResidue();
		const summaryPath = path.join(testDir, '.swarm', 'close-summary.md');
		expect(existsSync(summaryPath)).toBe(true);
		const summary = readFileSync(summaryPath, 'utf-8');
		expect(summary).toContain('evil');
		const summaryLine = summary.split('\n').find((l) => l.includes('evil'));
		expect(summaryLine).not.toBeUndefined();
		expect(summaryLine).toContain('context.md.tmp.1710000000.abcdef');
		expect(CONTROL_BYTE.test(summaryLine ?? '')).toBe(false);
		expect(summary.includes(DEL)).toBe(false);
		expect(summary.split('\n').filter((l) => l.includes('evil'))).toHaveLength(
			1,
		);
	});
});

describe('close dry-run archive candidate list is neutralized (#3836 D3)', () => {
	test('the post-mortem candidate line carries no raw control byte', async () => {
		const projectDir = canonicalMkdtemp('residue-render-dryrun-');
		const swarmDir = path.join(projectDir, '.swarm');
		mkdirSync(swarmDir, { recursive: true });
		try {
			const poisonedName = `post-mortem-evil${DEL}.md`;
			writeFileSync(path.join(swarmDir, poisonedName), '# post mortem\n');

			const report = await runFinalizeDryRun(
				projectDir,
				swarmDir,
				{ phases: [] } as never,
				false,
			);

			expect(report).toContain('Would archive');
			const candLine = report
				.split('\n')
				.find((l) => l.includes('post-mortem-evil'));
			expect(candLine).not.toBeUndefined();
			expect(candLine?.trim()).toBe('- post-mortem-evil.md');
			expect(CONTROL_BYTE.test(candLine ?? '')).toBe(false);
			expect(report.includes(DEL)).toBe(false);
			expect(
				report.split('\n').filter((l) => l.includes('post-mortem-evil')),
			).toHaveLength(1);
		} finally {
			rmSync(projectDir, { recursive: true, force: true });
		}
	});
});
