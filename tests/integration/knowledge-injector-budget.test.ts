/**
 * Integration regression test: knowledge injector budget fix.
 *
 * Before the fix, the injector used a static 75,000-char threshold that caused
 * it to silently skip injection at 181k chars (47% of the 387k model limit).
 * This file validates the three-regime headroom model that replaced it.
 *
 * Regression scenario from the bug report:
 *   - Session with 181,526 chars of existing context
 *   - Old behavior: "Skipping knowledge injection: context too large (181526 chars > 75000)"
 *   - New behavior: injects at moderate regime (~1000 char budget)
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createKnowledgeInjectorHook } from '../../src/hooks/knowledge-injector.js';
import type {
	KnowledgeConfig,
	MessageWithParts,
} from '../../src/hooks/knowledge-types.js';

// ---------------------------------------------------------------------------
// Constants (mirror knowledge-injector.ts)
// ---------------------------------------------------------------------------
const CHARS_PER_TOKEN = 1 / 0.33;
const MODEL_LIMIT_CHARS = Math.floor(128_000 * CHARS_PER_TOKEN); // ~387,878

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAN_JSON = JSON.stringify({
	schema_version: '1.0.0',
	swarm: 'budget-test',
	title: 'Budget Regression Test',
	current_phase: 1,
	phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
});

function makeKnowledgeEntry(id: string, lesson: string): string {
	return JSON.stringify({
		id,
		tier: 'swarm',
		lesson,
		category: 'process',
		tags: ['test'],
		scope: 'global',
		confidence: 0.8,
		status: 'established',
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: '2024-01-01T00:00:00.000Z',
				project_name: 'test',
			},
		],
		retrieval_outcomes: {
			applied_count: 2,
			succeeded_after_count: 2,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: '2024-01-01T00:00:00.000Z',
		updated_at: '2024-01-01T00:00:00.000Z',
		project_name: 'test',
	});
}

const KNOWLEDGE_JSONL = [
	makeKnowledgeEntry('aaaa-0001', 'Always run tests before merging'),
	makeKnowledgeEntry('bbbb-0002', 'Use structured logging for debugging'),
	makeKnowledgeEntry('cccc-0003', 'Pin dependency versions in CI'),
].join('\n');

const CONFIG: KnowledgeConfig = {
	enabled: true,
	swarm_max_entries: 100,
	hive_max_entries: 200,
	auto_promote_days: 90,
	max_inject_count: 5,
	inject_char_budget: 2000,
	max_lesson_display_chars: 120,
	dedup_threshold: 0.6,
	scope_filter: ['global'],
	hive_enabled: false,
	rejected_max_entries: 20,
	validation_enabled: true,
	evergreen_confidence: 0.9,
	evergreen_utility: 0.8,
	low_utility_threshold: 0.3,
	min_retrievals_for_utility: 3,
	schema_version: 1,
	same_project_weight: 1.0,
	cross_project_weight: 0.5,
	min_encounter_score: 0.1,
	initial_encounter_score: 1.0,
	encounter_increment: 0.1,
	max_encounter_score: 10.0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Must use a relative path because validateDirectory() inside
 * getRunMemorySummary() rejects absolute paths.
 */
function createRelativeTempDir(): string {
	const baseDir = 'tmp';
	if (!fs.existsSync(baseDir)) {
		fs.mkdirSync(baseDir, { recursive: true });
	}
	return fs.mkdtempSync(path.join(baseDir, 'ki-budget-test-'));
}

/**
 * Build a messages array with exactly `totalChars` total chars.
 * Always ends with a user message so the injector has a recency target.
 */
function makeMessages(totalChars: number): MessageWithParts[] {
	const sysText = 'System prompt for architect agent';
	const userPad = Math.max(1, totalChars - sysText.length);
	return [
		{
			info: { role: 'system', agent: 'architect' },
			parts: [{ type: 'text', text: sysText }],
		},
		{
			info: { role: 'user' },
			parts: [{ type: 'text', text: 'x'.repeat(userPad) }],
		},
	];
}

function findInjectedMessage(
	messages: MessageWithParts[],
): MessageWithParts | undefined {
	return messages.find((m) =>
		m.parts?.some((p) => p.text?.includes('\u{1F4DA} Lessons:')),
	);
}

