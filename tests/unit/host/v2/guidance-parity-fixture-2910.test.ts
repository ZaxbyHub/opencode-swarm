/**
 * Issue #2910 residual scope item 2 — v2 guidance-parity check, mirroring the
 * v1 fixture methodology (tests/unit/hooks/host-rendered-request-2526.test.ts).
 *
 * The v1 side proves guidance delivery by re-deriving the pinned host's
 * rendered provider request from fixed seeds (knowledge entry + memory record
 * + pendingAdvisory, frozen clock) through the REAL registered
 * `experimental.chat.messages.transform` chain and deep-equaling a committed
 * fixture. The v2 side had NO equivalent: this file is it.
 *
 * Methodology (same seeds, v2 adapter path):
 *  1. boot the REAL plugin via `bootKnowledgeHost` (v1 `server()` — the v2
 *     adapter consumes the SAME v1 hooks object);
 *  2. register the REAL `registerV2ContextHook` (src/host/v2/guidance.ts)
 *     against a fake V2PluginContext whose `session.hook('context', …)`
 *     CAPTURES the callback (no mock.module — a plain recording fake);
 *  3. invoke the captured callback with a v2 SessionContext event carrying
 *     the SAME seed transcript as the v1 fixture test (u1/a1/u2 over the
 *     `orbit-flanger-capture` keyword, frozen clock around the run);
 *  4. render the post-hook event through the DISTILLED pinned-v2-host
 *     renderer (tests/helpers/host-contract-v2_0_29.ts, provenance
 *     sst/opencode v2.0.29 model-request.ts + context.ts) and assert.
 *
 * CHOSEN ASSERTION SHAPE — keyword classes + carrier-absence + fence
 * presence, NOT a byte-frozen fixture JSON. Why: the v2 renderer's joined
 * text embeds the same per-run random tokens the v1 fixture normalizes
 * (knowledge trace_id uuid, mem_<hash> record id, machine-dependent
 * pre-flight advisory list) PLUS the full host base-system prompt surface
 * (`baseTranscript` combines agent.system, instruction layers, date and
 * environment blocks — date-bearing on a weekly-schedule check), so a
 * byte-frozen fixture would need per-run normalization broad enough to be
 * vacuous. The stable, honest contract is: all three injection classes
 * (DEGRADED advisory / knowledge recall / memory recall) reach the RENDERED
 * REQUEST text, every `swarm-guidance:*` carrier is RE-HOMED into the
 * rendered SYSTEM surface (fence intact) and ZERO carriers (or fence text)
 * remain on USER messages, and the transcript + host base system prompt
 * survive verbatim. That set is deterministic across runs and platforms.
 *
 * Class: NEW-SURFACE (the helper + this check did not exist at base; the
 * v2 re-homing transport itself is landed, so the expected result at base
 * with these files present is GREEN — this file FREEZES the parity contract
 * the #2910 follow-up (v2 CI lane, host-contract v2 digest leg) must keep
 * holding).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { registerV2ContextHook } from '../../../../src/host/v2/guidance';
import type { V2Registration } from '../../../../src/host/v2/types';
import { resolveMemoryConfig } from '../../../../src/memory/config';
import {
	createConfiguredMemoryProvider,
	MemoryGateway,
} from '../../../../src/memory/gateway';
import {
	computeMemoryContentHash,
	createMemoryId,
} from '../../../../src/memory/schema';
import type { MemoryRecord } from '../../../../src/memory/types';
import {
	ensureAgentSession,
	resetSwarmState,
	swarmState,
} from '../../../../src/state';
import {
	hostV2ToModelRequest,
	renderedV2RequestText,
	renderedV2SystemText,
	type V2PostContextEvent,
} from '../../../helpers/host-contract-v2_0_29';
import {
	bootKnowledgeHost,
	createKnowledgeProject,
} from '../../../helpers/knowledge-real-host';
import { safeRmRecursive } from '../../../helpers/safe-test-dir';
import {
	withFrozenClock,
	withFrozenClockAsync,
} from '../../../helpers/test-clock';

const SESSION_ID = 'v2-guidance-parity-2910';
const KEYWORD = 'orbit-flanger-capture';
/** Same frozen instant discipline as the v1 fixture test. */
const FIXED_ISO = '2026-01-02T00:00:00.000Z';
const FIXED_NOW = Date.parse(FIXED_ISO);
const CLOCK_OPTIONS = { fixedNow: FIXED_NOW, isoNow: FIXED_ISO } as const;

