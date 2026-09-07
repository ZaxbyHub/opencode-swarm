/**
 * Issue #2526 residual closure (AC4): the trace-only turn and its two
 * controls, in one file, through the REAL composed
 * `experimental.chat.messages.transform` chain.
 *
 *  Leg 1 (mixed flat control): a --trace turn (issue-reference + trace state +
 *      spec seeded exactly like `host-rendered-guidance-2526.test.ts`) whose
 *      incoming messages array mixes ONE legacy FLAT parts-less user entry
 *      (`{ info, content: [...] }`-shaped, issue #1778 H1) with normal
 *      parts-shaped entries. The transform must not throw, must leave no
 *      `role:'system'` entries, must introduce no parts-less entries of its
 *      own (the pinned host converter dereferences `msg.parts` unconditionally
 *      — a TypeError can only be excused for the pre-existing flat control
 *      entry), and the `[MODE: ...]` directive must still reach the rendered
 *      request.
 *  Leg 2 (injection-free control): the identical turn shape on a project with
 *      NOTHING seeded (no trace state, no advisory, no knowledge, no memory,
 *      no approved plan) and a child-role session — every injector is idle, so
 *      the output must contain NO guidance carriers (no `swarm-guidance:` ids)
 *      and render cleanly through the pinned converter.
 *  Leg 3 (parts-only control): the trace turn with an all-parts input — same
 *      MODE-directive delivery assertion as leg 1, proving the flat entry is
 *      not load-bearing for delivery.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import OpenCodeSwarmPlugin from '../../../src/index';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../src/state';
import {
	type HostPartsMessage,
	hostToModelMessages,
	renderedText,
} from '../../helpers/host-contract-v1_18_3';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../../helpers/knowledge-real-host';
import { safeRmRecursive } from '../../helpers/safe-test-dir';

const SESSION_ID = 'trace-controls-2526';

function writeJson(directory: string, name: string, value: unknown): void {
	writeFileSync(
		path.join(directory, '.swarm', name),
		JSON.stringify(value, null, 2),
		'utf-8',
	);
}

/** Trace-state seeding, exactly like the sibling exit-gate test's --trace leg. */
function seedTraceState(directory: string): void {
	writeJson(directory, 'issue-reference.json', {
		url: 'https://github.com/owner/repo/issues/4242',
		owner: 'owner',
		repo: 'repo',
		number: 4242,
		timestamp: '2026-01-01T00:00:00Z',
		flags: { trace: true, noRepro: true },
	});
	writeJson(directory, 'issue-trace-state.json', {
		issueNumber: 4242,
		lastTransition: null,
		status: 'in_progress',
	});
	writeFileSync(
		path.join(directory, '.swarm', 'spec.md'),
		'# Spec\n\n## Source Issue\n\n- Number: 4242\n\n## Details\n',
		'utf-8',
	);
}

function partsUserMessage(text: string, id: string): HostPartsMessage {
	return {
		info: { id, role: 'user', agent: 'architect', sessionID: SESSION_ID },
		parts: [{ type: 'text', text }],
	};
}

/** The pinned host renders only parts-bearing entries; the flat control entry
 * is excluded by construction (its `msg.parts.length` dereference is the
 * TypeError the host itself would throw — leg 1 asserts the plugin added no
 * NEW parts-less entries, so every exclusion is the original input entry). */
function renderPartsBearing(messages: HostPartsMessage[]): string {
	const partsBearing = messages.filter((m) =>
		Array.isArray((m as unknown as { parts?: unknown }).parts),
	);
	return renderedText(hostToModelMessages(partsBearing));
}

function countSystemEntries(messages: HostPartsMessage[]): number {
	return messages.filter(
		(m) =>
			(m as unknown as { info?: { role?: string } }).info?.role === 'system',
	).length;
}

function countGuidanceCarriers(messages: HostPartsMessage[]): number {
	return messages.filter((m) =>
		String(
			(m as unknown as { info?: { id?: unknown } }).info?.id ?? '',
		).startsWith('swarm-guidance:'),
	).length;
}

/**
 * Boot the REAL plugin WITHOUT the approved-plan fixture. The injection-free
 * control needs a project where no plan-driven injector (delegation-gate
 * [NEXT] deliberation preamble, guardrails partial-gate guidance,
 * pipeline-tracker workflow reminder) has anything to say —
 * `bootKnowledgeHost` always writes an approved plan, which makes those fire.
 */
