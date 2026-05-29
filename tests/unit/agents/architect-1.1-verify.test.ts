/**
 * Verification test for Task 1.1 — CLARIFY mode detection line change.
 *
 * Verifies that src/agents/architect.ts line 632:
 *   BEFORE: "Ask up to 3 questions" cap
 *   AFTER:  clarification-funnel routing language referencing the clarify skill
 *
 * Does NOT test the skill file — that is Task 1.2.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const architectPrompt = readFileSync(
	join(process.cwd(), 'src/agents/architect.ts'),
	'utf-8',
);

describe('Task 1.1 — CLARIFY mode detection (architect.ts line 632)', () => {
	// --- Structural presence checks ---

	it('MODE DETECTION section exists with priority order', () => {
		const idx = architectPrompt.indexOf('### MODE DETECTION (Priority Order)');
		expect(idx).toBeGreaterThan(-1);
	});

	it('CLARIFY entry (priority 4) is present in MODE DETECTION', () => {
		// The CLARIFY entry must appear after MODE DETECTION header
		const modeDetectionIdx = architectPrompt.indexOf(
			'### MODE DETECTION (Priority Order)',
		);
		expect(modeDetectionIdx).toBeGreaterThan(-1);

		// Priority 4 CLARIFY line
		const clarifyIdx = architectPrompt.indexOf(
			'4. **CLARIFY**',
			modeDetectionIdx,
		);
		expect(clarifyIdx).toBeGreaterThan(-1);
	});

	// --- The key substitution: "Ask up to 3 questions" must be GONE from architect.ts ---

	it('does NOT contain "Ask up to 3 questions" in architect.ts', () => {
		// This was the old cap text at line 632 — it must be removed
		expect(architectPrompt.indexOf('Ask up to 3 questions')).toBe(-1);
	});

	it('does NOT contain "up to 3 questions" anywhere in architect.ts', () => {
		// Broader check to ensure no remnant phrasing
		expect(architectPrompt.indexOf('up to 3 questions')).toBe(-1);
	});

	// --- The new clarification-funnel language must be PRESENT ---

	it('contains "clarification funnel" routing language at the CLARIFY entry', () => {
		const modeDetectionIdx = architectPrompt.indexOf(
			'### MODE DETECTION (Priority Order)',
		);
		const clarifyIdx = architectPrompt.indexOf(
			'4. **CLARIFY**',
			modeDetectionIdx,
		);
		const nextEntryIdx = architectPrompt.indexOf('5. **DISCOVER**', clarifyIdx);

		const clarifyBlock = architectPrompt.slice(
			clarifyIdx,
			nextEntryIdx > 0 ? nextEntryIdx : clarifyIdx + 300,
		);
		expect(clarifyBlock).toContain('clarification funnel');
	});

	it('references "clarify skill" in the CLARIFY routing block', () => {
		const modeDetectionIdx = architectPrompt.indexOf(
			'### MODE DETECTION (Priority Order)',
		);
		const clarifyIdx = architectPrompt.indexOf(
			'4. **CLARIFY**',
			modeDetectionIdx,
		);
		const nextEntryIdx = architectPrompt.indexOf('5. **DISCOVER**', clarifyIdx);

		const clarifyBlock = architectPrompt.slice(
			clarifyIdx,
			nextEntryIdx > 0 ? nextEntryIdx : clarifyIdx + 300,
		);
		expect(clarifyBlock).toContain('clarify skill');
	});

	it('mentions inventorying uncertainties in the CLARIFY routing block', () => {
		const modeDetectionIdx = architectPrompt.indexOf(
			'### MODE DETECTION (Priority Order)',
		);
		const clarifyIdx = architectPrompt.indexOf(
			'4. **CLARIFY**',
			modeDetectionIdx,
		);
		const nextEntryIdx = architectPrompt.indexOf('5. **DISCOVER**', clarifyIdx);

		const clarifyBlock = architectPrompt.slice(
			clarifyIdx,
			nextEntryIdx > 0 ? nextEntryIdx : clarifyIdx + 300,
		);
		expect(clarifyBlock.toLowerCase()).toContain('uncertain');
	});

	it('mentions consulting critic_sounding_board in the CLARIFY routing block', () => {
		const modeDetectionIdx = architectPrompt.indexOf(
			'### MODE DETECTION (Priority Order)',
		);
		const clarifyIdx = architectPrompt.indexOf(
			'4. **CLARIFY**',
			modeDetectionIdx,
		);
		const nextEntryIdx = architectPrompt.indexOf('5. **DISCOVER**', clarifyIdx);

		const clarifyBlock = architectPrompt.slice(
			clarifyIdx,
			nextEntryIdx > 0 ? nextEntryIdx : clarifyIdx + 300,
		);
		expect(clarifyBlock).toContain('critic_sounding_board');
	});

	it('mentions surfacing structured packet of remaining user decisions', () => {
		const modeDetectionIdx = architectPrompt.indexOf(
			'### MODE DETECTION (Priority Order)',
		);
		const clarifyIdx = architectPrompt.indexOf(
			'4. **CLARIFY**',
			modeDetectionIdx,
		);
		const nextEntryIdx = architectPrompt.indexOf('5. **DISCOVER**', clarifyIdx);

		const clarifyBlock = architectPrompt.slice(
			clarifyIdx,
			nextEntryIdx > 0 ? nextEntryIdx : clarifyIdx + 300,
		);
		expect(clarifyBlock).toContain('structured packet');
	});

	// --- Context: CLARIFY-SPEC entry must still be distinct and separate ---

	it('CLARIFY-SPEC (priority 3) is still present and distinct from CLARIFY (priority 4)', () => {
		const modeDetectionIdx = architectPrompt.indexOf(
			'### MODE DETECTION (Priority Order)',
		);

		const clarifySpecIdx = architectPrompt.indexOf(
			'3. **CLARIFY-SPEC**',
			modeDetectionIdx,
		);
		const clarifyIdx = architectPrompt.indexOf(
			'4. **CLARIFY**',
			modeDetectionIdx,
		);

		expect(clarifySpecIdx).toBeGreaterThan(-1);
		expect(clarifyIdx).toBeGreaterThan(-1);
		expect(clarifyIdx).toBeGreaterThan(clarifySpecIdx);
	});

	// --- After Task 1.2: skill file now has the funnel protocol, not the old cap ---

	it('clarify skill file now contains the funnel protocol instead of old cap', () => {
		const clarifySkillPath = join(
			process.cwd(),
			'.opencode/skills/clarify/SKILL.md',
		);
		const skillContent = readFileSync(clarifySkillPath, 'utf-8');
		// Task 1.2 replaced the skill with the full funnel — verify old cap is gone and funnel is present
		expect(skillContent).not.toContain('Ask up to 3 questions');
		expect(skillContent).toContain('Stage 2: Classify Each Uncertainty');
		expect(skillContent).toContain('Always-Surface Categories');
	});
});
