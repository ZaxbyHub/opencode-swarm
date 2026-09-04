/**
 * Shared "## Decisions" extractor tests (issue #2493 W9a, consolidating the
 * #1661 residual).
 *
 * Two layers:
 * 1. Unit coverage for `extractContextDecisions` (src/utils/context-decisions)
 *    including the boundary regressions the curator's old inline regex had.
 * 2. Fixture-agreement: ONE context.md fixture fed through ALL FOUR
 *    historical consumers, asserting each derives a semantically equivalent
 *    decision set from the shared seam:
 *      - decision-drift-analyzer (rich Decision[])
 *      - hooks/extractors (joined raw text)
 *      - handoff-service (cleaned strings, last 5)
 *      - curator (key_decisions via the real runCuratorPhase digest path)
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resetGlobalEventBus } from '../../../src/background/event-bus.js';
import { runCuratorPhase } from '../../../src/hooks/curator.js';
import type { CuratorConfig } from '../../../src/hooks/curator-types';
import { extractDecisions } from '../../../src/hooks/extractors';
import { extractDecisionsFromContext } from '../../../src/services/decision-drift-analyzer';
import { _internals as handoffInternals } from '../../../src/services/handoff-service';
import { extractContextDecisions } from '../../../src/utils/context-decisions';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/** The ONE fixture every consumer must agree on. */
const FIXTURE = [
	'# Project Context',
	'',
	'## Phase 1: Setup',
	'Baseline content before any decisions.',
	'',
	'## Decisions',
	'- Use PostgreSQL for the primary datastore [2026-01-10T08:00:00Z]',
	'- ✅ Adopt Bun as the runtime [confirmed] [2026-01-12T09:30:00Z]',
	'- Do not use Redis for caching Phase 1',
	'- Keep the monorepo layout',
	'',
	'## Notes',
	'- This bullet must NOT leak into any decisions output',
	'- Nor this one',
].join('\n');

describe('extractContextDecisions (shared seam)', () => {
	it('extracts the rich superset shape from the fixture', () => {
		const decisions = extractContextDecisions(FIXTURE);
		expect(decisions).toHaveLength(4);
		expect(decisions.map((d) => d.text)).toEqual([
			'Use PostgreSQL for the primary datastore',
			// ✅ is not bracketed, so it survives the marker strip (drift semantics)
			'✅ Adopt Bun as the runtime',
			'Do not use Redis for caching Phase 1',
			'Keep the monorepo layout',
		]);
		expect(decisions.map((d) => d.confirmed)).toEqual([
			false,
			true,
			false,
			false,
		]);
		expect(decisions.map((d) => d.timestamp)).toEqual([
			'2026-01-10T08:00:00Z',
			'2026-01-12T09:30:00Z',
			null,
			null,
		]);
		// Phase 1 comes from the explicit "Phase 1" in decision 3 and from the
		// "## Phase 1: Setup" heading for the others.
		expect(decisions.map((d) => d.phase)).toEqual([1, 1, 1, 1]);
		expect(decisions.map((d) => d.line)).toEqual([7, 8, 9, 10]);
		// raw preserves the source line verbatim for raw-text consumers.
		expect(decisions[0].raw).toBe(
			'- Use PostgreSQL for the primary datastore [2026-01-10T08:00:00Z]',
		);
	});

	it('ends the section at the next "## " header (no Notes leak)', () => {
		const decisions = extractContextDecisions(FIXTURE);
		const allText = decisions.map((d) => `${d.raw}${d.text}`).join('\n');
		expect(allText).not.toContain('must NOT leak');
		expect(allText).not.toContain('Nor this one');
	});

	it('does NOT start a section from a mid-line prose mention (curator old-regex regression)', () => {
		// The curator regex /## Decisions\r?\n/ matched ANYWHERE in a line, so
		// prose like this started a bogus section and swallowed later bullets.
		// (Falsified against the old regex: it extracted the quoted bullet
		// 'but these bullets are quoted prose continuation"'.)
		const content = [
			'## Notes',
			'An old template said "## Decisions',
			'- but these bullets are quoted prose continuation"',
			'',
			'## Patterns',
			'- Not a decision',
		].join('\n');
		expect(extractContextDecisions(content)).toHaveLength(0);
	});

	it('does NOT start a section from "### Decisions" (curator old-regex regression)', () => {
		// "### Decisions" contains the substring "## Decisions", which the old
		// curator regex matched from offset 1.
		const content = ['### Decisions', '- Bogus decision'].join('\n');
		expect(extractContextDecisions(content)).toHaveLength(0);
	});

	it('does NOT truncate at a "###" subheading inside the section (curator old-regex regression)', () => {
		// The old curator regex ended the section at any "\n##", including
		// "###" subheads, silently dropping later decisions.
		const content = [
			'## Decisions',
			'- Decision one',
			'### Rationale subheading',
			'- Decision two',
		].join('\n');
		const decisions = extractContextDecisions(content);
		expect(decisions.map((d) => d.text)).toEqual([
			'Decision one',
			'Decision two',
		]);
	});

	it('a repeated "## Decisions" header continues the section (historical scanner quirk)', () => {
		const content = [
			'## Decisions',
			'- First decision',
			'## Decisions',
			'- Second decision',
			'## Notes',
			'- Not a decision',
		].join('\n');
		expect(extractContextDecisions(content).map((d) => d.text)).toEqual([
			'First decision',
			'Second decision',
		]);
	});

	it('captures indented bullets (drift/handoff/curator item semantics)', () => {
		const content = ['## Decisions', '  - Indented decision'].join('\n');
		const decisions = extractContextDecisions(content);
		expect(decisions).toHaveLength(1);
		expect(decisions[0].text).toBe('Indented decision');
		expect(decisions[0].raw).toBe('  - Indented decision');
	});

	it('handles CRLF line endings', () => {
		const content = [
			'## Decisions',
			'- CRLF decision one [2026-01-10T08:00:00Z]',
			'',
			'## Notes',
			'- Not a decision',
		].join('\r\n');
		const decisions = extractContextDecisions(content);
		expect(decisions).toHaveLength(1);
		expect(decisions[0].text).toBe('CRLF decision one');
		expect(decisions[0].timestamp).toBe('2026-01-10T08:00:00Z');
	});

	it('returns [] for empty input and input without a Decisions section', () => {
		expect(extractContextDecisions('')).toEqual([]);
		expect(extractContextDecisions('## Phase 1\n\nNo decisions here')).toEqual(
			[],
		);
	});
});

