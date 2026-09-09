/**
 * Issue #2664 — registered-host integration: boots the real plugin
 * `server()`, executes real scan tools (`placeholder_scan`, `syntax_check`)
 * through the REGISTERED tool map, and drives pre_check_batch receipts
 * through the REGISTERED tool.execute.before/after hooks — with guardrails
 * enabled AND disabled (XDG_CONFIG_HOME hermetic so a developer's user-level
 * config cannot re-enable guardrails behind the project file).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readCoreEvents } from '../../src/events/core-events';
import {
	getTaskWorkflowSnapshot,
	readTaskEvidence,
	transitionTaskWorkflowEvidence,
} from '../../src/gate-evidence';
import OpenCodeSwarmPlugin from '../../src/index';
import { ensureAgentSession, resetSwarmState } from '../../src/state';
import { resetTelemetryForTesting } from '../../src/telemetry';
import { canonicalMkdtemp } from '../helpers/tmpdir';

const PASS_PAYLOAD = JSON.stringify({
	gates_passed: true,
	total_duration_ms: 1,
	batch_status: 'completed',
	lint: { ran: true, duration_ms: 1 },
	secretscan: {
		ran: true,
		duration_ms: 1,
		result: {
			count: 0,
			findings: [],
			files_scanned: 5,
			incomplete_files: 0,
			incomplete_paths: [],
		},
	},
	sast_scan: { ran: true, duration_ms: 1, result: { verdict: 'pass' } },
	quality_budget: { ran: false, duration_ms: 0 },
});

const FAIL_PAYLOAD = JSON.stringify({
	gates_passed: false,
	total_duration_ms: 1,
	batch_status: 'completed',
	lint: { ran: true, duration_ms: 1 },
	secretscan: { ran: false, duration_ms: 0 },
	sast_scan: { ran: false, duration_ms: 0 },
	quality_budget: { ran: false, duration_ms: 0 },
});

interface Host {
	hooks: Record<string, (input: unknown, output: unknown) => Promise<void>>;
	tool: Record<
		string,
		{ execute: (args: unknown, ctx: unknown) => Promise<unknown> }
	>;
}

let hermeticConfigHome: string;
let prevXdg: string | undefined;
let directory: string;

async function bootHost(guardrailsEnabled: boolean): Promise<Host> {
	const opencodeDir = path.join(directory, '.opencode');
	fs.mkdirSync(opencodeDir, { recursive: true });
	fs.writeFileSync(
		path.join(opencodeDir, 'opencode-swarm.json'),
		JSON.stringify({
			version_check: false,
			knowledge: { enabled: true, hive_enabled: false },
			guardrails: { enabled: guardrailsEnabled },
		}),
	);
	const ctx = {
		client: {},
		project: {},
		directory,
		worktree: directory,
		serverUrl: new URL('http://localhost:3000'),
		$: {},
	};
	// server() returns the hook map at TOP level (the knowledge-real-host
	// helper wraps this same object as { hooks: result, tool: result.tool }).
	const result = (await (
		OpenCodeSwarmPlugin as unknown as {
			server: (c: unknown) => Promise<Record<string, unknown>>;
		}
	).server(ctx)) as unknown as Host;
	return {
		hooks: result as unknown as Host['hooks'],
		tool: (result as unknown as { tool: Host['tool'] }).tool ?? {},
	};
}

beforeEach(() => {
	directory = canonicalMkdtemp('swarm-host-stage-a-');
	resetSwarmState();
	resetTelemetryForTesting();
	hermeticConfigHome = canonicalMkdtemp('swarm-host-xdg-');
	prevXdg = process.env.XDG_CONFIG_HOME;
	process.env.XDG_CONFIG_HOME = hermeticConfigHome;
});

afterEach(() => {
	if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
	else process.env.XDG_CONFIG_HOME = prevXdg;
	resetSwarmState();
	resetTelemetryForTesting();
	for (const dir of [directory, hermeticConfigHome]) {
		try {
			fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
		} catch {
			/* held handles on Windows; disposable */
		}
	}
});

function routeEvents(): Array<Record<string, unknown>> {
	const events: Array<Record<string, unknown>> = [];
	for (const line of readCoreEvents(directory).text.split('\n')) {
		if (!line.includes('stage_a_gate_route')) continue;
		try {
			events.push(JSON.parse(line) as Record<string, unknown>);
		} catch {
			/* manifest line */
		}
	}
	return events;
}

describe('registered host — Stage A receipts with guardrails on and off', () => {
	for (const enabled of [true, false]) {
		test(`real scan tools + valid/rejected receipts (guardrails ${enabled ? 'on' : 'off'})`, async () => {
			fs.mkdirSync(path.join(directory, 'src'), { recursive: true });
			fs.writeFileSync(
				path.join(directory, 'src', 'sample.ts'),
				'export function f() {\n  return 1;\n}\n',
			);
			const host = await bootHost(enabled);

			// Real scan tools through the REGISTERED tool map — bounded JSON.
			const scan = (await host.tool.placeholder_scan?.execute(
				{ files: ['src/sample.ts'] },
				{},
			)) as unknown;
			expect(scan).toBeDefined();
			expect(Buffer.byteLength(JSON.stringify(scan), 'utf8')).toBeLessThan(
				65_536,
			);
			const syntax = (await host.tool.syntax_check?.execute(
				{ files: ['src/sample.ts'] },
				{},
			)) as unknown;
			expect(syntax).toBeDefined();

			// Valid receipt: pre_check_batch PASS through REGISTERED hooks.
			await transitionTaskWorkflowEvidence(directory, '1.1', {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 0,
				transitionId: 'coder:setup-1.1',
			});
			resetSwarmState();
			const session = ensureAgentSession('architect');
			session.currentTaskId = '1.1';
			await host.hooks['tool.execute.before'](
				{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'rp1' },
				{ args: {} },
			);
			await host.hooks['tool.execute.after'](
				{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'rp1' },
				{ title: '', output: PASS_PAYLOAD, metadata: null },
			);
			expect(
				getTaskWorkflowSnapshot(await readTaskEvidence(directory, '1.1')).state,
			).toBe('pre_check_passed');

			// Rejected receipt: FAIL lands rework_required in BOTH modes.
			await transitionTaskWorkflowEvidence(directory, '1.2', {
				type: 'accepted_mutation',
				agentType: 'coder',
				expectedGeneration: 0,
				transitionId: 'coder:setup-1.2',
			});
			resetSwarmState();
			const session2 = ensureAgentSession('architect');
			session2.currentTaskId = '1.2';
			await host.hooks['tool.execute.before'](
				{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'rp2' },
				{ args: {} },
			);
			await host.hooks['tool.execute.after'](
				{ tool: 'pre_check_batch', sessionID: 'architect', callID: 'rp2' },
				{ title: '', output: FAIL_PAYLOAD, metadata: null },
			);
			expect(
				getTaskWorkflowSnapshot(await readTaskEvidence(directory, '1.2')).state,
			).toBe('rework_required');

			// Route events recorded with the correct mode flag.
			const events = routeEvents();
			const routes = events.map((e) => e.route);
			expect(routes).toContain('valid_pass');
			expect(routes).toContain('pre_check_failed');
			for (const event of events) {
				expect(event.guardrailsEnabled).toBe(enabled);
			}
		}, 120_000);
	}
});
