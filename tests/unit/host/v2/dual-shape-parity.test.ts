/**
 * OpenCode v2 dual-shape parity — repo-side regression suite (issue #3004).
 *
 * Repo twin of the trace-frozen checks C1/C3/C5/C6 so the repository owns the
 * guardrail after the trace freezes: the dual-shape default export, v2 tool
 * registration parity (names from the same manifest), ToolContext directory
 * injection (invariant 4 — the wrong-root corruption class the plan-critic
 * flagged), lifecycle registration + resolvable cleanup, and the v2 adapter
 * source-await convention.
 *
 * Drives the REAL source modules (src/index default export through the built
 * bundle for the shape legs; src/host/v2/* directly for behavior legs) against
 * a defensive mock v2 Context matching @opencode/plugin@2.0.20 shapes (see
 * src/host/v2/types.ts provenance header).
 */

import { describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
	V2PluginContext,
	V2ToolContext,
	V2ToolInfo,
} from '../../../../src/host/v2/types';
import { TOOL_NAMES } from '../../../../src/tools/tool-metadata';
import { canonicalMkdtemp } from '../../../helpers/tmpdir';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

function ensureBundle(): string {
	const bundle = join(REPO_ROOT, 'dist', 'index.js');
	if (existsSync(bundle)) return bundle;
	const res = spawnSync(process.execPath, ['run', 'build'], {
		cwd: REPO_ROOT,
		timeout: 300_000,
		stdin: 'ignore',
		encoding: 'utf8',
		windowsHide: true,
	});
	if (res.status !== 0 || !existsSync(bundle)) {
		throw new Error(`bun run build failed: ${String(res.stderr).slice(-500)}`);
	}
	return bundle;
}

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
	eventSubscribed: boolean;
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
		eventSubscribed: false,
		removedAgents: [],
	};
	const registration = { dispose: async () => {} };
	const stub = {
		transform: async () => ({ ...registration }),
		hook: async () => ({ ...registration }),
		list: async () => [],
	};
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
		event: {
			subscribe: () => {
				captured.eventSubscribed = true;
				return (async function* () {})();
			},
		},
		storage: {
			get: async () => undefined,
			set: async () => {},
			remove: async () => {},
			scan: async () => ({ entries: [] }),
		},
		plugin: { list: async () => [] },
		mcp: stub,
		model: stub,
		provider: stub,
		integration: stub,
		reference: stub,
		skill: stub,
		vcs: stub,
		websearch: stub,
		worktree: stub,
		shell: stub,
		permission: stub,
		generate: stub,
		rpc: stub,
		aisdk: stub,
		experimental: stub,
	} as unknown as V2PluginContext;
	return { ctx, captured };
}

describe('v2 dual-shape entrypoint (issue #3004)', () => {
	test('bundle default export carries the full dual shape id+server+setup', async () => {
		const mod = (await import(pathToFileURL(ensureBundle()).href)) as {
			default?: Record<string, unknown>;
		};
		const def = mod.default;
		expect(typeof def?.id).toBe('string');
		expect(typeof def?.server).toBe('function');
		expect(typeof def?.setup).toBe('function');
		// Mirror of the v2 host Module schema (sst/opencode v2.0.20
		// packages/core/src/plugin/module.ts): union of {id, effect:fn} /
		// {id, setup:fn}; excess keys ignored.
	});

	test('setup(ctx) registers the v1 tool-name set via ctx.tool.transform', async () => {
		const directory = canonicalMkdtemp('swarm-v2-parity-');
		try {
			// Manifest parity, not memory gating (issue #3659 owns that): the
			// full-manifest comparison needs every opt-in family enabled, and
			// the loader reads the project config from
			// <dir>/.opencode/opencode-swarm.json.
			mkdirSync(join(directory, '.opencode'), { recursive: true });
			writeFileSync(
				join(directory, '.opencode', 'opencode-swarm.json'),
				'{"memory":{"enabled":true}}',
			);
			const mod = (await import(pathToFileURL(ensureBundle()).href)) as {
				default?: { setup?: (ctx: unknown) => Promise<unknown> };
			};
			const setup = mod.default?.setup;
			expect(typeof setup).toBe('function');
			const { ctx, captured } = makeMockV2Context(directory);
			await setup(ctx);
			const added = captured.toolEditor?.added ?? [];
			expect(added.length).toBe(TOOL_NAMES.length);
			expect(new Set(added.map((t) => t.name))).toEqual(new Set(TOOL_NAMES));
			for (const t of added) {
				expect(typeof t.description).toBe('string');
				expect(typeof t.execute).toBe('function');
			}
		} finally {
			try {
				rmSync(directory, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	}, 120_000);

	test('synthesized ToolContext resolves directory from the setup root, not cwd (invariant 4)', async () => {
		const { _internals } = await import('../../../../src/host/v2/tools');
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
			const mod = (await import(pathToFileURL(ensureBundle()).href)) as {
				default?: { setup?: (ctx: unknown) => Promise<() => Promise<void>> };
			};
			const { ctx, captured } = makeMockV2Context(directory);
			const cleanup = await mod.default?.setup?.(ctx);
			expect(typeof cleanup).toBe('function');
			const names = captured.hookCalls.map((h) => `${h.domain}.${h.name}`);
			expect(names).toContain('tool.execute.before');
			expect(names).toContain('tool.execute.after');
			expect(names).toContain('session.context');
			expect(names).toContain('session.compaction');
			expect(names).toContain('session.prompt');
			expect(captured.eventSubscribed).toBe(true);
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
			await expect(cleanup?.()).resolves.toBeUndefined();
		} finally {
			try {
				rmSync(directory, { recursive: true, force: true });
			} catch {
				/* best-effort */
			}
		}
	}, 120_000);

	test('src/host adapter sources carry no bare awaits (C6 convention)', () => {
		const hostDir = join(REPO_ROOT, 'src', 'host');
		if (!existsSync(hostDir)) return;
		const list = readdirSync(hostDir, { recursive: true })
			.map((f) => (typeof f === 'string' ? f : f.toString()))
			.filter((f) => f.endsWith('.ts'))
			.map((f) => join(hostDir, f));
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
