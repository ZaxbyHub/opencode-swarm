/**
 * Issue #1905: the legacy reactive-intercept critic dispatch
 * (`dispatchCriticAndWriteEvent` in `src/hooks/full-auto-intercept.ts`) now
 * fails over to a configured `fallback_models` entry on a transient/quota
 * dispatch error instead of failing the stage outright. This mirrors
 * `tests/unit/full-auto/oversight-fallback.test.ts` for the sibling v2
 * `dispatchFullAutoOversight` site (PR #1901), and pins the #1905-specific
 * additions: the v2-mirror `critic_model` attribution rewrite and the
 * SDK-error-envelope preservation.
 *
 * Uses the `_internals.swarmState.opencodeClient` injection pattern (no
 * `mock.module`) per AGENTS.md invariant #7.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getAgentConfigs } from '../../../src/agents/index';
import type { PluginConfig } from '../../../src/config';
import { startFullAutoRun } from '../../../src/full-auto/state';
import { dispatchCriticAndWriteEvent } from '../../../src/hooks/full-auto-intercept';
import { _internals as stateInternals } from '../../../src/state';
import { _internals as telemetryInternals } from '../../../src/telemetry';

// Seed the default swarm map so critic_oversight has a fallback chain. The
// dispatcher resolves `oversightFallbackRole = critic_oversight` when this
// role has fallback_models, else falls back to `critic` — same logic as the
// sibling oversight.ts.
function seedOversightFallback(
	fallbackModels: string[],
	role: 'critic_oversight' | 'critic' = 'critic_oversight',
): void {
	const config = {
		agents: {
			[role]: {
				model: 'prov/primary-critic',
				fallback_models: fallbackModels,
			},
		},
	} as unknown as PluginConfig;
	getAgentConfigs(config);
}

type PromptBody = {
	agent?: string;
	model?: { providerID: string; modelID: string };
	tools?: Record<string, boolean>;
	parts?: Array<{ type: string; text?: unknown }>;
};

let tmpDir: string;
let origClient: typeof stateInternals.swarmState.opencodeClient;

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'fai-fallback-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	origClient = stateInternals.swarmState.opencodeClient;
});

afterEach(() => {
	stateInternals.swarmState.opencodeClient = origClient;
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

// Build a mock SDK client whose `session.prompt` fails on the primary model
// (no `body.model` override) with the supplied error shape, and succeeds on
// any fallback attempt (override present). Returns the ordered list of model
// labels actually passed to prompt so the test can assert the failover chain.
//
// The #1905 envelope fix means the classifier sees `response.error.message`
// embedded in the wrapped "Critic LLM prompt failed: …" string — so we drive
// the real default dispatch fn via the SDK envelope, NOT a throwing mock.
function buildQuotaFailingClient(errorEnvelope: {
	code: string;
	message: string;
}): {
	client: unknown;
	promptModels: Array<string | undefined>;
} {
	const promptModels: Array<string | undefined> = [];
	const client = {
		session: {
			create: mock(async () => ({
				data: { id: 'critic-session' },
				error: null,
			})),
			prompt: mock(async (params: { body: PromptBody }) => {
				const override = params.body?.model;
				const label = override
					? `${override.providerID}/${override.modelID}`
					: undefined;
				promptModels.push(label);
				if (!override) {
					// Primary model hit its quota — envelope shape (the dominant
					// SDK error class). The #1905 envelope fix preserves this.
					return { data: null, error: errorEnvelope };
				}
				return {
					data: {
						parts: [
							{
								type: 'text',
								text: 'VERDICT: APPROVED\nREASONING: recovered on fallback',
							},
						],
					},
				};
			}),
			delete: mock(async () => ({})),
		},
	};
	return { client, promptModels };
}

describe('dispatchCriticAndWriteEvent — model failover (#1905)', () => {
	test('fails over to a fallback model on a quota dispatch error and recovers', async () => {
		seedOversightFallback(['prov/fb1', 'prov/fb2']);
		const { client, promptModels } = buildQuotaFailingClient({
			code: 'QUOTA',
			message: '429 insufficient_quota: usage limit exceeded',
		});
		stateInternals.swarmState.opencodeClient = client as any;

		const result = await dispatchCriticAndWriteEvent(
			tmpDir,
			'architect output',
			'critic context',
			'prov/primary-critic',
			'question',
			1,
			0,
			'critic_oversight',
			'sess-failover',
			2, // maxDispatchRetries
			3, // maxConsecutiveDispatchFailures
		);

		// Recovered → APPROVED, not NEEDS_REVISION.
		expect(result.verdict).toBe('APPROVED');
		// Primary attempted first (undefined), then the first fallback adopted.
		expect(promptModels[0]).toBeUndefined();
		expect(promptModels[1]).toBe('prov/fb1');
	});

	test('emits telemetry.modelFallback on a quota failover (sessionID ?? "" for optional sessionID)', async () => {
		seedOversightFallback(['prov/fb1']);
		const { client } = buildQuotaFailingClient({
			code: 'QUOTA',
			message: 'insufficient_quota: usage limit exceeded',
		});
		stateInternals.swarmState.opencodeClient = client as any;

		const emitted: Array<Record<string, unknown>> = [];
		const origEmit = telemetryInternals.emit;
		telemetryInternals.emit = ((
			event: string,
			payload: Record<string, unknown>,
		) => {
			if (event === 'model_fallback') emitted.push(payload);
		}) as typeof telemetryInternals.emit;

		// NOTE: sessionID is intentionally OMITTED here to prove the
		// `sessionID ?? ''` coercion in the telemetry call site (critic item 3).
		try {
			await dispatchCriticAndWriteEvent(
				tmpDir,
				'architect output',
				'critic context',
				'prov/primary-critic',
				'question',
				1,
				0,
				'critic_oversight',
				// sessionID undefined — the telemetry call must still receive ''.
				undefined,
				2,
				3,
			);
		} finally {
			telemetryInternals.emit = origEmit;
		}

		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.agentName).toBe('critic_oversight');
		expect(emitted[0]?.fromModel).toBe('prov/primary-critic');
		expect(emitted[0]?.toModel).toBe('prov/fb1');
		// Auto-review/oversight tag quota vs transient based on the error text.
		// Here the error carries "insufficient_quota" → 'quota'.
		expect(emitted[0]?.reason).toBe('quota');
	});

	test('a permanent dispatch error still fails closed with no failover', async () => {
		seedOversightFallback(['prov/fb1', 'prov/fb2']);
		// 401 unauthorized is NOT in the transient/quota classifier → permanent.
		// The error code/message avoid any transient/quota token so the classifier
		// returns 'permanent' and no failover fires (site 1 still retries on
		// permanent per FR-003, but it re-hits the same primary each time).
		const { client, promptModels } = buildQuotaFailingClient({
			code: 'AUTH_REJECTED',
			message: '401 unauthorized: invalid api key',
		});
		stateInternals.swarmState.opencodeClient = client as any;

		const result = await dispatchCriticAndWriteEvent(
			tmpDir,
			'architect output',
			'critic context',
			'prov/primary-critic',
			'question',
			1,
			0,
			'critic_oversight',
			'sess-permanent',
			2,
			3,
		);

		// Permanent → no failover: every retry re-hit the same primary.
		expect(promptModels).toEqual([undefined, undefined, undefined]);
		// Fail-closed: verdict NEEDS_REVISION (reactive intercept's fail-closed
		// shape, distinct from oversight.ts's BLOCKED — pinned by existing tests).
		expect(result.verdict).toBe('NEEDS_REVISION');
	});

	test('a malformed fallback_models entry is skipped and the next valid one is reached', async () => {
		// maxDispatchRetries=4 gives 5 attempts → up to 4 fallback advances,
		// enough to skip the malformed index-1 entry and reach index-2. Mirrors
		// the oversight-fallback.test.ts:259 pin and the [undefined, undefined,
		// 'prov/fb2'] prompt-models assertion that documents the increment-
		// before-parse re-dispatched-primary quirk.
		seedOversightFallback(['no-separator-string', 'prov/fb2']);
		const { client, promptModels } = buildQuotaFailingClient({
			code: 'QUOTA',
			message: '429 insufficient_quota: usage limit exceeded',
		});
		stateInternals.swarmState.opencodeClient = client as any;

		const result = await dispatchCriticAndWriteEvent(
			tmpDir,
			'architect output',
			'critic context',
			'prov/primary-critic',
			'question',
			1,
			0,
			'critic_oversight',
			'sess-malformed',
			4, // maxDispatchRetries — sized to reach index-2 after the skip
			3,
		);

		// Recovered on the second valid fallback.
		expect(result.verdict).toBe('APPROVED');
		// Documented increment-before-parse behavior: the malformed index-1
		// entry advances the index but is NOT adopted, so the next retry
		// re-dispatches the still-undefined primary before the index-2 entry
		// parses cleanly and lands. The malformed entry never reaches the SDK.
		expect(promptModels).toEqual([undefined, undefined, 'prov/fb2']);
	});

	test('falls back to the `critic` role chain when critic_oversight has no fallback_models', async () => {
		// Seed BOTH: critic_oversight with no fallback (forces the inherit
		// branch) and critic with a fallback (the inherited chain).
		const config = {
			agents: {
				critic_oversight: { model: 'prov/primary-critic' },
				critic: {
					model: 'prov/primary-critic',
					fallback_models: ['prov/inherited-fb'],
				},
			},
		} as unknown as PluginConfig;
		getAgentConfigs(config);
		const { client, promptModels } = buildQuotaFailingClient({
			code: 'QUOTA',
			message: '429 insufficient_quota: usage limit exceeded',
		});
		stateInternals.swarmState.opencodeClient = client as any;

		const result = await dispatchCriticAndWriteEvent(
			tmpDir,
			'architect output',
			'critic context',
			'prov/primary-critic',
			'question',
			1,
			0,
			'critic_oversight',
			'sess-inherit',
			2,
			3,
		);

		// oversightFallbackRole resolves to 'critic' when critic_oversight has
		// no fallback_models, so the inherited fallback is reachable.
		expect(result.verdict).toBe('APPROVED');
		expect(promptModels[1]).toBe('prov/inherited-fb');
	});

	test('envelope-shaped quota error (data:null + error envelope) triggers failover — pins the #1905 envelope-preservation fix', async () => {
		// This is the Critical-finding test: without the envelope-preservation
		// fix at the dispatch site, the classifier would see only "Critic LLM
		// prompt failed: " with no quota token → permanent → no failover. The
		// fix embeds JSON.stringify(response.error) in the wrapped message.
		seedOversightFallback(['prov/fb1']);
		const { client, promptModels } = buildQuotaFailingClient({
			code: 'RATE_LIMITED',
			message: '429 rate_limit_exceeded: too many requests',
		});
		stateInternals.swarmState.opencodeClient = client as any;

		const result = await dispatchCriticAndWriteEvent(
			tmpDir,
			'architect output',
			'critic context',
			'prov/primary-critic',
			'question',
			1,
			0,
			'critic_oversight',
			'sess-envelope',
			2,
			3,
		);

		// Failover fired on the envelope-shaped error → recovered.
		expect(result.verdict).toBe('APPROVED');
		expect(promptModels[0]).toBeUndefined();
		expect(promptModels[1]).toBe('prov/fb1');
	});

	test('v2 mirror event records the landed fallback model in critic_model — pins plan-critic finding 2 (#1905)', async () => {
		// Plan-critic finding 2 (Important, 85/100) required: "Thread the landed
		// model into the mirror … AND assert it in the new site-1 test." The
		// threading is at full-auto-intercept.ts:801 (passes criticModelUsed)
		// and :1353 (writes critic_model: criticModelUsed ?? criticModel). This
		// test seeds a durable RUNNING v2 record so mirrorReactiveVerdictToV2
		// fires, runs a quota-failover dispatch, and asserts the mirrored
		// full_auto_oversight event's critic_model is the fallback — NOT the
		// configured primary. Without the threading, this regresses to the exact
		// stale-attribution defect #1901 fixed in oversight.ts.
		seedOversightFallback(['prov/fb1']);
		const { client } = buildQuotaFailingClient({
			code: 'QUOTA',
			message: '429 insufficient_quota: usage limit exceeded',
		});
		stateInternals.swarmState.opencodeClient = client as any;

		// Seed a durable RUNNING v2 record so the mirror does not no-op.
		// mirrorReactiveVerdictToV2 reads .swarm/full-auto-state.json, matches
		// the caller's sessionID with status === 'running', and writes a
		// full_auto_oversight event to .swarm/events.jsonl.
		startFullAutoRun(tmpDir, 'sess-mirror', { enabled: true });

		await dispatchCriticAndWriteEvent(
			tmpDir,
			'architect output',
			'critic context',
			'prov/primary-critic',
			'question',
			1,
			0,
			'critic_oversight',
			'sess-mirror', // must match the durable record's sessionID
			2,
			3,
		);

		// Read the mirrored full_auto_oversight event from events.jsonl. The
		// legacy auto_oversight event is also written; filter for the v2 type.
		const eventsPath = path.join(tmpDir, '.swarm', 'events.jsonl');
		const lines = fs
			.readFileSync(eventsPath, 'utf-8')
			.split('\n')
			.filter(Boolean);
		const v2Events = lines
			.map((l) => JSON.parse(l))
			.filter((e: { type?: string }) => e.type === 'full_auto_oversight');

		expect(v2Events.length).toBeGreaterThanOrEqual(1);
		const mirrorEvent = v2Events[v2Events.length - 1];
		// The landed fallback model — NOT the configured primary. This is the
		// attribution-rewrite pin plan-critic finding 2 required.
		expect(mirrorEvent.critic_model).toBe('prov/fb1');
		expect(mirrorEvent.critic_model).not.toBe('prov/primary-critic');
	});
});
