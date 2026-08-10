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

	test('filters tagged system fragments for the active prefixed role before collapse', async () => {
		swarmState.activeAgent.set(SESSION_ID, 'local_coder');
		const output = {
			system: [
				'base system prompt',
				'[FOR: architect] architect only',
				'[FOR: coder, reviewer] implementation context',
				'[FOR: ALL] shared context',
				'[FOR: ] malformed tag remains ordinary system context',
				'[FOR: typo] unknown role context',
			],
		};

		await transform({ sessionID: SESSION_ID }, output);

		expect(output.system).toHaveLength(1);
		const rendered = output.system[0] ?? '';
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
		const output = { system: ['base', '[FOR: architect] design context'] };

		await transform({ sessionID: SESSION_ID }, output);

		expect(output.system).toHaveLength(1);
		expect(output.system[0]).toContain('design context');
	});

	test('fails open when the active agent cannot be resolved', async () => {
		const output = { system: ['base', '[FOR: architect] critical context'] };

		await transform({ sessionID: SESSION_ID }, output);

		expect(output.system).toHaveLength(1);
		expect(output.system[0]).toContain('critical context');
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
