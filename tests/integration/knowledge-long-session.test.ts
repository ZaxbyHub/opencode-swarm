/**
 * Integration test: knowledge injection through long session simulation.
 * Exercises the REAL hook path via createKnowledgeInjectorHook.
 *
 * Note: The hook internally calls getRunMemorySummary() which uses
 * validateDirectory() that rejects absolute paths. To work around this,
 * we create temp directories as relative paths under the project root.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createKnowledgeInjectorHook } from '../../src/hooks/knowledge-injector.js';
import type {
	KnowledgeConfig,
	MessageWithParts,
} from '../../src/hooks/knowledge-types.js';
// (#1849) Identity is recovered from swarmState.activeAgent (primary) or the
// last user message's info.agent (fallback) — never from a role:'system'
// message. Fixtures set swarmState.activeAgent and stamp a consistent
// sessionID on every message.
import { swarmState } from '../../src/state';

const SESSION_ID = 'long-session';

// ---------------------------------------------------------------------------
// Constants (mirror the values in knowledge-injector.ts)
// ---------------------------------------------------------------------------
const CHARS_PER_TOKEN = 1 / 0.33;
const MODEL_LIMIT_CHARS = Math.floor(128_000 * CHARS_PER_TOKEN); // ~387,878

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PLAN_JSON = JSON.stringify({
	schema_version: '1.0.0',
	swarm: 'test-swarm',
	title: 'Test Plan',
	current_phase: 1,
	phases: [{ id: 1, name: 'Phase 1', status: 'in_progress', tasks: [] }],
});

function makeKnowledgeEntry(id: string, lesson: string) {
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
			applied_count: 1,
			succeeded_after_count: 1,
			failed_after_count: 0,
		},
		schema_version: 1,
		created_at: '2024-01-01T00:00:00.000Z',
		updated_at: '2024-01-01T00:00:00.000Z',
		project_name: 'test',
	});
}

const KNOWLEDGE_JSONL = [
	makeKnowledgeEntry('aaaa-1111', 'Always run tests before merging'),
	makeKnowledgeEntry('bbbb-2222', 'Use structured logging for debugging'),
	makeKnowledgeEntry('cccc-3333', 'Pin dependency versions in CI'),
].join('\n');

const config: KnowledgeConfig = {
	enabled: true,
	swarm_max_entries: 100,
	hive_max_entries: 200,
	auto_promote_days: 90,
	max_inject_count: 5,
	inject_char_budget: 2000,
	dedup_threshold: 0.6,
	scope_filter: ['global'],
	hive_enabled: false, // disable hive reads so we don't need a hive file
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
 * Creates a relative temp directory under the project root (tmp/).
 * We must use a relative path because getRunMemorySummary's
 * validateDirectory() rejects absolute paths.
 */
function createRelativeTempDir(): string {
	const baseDir = 'tmp';
	if (!fs.existsSync(baseDir)) {
		fs.mkdirSync(baseDir, { recursive: true });
	}
	return fs.mkdtempSync(path.join(baseDir, 'ki-test-'));
}

function createMessages(
	totalChars: number,
	agentName = 'architect',
): MessageWithParts[] {
	// (#1849) Drive identity via swarmState.activeAgent (the production path)
	// and stamp a consistent sessionID on every message.
	swarmState.activeAgent.set(SESSION_ID, agentName);
	const systemMsg: MessageWithParts = {
		info: { role: 'system', agent: agentName, sessionID: SESSION_ID },
		parts: [{ type: 'text', text: 'System prompt' }],
	};
	const userMsg: MessageWithParts = {
		info: { role: 'user', sessionID: SESSION_ID },
		parts: [{ type: 'text', text: 'x'.repeat(Math.max(1, totalChars - 13)) }],
	};
	return [systemMsg, userMsg];
}

