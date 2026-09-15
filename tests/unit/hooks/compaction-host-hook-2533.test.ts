import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
	isGuidanceCarrier,
	messageTextOf,
} from '../../../src/hooks/system-guidance-carrier';
import OpenCodeSwarmPlugin from '../../../src/index';
import {
	beginTurnLedger,
	clearTurnLedger,
	getTurnLedgerSummary,
} from '../../../src/services/injection-budget';
import { ensureAgentSession, swarmState } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

/**
 * Issue #2533: the registered `experimental.session.compacting` host hook
 * must complete with `hooks.compaction=false` (it used to await a handler the
 * factory omits when disabled), while preserving both the enabled-path facts
 * injection and the flag-independent #2107 §4 turn-ledger reset.
 *
 * Every case drives the REAL plugin through `server()` (the registered host
 * hook), never the hook factory directly. The equivalent shared boot helper
 * (tests/helpers/plugin-host.ts) carries the same registered-path fixture for
 * the class guardrail test and #2585's interrupt/restart/compaction
 * scenarios; this file keeps its own boot so the regression test stands alone
 * against future helper changes.
 */

const SESSION_IDS = [
	'2533-reg-',
	'2533-disabled-',
	'2533-true-',
	'2533-absent-',
	'2533-ledger-disabled-',
	'2533-ledger-enabled-',
	'2533-bridge-',
] as const;

const createdDirs: string[] = [];

afterEach(async () => {
	// Ledger state is module-scoped; clear the sessions this file seeded so a
	// later co-run test file sees a clean surface.
	for (const sessionID of SESSION_IDS) {
		clearTurnLedger(`${sessionID}session`);
	}
	swarmState.activeAgent.delete('2533-bridge-session');
	swarmState.agentSessions.delete('2533-bridge-session');
	swarmState.activeAgent.delete('2533-bridge-deleted-session');
	swarmState.agentSessions.delete('2533-bridge-deleted-session');
	// Remove the temp project dirs this file created (repo convention).
	// Bounded retry: a freshly-booted plugin can hold open handles in the
	// project dir on Windows (EBUSY). Hygiene never fails the test, but a dir
	// that stays unreclaimed after the retries is reported, not silently
	// leaked.
	for (const dir of createdDirs.splice(0)) {
		for (let attempt = 0; attempt < 4; attempt += 1) {
			try {
				rmSync(dir, { recursive: true, force: true });
				break;
			} catch {
				if (attempt === 3) {
					console.warn(
						`[compaction-host-hook-2533] temp dir not reclaimed: ${dir}`,
					);
				} else {
					await Bun.sleep(50);
				}
			}
		}
	}
});

async function bootRegisteredHooks(
	overrides: Record<string, unknown>,
): Promise<Record<string, (...args: unknown[]) => Promise<unknown>>> {
	const directory = canonicalMkdtemp('swarm-2533-');
	createdDirs.push(directory);
	const opencodeDir = path.join(directory, '.opencode');
	mkdirSync(opencodeDir, { recursive: true });
	writeFileSync(
		path.join(opencodeDir, 'opencode-swarm.json'),
		JSON.stringify({ version_check: false, ...overrides }, null, 2),
	);
	const result = await (
		OpenCodeSwarmPlugin as unknown as {
			server: (ctx: {
				client: unknown;
				project: unknown;
				directory: string;
				worktree: string;
				serverUrl: URL;
				$: unknown;
			}) => Promise<Record<string, unknown>>;
		}
	).server({
		client: {},
		project: {},
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {},
	});
	return result as unknown as Record<
		string,
		(...args: unknown[]) => Promise<unknown>
	>;
}

function factsBlockCount(output: { context: string[] }): number {
	return output.context.filter((entry) =>
		entry.includes('<swarm_compaction_facts>'),
	).length;
}

