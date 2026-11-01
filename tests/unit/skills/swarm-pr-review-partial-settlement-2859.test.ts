import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Issue #2859 (F0): the PARTIAL-settlement recovery path is documented in the
 * canonical swarm-pr-review skill. The `.claude`/`.agents` entries are thin
 * adapter shims by design (src/config/skill-mirrors.ts), so the guidance lives
 * in the `.opencode` canonical only. The canonical is pinned at 1705
 * lines by the progressive-disclosure ratchet; this suite anchors the section
 * so it cannot be silently relocated or dropped.
 */

const SKILL_PATH = join(
	process.cwd(),
	'.opencode',
	'skills',
	'swarm-pr-review',
	'SKILL.md',
);

describe('swarm-pr-review PARTIAL-settlement recovery guidance (issue #2859 F0)', () => {
	const content = readFileSync(SKILL_PATH, 'utf-8');

	test('the section exists between the coverage gate and contract-failure diagnosis', () => {
		const heading = '### PARTIAL-settlement recovery (all lanes terminal)';
		const headingAt = content.indexOf(heading);
		expect(headingAt).toBeGreaterThanOrEqual(0);
		const coverageGateAt = content.indexOf('**COVERAGE GATE');
		const contractFailureAt = content.indexOf(
			'### Contract-failure diagnosis and recovery',
		);
		expect(coverageGateAt).toBeGreaterThanOrEqual(0);
		expect(contractFailureAt).toBeGreaterThan(headingAt);
		expect(headingAt).toBeGreaterThan(coverageGateAt);
	});

	test('the section carries the recovery contract tokens (anchored)', () => {
		const start = content.indexOf('### PARTIAL-settlement recovery');
		const end = content.indexOf('### Contract-failure diagnosis and recovery');
		const section = content.slice(start, end);
		expect(section).toContain('TERMINAL');
		expect(section).toContain('trigger_evaluation');
		expect(section).toContain('write_pr_review_trigger_eval');
		expect(section).toContain('complete_pr_workflow');
		expect(section).toContain('PARTIAL');
		expect(section).toContain('not a deadlock');
	});

	test('the canonical stays at or below the 1705-line ratchet baseline', () => {
		const lines = content.trimEnd().split(/\r?\n/).length;
		expect(lines).toBeLessThanOrEqual(1705);
	});
});
