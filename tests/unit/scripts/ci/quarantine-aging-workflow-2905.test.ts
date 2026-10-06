/**
 * Quarantine aging workflow + routing tests (issue #2905, Workstream I8).
 *
 * Pins the workflow shape (weekly cron + workflow_dispatch + issues:write +
 * the census step, SHA-pinned actions, no ${{ }} inside run:) and the pure
 * decideAgingAction routing core: dedup by title prefix + github-actions[bot]
 * author, close-at-zero, duplicate closes, and the dry-run printed-line
 * contract frozen by check C4. All clocks use Date.UTC.
 */
import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { load } from 'js-yaml';
import {
	decideAgingAction,
	type ExistingIssue,
} from '../../../../scripts/ci/quarantine-aging';
import {
	buildQuarantineCensus,
	DEFAULT_QUARANTINE_LEDGERS,
	type QuarantineLedgerContent,
} from '../../../../scripts/ci/quarantine-census';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const REPO_ROOT = path.resolve(import.meta.dir, '../../../..');
const WORKFLOW_PATH = path.join(
	REPO_ROOT,
	'.github',
	'workflows',
	'quarantine-aging.yml',
);
const NOW = new Date(Date.UTC(2026, 9, 3));

function censusWithExpiring(
	expiry: string,
): ReturnType<typeof buildQuarantineCensus> {
	const contents: QuarantineLedgerContent[] = DEFAULT_QUARANTINE_LEDGERS.map(
		(ledger, index) => ({
			ledger,
			content:
				index === 0
					? [
							'# fixture',
							'# OWNER: @a — #2973',
							`# EXPIRY: ${expiry} — x`,
							'tests/unit/aging.test.ts',
						].join('\n')
					: '# empty\n',
		}),
	);
	return buildQuarantineCensus(contents, NOW);
}

function botIssue(title: string, number: number): ExistingIssue {
	return { number, title, author: { login: 'github-actions[bot]' } };
}

describe('decideAgingAction', () => {
	test('n=0 with no adopted issue -> close action (no-op when none exists)', () => {
		// EXPIRY 2026-12-01 is 59 days out: nothing expires within 21 days.
		const decision = decideAgingAction(censusWithExpiring('2026-12-01'), []);
		expect(decision.n).toBe(0);
		expect(decision.action).toBe('close');
		expect(decision.adopted).toEqual([]);
		expect(decision.title).toBe(
			'Quarantine aging: 0 entries expire within 21 days',
		);
	});

	test('n=0 with adopted issues -> close every adopted tracking issue', () => {
		const decision = decideAgingAction(censusWithExpiring('2026-12-01'), [
			botIssue('Quarantine aging: 2 entries expire within 21 days', 11),
			botIssue('Quarantine aging: 1 entries expire within 21 days', 12),
		]);
		expect(decision.action).toBe('close');
		expect(decision.adopted.map((i) => i.number)).toEqual([11, 12]);
	});

	test('n>0 with no adopted issue -> open', () => {
		// EXPIRY 2026-10-10 is 7 days out: within the 21-day window.
		const decision = decideAgingAction(censusWithExpiring('2026-10-10'), []);
		expect(decision.action).toBe('open');
		expect(decision.title).toBe(
			'Quarantine aging: 1 entries expire within 21 days',
		);
	});

	test('n>0 with an adopted issue -> update (comment + retitle to the new count)', () => {
		const decision = decideAgingAction(censusWithExpiring('2026-10-10'), [
			botIssue('Quarantine aging: 3 entries expire within 21 days', 21),
		]);
		expect(decision.action).toBe('update');
		expect(decision.title).toBe(
			'Quarantine aging: 1 entries expire within 21 days',
		);
	});

	test('human-authored same-title issue is never adopted', () => {
		const human: ExistingIssue = {
			number: 99,
			title: 'Quarantine aging: 1 entries expire within 21 days',
			author: { login: 'zaxbysauce' },
		};
		const decision = decideAgingAction(censusWithExpiring('2026-10-10'), [
			human,
		]);
		expect(decision.adopted).toEqual([]);
		expect(decision.action).toBe('open');
	});

	test('bot issue with a different title prefix is not adopted', () => {
		const other = botIssue('Auto-detected flaky tests (merge-group)', 5);
		const decision = decideAgingAction(censusWithExpiring('2026-10-10'), [
			other,
		]);
		expect(decision.adopted).toEqual([]);
	});
});

describe('quarantine-aging dry-run printed-line contract (frozen by check C4)', () => {
	test('decision vocabulary is exactly open|update|close (no "none")', () => {
		// The frozen C4 regex is ^decision: (open|update|close|open-or-update);
		// pin the vocabulary through the PRODUCTION decision core so a mutant
		// returning 'none' fails here (review PRR-026: regex-vs-literal
		// assertions cannot fail).
		expect(decideAgingAction(censusWithExpiring('2026-12-01'), []).action).toBe(
			'close',
		);
		expect(decideAgingAction(censusWithExpiring('2026-10-10'), []).action).toBe(
			'open',
		);
		const adopted = botIssue(
			'Quarantine aging: 1 entries expire within 21 days',
			21,
		);
		expect(
			decideAgingAction(censusWithExpiring('2026-10-10'), [adopted]).action,
		).toBe('update');
		// And the printed form for the real tree today stays inside C4's regex.
		const decision = decideAgingAction(censusWithExpiring('2026-12-01'), []);
		expect(`decision: ${decision.action}`).toMatch(
			/^decision: (open|update|close|open-or-update)$/,
		);
	});

	test('aging line form', () => {
		const decision = decideAgingAction(censusWithExpiring('2026-10-10'), []);
		expect(`aging: n=${decision.n}`).toBe('aging: n=1');
	});
});

