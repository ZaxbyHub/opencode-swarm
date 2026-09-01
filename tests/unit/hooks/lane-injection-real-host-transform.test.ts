/**
 * Issue #2045 — real-host transform injection for lane sessions.
 *
 * Invokes the REAL `experimental.chat.messages.transform` hook
 * (`createKnowledgeInjectorHook`) over a delegated session's message array —
 * no mocked internals beyond the `_internals.searchKnowledge` seam — and
 * asserts:
 *   - reviewer-role lane sessions receive the delegate directive block within
 *     the hard char cap, plus the per-phase compliance block (spliced IN PLACE,
 *     AGENTS.md invariant 10);
 *   - explorer/council roles (not delegated agents) receive NO directives;
 *   - the compliance block never double-delivers when the Task path already
 *     prepended one into the prompt.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { DIRECTIVES_TO_VERIFY_TAG } from '../../../src/agents/reviewer-directive-compliance.js';
import type { MessageWithParts } from '../../../src/hooks/knowledge-injector.js';
import {
	createKnowledgeInjectorHook,
	DELEGATE_DIRECTIVE_BLOCK_TAG,
	DELEGATE_INJECT_HARD_CHAR_CAP,
	_internals as injectorInternals,
} from '../../../src/hooks/knowledge-injector.js';
import type { RankedEntry } from '../../../src/hooks/knowledge-reader.js';
import { commitDisplayedMembership } from '../../../src/hooks/knowledge-receipt-ledger.js';
import {
	appendKnowledge,
	resolveSwarmKnowledgePath,
} from '../../../src/hooks/knowledge-store.js';
import type {
	KnowledgeConfig,
	SwarmKnowledgeEntry,
} from '../../../src/hooks/knowledge-types.js';
import { swarmState } from '../../../src/state.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

const SESSION_ID = 'sess-transform-2045';

function config(overrides: Partial<KnowledgeConfig> = {}): KnowledgeConfig {
	return {
		enabled: true,
		swarm_max_entries: 100,
		hive_max_entries: 200,
		auto_promote_days: 90,
		max_inject_count: 5,
		delegate_max_inject_count: 8,
		inject_char_budget: 2_000,
		dedup_threshold: 0.6,
		scope_filter: ['global'],
		hive_enabled: true,
		rejected_max_entries: 20,
		validation_enabled: true,
		evergreen_confidence: 0.9,
		evergreen_utility: 0.8,
		low_utility_threshold: 0.3,
		min_retrievals_for_utility: 3,
		schema_version: 1,
		receipt_close_grace_days: 7,
		...overrides,
	} as KnowledgeConfig;
}

function delegatedEntry(id: string, priority = 'high'): RankedEntry {
	return {
		id,
		tier: 'swarm',
		lesson: `lesson body for ${id}`,
		category: 'process',
		tags: [],
		scope: 'global',
		confidence: 0.8,
		status: 'established',
		confirmed_by: [],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		directive_priority: priority as RankedEntry['directive_priority'],
		relevanceScore: { category: 0, confidence: 0, keywords: 0 },
		finalScore: 0.5,
	} as RankedEntry;
}

function laneMessages(
	agent: string,
	sessionId: string = SESSION_ID,
): { messages: MessageWithParts[] } {
	return {
		messages: [
			{
				info: { role: 'system', agent, sessionID: sessionId },
				parts: [{ type: 'text', text: 'system preamble' }],
			},
			{
				info: { role: 'user', sessionID: sessionId },
				parts: [{ type: 'text', text: 'review the diff for lane work' }],
			},
		],
	};
}

function injectedText(output: { messages: MessageWithParts[] }): string {
	return output.messages
		.flatMap((m) => m.parts?.map((p) => p.text ?? '') ?? [])
		.join('\n');
}

/** Seed a real knowledge-store entry so readPhaseDirectivesToVerify can resolve it. */
async function seedKnowledgeEntry(
	directory: string,
	id: string,
): Promise<void> {
	const entry: SwarmKnowledgeEntry = {
		id,
		tier: 'swarm',
		lesson: `Lesson for ${id} — always validate inputs`,
		category: 'process',
		tags: ['validation'],
		scope: 'global',
		confidence: 0.85,
		status: 'established',
		confirmed_by: [],
		project_name: 'test-project',
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		directive_priority: 'high',
	} as SwarmKnowledgeEntry;
	await appendKnowledge(resolveSwarmKnowledgePath(directory), entry);
}

