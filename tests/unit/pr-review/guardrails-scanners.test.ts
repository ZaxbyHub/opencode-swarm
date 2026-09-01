import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
	type GuardrailSource,
	scanObserverTerminalization,
	scanParallelCircuitRuleConstruction,
} from '../../../src/pr-review/guardrails.js';

const ROOT = process.cwd();

/** Collect every TypeScript source under src/ (skips node_modules/dist). */
function collectSources(dir = join(ROOT, 'src')): GuardrailSource[] {
	const out: GuardrailSource[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		if (statSync(full).isDirectory()) {
			out.push(...collectSources(full));
			continue;
		}
		if (!entry.endsWith('.ts')) continue;
		out.push({
			path: relative(ROOT, full).replaceAll('\\', '/'),
			content: readFileSync(full, 'utf8'),
		});
	}
	return out;
}

describe('guardrail scanners bite on synthetic anti-patterns (issue #2385)', () => {
	test('observer-terminalizer scanner flags the historical symbols', () => {
		const hits = scanObserverTerminalization([
			{
				path: 'src/tools/dispatch-lanes.ts',
				content: 'finalizePrReviewWaitDeadlineLanes(directory, lanes);',
			},
		]);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.rule).toContain('observer-terminalizer-symbol');
	});

	test('observer scanner flags a delegation write outside the sanctioned functions', () => {
		const hits = scanObserverTerminalization([
			{
				path: 'src/tools/dispatch-lanes.ts',
				content: [
					'async function executeCollectLaneResults() {',
					'\tawait appendDelegationTransition(dir, id, { status: "error" });',
					'}',
				].join('\n'),
			},
		]);
		expect(hits).toHaveLength(1);
		expect(hits[0]?.rule).toBe(
			'observer-delegation-write-outside-allowlist:executeCollectLaneResults',
		);
	});

	test('observer scanner allows the sanctioned settlement functions', () => {
		const hits = scanObserverTerminalization([
			{
				path: 'src/tools/dispatch-lanes.ts',
				content: [
					'async function settleCollectedLane() {',
					'\tawait appendDelegationTransition(dir, id, { status: "completed" });',
					'}',
					'async function sweepStaleAsyncLaneRecords() {',
					'\tawait appendDelegationTransition(dir, id, { status: "stale" });',
					'}',
				].join('\n'),
			},
		]);
		expect(hits).toHaveLength(0);
	});

	test('parallel-rule scanner flags the pre-#2385 inline circuit construction', () => {
		// Verbatim shape of the removed pr-workflow-gate.ts:4916-4939 pattern.
		const hits = scanParallelCircuitRuleConstruction([
			{
				path: 'src/hooks/pr-workflow-gate.ts',
				content: [
					'nextResilience = {',
					'\tpolicy: snapshot,',
					'\tattempts: [],',
					'\tcircuit: {',
					'\t\tversion: 2,',
					"\t\tstate: 'CLOSED',",
					'\t\tgeneration: previousGeneration + 1,',
					'\t\tcontributors: [],',
					'\t\tevidenceWaterline: isoNow(),',
					'\t},',
					'};',
				].join('\n'),
			},
		]);
		expect(hits.length).toBeGreaterThan(0);
		expect(
			hits.some((h) => h.rule === 'parallel-circuit-record-construction'),
		).toBe(true);
	});

	test('parallel-rule scanner ignores read-only circuit references', () => {
		const hits = scanParallelCircuitRuleConstruction([
			{
				path: 'src/hooks/pr-workflow-gate.ts',
				content: [
					"if (circuit.state === 'OPEN') {",
					'\treturn formatMessage(circuit.contributors.length);',
					'}',
				].join('\n'),
			},
		]);
		expect(hits).toHaveLength(0);
	});

	test('parallel-rule scanner allows src/pr-review/ constructions', () => {
		const hits = scanParallelCircuitRuleConstruction([
			{
				path: 'src/pr-review/circuit.ts',
				content: "const r = { version: 2, state: 'CLOSED', contributors: [] };",
			},
		]);
		expect(hits).toHaveLength(0);
	});
});

describe('guardrail scanners over the real tree (issue #2385)', () => {
	test('no historical observer-terminalizer symbol reappears anywhere in src/', () => {
		const hits = scanObserverTerminalization(collectSources());
		expect(hits).toEqual([]);
	});

	test('delegation-transition writes in dispatch-lanes.ts stay inside sanctioned functions', () => {
		const sources = collectSources().filter((s) =>
			s.path.endsWith('src/tools/dispatch-lanes.ts'),
		);
		expect(sources).toHaveLength(1);
		const hits = scanObserverTerminalization(sources);
		expect(hits).toEqual([]);
	});

	test('no parallel circuit-record construction exists outside src/pr-review/', () => {
		const hits = scanParallelCircuitRuleConstruction(collectSources());
		expect(hits).toEqual([]);
	});
});
