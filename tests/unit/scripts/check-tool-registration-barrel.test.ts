import { describe, expect, test } from 'bun:test';
import {
	collectToolRegistrationErrors,
	findMissingBarrelExports,
	runToolRegistrationCli,
} from '../../../scripts/check-tool-registration.ts';
import { detectToolRegistrationDrift } from '../../../scripts/drift-check.ts';
import * as realBarrel from '../../../src/tools/index';
import { TOOL_NAMES } from '../../../src/tools/tool-metadata';

// Issue #1643 — barrel-export coherence (check #7 in check-tool-registration).
//
// Checks 1-6 validate metadata ⇔ manifest ⇔ plugin object ⇔ TOOL_NAMES ⇔
// AGENT_TOOL_MAP plus the reverse source→metadata scan (#1781 E4), but none
// of them import the src/tools/index.ts barrel that wiring and registration
// tests (tests/unit/tools/wiring-adversarial.test.ts,
// tests/unit/tools/check-gate-status-export.test.ts,
// tests/integration/declare-scope-registration.test.ts) consume. A tool missing its
// barrel export therefore passed drift-check. Check #7 closes that leg:
// every TOOL_NAMES entry must resolve to a DEFINED export of the barrel.
//
// The barrel is loaded (or injected) as a plain record so the
// deliberately-missing-export regression can run against a copy of the real
// barrel without mutating the working tree or mocking modules.

describe('check-tool-registration barrel: pure helper', () => {
	test('flags a name absent from the barrel', () => {
		expect(findMissingBarrelExports(['diff', 'lint'], { diff: {} })).toEqual([
			'lint',
		]);
	});

	test('a key present but undefined counts as missing', () => {
		// `export { x } from './x'` resolving to an undefined binding must
		// not count as an export.
		expect(
			findMissingBarrelExports(['checkpoint'], { checkpoint: undefined }),
		).toEqual(['checkpoint']);
	});

	test('a complete barrel yields no missing names', () => {
		expect(findMissingBarrelExports(['diff'], { diff: {}, extra: 1 })).toEqual(
			[],
		);
	});

	test('extra barrel exports are NOT flagged (aliases and helpers are legal)', () => {
		// The real barrel exports more keys than TOOL_NAMES has entries —
		// camelCase aliases (swarmApplyPatch), helper functions
		// (collect_lane_results), and type exports are intentional.
		expect(findMissingBarrelExports([], { anything: 1 })).toEqual([]);
	});

	test('empty tool list never fails, even with an empty barrel', () => {
		expect(findMissingBarrelExports([], {})).toEqual([]);
	});
});

describe('check-tool-registration barrel: real-tree + deliberately-missing export', () => {
	test('the real barrel covers every TOOL_NAMES entry', () => {
		expect(
			findMissingBarrelExports(
				TOOL_NAMES,
				realBarrel as unknown as Record<string, unknown>,
			),
		).toEqual([]);
	});

	test('collectToolRegistrationErrors passes on the real tree', () => {
		// Live regression guard: the current repo must stay coherent across
		// all checks including the new barrel leg.
		expect(collectToolRegistrationErrors()).toEqual([]);
	});

	test('a deliberately-missing barrel export fails the check (issue #1643)', () => {
		// Remove one export from a copy of the real barrel and inject it —
		// the collector must report exactly that tool. This is the
		// acceptance-criterion regression: before check #7, deleting any one
		// export line from src/tools/index.ts (e.g. `export { checkpoint }
		// from './checkpoint'`) left `bun run scripts/check-tool-registration.ts`
		// green. The victim below is TOOL_NAMES[0], whatever it currently is.
		const barrel: Record<string, unknown> = {
			...(realBarrel as unknown as Record<string, unknown>),
		};
		const victim = TOOL_NAMES[0] as string;
		delete barrel[victim];

		const errors = collectToolRegistrationErrors({ barrel });
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain(victim);
		expect(errors[0]).toContain('src/tools/index.ts');
	});

	test('an undefined-valued barrel export also fails the check', () => {
		const barrel: Record<string, unknown> = {
			...(realBarrel as unknown as Record<string, unknown>),
			[TOOL_NAMES[0] as string]: undefined,
		};
		const errors = collectToolRegistrationErrors({ barrel });
		expect(
			errors.some(
				(e) =>
					e.includes(TOOL_NAMES[0] as string) &&
					e.includes('src/tools/index.ts'),
			),
		).toBe(true);
	});
});

describe('check-tool-registration CLI — regression: exit code + success message (PRR-006)', () => {
	// Plain closure capture instead of bun:test spyOn: the spy mock-call API
	// changed shape across Bun versions (calls property vs calls()), and the
	// capture must silence CLI output on every Bun the repo tests.
	function captureConsole(): {
		errors: string[];
		logs: string[];
		restore: () => void;
	} {
		const errors: string[] = [];
		const logs: string[] = [];
		const originalError = console.error;
		const originalLog = console.log;
		console.error = (...args: unknown[]) => {
			errors.push(args.map(String).join(' '));
		};
		console.log = (...args: unknown[]) => {
			logs.push(args.map(String).join(' '));
		};
		return {
			errors,
			logs,
			restore: () => {
				console.error = originalError;
				console.log = originalLog;
			},
		};
	}

	function barrelWithoutFirstTool(): Record<string, unknown> {
		const barrel: Record<string, unknown> = {
			...(realBarrel as unknown as Record<string, unknown>),
		};
		delete barrel[TOOL_NAMES[0] as string];
		return barrel;
	}

	test('runToolRegistrationCli returns 1 and reports the violation for a missing export', () => {
		// Previous behavior: only the collector was under test, so the CLI's
		// exit-1 contract (the path CI actually gates on) had no coverage.
		const capture = captureConsole();
		try {
			expect(runToolRegistrationCli({ barrel: barrelWithoutFirstTool() })).toBe(
				1,
			);
			const victim = TOOL_NAMES[0] as string;
			expect(capture.errors.some((line) => line.includes(victim))).toBe(true);
			expect(
				capture.errors.some((line) =>
					line.includes('src/tools/index.ts barrel'),
				),
			).toBe(true);
		} finally {
			capture.restore();
		}
	});

	test('runToolRegistrationCli returns 0 and prints the barrel-coherent success line on the real tree', () => {
		const capture = captureConsole();
		try {
			expect(runToolRegistrationCli()).toBe(0);
			expect(capture.errors).toEqual([]);
			expect(
				capture.logs.some((line) =>
					line.includes('and the src/tools/index.ts barrel'),
				),
			).toBe(true);
		} finally {
			capture.restore();
		}
	});
});

describe('drift-check tool-registration detector — regression: negative propagation (PRR-004)', () => {
	test('detectToolRegistrationDrift surfaces a check-7 barrel error as a DriftFinding', () => {
		// Previous behavior: the detector accepted no options and its only test
		// asserted zero findings on the real tree, so a check-7 error that
		// failed to propagate through the wrapper would have gone undetected.
		const barrel: Record<string, unknown> = {
			...(realBarrel as unknown as Record<string, unknown>),
		};
		const victim = TOOL_NAMES[0] as string;
		delete barrel[victim];

		const findings = detectToolRegistrationDrift({ barrel });
		expect(findings).toHaveLength(1);
		expect(findings[0]?.category).toBe('tool');
		expect(findings[0]?.severity).toBe('error');
		expect(findings[0]?.message).toContain(victim);
	});
});