/** Advisory class marker — only the seeded pendingAdvisory carries this. */
const ADVISORY_MARKER = 'DEGRADED:';
/** Knowledge class marker — a fragment ONLY the seeded knowledge lesson
 * carries (the transcript keyword alone is vacuous: KEYWORD also appears in
 * the seeded user messages). */
const KNOWLEDGE_MARKER = 'smoke gate before merging database changes';
/** Memory class marker — only the seeded memory record text carries this. */
const MEMORY_MARKER = 'bun test before every release cut';
/** v1-parity provenance fence (src/hooks/system-guidance-carrier.ts). */
const GUIDANCE_FENCE_OPEN = '<swarm_system_directive source="opencode-swarm"';
/** Carrier id prefix (GUIDANCE_CARRIER_ID_PREFIX, detection is by id). */
const CARRIER_ID_PREFIX = 'swarm-guidance:';
const HOST_BASE_SYSTEM = 'HOST BASE SYSTEM PROMPT (2910 parity seed)';

/** Same seeding as the v1 fixture test (issue #2526 AC2 methodology). */
function seedKnowledgeEntry(directory: string): void {
	const entry = {
		id: 'b7e5c1a2-0000-4000-8000-291000000001',
		tier: 'swarm',
		lesson: `Always run the ${KEYWORD} smoke gate before merging database changes.`,
		category: 'process',
		tags: ['fixture'],
		scope: 'global',
		confidence: 0.9,
		status: 'established',
		confirmed_by: [
			{
				phase_number: 1,
				confirmed_at: '2026-01-01T00:00:00.000Z',
				project_name: 'v2-guidance-parity-2910',
			},
		],
		retrieval_outcomes: {
			applied_count: 0,
			succeeded_after_count: 0,
			failed_after_count: 0,
		},
		schema_version: 2,
		created_at: '2026-01-01T00:00:00.000Z',
		updated_at: '2026-01-01T00:00:00.000Z',
		project_name: 'v2-guidance-parity-2910',
		applies_to_agents: ['architect'],
		forbidden_actions: [`skip the ${KEYWORD} smoke gate`],
		directive_priority: 'critical',
	};
	writeFileSync(
		path.join(directory, '.swarm', 'knowledge.jsonl'),
		JSON.stringify(entry),
		'utf-8',
	);
}

async function seedMemoryRecordAsync(
	directory: string,
	sessionId: string,
): Promise<void> {
	const config = resolveMemoryConfig({ enabled: true });
	const context = {
		directory,
		sessionID: sessionId,
		agentRole: 'architect',
		agentId: 'architect',
		runId: sessionId,
	};
	const probe = new MemoryGateway(context, { config });
	const scopes = probe.deriveAllowedScopes();
	probe.dispose();
	const repositoryScope =
		scopes.find((s) => s.type === 'repository') ?? scopes[0]!;
	const now = withFrozenClock(() => new Date().toISOString(), CLOCK_OPTIONS);
	const text = `The ${KEYWORD} pipeline requires bun test before every release cut.`;
	const record: MemoryRecord = {
		id: createMemoryId({ scope: repositoryScope, kind: 'project_fact', text }),
		scope: repositoryScope,
		kind: 'project_fact',
		text,
		tags: ['fixture'],
		confidence: 0.9,
		stability: 'durable',
		source: { type: 'manual', ref: 'issue-2910-v2-parity' },
		createdAt: now,
		updatedAt: now,
		contentHash: computeMemoryContentHash({
			scope: repositoryScope,
			kind: 'project_fact',
			text,
		}),
		metadata: {},
	};
	const provider = createConfiguredMemoryProvider(directory, config);
	await provider.upsert(record);
}

/** The v2 SessionContext event carrying the v1 fixture's seed transcript. */
function seedEvent(): V2PostContextEvent {
	return {
		sessionID: SESSION_ID,
		agent: { id: 'architect', name: 'architect' },
		model: { id: 'parity-model', providerID: 'parity-provider' },
		system: [{ type: 'text', text: HOST_BASE_SYSTEM }],
		messages: [
			{
				id: 'u1',
				role: 'user',
				content: [
					{
						type: 'text',
						text: `Please handle the ${KEYWORD} release checklist.`,
					},
				],
			},
			{
				id: 'a1',
				role: 'assistant',
				content: [{ type: 'text', text: 'Working on it.' }],
			},
			{
				id: 'u2',
				role: 'user',
				content: [
					{ type: 'text', text: `Continue the ${KEYWORD} release checklist.` },
				],
			},
		],
		options: {},
		tools: {},
	};
}

