/**
 * Issue #1896 (sub-issue 3): oversight critic dispatch now fails over to a
 * configured `fallback_models` entry on a transient/quota error instead of
 * failing the stage outright. The PR shipped an equivalent test for the lean
 * reviewer (`reviewer-fallback.test.ts`); this mirrors it for the bespoke
 * INLINE oversight loop (`src/full-auto/oversight.ts`), which does NOT use the
 * shared `dispatchWithModelFallback` helper and therefore is not covered by
 * `tests/unit/utils/model-dispatch-fallback.test.ts`.
 *
 * Covers the #1896 incident path directly: a quota-exhausted critic model
 * fails over to a configured backup and the run recovers, plus the
 * increment-before-parse malformed-entry skip, the per-attempt model override,
 * the `baseEvent.critic_model` attribution rewrite, and the
 * `telemetry.modelFallback` signal. A permanent error still fails closed with
 * no failover (asymmetry guard).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getAgentConfigs } from '../../../src/agents/index';
import type { PluginConfig } from '../../../src/config';
import { dispatchFullAutoOversight } from '../../../src/full-auto/oversight';
import { startFullAutoRun } from '../../../src/full-auto/state';
import { _internals as stateInternals } from '../../../src/state';
import { _internals as telemetryInternals } from '../../../src/telemetry';

// Seed the default swarm map so critic_oversight has a fallback chain. The
// oversight dispatcher resolves `oversightFallbackRole = critic_oversight`
// when this role has fallback_models, else falls back to `critic` — so seeding
// critic_oversight directly exercises the primary path.
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
		fs.mkdtempSync(path.join(os.tmpdir(), 'oversight-fallback-')),
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
// (no `body.model` override) with the supplied error message, and succeeds on
// any fallback attempt (override present). Returns the ordered list of model
// labels actually passed to prompt so the test can assert the failover chain.
function buildQuotaFailingClient(
	primaryErrorMessage: string,
	primaryErrorCode = 'QUOTA',
): {
	client: unknown;
	promptModels: Array<string | undefined>;
	promptCalls: number;
	deleteCalls: number;
} {
	const promptModels: Array<string | undefined> = [];
	let promptCalls = 0;
	let deleteCalls = 0;
	const client = {
		session: {
			create: mock(async () => ({
				data: { id: 'critic-session' },
				error: null,
			})),
			prompt: mock(async (params: { body: PromptBody }) => {
				promptCalls++;
				const override = params.body?.model;
				const label = override
					? `${override.providerID}/${override.modelID}`
					: undefined;
				promptModels.push(label);
				if (!override) {
					// Primary model hit its quota.
					return {
						data: null,
						error: { code: primaryErrorCode, message: primaryErrorMessage },
					};
				}
				return {
					data: {
						parts: [
							{
								type: 'text',
								text: 'VERDICT: APPROVED\nREASONING: recovered on fallback\nEVIDENCE_CHECKED: none\nANTI_PATTERNS_DETECTED: none\nESCALATION_NEEDED: NO',
							},
						],
					},
				};
			}),
			delete: mock(async () => {
				deleteCalls++;
				return {};
			}),
		},
	};
	return { client, promptModels, promptCalls, deleteCalls };
}

describe('dispatchFullAutoOversight — model failover (#1896)', () => {
	test('fails over to a fallback model on a quota dispatch error and recovers', async () => {
		startFullAutoRun(tmpDir, 'sess-failover', { enabled: true });
		seedOversightFallback(['prov/fb1', 'prov/fb2']);
		const { client, promptModels } = buildQuotaFailingClient(
			'429 insufficient_quota: usage limit exceeded',
		);
		stateInternals.swarmState.opencodeClient = client as any;

		const out = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-failover',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'prov/primary-critic',
			oversightAgentName: 'critic_oversight',
			fullAutoConfig: {
				max_dispatch_retries: 2,
				max_consecutive_dispatch_failures: 3,
			},
		});

		// Recovered → APPROVED, not BLOCKED/pause.
		expect(out.verdict).toBe('APPROVED');
		expect(out.decision).toBe('allow');
		// Primary attempted first (undefined), then the first fallback adopted.
		expect(promptModels[0]).toBeUndefined();
		expect(promptModels[1]).toBe('prov/fb1');
		// baseEvent.critic_model is rewritten to the fallback that actually landed,
		// so the event audit trail is not stale.
		expect(out.event.critic_model).toBe('prov/fb1');
	});

	test('emits telemetry.modelFallback with reason=quota on a quota failover', async () => {
		startFullAutoRun(tmpDir, 'sess-telemetry', { enabled: true });
		seedOversightFallback(['prov/fb1']);
		const { client } = buildQuotaFailingClient(
			'insufficient_quota: usage limit exceeded',
		);
		stateInternals.swarmState.opencodeClient = client as any;

		const emitted: Array<Record<string, unknown>> = [];
		const origEmit = telemetryInternals.emit;
		telemetryInternals.emit = ((
			event: string,
			payload: Record<string, unknown>,
		) => {
			if (event === 'model_fallback') emitted.push(payload);
		}) as typeof telemetryInternals.emit;

		try {
			await dispatchFullAutoOversight({
				directory: tmpDir,
				sessionID: 'sess-telemetry',
				trigger: 'test',
				triggerSource: 'tool_action',
				criticModel: 'prov/primary-critic',
				oversightAgentName: 'critic_oversight',
				fullAutoConfig: {
					max_dispatch_retries: 2,
					max_consecutive_dispatch_failures: 3,
				},
			});
		} finally {
			telemetryInternals.emit = origEmit;
		}

		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.agentName).toBe('critic_oversight');
		expect(emitted[0]?.fromModel).toBe('prov/primary-critic');
		expect(emitted[0]?.toModel).toBe('prov/fb1');
		expect(emitted[0]?.reason).toBe('quota');
	});

	test('a permanent dispatch error still fails closed with no failover', async () => {
		startFullAutoRun(tmpDir, 'sess-permanent', { enabled: true });
		seedOversightFallback(['prov/fb1', 'prov/fb2']);
		// 401 unauthorized is NOT in the transient/quota classifier → permanent.
		// The error code/message are chosen to avoid any transient/quota token
		// (the oversight loop wraps the SDK error in `Critic prompt failed:
		// <JSON>` before classifying, so the JSON must not carry a transient/quota
		// token either — a `code: 'QUOTA'` here would falsely classify transient).
		const { client, promptModels } = buildQuotaFailingClient(
			'401 unauthorized: invalid api key',
			'AUTH_REJECTED',
		);
		stateInternals.swarmState.opencodeClient = client as any;

		const out = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-permanent',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'prov/primary-critic',
			oversightAgentName: 'critic_oversight',
			fullAutoConfig: {
				max_dispatch_retries: 2,
				max_consecutive_dispatch_failures: 3,
			},
		});

		// Permanent → no failover, only the primary was attempted.
		expect(promptModels).toEqual([undefined]);
		// Fail-closed: verdict BLOCKED, decision pause (active run).
		expect(out.verdict).toBe('BLOCKED');
		expect(out.decision).toBe('pause');
		// No fallback landed → critic_model is NOT rewritten.
		expect(out.event.critic_model).toBe('prov/primary-critic');
	});

	test('a malformed fallback_models entry is skipped and the next valid one is reached', async () => {
		startFullAutoRun(tmpDir, 'sess-malformed', { enabled: true });
		// Index 1 is malformed (no `/` separator) — parseModelString throws and
		// the oversight loop advances past it without adopting it; index 2 is the
		// next valid fallback and SHOULD be the one that recovers the run.
		seedOversightFallback(['no-separator-string', 'prov/fb2']);
		const { client, promptModels } = buildQuotaFailingClient(
			'429 insufficient_quota: usage limit exceeded',
		);
		stateInternals.swarmState.opencodeClient = client as any;

		const out = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-malformed',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'prov/primary-critic',
			oversightAgentName: 'critic_oversight',
			fullAutoConfig: {
				max_dispatch_retries: 4,
				max_consecutive_dispatch_failures: 3,
			},
		});

		// Recovered on the second valid fallback.
		expect(out.verdict).toBe('APPROVED');
		expect(out.event.critic_model).toBe('prov/fb2');
		// Documented increment-before-parse behavior: when parseModelString
		// throws on the malformed index-1 entry, modelOverride is NOT adopted, so
		// the next retry re-dispatches the still-undefined primary (a known,
		// commented inefficiency in the oversight loop) before the index-2 entry
		// parses cleanly and lands. The malformed entry itself never reaches the
		// SDK — it is skipped at parse time. promptModels therefore records:
		// [primary, primary-retry, prov/fb2].
		expect(promptModels).toEqual([undefined, undefined, 'prov/fb2']);
	});

	test('falls back to the `critic` role chain when critic_oversight has no fallback_models', async () => {
		startFullAutoRun(tmpDir, 'sess-inherit', { enabled: true });
		// Seed BOTH: critic_oversight with no fallback (forces the inherit branch)
		// and critic with a fallback (the inherited chain).
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
		const { client, promptModels } = buildQuotaFailingClient(
			'429 insufficient_quota: usage limit exceeded',
		);
		stateInternals.swarmState.opencodeClient = client as any;

		const out = await dispatchFullAutoOversight({
			directory: tmpDir,
			sessionID: 'sess-inherit',
			trigger: 'test',
			triggerSource: 'tool_action',
			criticModel: 'prov/primary-critic',
			oversightAgentName: 'critic_oversight',
			fullAutoConfig: {
				max_dispatch_retries: 2,
				max_consecutive_dispatch_failures: 3,
			},
		});

		// oversightFallbackRole resolves to 'critic' when critic_oversight has
		// no fallback_models, so the inherited fallback is reachable.
		expect(out.verdict).toBe('APPROVED');
		expect(promptModels[1]).toBe('prov/inherited-fb');
		expect(out.event.critic_model).toBe('prov/inherited-fb');
	});
});