describe('quarantine-aging.yml workflow shape', () => {
	interface WorkflowShape {
		on?: {
			schedule?: { cron?: string }[];
			workflow_dispatch?: {
				inputs?: Record<string, { description?: string; type?: string }>;
			};
		};
		permissions?: Record<string, string>;
		jobs?: Record<
			string,
			{
				permissions?: Record<string, string>;
				'timeout-minutes'?: number;
				steps?: {
					uses?: string;
					run?: string;
					name?: string;
					with?: Record<string, unknown>;
				}[];
			}
		>;
	}

	function loadWorkflow(): WorkflowShape {
		const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
		return load(raw) as WorkflowShape;
	}

	test('weekly schedule + workflow_dispatch with the dry_run input', () => {
		const wf = loadWorkflow();
		expect(wf.on?.schedule?.[0]?.cron).toBe('0 12 * * 1');
		expect(wf.on?.workflow_dispatch).toBeTruthy();
		// PRR-023: the dry_run input is load-bearing (it is the only thing
		// mapping a dispatch onto --dry-run); pin its presence explicitly.
		expect(wf.on?.workflow_dispatch?.inputs?.dry_run).toBeTruthy();
	});

	test('workflow and job permissions are least-privilege', () => {
		const wf = loadWorkflow();
		expect(wf.permissions?.contents).toBe('read');
		const job = wf.jobs?.aging;
		expect(job?.permissions?.contents).toBe('read');
		expect(job?.permissions?.issues).toBe('write');
	});

	test('aging job is time-bounded (PRR-037)', () => {
		const wf = loadWorkflow();
		expect(wf.jobs?.aging?.['timeout-minutes']).toBe(15);
	});

	test('checkout fetches full history for the trend (PRR-010)', () => {
		const wf = loadWorkflow();
		const checkout = (wf.jobs?.aging?.steps ?? []).find((s) =>
			s.uses?.startsWith('actions/checkout'),
		);
		expect(checkout?.with?.['fetch-depth']).toBe(0);
		expect(checkout?.with?.['persist-credentials']).toBe(false);
	});

	test('aging job carries issues: write permission and a census step', () => {
		const wf = loadWorkflow();
		const job = wf.jobs?.aging;
		expect(job).toBeTruthy();
		expect(job?.permissions?.issues).toBe('write');
		const runs = (job?.steps ?? []).map((s) => `${s.run ?? ''}`).join('\n');
		expect(runs).toContain('scripts/ci/quarantine-aging.ts');
	});

	test('actions are SHA-pinned and no ${{ }} appears inside run blocks', () => {
		const raw = fs.readFileSync(WORKFLOW_PATH, 'utf8');
		const wf = load(raw) as WorkflowShape;
		// Pin equality, not just shape: the checkout/setup-bun pins must equal
		// the repo-standard pins (the ones every other workflow here uses and
		// GitHub resolves) — a 40-hex typo passes a shape regex but ships a
		// dead workflow (reviewer R1).
		const standard = fs.readFileSync(
			path.join(REPO_ROOT, '.github', 'workflows', 'host-contract-check.yml'),
			'utf8',
		);
		const standardPin = (action: string): string => {
			const match = standard.match(new RegExp(`${action}@([0-9a-f]{40})`));
			return match?.[1] ?? '';
		};
		for (const step of wf.jobs?.aging?.steps ?? []) {
			if (step.uses) {
				expect(step.uses).toMatch(/@[0-9a-f]{40}/);
				const name = step.uses.split('@')[0] ?? '';
				const expected = standardPin(name);
				if (expected !== '') {
					expect(step.uses).toBe(`${name}@${expected}`);
				}
			}
			if (step.run) {
				expect(step.run).not.toContain('${{');
			}
		}
	});
});

describe('quarantine-aging dry-run CLI (single decision source, reviewer R2-1/M6)', () => {
	test('CLI --dry-run prints decision: close at n=0 through decideAgingAction', () => {
		const root = canonicalMkdtemp('q-aging-cli-');
		try {
			const script = path.resolve(
				import.meta.dir,
				'../../../../scripts/ci/quarantine-aging.ts',
			);
			const result = spawnSync(
				process.execPath,
				[script, '--dry-run', '--root', root],
				{ encoding: 'utf8', timeout: 60_000 },
			);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain('aging: n=0');
			expect(result.stdout).toContain('decision: close');
			expect(result.stdout).toContain(
				'Quarantine aging: 0 entries expire within 21 days',
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 90_000);

	test('CLI --dry-run prints decision: open when an entry expires within 21 days', () => {
		const root = canonicalMkdtemp('q-aging-cli-');
		try {
			fs.mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true });
			for (const ledger of DEFAULT_QUARANTINE_LEDGERS) {
				fs.writeFileSync(
					path.join(root, ...ledger.split('/')),
					ledger.endsWith('quarantined-tests.txt')
						? [
								'# fixture',
								'# OWNER: @a — #2973',
								// EXPIRY 3 days after the fixed --now anchor (2099-01-01):
								// inside the 21-day window by construction.
								'# EXPIRY: 2099-01-04 — x',
								'tests/unit/aging.test.ts',
							].join('\n')
						: '# empty\n',
				);
			}
			const script = path.resolve(
				import.meta.dir,
				'../../../../scripts/ci/quarantine-aging.ts',
			);
			const result = spawnSync(
				process.execPath,
				[script, '--dry-run', '--root', root, '--now', '2099-01-01'],
				{ encoding: 'utf8', timeout: 60_000 },
			);
			expect(result.status).toBe(0);
			expect(result.stdout).toContain('aging: n=1');
			expect(result.stdout).toContain('decision: open');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	}, 90_000);
});