describe('registered experimental.session.compacting host hook (#2533)', () => {
	it('is registered as a function in every flag state', async () => {
		for (const overrides of [
			{ hooks: { compaction: false } },
			{ hooks: { compaction: true } },
			{},
		]) {
			const hooks = await bootRegisteredHooks({ ...overrides });
			expect(typeof hooks['experimental.session.compacting']).toBe('function');
		}
	});

	it('completes with hooks.compaction=false and injects no facts block', async () => {
		const hooks = await bootRegisteredHooks({ hooks: { compaction: false } });
		const output = { context: [] as string[] };
		await hooks['experimental.session.compacting'](
			{ sessionID: '2533-disabled-session' },
			output,
		);
		expect(factsBlockCount(output)).toBe(0);
	});

	it('still delegates with the flag true and with it absent: exactly one facts block', async () => {
		for (const [sessionID, overrides] of [
			['2533-true-session', { hooks: { compaction: true } }],
			['2533-absent-session', {}],
		] as const) {
			const hooks = await bootRegisteredHooks({ ...overrides });
			const output = { context: [] as string[] };
			await hooks['experimental.session.compacting']({ sessionID }, output);
			expect(factsBlockCount(output)).toBe(1);
		}
	});

	it('discards the per-session turn ledger in BOTH flag states (#2107 §4)', async () => {
		for (const [sessionID, overrides] of [
			['2533-ledger-disabled-session', { hooks: { compaction: false } }],
			['2533-ledger-enabled-session', { hooks: { compaction: true } }],
		] as const) {
			const hooks = await bootRegisteredHooks({ ...overrides });
			beginTurnLedger(sessionID, 4096, true);
			expect(getTurnLedgerSummary(sessionID)).not.toBeNull();
			await hooks['experimental.session.compacting'](
				{ sessionID },
				{ context: [] },
			);
			expect(getTurnLedgerSummary(sessionID)).toBeNull();
		}
	});

	it('suppresses only the architect bridge on the immediate post-compaction transform', async () => {
		const sessionID = '2533-bridge-session';
		const hooks = await bootRegisteredHooks({
			knowledge: { enabled: false, hive_enabled: false },
			memory: { enabled: false },
			hooks: { delegation_gate: false },
		});
		ensureAgentSession(sessionID, 'architect');
		swarmState.activeAgent.set(sessionID, 'architect');
		ensureAgentSession(sessionID, 'architect').pendingAdvisoryMessages = [
			'[PRE-COMPACTION GUIDANCE]',
		];
		const preCompactionMessages = [
			{
				info: { id: 'pre-compaction-user', role: 'user', sessionID },
				parts: [{ type: 'text', text: 'Before compaction' }],
			},
		];
		await hooks['experimental.chat.messages.transform'](
			{},
			{ messages: preCompactionMessages },
		);
		expect(
			preCompactionMessages
				.filter((message) => isGuidanceCarrier(message))
				.map((message) => messageTextOf(message as never))
				.join('\n'),
		).toContain('[PRE-COMPACTION GUIDANCE]');

		await hooks['experimental.session.compacting'](
			{ sessionID },
			{ context: [] },
		);
		const compactedMessages = [
			{
				info: { id: 'summary-user', role: 'user', sessionID },
				parts: [{ type: 'text', text: 'Compacted summary' }],
			},
		];
		await hooks['experimental.chat.messages.transform'](
			{},
			{ messages: compactedMessages },
		);
		const compactedGuidance = compactedMessages
			.filter((message) => isGuidanceCarrier(message))
			.map((message) => messageTextOf(message as never))
			.join('\n');
		expect(
			compactedMessages.some(
				(message) =>
					isGuidanceCarrier(message) &&
					message.info.id === 'swarm-guidance:architect-session',
			),
		).toBe(false);
		expect(compactedGuidance).not.toContain('[PRE-COMPACTION GUIDANCE]');

		ensureAgentSession(sessionID, 'architect').pendingAdvisoryMessages = [
			'[POST-COMPACTION GUIDANCE]',
		];
		const ordinaryMessages = [
			{
				info: { id: 'ordinary-user', role: 'user', sessionID },
				parts: [{ type: 'text', text: 'Ordinary next turn' }],
			},
		];
		await hooks['experimental.chat.messages.transform'](
			{},
			{ messages: ordinaryMessages },
		);
		const ordinaryGuidance = ordinaryMessages
			.filter((message) => isGuidanceCarrier(message))
			.map((message) => messageTextOf(message as never))
			.join('\n');
		const architectCarriers = ordinaryMessages.filter(
			(message) =>
				isGuidanceCarrier(message) &&
				message.info.id === 'swarm-guidance:architect-session',
		);
		expect(architectCarriers).toHaveLength(1);
		expect(ordinaryGuidance).toContain('[POST-COMPACTION GUIDANCE]');
		expect(ordinaryGuidance).not.toContain('[PRE-COMPACTION GUIDANCE]');
	});

	it('cleans the exact session bridge marker on session deletion', async () => {
		const sessionID = '2533-bridge-deleted-session';
		const hooks = await bootRegisteredHooks({
			knowledge: { enabled: false, hive_enabled: false },
			memory: { enabled: false },
			hooks: { delegation_gate: false },
		});
		ensureAgentSession(sessionID, 'architect');
		swarmState.activeAgent.set(sessionID, 'architect');
		await hooks['experimental.session.compacting'](
			{ sessionID },
			{ context: [] },
		);
		await hooks.event({
			event: { type: 'session.deleted', properties: { sessionID } },
		});

		const messages = [
			{
				info: { id: 'deleted-user', role: 'user', sessionID },
				parts: [{ type: 'text', text: 'New ordinary turn' }],
			},
		];
		await hooks['experimental.chat.messages.transform']({}, { messages });
		expect(
			messages.some(
				(message) =>
					isGuidanceCarrier(message) &&
					message.info.id === 'swarm-guidance:architect-session',
			),
		).toBe(true);
	});
});
