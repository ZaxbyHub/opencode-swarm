/**
 * PR 3920 closeout (SolCritic F-019/F-020): the changes arm of the markerless
 * gate's presence check is budget-bounded and incremental (hasAnySubdirUnder),
 * so a changes layout that the bounded walk cannot classify blocks as
 * retryable ("could not be scanned"), never as deletion. F-020 replaces the
 * duplicated precheck with ONE gate-owned budget of 2,000 total
 * directory-entry visits shared across the current-specs scan, the changes
 * listing, every change's nested specs scan, Spec-Kit detection, and the
 * presence fallback: exhaustion anywhere on that path is a retryable block
 * with scan-specific guidance — never a partial hash, deletion, or admission.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { enforceSpecDriftGate } from '../../../src/hooks/guardrails';
import {
	readEffectiveSpecSync,
	withSpecScanBudget,
} from '../../../src/sdd/effective-spec';
import { detectUnmarkedSpecDriftSync } from '../../../src/utils/spec-hash';

const hashOf = (content: string): string =>
	createHash('sha256').update(content, 'utf-8').digest('hex');

function writePlan(dir: string, specHash: string): void {
	fsSync.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Pair Plan',
			swarm: 'test-swarm',
			current_phase: 1,
			phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
			migration_status: 'native',
			specHash,
		}),
	);
}

describe('changes-arm gate cases (PR 3920 closeout, SolCritic F-019/F-020)', () => {
	let pairDir: string;

	beforeEach(async () => {
		pairDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spec-drift-chg-'));
		await fs.mkdir(path.join(pairDir, '.swarm'), { recursive: true });
	});

	afterEach(async () => {
		try {
			await fs.rm(pairDir, { recursive: true, force: true });
		} catch {
			// best effort
		}
	});

	test('an over-budget change-dir layout blocks as retryable before the projection read (F-020)', () => {
		// 2010 change DIRECTORIES exceed the pre-check budget: the gate must block
		// as retryable BEFORE entering the reader's unbounded change scan.
		for (let i = 0; i < 2010; i++) {
			fsSync.mkdirSync(path.join(pairDir, 'openspec', 'changes', `c${i}`), {
				recursive: true,
			});
			fsSync.writeFileSync(
				path.join(pairDir, 'openspec', 'changes', `c${i}`, 'proposal.md'),
				'# Proposal.\n',
			);
		}
		writePlan(pairDir, hashOf('# Spec\n\nGone.\n'));

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(
			/could not be scanned/,
		);
	});

	test('a walk-budget overrun in the changes tree blocks as retryable, not deletion', () => {
		// 2010 change FILES (no subdirs) exhaust the changes walk budget with no
		// source found: presence is UNKNOWN, which must block as retryable with the
		// scan-specific reason, never as deletion.
		fsSync.mkdirSync(path.join(pairDir, 'openspec', 'changes'), {
			recursive: true,
		});
		for (let i = 0; i < 2010; i++) {
			fsSync.writeFileSync(
				path.join(pairDir, 'openspec', 'changes', `f${i}.md`),
				'x',
			);
		}
		writePlan(pairDir, hashOf('# Spec\n\nGone.\n'));

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(
			/could not be scanned/,
		);
	});

	test('a wide nested markdown-free openspec/specs tree blocks as retryable (F-020 shared budget)', () => {
		// 30 top-level dirs x 70 nested subdirs = 2100 nested directories, no .md
		// anywhere, and an EMPTY changes tree. The old duplicated precheck only
		// counted the changes directory, so this layout slipped past it and the
		// reader's current-specs walk ran unbudgeted. The shared budget must bound
		// that walk itself and surface as a retryable block with the
		// scan-specific reason, never as a deletion verdict from a truncated scan.
		for (let i = 0; i < 30; i++) {
			for (let j = 0; j < 70; j++) {
				fsSync.mkdirSync(
					path.join(
						pairDir,
						'openspec',
						'specs',
						`t${String(i).padStart(2, '0')}`,
						`n${String(j).padStart(2, '0')}`,
					),
					{ recursive: true },
				);
			}
		}
		writePlan(pairDir, hashOf('# Spec\n\nGone.\n'));

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(
			/could not be scanned/,
		);
	});

	test('cumulative exhaustion across individually bounded scans blocks as retryable (F-020)', () => {
		// 700 specs entries + 700 change dirs + 700 change-spec entries: every
		// scan is individually far under the 2,000-entry budget but the total
		// (2,100) exceeds it, so the SHARED budget must abort as retryable. A
		// budget reset between scans (or per-scanner reinitialization) would
		// complete every scan and classify the null projection as deletion or
		// projection failure instead of the scan-specific retryable block.
		for (let i = 0; i < 700; i++) {
			fsSync.mkdirSync(path.join(pairDir, 'openspec', 'specs', `d${i}`), {
				recursive: true,
			});
		}
		for (let i = 0; i < 700; i++) {
			fsSync.mkdirSync(
				path.join(pairDir, 'openspec', 'changes', `c${i}`, 'specs', 's'),
				{ recursive: true },
			);
		}
		writePlan(pairDir, hashOf('# Spec\n\nGone.\n'));

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(
			/could not be scanned/,
		);
	});

	test('a small valid openspec layout still admits through the budgeted gate (under-budget parity)', () => {
		// Far under the budget: the projection read must produce the SAME
		// content and hash order as before the refactor, so a plan bound to the
		// projected hash still admits.
		fsSync.mkdirSync(path.join(pairDir, 'openspec', 'specs', 'core'), {
			recursive: true,
		});
		fsSync.writeFileSync(
			path.join(pairDir, 'openspec', 'specs', 'core', 'spec.md'),
			'### Requirement: Core\n\nSystem MUST stay consistent.\n',
		);
		const projected = readEffectiveSpecSync(pairDir);
		expect(projected).not.toBeNull();
		writePlan(pairDir, hashOf(projected?.content ?? ''));

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).not.toThrow();
	});

	test('real markerless drift still block-drifts with the pre-refactor reason (under-budget parity)', () => {
		// Same small layout with a stale stored hash: the drift classification
		// must keep the exact pre-refactor reason, pinning hash/order parity of
		// the budgeted projection read against the unbudgeted one.
		fsSync.mkdirSync(path.join(pairDir, 'openspec', 'specs', 'core'), {
			recursive: true,
		});
		fsSync.writeFileSync(
			path.join(pairDir, 'openspec', 'specs', 'core', 'spec.md'),
			'### Requirement: Core\n\nSystem MUST stay consistent.\n',
		);
		writePlan(pairDir, hashOf('# Spec\n\nOld obligations.\n'));

		expect(() => enforceSpecDriftGate(pairDir, 'save_plan')).toThrow(
			'effective spec has been modified since the plan was saved (no staleness marker present)',
		);
	});

	test('an exhausted shared budget surfaces as retryable, never as drift from truncated input', () => {
		// 60 feature dirs x (1 dir entry + 1 spec.md entry) = 120 charged
		// visits; a budget of half that size must abort the scan as retryable.
		// A truncated-listing implementation (sorting and hashing the prefix
		// collected before exhaustion) would instead resolve a partial
		// projection and classify as drift — the pinned failure mode.
		for (let i = 0; i < 60; i++) {
			const dir = path.join(
				pairDir,
				'openspec',
				'specs',
				`f${String(i).padStart(2, '0')}`,
			);
			fsSync.mkdirSync(dir, { recursive: true });
			fsSync.writeFileSync(
				path.join(dir, 'spec.md'),
				`### Requirement: R${i}\n\nSystem MUST do ${i}.\n`,
			);
		}
		writePlan(pairDir, hashOf('# Spec\n\nOld obligations.\n'));

		const verdict = withSpecScanBudget(100, () =>
			detectUnmarkedSpecDriftSync(pairDir),
		);
		expect(verdict.outcome).toBe('block-retry');
		if (verdict.outcome === 'block-retry') {
			expect(verdict.reason).toBe(
				'the openspec projection source could not be scanned; retry',
			);
		}
	});
});