describe('v2 guidance parity (issue #2910 residual scope item 2)', () => {
	beforeEach(() => {
		resetSwarmState();
	});

	afterEach(() => {
		resetSwarmState();
	});

	test('the v2 context hook delivers all three guidance classes and re-homes every carrier into the rendered system', async () => {
		const directory = createKnowledgeProject();
		try {
			seedKnowledgeEntry(directory);
			await seedMemoryRecordAsync(directory, SESSION_ID);

			const plugin = await bootKnowledgeHost(directory, {
				execution_mode: 'balanced',
				context_budget: { scoring: { enabled: false } },
				memory: { enabled: true },
				guardrails: { enabled: true },
			});

			// Pre-hook session state — the same seeds the v1 fixture test sets.
			ensureAgentSession(SESSION_ID, 'architect', directory);
			swarmState.activeAgent.set(SESSION_ID, 'architect');
			const session = swarmState.agentSessions.get(SESSION_ID)!;
			session.pendingAdvisoryMessages = [
				`${ADVISORY_MARKER} ${KEYWORD} context-limit error detected. No fallback models available.`,
			];

			// Register the REAL v2 context hook against a recording fake ctx.
			let capturedContext: ((event: unknown) => Promise<void>) | undefined;
			const registrations: V2Registration[] = [];
			const fakeV2Ctx = {
				session: {
					hook: async (
						name: string,
						callback: (event: unknown) => Promise<void>,
					) => {
						expect(name).toBe('context');
						capturedContext = callback;
						return { dispose: async () => {} };
					},
				},
			};
			await registerV2ContextHook(
				fakeV2Ctx as never,
				plugin.hooks as never,
				directory,
				registrations,
			);
			expect(typeof capturedContext).toBe('function');
			expect(registrations.length).toBe(1);

			const event = seedEvent();
			await withFrozenClockAsync(async () => {
				await capturedContext!(event);
			}, CLOCK_OPTIONS);

			const request = hostV2ToModelRequest(event);
			const systemText = renderedV2SystemText(request);
			const requestText = renderedV2RequestText(request);

			// (1) All three injection classes reach the RENDERED request text.
			expect(requestText).toContain(ADVISORY_MARKER);
			expect(requestText).toContain(KNOWLEDGE_MARKER);
			expect(requestText).toContain(MEMORY_MARKER);

			// (2) The v2 transport delta (#2526 carriers are re-homed, not
			// duplicated): the provenance fence rides the SYSTEM surface …
			expect(systemText).toContain(GUIDANCE_FENCE_OPEN);
			// … and ZERO carriers remain as messages — no carrier id, no fence
			// text, on any role.
			for (const message of event.messages) {
				expect(
					typeof message.id === 'string' &&
						message.id.startsWith(CARRIER_ID_PREFIX),
				).toBe(false);
			}
			for (const rendered of request.messages) {
				expect(rendered.text).not.toContain(GUIDANCE_FENCE_OPEN);
				expect(
					typeof rendered.id === 'string' &&
						rendered.id.startsWith(CARRIER_ID_PREFIX),
				).toBe(false);
			}

			// (3) The transcript prefix survives verbatim (host claim 3:
			// text passes through untouched) and no message was dropped.
			expect(requestText).toContain(
				`Please handle the ${KEYWORD} release checklist.`,
			);
			expect(requestText).toContain('Working on it.');
			expect(requestText).toContain(
				`Continue the ${KEYWORD} release checklist.`,
			);
			expect(request.messages.length).toBe(3);

			// (4) The host's own base system prompt part survives alongside
			// the re-homed guidance (order preserved, array intact).
			expect(systemText).toContain(HOST_BASE_SYSTEM);

			// (5) Advisory class is NOT silently duplicated into the system
			// surface as raw unfenced text AND left on a user message — the
			// advisory marker must appear at least once somewhere (asserted
			// above); the fence shape above is the single-destination guard.
			expect(request.system.length).toBeGreaterThan(1);
		} finally {
			resetSwarmState();
			try {
				safeRmRecursive(directory);
			} catch {
				// Best-effort teardown only (Windows EBUSY from background workers).
			}
		}
	}, 60_000);
});
