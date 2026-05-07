/**
 * Integration-style tests for the Full-Auto v2 permission hook.
 *
 * These tests close the coverage gaps flagged by the completeness verifier
 * (Phases 4.8, 4.9, 6.6, 6.7) — exercising the permission hook end-to-end
 * with a mocked OpenCode SDK client to drive the full
 * permission-hook -> dispatchFullAutoOversight -> evidence flow.
 *
 * Coverage:
 *   - phase_complete with valid phase + APPROVED critic + evidence write
 *     leads to verifyFullAutoPhaseApproval returning ok=true.
 *   - phase_complete with missing phase / non-numeric / 0 / -1 / hex string
 *     surfaces FULL_AUTO_DENY [phase_complete_invalid_phase].
 *   - persistence failure at the dispatcher level converts an APPROVED
 *     verdict to a BLOCKED outcome.
 *   - parsePhaseArg M2 strictness — '0x10', '+3', '1e308' all rejected.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PluginConfig } from '../../../src/config';
import { verifyFullAutoPhaseApproval } from '../../../src/full-auto/phase-approval';
import {
	loadFullAutoRunState,
	startFullAutoRun,
} from '../../../src/full-auto/state';
import { createFullAutoPermissionHook } from '../../../src/hooks/full-auto-permission';
import { _internals as stateInternals, swarmState } from '../../../src/state';

let tmpDir: string;
const SESSION_ID = 'sess-perm-int';
let origClient: typeof stateInternals.swarmState.opencodeClient;

function makeConfig(): PluginConfig {
	return {
		full_auto: {
			enabled: true,
			mode: 'supervised',
			fail_closed: true,
			permission_policy: { enabled: true, allow_defaults: true },
			denials: { max_consecutive: 3, max_total: 20, on_limit: 'pause' },
		},
		agents: {},
	} as unknown as PluginConfig;
}

function mockClientReturning(criticResponseText: string) {
	return {
		session: {
			create: mock(async () => ({ data: { id: 'ephemeral' } })),
			prompt: mock(async () => ({
				data: { parts: [{ type: 'text', text: criticResponseText }] },
			})),
			delete: mock(async () => ({ data: {} })),
		},
	};
}

beforeEach(() => {
	tmpDir = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), 'full-auto-perm-int-')),
	);
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
	origClient = stateInternals.swarmState.opencodeClient;
	swarmState.activeAgent.set(SESSION_ID, 'architect');
});

afterEach(() => {
	stateInternals.swarmState.opencodeClient = origClient;
	swarmState.activeAgent.delete(SESSION_ID);
	swarmState.agentSessions.delete(SESSION_ID);
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	} catch {
		// best-effort
	}
});

// ----------------------------------------------------------------------------
// Phase 4.9 — parsePhaseArg rejection via permission hook
// ----------------------------------------------------------------------------
describe('Phase 4.9 — phase_complete invalid phase rejected up-front', () => {
	for (const bad of [
		undefined,
		null,
		'',
		'  ',
		'abc',
		'0',
		'-1',
		'1.5',
		'0x10',
		'+3',
		'1e308',
		'NaN',
	]) {
		test(`phase=${JSON.stringify(bad)} -> FULL_AUTO_DENY [phase_complete_invalid_phase]`, async () => {
			startFullAutoRun(tmpDir, SESSION_ID, { enabled: true });
			const hook = createFullAutoPermissionHook({
				config: makeConfig(),
				directory: tmpDir,
			});
			await expect(
				hook.toolBefore(
					{ tool: 'phase_complete', sessionID: SESSION_ID, callID: 'c1' },
					{ args: bad === undefined ? {} : { phase: bad } },
				),
			).rejects.toThrow(/phase_complete_invalid_phase/);
		});
	}

	test('phase=2 (number) does NOT throw the invalid-phase deny (escalates to critic instead)', async () => {
		startFullAutoRun(tmpDir, SESSION_ID, { enabled: true });
		// No client -> dispatcher pauses durable state under fail_closed.
		stateInternals.swarmState.opencodeClient = null;
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});
		// Phase 2 is valid; the throw should be a critic-related BLOCK
		// (the no-client fail-closed path), NOT phase_complete_invalid_phase.
		try {
			await hook.toolBefore(
				{ tool: 'phase_complete', sessionID: SESSION_ID, callID: 'c1' },
				{ args: { phase: 2 } },
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).not.toMatch(/phase_complete_invalid_phase/);
		}
	});

	test('phase="3" (numeric string) parses correctly', async () => {
		startFullAutoRun(tmpDir, SESSION_ID, { enabled: true });
		stateInternals.swarmState.opencodeClient = null;
		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});
		try {
			await hook.toolBefore(
				{ tool: 'phase_complete', sessionID: SESSION_ID, callID: 'c1' },
				{ args: { phase: '3' } },
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			expect(msg).not.toMatch(/phase_complete_invalid_phase/);
		}
	});
});

// ----------------------------------------------------------------------------
// Phase 4.8 — end-to-end APPROVED critic + verifyFullAutoPhaseApproval
// ----------------------------------------------------------------------------
describe('Phase 4.8 — phase_complete with APPROVED critic writes evidence and unblocks verify', () => {
	test('full pipeline: phase=2 + APPROVED critic -> verifyFullAutoPhaseApproval ok=true', async () => {
		startFullAutoRun(tmpDir, SESSION_ID, { enabled: true });
		// Mock opencode client with an APPROVED verdict + evidence.
		stateInternals.swarmState.opencodeClient = mockClientReturning(
			[
				'VERDICT: APPROVED',
				'REASONING: phase 2 work verified',
				'EVIDENCE_CHECKED: diff,test_impact,evidence_check',
				'ANTI_PATTERNS_DETECTED: none',
				'ESCALATION_NEEDED: NO',
			].join('\n'),
		) as unknown as typeof stateInternals.swarmState.opencodeClient;

		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});

		// The classifier escalates `phase_complete` to critic; with the
		// mocked APPROVED client the dispatcher writes evidence and the
		// hook returns without throwing.
		await expect(
			hook.toolBefore(
				{ tool: 'phase_complete', sessionID: SESSION_ID, callID: 'c1' },
				{ args: { phase: 2 } },
			),
		).resolves.toBeUndefined();

		// Evidence file landed under .swarm/evidence/2/.
		const evidenceDir = path.join(tmpDir, '.swarm', 'evidence', '2');
		expect(fs.existsSync(evidenceDir)).toBe(true);
		const evidenceFiles = fs
			.readdirSync(evidenceDir)
			.filter((f) => f.startsWith('full-auto-') && f.endsWith('.json'));
		expect(evidenceFiles.length).toBeGreaterThan(0);

		// verifyFullAutoPhaseApproval returns ok=true.
		const verify = verifyFullAutoPhaseApproval(
			tmpDir,
			SESSION_ID,
			2,
			makeConfig(),
		);
		expect(verify.ok).toBe(true);

		// Durable run state's currentPhase was updated.
		const finalState = loadFullAutoRunState(tmpDir, SESSION_ID);
		expect(finalState?.currentPhase).toBe(2);
	});
});

// ----------------------------------------------------------------------------
// Phase 5.5 — explicit verdict=BLOCKED test for phase-approval
// ----------------------------------------------------------------------------
describe('Phase 5.5 — verdict=BLOCKED phase_boundary record blocks phase_complete', () => {
	test('a phase_boundary record with verdict=BLOCKED is rejected', () => {
		startFullAutoRun(tmpDir, SESSION_ID, { enabled: true });
		const dir = path.join(tmpDir, '.swarm', 'evidence', '4');
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, 'full-auto-1.json'),
			JSON.stringify({
				type: 'full_auto_oversight',
				phase: 4,
				verdict: 'BLOCKED',
				trigger_source: 'phase_boundary',
				timestamp: new Date().toISOString(),
				evidence_checked: ['diff'],
			}),
		);
		const r = verifyFullAutoPhaseApproval(tmpDir, SESSION_ID, 4, makeConfig());
		expect(r.ok).toBe(false);
	});
});

// ----------------------------------------------------------------------------
// Phase 6.6 / 6.7 — dispatcher converts APPROVED to BLOCKED on persistence failure
// ----------------------------------------------------------------------------
describe('Phase 6.6/6.7 — APPROVED critic + persistence failure -> BLOCKED outcome via permission hook', () => {
	test('events.jsonl write failure -> hook throws FULL_AUTO_BLOCKED and durable state pauses', async () => {
		startFullAutoRun(tmpDir, SESSION_ID, { enabled: true });
		// Mock APPROVED critic.
		stateInternals.swarmState.opencodeClient = mockClientReturning(
			[
				'VERDICT: APPROVED',
				'REASONING: ok',
				'EVIDENCE_CHECKED: diff',
				'ANTI_PATTERNS_DETECTED: none',
				'ESCALATION_NEEDED: NO',
			].join('\n'),
		) as unknown as typeof stateInternals.swarmState.opencodeClient;
		// Force events.jsonl write to fail by making it a directory.
		const eventsPath = path.join(tmpDir, '.swarm', 'events.jsonl');
		fs.mkdirSync(eventsPath, { recursive: true });

		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});

		// phase_complete escalates to critic; the critic returns APPROVED
		// but writeFullAutoOversightEvent throws because events.jsonl is a
		// directory. The dispatcher catches this and returns BLOCKED;
		// the hook surfaces FULL_AUTO_BLOCKED to the caller.
		await expect(
			hook.toolBefore(
				{ tool: 'phase_complete', sessionID: SESSION_ID, callID: 'c1' },
				{ args: { phase: 5 } },
			),
		).rejects.toThrow(/FULL_AUTO_(BLOCKED|CRITIC_DENY)/);

		// Durable state must be paused.
		const state = loadFullAutoRunState(tmpDir, SESSION_ID);
		expect(state?.status).toBe('paused');
	});

	test('phase_boundary evidence write failure -> BLOCKED + pause regardless of fail_closed', async () => {
		startFullAutoRun(tmpDir, SESSION_ID, { enabled: true });
		stateInternals.swarmState.opencodeClient = mockClientReturning(
			[
				'VERDICT: APPROVED',
				'REASONING: ok',
				'EVIDENCE_CHECKED: diff',
				'ANTI_PATTERNS_DETECTED: none',
				'ESCALATION_NEEDED: NO',
			].join('\n'),
		) as unknown as typeof stateInternals.swarmState.opencodeClient;
		// Force per-phase evidence write to fail by making the phase dir
		// already a regular file.
		const phaseDir = path.join(tmpDir, '.swarm', 'evidence');
		fs.mkdirSync(phaseDir, { recursive: true });
		fs.writeFileSync(path.join(phaseDir, '6'), 'blocking-file', 'utf-8');

		const hook = createFullAutoPermissionHook({
			config: makeConfig(),
			directory: tmpDir,
		});

		await expect(
			hook.toolBefore(
				{ tool: 'phase_complete', sessionID: SESSION_ID, callID: 'c1' },
				{ args: { phase: 6 } },
			),
		).rejects.toThrow(/FULL_AUTO_(BLOCKED|CRITIC_DENY)/);

		const state = loadFullAutoRunState(tmpDir, SESSION_ID);
		expect(state?.status).toBe('paused');
	});

	test('H4 fix: persistence failure with fail_closed=false still BLOCKS', async () => {
		startFullAutoRun(tmpDir, SESSION_ID, { enabled: true });
		stateInternals.swarmState.opencodeClient = mockClientReturning(
			[
				'VERDICT: APPROVED',
				'REASONING: ok',
				'EVIDENCE_CHECKED: diff',
				'ANTI_PATTERNS_DETECTED: none',
				'ESCALATION_NEEDED: NO',
			].join('\n'),
		) as unknown as typeof stateInternals.swarmState.opencodeClient;
		const eventsPath = path.join(tmpDir, '.swarm', 'events.jsonl');
		fs.mkdirSync(eventsPath, { recursive: true });

		// fail_closed=false — under H4, the dispatcher must STILL not
		// return decision='allow' when persistence failed.
		const cfg = makeConfig();
		(cfg.full_auto as { fail_closed: boolean }).fail_closed = false;
		const hook = createFullAutoPermissionHook({
			config: cfg,
			directory: tmpDir,
		});

		await expect(
			hook.toolBefore(
				{ tool: 'web_search', sessionID: SESSION_ID, callID: 'c1' },
				{ args: { query: 'foo' } },
			),
		).rejects.toThrow(/FULL_AUTO_(BLOCKED|CRITIC_DENY)/);
	});
});