describe('lane injection via the real messages.transform hook (issue #2045)', () => {
	let dir: string;
	let prevHome: string | undefined;
	let prevLocalAppData: string | undefined;
	let prevXdgDataHome: string | undefined;
	const realSearch = injectorInternals.searchKnowledge;

	beforeEach(() => {
		dir = canonicalMkdtemp('lane-injection-transform-');
		fs.writeFileSync(path.join(dir, '.git'), 'gitdir: fixture');
		// Isolate hive/home resolution (phase-directives test precedent).
		prevHome = process.env.HOME;
		prevLocalAppData = process.env.LOCALAPPDATA;
		prevXdgDataHome = process.env.XDG_DATA_HOME;
		const isolatedHome = path.join(dir, 'home');
		fs.mkdirSync(isolatedHome, { recursive: true });
		process.env.HOME = isolatedHome;
		process.env.LOCALAPPDATA = path.join(dir, 'localappdata');
		process.env.XDG_DATA_HOME = path.join(dir, 'xdg-data');
		swarmState.activeAgent.set(SESSION_ID, 'reviewer');
	});

	afterEach(() => {
		injectorInternals.searchKnowledge = realSearch;
		swarmState.activeAgent.delete(SESSION_ID);
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		if (prevLocalAppData === undefined) delete process.env.LOCALAPPDATA;
		else process.env.LOCALAPPDATA = prevLocalAppData;
		if (prevXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
		else process.env.XDG_DATA_HOME = prevXdgDataHome;
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('injects the delegate block within the hard cap for a reviewer lane session', async () => {
		injectorInternals.searchKnowledge = (async () => ({
			results: Array.from({ length: 8 }, (_, i) =>
				delegatedEntry(`entry-${i}`, 'high'),
			),
			trace_id: 'trace-transform-2045',
		})) as typeof realSearch;

		const hook = createKnowledgeInjectorHook(dir, config());
		const output = laneMessages('reviewer');
		const messagesBefore = output.messages.length;
		const arrayIdentity = output.messages;

		await hook({}, output);

		// In-place mutation (AGENTS.md invariant 10): same array, grown.
		expect(output.messages).toBe(arrayIdentity);
		expect(output.messages.length).toBeGreaterThan(messagesBefore);
		const text = injectedText(output);
		expect(text).toContain(DELEGATE_DIRECTIVE_BLOCK_TAG);
		// The delegate block itself never exceeds the hard cap.
		const blockStart = text.indexOf(DELEGATE_DIRECTIVE_BLOCK_TAG);
		const blockEnd = text.indexOf('</delegate_knowledge_directives>');
		expect(blockEnd).toBeGreaterThan(blockStart);
		expect(
			blockEnd + '</delegate_knowledge_directives>'.length - blockStart,
		).toBeLessThanOrEqual(DELEGATE_INJECT_HARD_CHAR_CAP);
	});

	it('splices the reviewer compliance block for reviewer sessions only', async () => {
		// Seed a live membership + its knowledge entry so
		// readPhaseDirectivesToVerify has resolvable content.
		await seedKnowledgeEntry(dir, 'entry-review-1');
		await commitDisplayedMembership(dir, {
			trace_id: 'trace-transform-2045',
			session_id: SESSION_ID,
			phase: 'Phase 1',
			agent: 'reviewer',
			exposure_kind: 'delegate_directive',
			entries: [{ entry_id: 'entry-review-1', critical: false }],
		});
		// Every retrieval mints its OWN trace (production behavior). Reusing the
		// seeded membership's trace here would trip the injector's
		// terminal_trace_reuse guard and silently skip the delegate block,
		// making the ordering assertion below vacuously true (external F-003).
		let searchCalls = 0;
		injectorInternals.searchKnowledge = (async () => {
			searchCalls += 1;
			return {
				results: [delegatedEntry('entry-review-1')],
				trace_id: `trace-transform-2045-call-${searchCalls}`,
			};
		}) as typeof realSearch;

		const hook = createKnowledgeInjectorHook(dir, config());
		const reviewerOutput = laneMessages('reviewer');
		await hook({}, reviewerOutput);
		const reviewerText = injectedText(reviewerOutput);
		expect(reviewerText).toContain(DIRECTIVES_TO_VERIFY_TAG);
		// Non-vacuous ordering proof: BOTH blocks must render, compliance after
		// the delegate block (same reading order as the Task prompt-prepend path).
		expect(reviewerText).toContain(DELEGATE_DIRECTIVE_BLOCK_TAG);
		expect(reviewerText.indexOf(DIRECTIVES_TO_VERIFY_TAG)).toBeGreaterThan(
			reviewerText.indexOf(DELEGATE_DIRECTIVE_BLOCK_TAG),
		);

		// A non-reviewer delegated role (sme, in its OWN session) gets the
		// delegate block but NEVER the reviewer grammar.
		const SME_SESSION_ID = 'sess-transform-2045-sme';
		swarmState.activeAgent.set(SME_SESSION_ID, 'sme');
		const smeOutput = laneMessages('sme', SME_SESSION_ID);
		await hook({}, smeOutput);
		const smeText = injectedText(smeOutput);
		expect(smeText).toContain(DELEGATE_DIRECTIVE_BLOCK_TAG);
		expect(smeText).not.toContain(DIRECTIVES_TO_VERIFY_TAG);
		swarmState.activeAgent.delete(SME_SESSION_ID);
	});

	it('never injects directives into non-delegated lane roles (explorer/council)', async () => {
		injectorInternals.searchKnowledge = (async () => ({
			results: [delegatedEntry('entry-x')],
			trace_id: 'trace-transform-2045',
		})) as typeof realSearch;

		for (const agent of ['explorer', 'council_skeptic']) {
			swarmState.activeAgent.set(SESSION_ID, agent);
			const hook = createKnowledgeInjectorHook(dir, config());
			const output = laneMessages(agent);
			const before = output.messages.length;
			await hook({}, output);
			expect(output.messages.length).toBe(before);
			expect(injectedText(output)).not.toContain(DELEGATE_DIRECTIVE_BLOCK_TAG);
		}
	});

	it('role matrix: test_engineer and sme get the ACK self-report grammar, never reviewer compliance', async () => {
		// Issue #2045 role contract: reviewer = structured per-directive
		// compliance adjudication; test_engineer = structured verification
		// evidence (the ACK grammar's verification markers — NOT final semantic
		// compliance); other delegated roles = ACK | IGNORED | N_A self-report.
		// Structurally: every delegated role EXCEPT reviewer receives the ACK
		// block only; the compliance grammar is reviewer-exclusive.
		await seedKnowledgeEntry(dir, 'entry-role-1');
		await commitDisplayedMembership(dir, {
			trace_id: 'trace-transform-2045',
			session_id: SESSION_ID,
			phase: 'Phase 1',
			agent: 'reviewer',
			exposure_kind: 'delegate_directive',
			entries: [{ entry_id: 'entry-role-1', critical: false }],
		});
		for (const agent of ['test_engineer', 'mega_test_engineer', 'sme']) {
			const sessionId = `sess-role-${agent.replace(/[^a-z]/gi, '')}`;
			swarmState.activeAgent.set(sessionId, agent);
			injectorInternals.searchKnowledge = (async () => ({
				results: [delegatedEntry('entry-role-1')],
				trace_id: `trace-role-${sessionId}`,
			})) as typeof realSearch;
			const hook = createKnowledgeInjectorHook(dir, config());
			const output = laneMessages(agent, sessionId);
			await hook({}, output);
			const text = injectedText(output);
			expect(text).toContain(DELEGATE_DIRECTIVE_BLOCK_TAG);
			// Verification-evidence grammar present (KNOWLEDGE_* markers), final
			// compliance grammar ABSENT.
			expect(text).toContain('KNOWLEDGE_APPLIED:');
			expect(text).not.toContain(DIRECTIVES_TO_VERIFY_TAG);
			expect(text).not.toContain('DIRECTIVE_COMPLIANCE:');
			swarmState.activeAgent.delete(sessionId);
		}
	});

	it('does not double-deliver the compliance block when the prompt already carries one', async () => {
		await seedKnowledgeEntry(dir, 'entry-review-1');
		await commitDisplayedMembership(dir, {
			trace_id: 'trace-transform-2045',
			session_id: SESSION_ID,
			phase: 'Phase 1',
			agent: 'reviewer',
			exposure_kind: 'delegate_directive',
			entries: [{ entry_id: 'entry-review-1', critical: false }],
		});
		injectorInternals.searchKnowledge = (async () => ({
			results: [],
			trace_id: 'trace-transform-2045-empty',
		})) as typeof realSearch;

		const hook = createKnowledgeInjectorHook(dir, config());
		// The Task prompt-prepend path already embedded a WELL-FORMED
		// directives-to-verify block in the delegation prompt (now the user
		// message). The structural guard (parseDirectivesToVerifyBlock) must
		// recognize it — a bare tag alone must NOT count, so the fixture has to
		// carry a complete record (trace/entry/session/priority).
		const encoded = (value: string) => encodeURIComponent(value);
		const output = laneMessages('reviewer');
		output.messages[1].parts = [
			{
				type: 'text',
				text: [
					DIRECTIVES_TO_VERIFY_TAG,
					`- trace_id: ${encoded('trace-prefetch')}`,
					`  entry_id: ${encoded('entry-prefetch')}`,
					`  session_id: ${encoded(SESSION_ID)}`,
					'  priority: medium',
					'</directives_to_verify>',
					'',
					'review the diff',
				].join('\n'),
			},
		];
		const before = output.messages.length;
		await hook({}, output);
		expect(output.messages.length).toBe(before);
		expect(
			injectedText(output).match(new RegExp(DIRECTIVES_TO_VERIFY_TAG, 'g')),
		).toHaveLength(1);
	});

	it('delivers the compliance block even when prompt text quotes the bare tag (F-001 regression)', async () => {
		// External review F-001: the old guard matched the raw tag substring, so
		// ordinary content — a prompt quoting the tag constant, or a stored
		// lesson quoting it — self-suppressed the compliance block, and settle
		// then fabricated CRITICAL reviewer_omitted verdicts for directives the
		// reviewer never saw. The structural guard must deliver anyway.
		await seedKnowledgeEntry(dir, 'entry-review-1');
		await commitDisplayedMembership(dir, {
			trace_id: 'trace-transform-2045',
			session_id: SESSION_ID,
			phase: 'Phase 1',
			agent: 'reviewer',
			exposure_kind: 'delegate_directive',
			entries: [{ entry_id: 'entry-review-1', critical: false }],
		});
		injectorInternals.searchKnowledge = (async () => ({
			results: [],
			trace_id: 'trace-transform-2045-poison',
		})) as typeof realSearch;

		const hook = createKnowledgeInjectorHook(dir, config());
		const output = laneMessages('reviewer');
		// Poison: the prompt quotes the tag constant and a malformed fragment —
		// NOT a well-formed verify block (no record fields).
		output.messages[1].parts = [
			{
				type: 'text',
				text: [
					"Verify the constant DIRECTIVES_TO_VERIFY_TAG = '<directives_to_verify>' in reviewer-directive-compliance.ts.",
					'</directives_to_verify>',
					'review the diff',
				].join('\n'),
			},
		];
		const before = output.messages.length;
		await hook({}, output);
		// The compliance block MUST still be delivered: the prompt's own tag
		// quote (1) + the injected block (1) = 2 occurrences. Under the old
		// substring guard the block was suppressed and the total stayed at 1.
		expect(output.messages.length).toBe(before + 1);
		expect(
			injectedText(output).match(new RegExp(DIRECTIVES_TO_VERIFY_TAG, 'g')),
		).toHaveLength(2);
	});
});