describe('fixture agreement across all four consumers (#2493 W9a)', () => {
	const shared = extractContextDecisions(FIXTURE);

	it('decision-drift-analyzer returns the same rich set', () => {
		const drift = extractDecisionsFromContext(FIXTURE);
		expect(drift).toHaveLength(shared.length);
		expect(drift.map((d) => d.text)).toEqual(shared.map((d) => d.text));
		expect(drift.map((d) => d.phase)).toEqual(shared.map((d) => d.phase));
		expect(drift.map((d) => d.confirmed)).toEqual(
			shared.map((d) => d.confirmed),
		);
		expect(drift.map((d) => d.timestamp)).toEqual(
			shared.map((d) => d.timestamp),
		);
		expect(drift.map((d) => d.line)).toEqual(shared.map((d) => d.line));
	});

	it('hooks/extractors returns the same raw lines joined (markers intact, non-indented only)', () => {
		const joined = extractDecisions(FIXTURE);
		// This consumer historically matched raw startsWith('- ') only.
		const expected = shared
			.filter((d) => d.raw.startsWith('- '))
			.map((d) => d.raw)
			.join('\n');
		expect(joined).toBe(expected);
		expect(joined).not.toContain('must NOT leak');
		expect(joined).toContain(
			'- ✅ Adopt Bun as the runtime [confirmed] [2026-01-12T09:30:00Z]',
		);
	});

	it('hooks/extractors still ignores indented bullets (historical item semantics)', () => {
		const content = ['## Decisions', '- Top-level', '  - Indented'].join('\n');
		expect(extractDecisions(content)).toBe('- Top-level');
	});

	it('handoff-service returns the same decisions cleaned (markers stripped, last 5)', () => {
		const handoff = handoffInternals.extractDecisions(FIXTURE);
		const expected = shared
			.map((d) => d.text.replace(/✅/g, '').trim())
			.slice(-5);
		expect(handoff).toEqual(expected);
		expect(handoff).toEqual([
			'Use PostgreSQL for the primary datastore',
			'Adopt Bun as the runtime',
			'Do not use Redis for caching Phase 1',
			'Keep the monorepo layout',
		]);
	});

	it('curator derives the same key_decisions from the real digest path', async () => {
		const tempDir = canonicalMkdtemp('context-decisions-curator-');
		resetGlobalEventBus();
		try {
			fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
			fs.writeFileSync(path.join(tempDir, '.swarm', 'context.md'), FIXTURE);

			const curatorConfig: CuratorConfig = {
				enabled: true,
				init_enabled: true,
				phase_enabled: true,
				max_summary_tokens: 2000,
				min_knowledge_confidence: 0.7,
				compliance_report: true,
				suppress_warnings: true,
				drift_inject_max_chars: 500,
			};
			const result = await runCuratorPhase(
				tempDir,
				1,
				['reviewer', 'test_engineer'],
				curatorConfig,
				{},
			);

			// Curator keeps the RAW decision text (markers intact), first 5.
			const expected = shared.map((d) => d.raw.trim().slice(2)).slice(0, 5);
			expect(result.digest.key_decisions).toEqual(expected);
			const joined = result.digest.key_decisions.join('\n');
			expect(joined).not.toContain('must NOT leak');
			expect(joined).not.toContain('Nor this one');
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
			resetGlobalEventBus();
		}
	});
});

// Keep beforeEach/afterEach symmetry for the event-bus reset even when only
// the curator describe block needs it (the reset is idempotent and cheap).
beforeEach(() => {
	resetGlobalEventBus();
});

afterEach(() => {
	resetGlobalEventBus();
});
