/**
 * OpenCode v2 dual-shape parity — 8.x repo-side regression suite (issue #3151;
 * port of the 7.x #3004 suite).
 *
 * The repository owns the guardrail: the dual-shape default export
 * {id, server, setup}, v2 tool registration parity (names from the same
 * hooks.tool map the v1 factory returns), ToolContext directory injection
 * (invariant 4 — the wrong-root corruption class the plan-critic flagged),
 * lifecycle registration + resolvable cleanup, and the v2 adapter source-await
 * convention (C6).
 *
 * Where the 7.x twin asserted the BUILT bundle (ensureBundle → dist/index.js),
 * this suite asserts the SOURCE-level default export — this lane must not run
 * repo-wide builds (a parallel lane owns shared build state); the BUILT
 * artifact leg is covered by the trace-frozen C4 check and by
 * tests/smoke/packaging.test.ts once dist is rebuilt.
 */

import { describe, expect, test } from 'bun:test';
import {
	existsSync,
	readdirSync,
	readFileSync,
	rmSync,
} from 'node:fs';
import { join } from 'node:path';
import type { V2PluginContext, V2ToolContext, V2ToolInfo } from '../../../src/host/v2/types';
import { canonicalMkdtemp } from './tmpdir';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');

interface Captured {
	hookCalls: Array<{
		domain: string;
		name: string;
		cb: (event: unknown) => unknown;
	}>;
	toolEditor: { added: V2ToolInfo[]; add(t: V2ToolInfo): void } | null;
	commandEditor: {
		added: Array<{ name: string }>;
		add(d: { name: string }): void;
	} | null;
	agentUpdates: Array<{ id: string; mapped: Record<string, unknown> }>;
	removedAgents: string[];
}

function makeMockV2Context(directory: string): {
	ctx: V2PluginContext;
	captured: Captured;
} {
	const captured: Captured = {
		hookCalls: [],
		toolEditor: null,
		commandEditor: null,
		agentUpdates: [],
		removedAgents: [],
	};
	const registration = { dispose: async () => {} };
	const ctx = {
		app: { name: 'opencode', version: '2.0.20-test', channel: 'test' },
		location: {
			directory,
			workspaceID: 'w',
			project: { id: 'p', directory, canonical: directory },
		},
		options: {},
		tool: {
			transform: async (cb: (editor: Captured['toolEditor']) => void) => {
				const editor = {
					added: [] as V2ToolInfo[],
					add(t: V2ToolInfo) {
						this.added.push(t);
					},
				};
				cb(editor);
				captured.toolEditor = editor;
				return registration;
			},
			reload: async () => {},
			list: async () => [],
			hook: async (name: string, cb: (event: unknown) => unknown) => {
				captured.hookCalls.push({ domain: 'tool', name, cb });
				return registration;
			},
		},
		agent: {
			transform: async (cb: (editor: unknown) => void) => {
				cb({
					list: () => [],
					get: () => undefined,
					default: () => {},
					remove: (id: string) => {
						captured.removedAgents.push(id);
					},
					update: (id: string, fn: (a: Record<string, unknown>) => void) => {
						const mapped: Record<string, unknown> = {};
						fn(
							new Proxy(
								{},
								{
									set: (_t, key, value) => {
										mapped[key as string] = value;
										return true;
									},
								},
							) as unknown as Record<string, unknown>,
						);
						captured.agentUpdates.push({ id, mapped });
					},
				});
				return registration;
			},
			reload: async () => {},
		},
		command: {
			transform: async (cb: (editor: Captured['commandEditor']) => void) => {
				const editor = {
					added: [] as Array<{ name: string }>,
					add(d: { name: string }) {
						this.added.push(d);
					},
				};
				cb(editor);
				captured.commandEditor = editor;
				return registration;
			},
			reload: async () => {},
		},
		session: {
			hook: async (name: string, cb: (event: unknown) => unknown) => {
				captured.hookCalls.push({ domain: 'session', name, cb });
				return registration;
			},
		},
		// delta D4: no event subscription — 8.x setup registers no event pump.
		event: {},
		permission: {},
	} as unknown as V2PluginContext;
	return { ctx, captured };
}