async function bootPlanlessHost(
	directory: string,
): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> {
	const opencodeDir = path.join(directory, '.opencode');
	mkdirSync(opencodeDir, { recursive: true });
	writeFileSync(
		path.join(opencodeDir, 'opencode-swarm.json'),
		JSON.stringify(
			{
				version_check: false,
				knowledge: { enabled: true, hive_enabled: false },
				guardrails: { enabled: true },
			},
			null,
			2,
		),
		'utf-8',
	);
	// The raw server() result IS the hook record (bootKnowledgeHost wraps it
	// as { hooks, tool } — here the hooks record is returned directly).
	const result = await (
		OpenCodeSwarmPlugin as unknown as {
			server: (ctx: unknown) => Promise<Record<string, unknown>>;
		}
	).server({
		client: {},
		project: {} as unknown,
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {} as unknown,
	});
	return result as unknown as Record<
		string,
		(...args: unknown[]) => Promise<unknown>
	>;
}

describe('host-rendered trace-turn guidance controls (issue #2526 AC4)', () => {
	let directory = '';

	beforeEach(() => {
		resetSwarmState();
		directory = createKnowledgeProject();
	});

	afterEach(() => {
		resetSwarmState();
		try {
			safeRmRecursive(directory);
		} catch {
			// Best-effort teardown only (Windows EBUSY from background workers).
		}
	});

	test('leg 1: mixed flat/parts input on a trace turn — no throw, no system entries, MODE delivered', async () => {
		seedTraceState(directory);
		const plugin = await bootKnowledgeHost(directory);
		ensureAgentSession(SESSION_ID, 'architect', directory);
		swarmState.activeAgent.set(SESSION_ID, 'architect');

		// Legacy flat parts-less user entry (issue #1778 H1 shape). This is the
		// hostile control: pre-#2526 the issue-trace injector pushed more flat
		// entries; the fixed chain must leave this one untouched and add none.
		const legacyFlatUser = {
			info: {
				id: 'u0',
				role: 'user',
				agent: 'architect',
				sessionID: SESSION_ID,
			},
			content: [{ type: 'text', text: 'legacy flat user entry' }],
		};
		const messages: HostPartsMessage[] = [
			legacyFlatUser as never,
			partsUserMessage('next step please'),
		];

		// Pre-#2526 this exact turn threw inside the host converter because
		// issue-trace pushed flat {role:'system', content:[...]} entries.
		await plugin.hooks['experimental.chat.messages.transform'](
			{},
			{ messages: messages as never },
		);

		expect(countSystemEntries(messages)).toBe(0);

		// The ONLY parts-less entry left is the original flat control entry,
		// passed through untouched — no TypeError can originate from OUR entries.
		const partsLess = messages.filter(
			(m) => !Array.isArray((m as unknown as { parts?: unknown }).parts),
		);
		expect(partsLess).toHaveLength(1);
		expect(partsLess[0]).toBe(legacyFlatUser as never);

		const text = renderPartsBearing(messages);
		expect(text).toMatch(/\[MODE: [A-Z_]+\]/);
	});

	test('leg 2: injection-free control — no trace state seeded, no carriers, renders cleanly', async () => {
		// The beforeEach project is bare (no trace state, no advisory, no
		// knowledge, no memory); boot it WITHOUT the approved-plan fixture so no
		// plan-driven injector fires either. A child-role session keeps every
		// architect-only injector (delegation deliberation preamble, partial
		// gate guidance, workflow reminder) idle as well.
		const plugin = await bootPlanlessHost(directory);
		const childSession = 'trace-controls-child-2526';
		ensureAgentSession(childSession, 'coder', directory);
		swarmState.activeAgent.set(childSession, 'coder');

		const legacyFlatUser = {
			info: { id: 'u0', role: 'user', agent: 'coder', sessionID: childSession },
			content: [{ type: 'text', text: 'legacy flat user entry' }],
		};
		const messages: HostPartsMessage[] = [
			legacyFlatUser as never,
			{
				info: {
					id: 'u1',
					role: 'user',
					agent: 'coder',
					sessionID: childSession,
				},
				parts: [{ type: 'text', text: 'next step please' }],
			},
		];
		await plugin['experimental.chat.messages.transform'](
			{},
			{ messages: messages as never },
		);

		expect(countGuidanceCarriers(messages)).toBe(0);
		expect(countSystemEntries(messages)).toBe(0);
		const text = renderPartsBearing(messages);
		expect(text).toBe('next step please');
		expect(text).not.toContain('<swarm_system_directive');
	});

	test('leg 3: parts-only input on a trace turn — MODE directive delivered', async () => {
		seedTraceState(directory);
		const plugin = await bootKnowledgeHost(directory);
		ensureAgentSession(SESSION_ID, 'architect', directory);
		swarmState.activeAgent.set(SESSION_ID, 'architect');

		const messages: HostPartsMessage[] = [partsUserMessage('next step please')];
		await plugin.hooks['experimental.chat.messages.transform'](
			{},
			{ messages: messages as never },
		);

		expect(countSystemEntries(messages)).toBe(0);
		// All-parts input: the whole array converts through the pinned host
		// converter without any filtering.
		const text = renderedText(hostToModelMessages(messages));
		expect(text).toMatch(/\[MODE: [A-Z_]+\]/);
	});
});