function totalTextLength(msg: MessageWithParts): number {
	return msg.parts.reduce((sum, p) => sum + (p.text?.length ?? 0), 0);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Knowledge injector budget regression', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createRelativeTempDir();
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(path.join(swarmDir, 'plan.json'), PLAN_JSON);
		fs.writeFileSync(path.join(swarmDir, 'knowledge.jsonl'), KNOWLEDGE_JSONL);
	});

	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// -----------------------------------------------------------------------
	// Primary regression: 181,526 chars must inject (was broken before fix)
	// -----------------------------------------------------------------------

	it('[REGRESSION] injects at 181,526 chars (exact bug-report value) — was incorrectly skipped before fix', async () => {
		const hook = createKnowledgeInjectorHook(tempDir, CONFIG);
		const messages = makeMessages(181_526);
		const output = { messages };

		await hook({} as Record<string, never>, output);

		// Injection must have occurred — message count grew
		expect(output.messages.length).toBeGreaterThan(2);

		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeDefined();
	});

	it('[REGRESSION] old "context too large" warning is NOT emitted at 181,526 chars', async () => {
		const warnSpy = spyOn(console, 'warn');
		try {
			const hook = createKnowledgeInjectorHook(tempDir, CONFIG);
			const messages = makeMessages(181_526);
			await hook({} as Record<string, never>, { messages });

			const oldMessage = warnSpy.mock.calls.some((args) =>
				String(args[0]).includes('context too large'),
			);
			expect(oldMessage).toBe(false);
		} finally {
			warnSpy.mockRestore();
		}
	});

	// -----------------------------------------------------------------------
	// Recency position: injected message is just before the last user message
	// -----------------------------------------------------------------------

	it('injected message is placed just before the last user message at 181,526 chars', async () => {
		const hook = createKnowledgeInjectorHook(tempDir, CONFIG);
		const messages = makeMessages(181_526);
		const output = { messages };

		await hook({} as Record<string, never>, output);

		const injectedIdx = output.messages.findIndex((m) =>
			m.parts?.some((p) => p.text?.includes('\u{1F4DA} Lessons:')),
		);
		expect(injectedIdx).toBeGreaterThanOrEqual(0);

		// The message immediately after the injected one must be the last user message
		const after = output.messages[injectedIdx + 1];
		expect(after.info.role).toBe('user');
		// And it must be the last element
		expect(injectedIdx + 1).toBe(output.messages.length - 1);
	});

	// -----------------------------------------------------------------------
	// Budget cap: injected block must not exceed inject_char_budget
	// -----------------------------------------------------------------------

	it('injected block length does not exceed inject_char_budget (2000 chars) at 181,526 chars', async () => {
		const hook = createKnowledgeInjectorHook(tempDir, CONFIG);
		const messages = makeMessages(181_526);
		const output = { messages };

		await hook({} as Record<string, never>, output);

		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeDefined();

		const blockLength = totalTextLength(injected!);
		expect(blockLength).toBeLessThanOrEqual(CONFIG.inject_char_budget ?? 2000);
	});

	// -----------------------------------------------------------------------
	// Moderate regime: 20–60% headroom → half budget
	// -----------------------------------------------------------------------

	it('injects at moderate regime for 181k chars (headroom ~53% of model limit)', async () => {
		// 181k existing → headroom = ~206k → headroom/limit ≈ 53% → moderate regime
		// Moderate regime budget = floor(2000 * 0.5) = 1000 chars
		const hook = createKnowledgeInjectorHook(tempDir, CONFIG);
		const output = { messages: makeMessages(181_000) };

		await hook({} as Record<string, never>, output);

		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeDefined();

		// Moderate budget is 1000 — injected block must respect this
		const blockLength = totalTextLength(injected!);
		expect(blockLength).toBeLessThanOrEqual(1000);
	});

	// -----------------------------------------------------------------------
	// Low regime: <20% headroom → quarter budget
	// -----------------------------------------------------------------------

	it('injects at low regime for 370k chars (headroom ~4.6% of model limit)', async () => {
		// 370k existing → headroom = ~17k → headroom/limit ≈ 4.6% → low regime
		// Low regime budget = floor(2000 * 0.25) = 500 chars
		const hook = createKnowledgeInjectorHook(tempDir, CONFIG);
		const output = { messages: makeMessages(370_000) };

		await hook({} as Record<string, never>, output);

		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeDefined();

		const blockLength = totalTextLength(injected!);
		expect(blockLength).toBeLessThanOrEqual(500);
	});

	// -----------------------------------------------------------------------
	// Near-limit skip: headroom < 300 chars → skip injection (logged via debug-gated warn)
	// -----------------------------------------------------------------------

	it('skips injection when headroom is below 300 chars', async () => {
		// Leave only 200 chars of headroom — below the 300-char MIN_INJECT_CHARS threshold
		const nearLimitChars = MODEL_LIMIT_CHARS - 200;
		const hook = createKnowledgeInjectorHook(tempDir, CONFIG);
		const messages = makeMessages(nearLimitChars);
		const originalLength = messages.length;
		const output = { messages };

		await hook({} as Record<string, never>, output);

		// No injection should have happened
		expect(output.messages.length).toBe(originalLength);
		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeUndefined();
	});

	// -----------------------------------------------------------------------
	// Boundary tests: exactly at, just below, zero, and negative headroom
	// -----------------------------------------------------------------------

	it('injects when headroom is exactly at the 300-char threshold', async () => {
		// Exactly 300 chars of headroom — 300 < 300 is FALSE, so injection proceeds
		const atThresholdChars = MODEL_LIMIT_CHARS - 300;
		const hook = createKnowledgeInjectorHook(tempDir, CONFIG);
		const messages = makeMessages(atThresholdChars);
		const originalLength = messages.length;
		const output = { messages };

		await hook({} as Record<string, never>, output);

		// Injection should have happened
		expect(output.messages.length).toBeGreaterThan(originalLength);
		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeDefined();
		const blockLength = totalTextLength(injected!);
		expect(blockLength).toBeLessThanOrEqual(500);
	});

	it('skips injection when headroom is 299 chars (just below threshold)', async () => {
		// 299 chars of headroom — 299 < 300 is TRUE, so injection is skipped
		const justBelowChars = MODEL_LIMIT_CHARS - 299;
		const hook = createKnowledgeInjectorHook(tempDir, CONFIG);
		const messages = makeMessages(justBelowChars);
		const originalLength = messages.length;
		const output = { messages };

		await hook({} as Record<string, never>, output);

		// No injection should have happened
		expect(output.messages.length).toBe(originalLength);
		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeUndefined();
	});

	it('skips injection when headroom is zero', async () => {
		// Zero headroom — 0 < 300 is TRUE, so injection is skipped
		const zeroHeadroomChars = MODEL_LIMIT_CHARS;
		const hook = createKnowledgeInjectorHook(tempDir, CONFIG);
		const messages = makeMessages(zeroHeadroomChars);
		const originalLength = messages.length;
		const output = { messages };

		await hook({} as Record<string, never>, output);

		// No injection should have happened
		expect(output.messages.length).toBe(originalLength);
		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeUndefined();
	});

	it('skips injection when headroom is negative', async () => {
		// Negative headroom (over limit) — -5000 < 300 is TRUE, so injection is skipped
		const negativeHeadroomChars = MODEL_LIMIT_CHARS + 5000;
		const hook = createKnowledgeInjectorHook(tempDir, CONFIG);
		const messages = makeMessages(negativeHeadroomChars);
		const originalLength = messages.length;
		const output = { messages };

		await hook({} as Record<string, never>, output);

		// No injection should have happened
		expect(output.messages.length).toBe(originalLength);
		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeUndefined();
	});

	// -----------------------------------------------------------------------
	// Full budget: >60% headroom → full 2000 char budget
	// -----------------------------------------------------------------------

	it('injects at full budget when context is small (20k chars, >60% headroom)', async () => {
		const hook = createKnowledgeInjectorHook(tempDir, CONFIG);
		const output = { messages: makeMessages(20_000) };

		await hook({} as Record<string, never>, output);

		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeDefined();

		// Full budget is 2000 chars — injected block must fit within it
		const blockLength = totalTextLength(injected!);
		expect(blockLength).toBeLessThanOrEqual(2000);
	});

	// -----------------------------------------------------------------------
	// Compact format: [S]/[H] tier markers, no star ratings
	// -----------------------------------------------------------------------

	it('injected block uses [S] tier marker and no star ratings', async () => {
		const hook = createKnowledgeInjectorHook(tempDir, CONFIG);
		const output = { messages: makeMessages(20_000) };

		await hook({} as Record<string, never>, output);

		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeDefined();

		const text = injected!.parts.map((p) => p.text ?? '').join('');
		expect(text).toContain('[S]');
		// Star ratings (★) must not appear
		expect(text).not.toContain('★');
	});
});