function findInjectedMessage(
	messages: MessageWithParts[],
): MessageWithParts | undefined {
	return messages.find((m) =>
		m.parts?.some((p) => p.text?.includes('\u{1F4DA} Lessons:')),
	);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Knowledge injection long session integration', () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = createRelativeTempDir();
		const swarmDir = path.join(tempDir, '.swarm');
		fs.mkdirSync(swarmDir, { recursive: true });
		fs.writeFileSync(path.join(swarmDir, 'plan.json'), PLAN_JSON);
		fs.writeFileSync(path.join(swarmDir, 'knowledge.jsonl'), KNOWLEDGE_JSONL);
	});

	afterEach(() => {
		swarmState.activeAgent.delete(SESSION_ID);
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	// -----------------------------------------------------------------------
	// (a) Regime selection -- injection happens at various context sizes
	// -----------------------------------------------------------------------

	it('injects at full budget when context is small (20k chars)', async () => {
		const hook = createKnowledgeInjectorHook(tempDir, config);
		const messages = createMessages(20_000);
		const output = { messages };

		await hook({} as Record<string, never>, output);

		// A system message should have been injected (messages grew)
		expect(output.messages.length).toBeGreaterThan(2);

		// Find injected message
		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeDefined();
	});

	it('injects at moderate regime (~181k chars used, 20-60% headroom)', async () => {
		const hook = createKnowledgeInjectorHook(tempDir, config);
		const messages = createMessages(181_000);
		const output = { messages };

		await hook({} as Record<string, never>, output);

		// Should still inject (moderate regime, half budget)
		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeDefined();
	});

	it('injects at low regime (~370k chars used, 5-20% headroom)', async () => {
		const hook = createKnowledgeInjectorHook(tempDir, config);
		const messages = createMessages(370_000);
		const output = { messages };

		await hook({} as Record<string, never>, output);

		// Should still inject at low regime (quarter budget)
		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeDefined();
	});

	// -----------------------------------------------------------------------
	// (b) Injection placement -- just before last user message
	// -----------------------------------------------------------------------

	it('places injected message just before the last user message', async () => {
		const hook = createKnowledgeInjectorHook(tempDir, config);
		swarmState.activeAgent.set(SESSION_ID, 'architect');
		const messages: MessageWithParts[] = [
			{
				info: { role: 'system', agent: 'architect', sessionID: SESSION_ID },
				parts: [{ type: 'text', text: 'System prompt' }],
			},
			{
				info: { role: 'user', sessionID: SESSION_ID },
				parts: [{ type: 'text', text: 'First user message' }],
			},
			{
				info: { role: 'assistant', sessionID: SESSION_ID },
				parts: [{ type: 'text', text: 'Assistant reply' }],
			},
			{
				info: { role: 'user', sessionID: SESSION_ID },
				parts: [{ type: 'text', text: 'Second user message' }],
			},
		];
		const output = { messages };

		await hook({} as Record<string, never>, output);

		// Find the index of the injected knowledge message
		const injectedIdx = output.messages.findIndex((m) =>
			m.parts?.some((p) => p.text?.includes('\u{1F4DA} Lessons:')),
		);
		expect(injectedIdx).toBeGreaterThanOrEqual(0);

		// The message right after the injected one should be the last user message
		const nextMsg = output.messages[injectedIdx + 1];
		expect(nextMsg.info.role).toBe('user');
		expect(nextMsg.parts[0].text).toBe('Second user message');
	});

	// -----------------------------------------------------------------------
	// (c) Architect-only filtering
	// -----------------------------------------------------------------------

	it('does NOT inject for non-architect agents', async () => {
		const hook = createKnowledgeInjectorHook(tempDir, config);
		const messages = createMessages(20_000, 'developer');
		const originalLength = messages.length;
		const output = { messages };

		await hook({} as Record<string, never>, output);

		// No injection should have happened
		expect(output.messages.length).toBe(originalLength);
		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeUndefined();
	});

	it('does NOT inject for "reviewer" agent', async () => {
		const hook = createKnowledgeInjectorHook(tempDir, config);
		const messages = createMessages(20_000, 'reviewer');
		const output = { messages };

		await hook({} as Record<string, never>, output);

		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeUndefined();
	});

	it('does NOT inject when agent name is missing', async () => {
		const hook = createKnowledgeInjectorHook(tempDir, config);
		const messages: MessageWithParts[] = [
			{
				info: { role: 'system' },
				parts: [{ type: 'text', text: 'System prompt' }],
			},
			{
				info: { role: 'user' },
				parts: [{ type: 'text', text: 'Hello' }],
			},
		];
		const output = { messages };

		await hook({} as Record<string, never>, output);

		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeUndefined();
	});

	// -----------------------------------------------------------------------
	// (d) Knowledge content -- injected text includes lesson content
	// -----------------------------------------------------------------------

	it('injected text contains lesson content from knowledge.jsonl', async () => {
		const hook = createKnowledgeInjectorHook(tempDir, config);
		const messages = createMessages(20_000);
		const output = { messages };

		await hook({} as Record<string, never>, output);

		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeDefined();

		const injectedText = injected!.parts.map((p) => p.text ?? '').join('');

		// Verify lesson text is present
		expect(injectedText).toContain('Always run tests before merging');
		expect(injectedText).toContain('Use structured logging for debugging');
		expect(injectedText).toContain('Pin dependency versions in CI');
	});

	it('injected text includes tier markers', async () => {
		const hook = createKnowledgeInjectorHook(tempDir, config);
		const messages = createMessages(20_000);
		const output = { messages };

		await hook({} as Record<string, never>, output);

		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeDefined();

		const injectedText = injected!.parts.map((p) => p.text ?? '').join('');

		// All entries are swarm tier, so [S] markers expected
		expect(injectedText).toContain('[S]');
	});

	// -----------------------------------------------------------------------
	// (e) Skip at near-capacity -- headroom < 300 chars
	// -----------------------------------------------------------------------

	it('skips injection when headroom is less than 300 chars', async () => {
		const hook = createKnowledgeInjectorHook(tempDir, config);
		// Set total chars so headroom is < 300
		const targetChars = MODEL_LIMIT_CHARS - 200;
		const messages = createMessages(targetChars);
		const originalLength = messages.length;
		const output = { messages };

		await hook({} as Record<string, never>, output);

		// No injection should have happened
		expect(output.messages.length).toBe(originalLength);
		const injected = findInjectedMessage(output.messages);
		expect(injected).toBeUndefined();
	});

	it('skips injection when exactly at model limit', async () => {
		const hook = createKnowledgeInjectorHook(tempDir, config);
		const messages = createMessages(MODEL_LIMIT_CHARS);
		const originalLength = messages.length;
		const output = { messages };

		await hook({} as Record<string, never>, output);

		expect(output.messages.length).toBe(originalLength);
	});

	// -----------------------------------------------------------------------
	// Idempotency -- re-injection is blocked within the same call
	// -----------------------------------------------------------------------

	it('does not double-inject on repeated hook calls (idempotency)', async () => {
		const hook = createKnowledgeInjectorHook(tempDir, config);
		const messages = createMessages(20_000);
		const output = { messages };

		await hook({} as Record<string, never>, output);
		const countAfterFirst = output.messages.length;

		// Call again on the same output -- should not inject again
		await hook({} as Record<string, never>, output);
		expect(output.messages.length).toBe(countAfterFirst);
	});
});
