/**
 * Phase 3 behavior tests for auto-proceed feature.
 *
 * Covers the following behaviors specified in the feature spec:
 * 1. SC-001: Non-blocking boundaries — auto_proceed only skips phase-transition
 *    confirmation. The architect must still stop for blocked tasks, user questions,
 *    and required decisions.
 * 2. FR-004: Nudge-once — at the first phase boundary when auto_proceed is off
 *    and autoProceedNudgeDone is false, the architect should suggest enabling it.
 * 3. Opt-out suppression — if the user explicitly ran `/swarm auto-proceed off`,
 *    the nudge should NOT fire even if auto_proceed is off.
 * 4. SC-002: Full-auto independence — when full-auto mode is active, the
 *    existing full-auto behavior continues to work. auto_proceed has no effect.
 * 5. SC-003: Summary-before-advance — when auto-proceed advances to the next
 *    phase, a completion summary is shown.
 *
 * These tests verify the architect prompt and skill logic behavior:
 * - Text-based: verifying prompt/skill text contains the expected logic
 * - Logic-based: verifying the state machine for autoProceedNudgeDone and
 *   autoProceedOverride works correctly in the nudge/opt-out scenarios
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Paths to the source-of-truth files
// import.meta.dir = tests/unit/phase-wrap/
// 3 levels up = workspace root (E:\OpenCode\opencode-swarm-dev2)
const ARCHITECT_PROMPT_PATH = join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'src',
	'agents',
	'architect.ts',
);
const PHASE_WRAP_SKILL_PATH = join(
	import.meta.dir,
	'..',
	'..',
	'..',
	'.opencode',
	'skills',
	'phase-wrap',
	'SKILL.md',
);

// ---------------------------------------------------------------------------
// Helper: extract a named HARD CONSTRAINTS block from the architect prompt
// ---------------------------------------------------------------------------
function getArchitectPromptText(): string {
	return readFileSync(ARCHITECT_PROMPT_PATH, 'utf-8');
}

function getPhaseWrapSkillText(): string {
	return readFileSync(PHASE_WRAP_SKILL_PATH, 'utf-8');
}

// ---------------------------------------------------------------------------
// SC-001: Non-blocking boundaries
// Text-based: architect prompt says auto_proceed does NOT affect blocking
// ---------------------------------------------------------------------------
describe('SC-001: Non-blocking boundaries', () => {
	const architectText = getArchitectPromptText();

	test('architect prompt says auto-proceed only skips phase-transition confirmation', () => {
		// Anchor to the SC-001 section in the HARD CONSTRAINTS block
		const sc001Start = architectText.indexOf('SC-001:');
		const sc001Section = architectText.slice(sc001Start, sc001Start + 300);
		expect(sc001Section).toContain('auto-proceed only skips');
		expect(sc001Section).toContain('phase-transition confirmation');
	});

	test('architect prompt says architect MUST still stop for blocked tasks', () => {
		const sc001Start = architectText.indexOf('SC-001:');
		const sc001Section = architectText.slice(sc001Start, sc001Start + 300);
		// Must still stop for blocked tasks regardless of auto_proceed
		expect(sc001Section).toContain('MUST still stop');
		expect(sc001Section).toContain('blocked tasks');
	});

	test('architect prompt says architect MUST still stop for user questions', () => {
		const sc001Start = architectText.indexOf('SC-001:');
		const sc001Section = architectText.slice(sc001Start, sc001Start + 300);
		expect(sc001Section).toContain('user questions');
	});

	test('architect prompt says blocking behavior is NOT affected by auto_proceed', () => {
		const sc001Start = architectText.indexOf('SC-001:');
		const sc001Section = architectText.slice(sc001Start, sc001Start + 300);
		expect(sc001Section).toContain('NOT affected by the auto_proceed');
	});
});

// ---------------------------------------------------------------------------
// FR-004: Nudge-once (banner-based)
// The nudge is now driven by the AUTO_PROCEED STATUS banner injected by system-enhancer.
// Architect prompt describes the banner fields and the nudge routing via swarm_command.
// ---------------------------------------------------------------------------
describe('FR-004: Nudge-once (banner-based)', () => {
	const architectText = getArchitectPromptText();
	const skillText = getPhaseWrapSkillText();

	test('architect prompt describes banner nudge flag meaning', () => {
		// Banner shows: nudge flag (true if user has already been asked or has explicitly toggled)
		const nudgeFlagIndex = architectText.indexOf(
			'nudge flag (true if user has already been asked',
		);
		expect(nudgeFlagIndex).toBeGreaterThan(0);
	});

	test('architect prompt describes nudge routing via swarm_command on YES', () => {
		// On YES: call swarm_command({ command: "auto-proceed", args: ["on"] })
		const swarmCommandIndex = architectText.indexOf(
			'swarm_command({ command: "auto-proceed", args: ["on"] })',
		);
		expect(swarmCommandIndex).toBeGreaterThan(0);
		const surrounding = architectText.slice(
			Math.max(0, swarmCommandIndex - 100),
			swarmCommandIndex + 150,
		);
		// The yes path sets both override and nudge-done
		expect(surrounding).toContain('override');
		expect(surrounding).toContain('nudge-done');
	});

	test('architect prompt describes nudge routing via swarm_command on NO', () => {
		// On NO: call swarm_command({ command: "auto-proceed", args: ["off"] })
		const swarmCommandOffIndex = architectText.indexOf(
			'swarm_command({ command: "auto-proceed", args: ["off"] })',
		);
		expect(swarmCommandOffIndex).toBeGreaterThan(0);
		const surrounding = architectText.slice(
			Math.max(0, swarmCommandOffIndex - 100),
			swarmCommandOffIndex + 150,
		);
		// The no path sets override=false and nudge-done=true
		expect(surrounding).toContain('override=false');
		expect(surrounding).toContain('nudge-done=true');
	});

	test('architect prompt describes the nudge suggestion text', () => {
		// "Auto-proceed is currently disabled. Would you like me to automatically advance..."
		const suggestionIndex = architectText.indexOf(
			'Auto-proceed is currently disabled. Would you like me to automatically advance',
		);
		expect(suggestionIndex).toBeGreaterThan(0);
	});

	test('FR-004 first-boundary nudge is mentioned in banner description', () => {
		// Banner nudge field mentions: whether the FR-004 first-boundary nudge has already been done
		// This text is in the phase-wrap skill, not the architect prompt
		const fr004Index = skillText.indexOf('FR-004 first-boundary nudge');
		expect(fr004Index).toBeGreaterThan(0);
	});
});

// ---------------------------------------------------------------------------
// Opt-out suppression (banner-based)
// The nudge is suppressed when banner shows nudge: true (already asked or toggled).
// The banner's nudge flag is set to true when user explicitly toggles via swarm_command.
// ---------------------------------------------------------------------------
describe('Opt-out suppression (banner-based)', () => {
	const architectText = getArchitectPromptText();

	test('architect prompt says nudge flag is false when user has NOT been asked', () => {
		// Banner nudge field: "true if user has already been asked or has explicitly toggled"
		// This means false = not yet asked / not toggled = nudge SHOULD fire
		const nudgeFlagIndex = architectText.indexOf(
			'nudge flag (true if user has already been asked',
		);
		expect(nudgeFlagIndex).toBeGreaterThan(0);
		const surrounding = architectText.slice(
			nudgeFlagIndex,
			nudgeFlagIndex + 120,
		);
		expect(surrounding).toContain('already been asked');
		expect(surrounding).toContain('explicitly toggled');
	});

	test('architect prompt conditions nudge on nudge flag being false', () => {
		// "If auto-proceed is OFF AND nudge flag is false: ...suggest enabling auto-proceed"
		const offAndNudgeIndex = architectText.indexOf(
			'auto-proceed is OFF (banner shows "off") AND nudge flag is false',
		);
		expect(offAndNudgeIndex).toBeGreaterThan(0);
	});

	test('architect prompt does NOT show nudge when nudge flag is true', () => {
		// When nudge flag is true: "just ask 'Ready for Phase [N+1]?' as before"
		const nudgeTruePath = architectText.indexOf(
			'auto-proceed is OFF AND nudge flag is true',
		);
		expect(nudgeTruePath).toBeGreaterThan(0);
		const surrounding = architectText.slice(nudgeTruePath, nudgeTruePath + 100);
		// The nudge suggestion should NOT appear when nudge is already done
		expect(surrounding).not.toContain('suggest enabling auto-proceed');
	});
});

// ---------------------------------------------------------------------------
// SC-002: Full-auto independence
// Text-based: architect prompt says full-auto mode is independent of auto_proceed
// ---------------------------------------------------------------------------
describe('SC-002: Full-auto independence', () => {
	const architectText = getArchitectPromptText();

	test('architect prompt says full-auto mode is independent of auto_proceed', () => {
		const sc002Start = architectText.indexOf(
			'Full-auto mode (critic oversight) is independent',
		);
		expect(sc002Start).toBeGreaterThan(0);
		const sc002Section = architectText.slice(sc002Start, sc002Start + 200);
		expect(sc002Section).toContain('Full-auto mode');
		expect(sc002Section).toContain('independent');
	});

	test('architect prompt says auto_proceed has no additional effect under full-auto', () => {
		const sc002Start = architectText.indexOf(
			'Full-auto mode (critic oversight) is independent',
		);
		const sc002Section = architectText.slice(sc002Start, sc002Start + 200);
		expect(sc002Section).toContain('auto_proceed has no additional effect');
	});

	test('architect prompt mentions full-auto existing override behavior', () => {
		// "its existing 'Do NOT ask Ready for Phase N+1?' override continues to work"
		const sc002Start = architectText.indexOf(
			'Full-auto mode (critic oversight) is independent',
		);
		const sc002Section = architectText.slice(sc002Start, sc002Start + 200);
		expect(sc002Section).toContain('existing');
		expect(sc002Section).toContain('override continues to work');
	});
});

// ---------------------------------------------------------------------------
// SC-003: Summary-before-advance (banner-based)
// Step 6 summarizes before step 7 (banner check and advance decision).
// ---------------------------------------------------------------------------
describe('SC-003: Summary-before-advance (banner-based)', () => {
	const skillText = getPhaseWrapSkillText();

	test('phase-wrap skill step 6 says summarize to user before advancing', () => {
		// Step 6 in phase-wrap: "Summarize to user"
		const step6Index = skillText.indexOf('6. Summarize to user');
		expect(step6Index).toBeGreaterThan(0);
	});

	test('phase-wrap skill step 7 is the AUTO_PROCEED STATUS banner check', () => {
		// Step 7: Check the AUTO_PROCEED STATUS banner (not "resolved auto_proceed")
		const step7Index = skillText.indexOf(
			'7. Check the AUTO_PROCEED STATUS banner',
		);
		expect(step7Index).toBeGreaterThan(0);
		// Step 6 (summarize) comes before step 7 (banner check)
		const step6Index = skillText.indexOf('6. Summarize to user');
		expect(step6Index).toBeGreaterThan(0);
		expect(step6Index).toBeLessThan(step7Index);
	});

	test('phase-wrap skill step 7 uses banner branches (auto-proceed on/off, nudge true/false)', () => {
		// Step 7 branches on banner values: auto-proceed on/off, nudge true/false
		const step7Index = skillText.indexOf(
			'7. Check the AUTO_PROCEED STATUS banner',
		);
		const step7Section = skillText.slice(step7Index, step7Index + 500);
		// Branch 1: auto-proceed: on
		expect(step7Section).toContain('auto-proceed: on');
		// Branch 2: auto-proceed: off AND nudge: false
		expect(step7Section).toContain('auto-proceed: off');
		// nudge field is described as template: nudge: <true|false>
		expect(step7Section).toContain('nudge: <true|false>');
	});
});

// ---------------------------------------------------------------------------
// Integration: Phase 2 — banner-based auto-proceed flow
// The system-enhancer injects AUTO_PROCEED STATUS banner into architect context.
// Both architect.ts HARD CONSTRAINTS and phase-wrap/SKILL.md read the banner.
// ---------------------------------------------------------------------------
describe('Phase 2: Banner-based auto-proceed flow', () => {
	const architectText = getArchitectPromptText();
	const skillText = getPhaseWrapSkillText();

	// -------------------------------------------------------------------------
	// Architect prompt references the AUTO_PROCEED STATUS banner (not getResolvedAutoProceed)
	// -------------------------------------------------------------------------
	test('architect prompt references AUTO_PROCEED STATUS banner', () => {
		// architect.ts: "read the AUTO_PROCEED STATUS banner injected into your context"
		expect(architectText).toContain('AUTO_PROCEED STATUS banner');
	});

	test('architect prompt references swarm_command for nudge routing', () => {
		// architect.ts: nudge uses swarm_command({ command: "auto-proceed", args: ["on"|"off"] })
		// This tests that the banner-based nudge flow is documented
		const nudgeSection = architectText.slice(
			architectText.indexOf('swarm_command({ command: "auto-proceed"'),
			architectText.indexOf('swarm_command({ command: "auto-proceed"') + 200,
		);
		expect(nudgeSection).toContain('swarm_command');
		expect(nudgeSection).toContain('auto-proceed');
	});

	test('architect prompt does NOT call getResolvedAutoProceed directly', () => {
		// Phase 2 change: architect reads the banner, not getResolvedAutoProceed
		// The banner is pre-resolved by system-enhancer
		expect(architectText).not.toContain('getResolvedAutoProceed');
	});

	// -------------------------------------------------------------------------
	// Phase-wrap skill references the AUTO_PROCEED STATUS banner
	// -------------------------------------------------------------------------
	test('phase-wrap skill step 7 references AUTO_PROCEED STATUS banner', () => {
		// phase-wrap skill step 7: "Check the AUTO_PROCEED STATUS banner"
		const step7Index = skillText.indexOf(
			'7. Check the AUTO_PROCEED STATUS banner',
		);
		expect(step7Index).toBeGreaterThan(0);
	});

	test('phase-wrap skill does NOT say "read resolved auto_proceed value"', () => {
		// Phase 2 change: skill reads the banner, not the old "resolved auto_proceed" text
		expect(skillText).not.toContain('read resolved auto_proceed');
		expect(skillText).not.toContain('resolved auto_proceed value');
	});

	// -------------------------------------------------------------------------
	// Both documents use swarm_command for nudge routing
	// -------------------------------------------------------------------------
	test('phase-wrap skill uses swarm_command for nudge routing', () => {
		// skill step 7: uses swarm_command({ command: "auto-proceed", args: ["on"|"off"] })
		expect(skillText).toContain('swarm_command({ command: "auto-proceed"');
	});

	// -------------------------------------------------------------------------
	// Banner content: architect prompt describes the banner fields
	// -------------------------------------------------------------------------
	test('architect prompt describes banner fields (auto-proceed, source, nudge)', () => {
		// architect.ts HARD CONSTRAINTS describes what the banner shows:
		// - auto-proceed state (on/off)
		// - source (session override vs plan-or-default)
		// - nudge flag (true if user has already been asked or has explicitly toggled)
		const bannerFieldsIndex = architectText.indexOf(
			'auto-proceed state (on/off)',
		);
		expect(bannerFieldsIndex).toBeGreaterThan(0);
		const surrounding = architectText.slice(
			Math.max(0, bannerFieldsIndex - 100),
			bannerFieldsIndex + 200,
		);
		expect(surrounding).toContain('source');
		expect(surrounding).toContain('nudge flag');
	});

	// -------------------------------------------------------------------------
	// Phase-wrap skill step 7 describes banner branches
	// -------------------------------------------------------------------------
	test('phase-wrap skill step 7 describes banner branches (auto-proceed on/off, nudge true/false)', () => {
		// skill step 7: three branches based on banner values
		const step7Start = skillText.indexOf(
			'7. Check the AUTO_PROCEED STATUS banner',
		);
		// Extend slice to capture the full step 7 content including nudge text
		const step7Section = skillText.slice(step7Start, step7Start + 800);
		// Branch 1: auto-proceed: on
		expect(step7Section).toContain('auto-proceed: on');
		// Branch 2: auto-proceed: off AND nudge: false (nudge not yet done)
		expect(step7Section).toContain('auto-proceed: off');
		// nudge field is described as template: nudge: <true|false>
		expect(step7Section).toContain('nudge: <true|false>');
		// The branches describe the nudge behavior based on the template value
		expect(step7Section).toContain('suggest enabling auto-proceed');
	});
});
