/**
 * PR 3920 closeout (SolCritic F-019): the changes arm of the markerless gate's
 * presence check is budget-bounded and incremental (hasAnySubdirUnder), so a
 * changes layout that the bounded walk cannot classify blocks as retryable
 * ("could not be scanned"), never as deletion. A suppressed two-source
 * projection (Spec-Kit plus openspec changes, no native spec) is a projection
 * failure and also blocks as retryable.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { enforceSpecDriftGate } from '../../../src/hooks/guardrails';

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

describe('changes-arm gate cases (PR 3920 closeout, SolCritic F-019)', () => {
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
});
