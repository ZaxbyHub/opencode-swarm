import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function readSkill(skillPath: string): string {
	return readFileSync(join(process.cwd(), skillPath), 'utf-8');
}

function sectionBetween(source: string, start: string, end: string): string {
	const startIndex = source.indexOf(start);
	const endIndex = source.indexOf(end, startIndex + start.length);
	expect(startIndex).toBeGreaterThan(-1);
	expect(endIndex).toBeGreaterThan(startIndex);
	return source.slice(startIndex, endIndex);
}

function expectNoLegacyContradiction(source: string): void {
	expect(source).toContain('singleton canary');
	expect(source).toContain('fanout');
	expect(source).toContain('policy is disabled');
	for (const stalePhrase of [
		'initial base wave is one structured exact-six batch',
		'response, and an initial base wave of one exact-six batch',
		'initial base wave and every micro batch keep the historical tier-L full fan-out',
		'launch all base lanes with `dispatch_lanes_async`. Pass the',
		'lane specs together, set `mode: "swarm-pr-review:base"`',
		'follow-up batch or batches',
		'one or more fanout batches',
		'successful source, or whose prior attempt is still in flight, still requires',
		'a full six-lane singleton re-dispatch is always accepted',
	]) {
		expect(source).not.toContain(stalePhrase);
	}
}

describe('swarm-pr-review resilience guidance', () => {
	test('canonical dispatch contract requires one canary and one unresolved fanout', () => {
		const source = readSkill('.opencode/skills/swarm-pr-review/SKILL.md');
		const retrySection = sectionBetween(source, '## Phase 3', '## Phase 4');
		const dispatchSection = sectionBetween(
			source,
			'### Dispatch',
			'### Contract-failure diagnosis and recovery',
		);
		for (const expected of [
			'pr_review_resilience',
			'pr_review_wave_stage',
			'pr_review_wave_attempt',
			'exactly one follow-up fanout batch',
			'successful source are complete and MUST NOT be re-dispatched',
			'live or in-flight source are not yet eligible for the retry set',
			'unresolved-only fanout call',
			'attempt 0 plus two retry attempts',
			'retry_exhausted',
			'circuit_open',
		]) {
			expect(retrySection).toContain(expected);
		}
		expect(dispatchSection).toContain('singleton canary batch');
		expect(dispatchSection).toContain('pr_review_wave_stage: "canary"');
		expect(dispatchSection).toContain('pr_review_wave_stage: "fanout"');
		expect(dispatchSection).toContain('followed by exactly one fanout batch');
		expectNoLegacyContradiction(source);
	});
});
