import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { getSafeDefaultConfigLoadResult } from '../../../src/config';
import {
	createRoleFilterSystemHook,
	filterByRole,
} from '../../../src/context/role-filter';
import OpenCodeSwarm, {
	overrideIndexInternalsForTest,
} from '../../../src/index';
import { swarmState } from '../../../src/state';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SESSION_ID = 'role-filter-wiring-session';

describe('role-filter production wiring', () => {
	let tempDir: string;
	let restoreIndexInternals = () => {};
	let transform: (
		input: { sessionID?: string },
		output: { system?: string[] },
	) => Promise<void>;

	beforeAll(async () => {
		tempDir = canonicalMkdtemp('swarm-role-filter-wiring-');
		restoreIndexInternals = overrideIndexInternalsForTest({
			loadPluginConfigWithMetaAsync: async () =>
				getSafeDefaultConfigLoadResult(),
			loadSnapshot: async () => undefined,
			ensureSwarmGitExcluded: async () => undefined,
			schedulePostResolutionTasks: () => {},
		});
		const plugin = await OpenCodeSwarm.server({
			client: {} as never,
			project: {} as never,
			directory: tempDir,
			worktree: tempDir,
			serverUrl: new URL('http://localhost:3000'),
			$: {} as never,
		});
		transform = plugin[
			'experimental.chat.system.transform'
		] as typeof transform;
	});

	afterEach(() => {
		swarmState.activeAgent.delete(SESSION_ID);
		swarmState.agentSessions.delete(SESSION_ID);
	});

	afterAll(async () => {
		restoreIndexInternals();
		await rm(tempDir, { recursive: true, force: true });
	});

	// These assertions read the WHOLE `output.system` array rather than a single
	// collapsed entry. The chain used to end in a handler that joined every entry
	// into one, so `output.system[0]` was the entire prompt — but that handler
	// rebound `output.system`, which the host never observes, so it never ran in
	// production and was removed in issue #1619. Asserting on the joined array is
	// what the host actually materializes (one system message per entry).
	//
	// #1619 review round 4 (F6): a joined-string `toContain` check alone cannot
	// see a DUPLICATE, so a double-push regression in role-filter's new
	// `output.system.length = 0` + loop refill would pass silently. The count
	// assertions below restore that coverage. They deliberately count only the
	// SEEDED entries, not `output.system.length`: the full array also carries
	// injections from every other handler in the chain, one of which
	// (`[PRE-FLIGHT ADVISORY]`) enumerates binaries that happen to be missing on
	// the host, so a whole-array length would be machine-dependent. The
	// no-duplicates assertion is the whole-array guard, and it is
	// environment-independent.
	function seededOnly(system: string[] | undefined, seeded: string[]) {
		return (system ?? []).filter((entry) => seeded.includes(entry));
	}

	function expectNoDuplicates(system: string[] | undefined) {
		const entries = system ?? [];
		expect(new Set(entries).size, 'duplicate system entries').toBe(
			entries.length,
		);
	}

	test('filters tagged system fragments for the active prefixed role', async () => {
		swarmState.activeAgent.set(SESSION_ID, 'local_coder');
		const seeded = [
			'base system prompt',
			'[FOR: architect] architect only',
			'[FOR: coder, reviewer] implementation context',
			'[FOR: ALL] shared context',
			'[FOR: ] malformed tag remains ordinary system context',
			'[FOR: typo] unknown role context',
		];
		const output = { system: [...seeded] };

		await transform({ sessionID: SESSION_ID }, output);

		// Exact, measured behaviour: of the six seeded entries the filter keeps
		// four (untagged, [FOR: coder…], [FOR: ALL], and the malformed empty tag,
		// which stays protected system context) and drops two.
		const kept = seededOnly(output.system, seeded);
		expect(kept).toHaveLength(4);
		expect(kept).toEqual([
			'base system prompt',
			'[FOR: coder, reviewer] implementation context',
			'[FOR: ALL] shared context',
			'[FOR: ] malformed tag remains ordinary system context',
		]);
		expectNoDuplicates(output.system);

		const rendered = (output.system ?? []).join('\n\n');
		expect(rendered).toContain('base system prompt');
		expect(rendered).not.toContain('architect only');
		expect(rendered).toContain('implementation context');
		expect(rendered).toContain('shared context');
		expect(rendered).toContain('malformed tag remains ordinary system context');
		expect(rendered).not.toContain('unknown role context');
		expect(rendered.indexOf('base system prompt')).toBeLessThan(
			rendered.indexOf('implementation context'),
		);
		const eventsPath = path.join(tempDir, '.swarm', 'events.jsonl');
		const events = existsSync(eventsPath)
			? readFileSync(eventsPath, 'utf8')
			: '';
		expect(events).not.toContain('"event":"context_filtered"');
	});

	test('preserves matching tagged system context for a prefixed architect', async () => {
		swarmState.activeAgent.set(SESSION_ID, 'mega_architect');
		const seeded = ['base', '[FOR: architect] design context'];
		const output = { system: [...seeded] };

		await transform({ sessionID: SESSION_ID }, output);

		expect(seededOnly(output.system, seeded)).toEqual(seeded);
		expectNoDuplicates(output.system);
		expect((output.system ?? []).join('\n\n')).toContain('design context');
	});

	test('fails open when the active agent cannot be resolved', async () => {
		const seeded = ['base', '[FOR: architect] critical context'];
		const output = { system: [...seeded] };

		await transform({ sessionID: SESSION_ID }, output);

		expect(seededOnly(output.system, seeded)).toEqual(seeded);
		expectNoDuplicates(output.system);
		expect((output.system ?? []).join('\n\n')).toContain('critical context');
	});

	test('retains direct-call zero-exclusion metrics behavior', () => {
		const metricsDir = path.join(tempDir, 'direct-metrics');
		filterByRole(
			[{ role: 'assistant', content: 'shared' }],
			'coder',
			metricsDir,
		);

		const events = readFileSync(
			path.join(metricsDir, '.swarm', 'events.jsonl'),
			'utf8',
		)
			.trim()
			.split('\n');
		const event = JSON.parse(events.at(-1) ?? '{}');
		expect(event.filteredEntries).toBe(0);
		expect(event.includedEntries).toBe(1);
	});
});