describe('v2 dual-shape entrypoint (issue #3151)', () => {
	test('source default export carries the full dual shape id+server+setup', async () => {
		// SOURCE-level import (bun TS resolution): the built-bundle leg is owned
		// by the trace-frozen C4 check + tests/smoke/packaging.test.ts (dist is
		// rebuilt outside this lane).
		const mod = (await import('../../../src/index')) as {
			default?: Record<string, unknown>;
		};
		const def = mod.default;
		expect(typeof def).toBe('object');
		expect(def?.id).toBe('opencode-swarm');
		expect(typeof def?.server).toBe('function');
		expect(typeof def?.setup).toBe('function');
		// Mirror of the v2 host Module schema (sst/opencode v2.0.20
		// packages/core/src/plugin/module.ts): union of {id, effect:fn} /
		// {id, setup:fn}; excess keys ignored.
	});

	test('setup registers the v1 hooks.tool map names verbatim via ctx.tool.transform', async () => {
		const directory = canonicalMkdtemp('swarm-v2-parity-');
		try {
			const { openCodeSwarmV2Setup } = await import('../../../src/host/v2/setup');
			const { ctx, captured } = makeMockV2Context(directory);
			const v1ToolNames = ['fake_tool_a', 'fake_tool_b'];
			const cleanup = await openCodeSwarmV2Setup(ctx, {
				runInit: async () =>
					({
						name: 'opencode-swarm',
						tool: Object.fromEntries(
							v1ToolNames.map((name) => [
								name,
								{
									description: `v1 tool ${name}`,
									args: {},
									execute: async () => 'ok',
								},
							]),
						),
						agent: {},
						config: async () => {},
						dispose: async () => {},
					}) as never,
			});
			const added = captured.toolEditor?.added ?? [];
			// Parity contract: the v2 tool editor receives EXACTLY the map the v1
			// factory's `tool: {...}` block returns — same names, nothing parallel.
			expect(new Set(added.map((t) => t.name))).toEqual(
				new Set(v1ToolNames),
			);
			for (const t of added) {
				expect(typeof t.description).toBe('string');
				expect(typeof t.execute).toBe('function');
			}
			await expect(cleanup()).resolves.toBeUndefined();
		} finally {
			try {
				rmSync(directory, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	}, 30_000);

	test('synthesized ToolContext resolves directory from the setup root, not cwd (invariant 4)', async () => {
		const { _internals } = await import('../../../src/host/v2/tools');
		const projectRoot = canonicalMkdtemp('swarm-v2-root-');
		try {
			const controller = new AbortController();
			let progressed: Record<string, unknown> | undefined;
			const v2ctx = {
				sessionID: 'v2-dir-test',
				agent: { id: 'local_architect', name: 'architect' },
				messageID: 'm1',
				id: 'call-1',
				signal: controller.signal,
				progress: async (u: Record<string, unknown>) => {
					progressed = u;
				},
			};
			const v1 = _internals.synthesizeV1ToolContext(
				v2ctx,
				projectRoot,
				undefined,
			);
			expect(v1.directory).toBe(projectRoot);
			expect(v1.worktree).toBe(projectRoot);
			expect(v1.sessionID).toBe('v2-dir-test');
			expect(v1.agent).toBe('local_architect');
			expect(v1.abort).toBe(controller.signal);
			v1.metadata({ title: 't', metadata: { k: 1 } });
			expect(progressed).toEqual({ k: 1, title: 't' });
			// ask() fails closed without a permission bridge.
			await expect(v1.ask({})).rejects.toThrow(/permission/i);
		} finally {
			try {
				rmSync(projectRoot, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	}, 20_000);

	test('setup registers lifecycle hooks and returns a resolvable cleanup', async () => {
		const directory = canonicalMkdtemp('swarm-v2-life-');
		try {
			const { openCodeSwarmV2Setup } = await import('../../../src/host/v2/setup');
			const { ctx, captured } = makeMockV2Context(directory);
			const cleanup = await openCodeSwarmV2Setup(ctx, {
				runInit: async () =>
					({
						name: 'opencode-swarm',
						tool: {},
						agent: {},
						config: async (cfg: Record<string, unknown>) => {
							cfg.agent = {
								architect: {
									mode: 'primary',
									prompt: 'orchestrator system prompt',
									description: 'architect',
								},
							};
							cfg.command = {
								swarm: {
									template: '/swarm $ARGUMENTS',
									description: 'swarm management',
								},
							};
						},
						dispose: async () => {},
					}) as never,
			});
			expect(typeof cleanup).toBe('function');
			const names = captured.hookCalls.map((h) => `${h.domain}.${h.name}`);
			expect(names).toContain('tool.execute.before');
			expect(names).toContain('tool.execute.after');
			expect(names).toContain('session.context');
			expect(names).toContain('session.compaction');
			expect(names).toContain('session.prompt');
			// Agents (invariant 11: prefixed primaries survive the v1->v2 mapping)
			// and commands are registered from the shared config-hook output. The
			// mock editor mirrors the vendored V2AgentEditor: the update() upsert
			// is the ONLY path real v2 hosts take.
			expect(captured.agentUpdates.length).toBeGreaterThan(0);
			const architect = captured.agentUpdates.find(
				(a) => a.id === 'architect' || a.id.endsWith('_architect'),
			);
			expect(architect).toBeDefined();
			expect(architect?.mapped.system).toBeTypeOf('string');
			expect(String(architect?.mapped.mode)).toMatch(/primary|subagent|all/);
			expect(captured.commandEditor?.added.length).toBeGreaterThan(0);
			expect(
				captured.commandEditor?.added.some((c) => c.name === 'swarm'),
			).toBe(true);
			await expect(cleanup()).resolves.toBeUndefined();
		} finally {
			try {
				rmSync(directory, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	}, 30_000);

	test('src/host adapter sources carry no bare awaits (C6 convention)', () => {
		const hostDir = join(REPO_ROOT, 'packages', 'opencode', 'src', 'host');
		if (!existsSync(hostDir)) return;
		const list = readdirSync(hostDir, { recursive: true })
			.map((f) => (typeof f === 'string' ? f : f.toString()))
			.filter((f) => f.endsWith('.ts'))
			.map((f) => join(hostDir, f))
			// timeout.ts IS the withTimeout primitive itself — in 7.x it lived in
			// src/utils/timeout.ts, outside the scanned host tree; its internal
			// Promise.race awaits are the boundedness mechanism, not bare awaits.
			.filter((f) => !f.endsWith(`${join('v2', 'timeout.ts')}`));
		expect(list.length).toBeGreaterThan(0);
		const violations: string[] = [];
		for (const file of list) {
			const text = readFileSync(file, 'utf8');
			const lines = text.split(/\r?\n/);
			let currentFn = '';
			for (const line of lines) {
				const trimmed = line.trim();
				if (
					trimmed.startsWith('*') ||
					trimmed.startsWith('//') ||
					trimmed.startsWith('/*')
				)
					continue;
				const fnDecl = line.match(
					/(?:^|\s)(?:function\s+([A-Za-z0-9_]+)|(?:const|let)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\()/,
				);
				if (fnDecl) currentFn = fnDecl[1] ?? fnDecl[2] ?? '';
				if (!/\bawait\b/.test(line)) continue;
				if (line.includes('withTimeout')) continue;
				if (/deferred|cleanup|postresolution/i.test(currentFn)) continue;
				violations.push(
					`${file.split(String.fromCharCode(92)).pop()}: bare await in '${currentFn}': ${line.trim()}`,
				);
			}
		}
		expect(violations).toEqual([]);
	});
});