describe('role-filter system hook adapter', () => {
	test('filters only valid tagged system entries when opted in', async () => {
		const hook = createRoleFilterSystemHook(() => 'local_coder');
		const transform = hook['experimental.chat.system.transform'];
		const output = {
			system: [
				'  untagged bytes  ',
				'[FOR: architect] hidden',
				'[FOR: coder] visible',
				'[FOR: ] malformed',
			],
		};

		await transform({ sessionID: 'session' }, output);

		expect(output.system).toEqual([
			'  untagged bytes  ',
			'[FOR: coder] visible',
			'[FOR: ] malformed',
		]);
	});

	// #1619 review round 4. The host builds its own system list `l`, remembers
	// `i = l[0]`, runs the system.transform chain, and only collapses to at most
	// two entries when `l.length > 2 && l[0] === i` (host binary ~100,587,200).
	// This filter mutates `l` in place, so if it ever dropped or reordered the
	// first entry the host would SKIP that reshape and the model would receive
	// more than two system messages — the #628 local-model crash class. The base
	// prompt is untagged, so `parseForTag` returns null and it is retained first;
	// this pins that, because nothing else does.
	test('leaves the first (untagged) entry in place, preserving the host reshape precondition', async () => {
		const hook = createRoleFilterSystemHook(() => 'local_coder');
		const transform = hook['experimental.chat.system.transform'];
		const basePrompt = 'BASE SYSTEM PROMPT';
		const output = {
			system: [
				basePrompt,
				'[FOR: architect] dropped',
				'[FOR: coder] kept',
				'[FOR: reviewer] also dropped',
			],
		};
		const first = output.system[0];

		await transform({ sessionID: 'session' }, output);

		expect(output.system[0]).toBe(first);
		expect(output.system).toEqual([basePrompt, '[FOR: coder] kept']);
	});

	test('fails open for a missing session ID or unresolved agent', async () => {
		const hook = createRoleFilterSystemHook(() => undefined);
		const transform = hook['experimental.chat.system.transform'];
		const withoutSession = { system: ['[FOR: architect] one'] };
		const withoutAgent = { system: ['[FOR: architect] two'] };

		await transform({}, withoutSession);
		await transform({ sessionID: 'unknown' }, withoutAgent);

		expect(withoutSession.system).toEqual(['[FOR: architect] one']);
		expect(withoutAgent.system).toEqual(['[FOR: architect] two']);
	});

	test('leaves missing and empty system arrays unchanged', async () => {
		const hook = createRoleFilterSystemHook(() => 'coder');
		const transform = hook['experimental.chat.system.transform'];
		const missing: { system?: string[] } = {};
		const empty = { system: [] as string[] };

		await transform({ sessionID: 'session' }, missing);
		await transform({ sessionID: 'session' }, empty);

		expect(missing).toEqual({});
		expect(empty.system).toEqual([]);
	});
});
