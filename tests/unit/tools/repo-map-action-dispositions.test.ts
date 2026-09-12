import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { repo_map } from '../../../src/tools/repo-map.js';
import {
	REPO_MAP_ACTION_DISPOSITIONS,
	type RepoMapActionDisposition,
} from '../../../src/tools/repo-map-action-dispositions.js';
import { isContextualReferenceLine } from '../../helpers/repo-map-ratchet.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir.js';

/**
 * Disposition-registry contract for the six audit actions of issue #2540
 * (REPOGRAPH-11): each action is individually disposed retained-with-consumer
 * or retired, the subject set is exactly the six audit actions (the #2516
 * controls route_trace/test_pack and the independently-wired callers/retrieve
 * are not subjects), and every retained action proves a bounded runtime
 * result (or typed fallback) through the registered repo_map tool path.
 */

const ROOT = path.resolve(import.meta.dir, '..', '..', '..');
const AUDIT_ACTIONS = [
	'dead_exports',
	'graph_explain',
	'ontology',
	'preflight_packet',
	'symbol_context',
	'symbol_search',
] as const;

interface ExecutableTool {
	execute: (args: unknown, ctx: { directory: string }) => Promise<string>;
}

const tool = repo_map as unknown as ExecutableTool;

const tempDirs: string[] = [];

function parse(raw: string): Record<string, unknown> {
	try {
		return JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return { __unparseable: true, __length: raw.length };
	}
}

/** Mirrors the frozen c3/c5 makeWorkspace fixture (issue #2540 check contract). */
function makeWorkspace(): string {
	const tmp = canonicalMkdtemp('repo-map-disp-');
	tempDirs.push(tmp);
	fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
	fs.writeFileSync(
		path.join(tmp, 'src/util.ts'),
		[
			'export function add(a: number, b: number) { return a + b; }',
			'export class Calculator {',
			'  run() { return add(1, 2); }',
			'}',
			'',
		].join('\n'),
	);
	fs.writeFileSync(
		path.join(tmp, 'src/main.ts'),
		"import { add } from './util';\nconsole.log(add(1, 2));\n",
	);
	return tmp;
}

function makeEmptyDir(): string {
	const tmp = canonicalMkdtemp('repo-map-disp-empty-');
	tempDirs.push(tmp);
	return tmp;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup on Windows file-lock contention.
		}
	}
});

/** Minimal per-action payload shape the name promises (F-N04/F-004). */
const PAYLOAD_PROBES: Record<
	string,
	(result: Record<string, unknown>) => void
> = {
	symbol_search: (r) => {
		expect(Array.isArray(r.hits), 'symbol_search hits').toBe(true);
		expect(
			(r.hits as unknown[]).length,
			'symbol_search hit count',
		).toBeGreaterThan(0);
	},
	symbol_context: (r) => {
		expect(
			r.found ?? r.identity ?? r.symbol,
			'symbol_context payload',
		).toBeTruthy();
	},
	graph_explain: (r) => {
		expect(
			Array.isArray(r.reasons) || Array.isArray(r.entries) || r.explanation,
			'graph_explain payload',
		).toBeTruthy();
	},
	preflight_packet: (r) => {
		expect(
			r.packet ?? r.targets ?? r.summary,
			'preflight_packet payload',
		).toBeTruthy();
	},
	dead_exports: (r) => {
		expect(Array.isArray(r.candidates), 'dead_exports candidates').toBe(true);
	},
	ontology: (r) => {
		expect(r.target ?? r.ontology, 'ontology payload').toBeTruthy();
	},
};

describe('REPO_MAP_ACTION_DISPOSITIONS registry (issue #2540)', () => {
	test('subject set is exactly the six audit actions, all retained', () => {
		expect(Object.keys(REPO_MAP_ACTION_DISPOSITIONS).sort()).toEqual(
			[...AUDIT_ACTIONS].sort(),
		);
		for (const action of AUDIT_ACTIONS) {
			const entry: RepoMapActionDisposition =
				REPO_MAP_ACTION_DISPOSITIONS[action];
			expect(entry.disposition, action).toBe('retained');
			expect(entry.consumers, action).toBeDefined();
			expect(entry.consumers?.length ?? 0, action).toBeGreaterThan(0);
		}
	});

	test('the #2516 controls are not registry subjects', () => {
		expect(REPO_MAP_ACTION_DISPOSITIONS['route_trace']).toBeUndefined();
		expect(REPO_MAP_ACTION_DISPOSITIONS['test_pack']).toBeUndefined();
	});

	test('every retained consumer file exists and contains a repo_map-contextual reference', () => {
		for (const action of AUDIT_ACTIONS) {
			for (const consumer of REPO_MAP_ACTION_DISPOSITIONS[action].consumers ??
				[]) {
				const file = path.join(ROOT, consumer);
				expect(fs.existsSync(file), `${action} consumer ${consumer}`).toBe(
					true,
				);
				const lines = fs.readFileSync(file, 'utf-8').split(/\r?\n/);
				const hit = lines.some((line) =>
					isContextualReferenceLine(line, action),
				);
				expect(
					hit,
					`${action} consumer ${consumer} has no repo_map-contextual reference`,
				).toBe(true);
			}
		}
	});

	test('each retained action returns a useful bounded result on a built graph', async () => {
		const dir = makeWorkspace();
		const built = parse(
			await tool.execute({ action: 'build' }, { directory: dir }),
		);
		expect(built.success, 'build failed').toBe(true);

		const requests: Record<string, Record<string, unknown>> = {
			symbol_search: { action: 'symbol_search', symbol: 'add' },
			symbol_context: {
				action: 'symbol_context',
				file: 'src/util.ts',
				symbol: 'add',
			},
			graph_explain: { action: 'graph_explain', file: 'src/main.ts' },
			preflight_packet: { action: 'preflight_packet', files: ['src/util.ts'] },
			dead_exports: { action: 'dead_exports' },
			ontology: { action: 'ontology', file: 'src/util.ts' },
		};
		for (const action of AUDIT_ACTIONS) {
			const raw = await tool.execute(requests[action], { directory: dir });
			expect(raw.length, `${action} unbounded output`).toBeLessThan(32_768);
			const result = parse(raw);
			expect(
				result.success,
				`${action} failed on built graph: ${raw.slice(0, 200)}`,
			).toBe(true);
			expect(result.action, action).toBe(action);
			PAYLOAD_PROBES[action]?.(result);
		}
	}, 120_000);

	test('each retained action returns a typed actionable fallback when the graph is absent', async () => {
		const dir = makeEmptyDir();
		const requests: Record<string, Record<string, unknown>> = {
			symbol_search: { action: 'symbol_search', symbol: 'add' },
			symbol_context: {
				action: 'symbol_context',
				file: 'src/util.ts',
				symbol: 'add',
			},
			graph_explain: { action: 'graph_explain', file: 'src/main.ts' },
			preflight_packet: { action: 'preflight_packet', files: ['src/util.ts'] },
			dead_exports: { action: 'dead_exports' },
			ontology: { action: 'ontology', file: 'src/util.ts' },
		};
		for (const action of AUDIT_ACTIONS) {
			const raw = await tool.execute(requests[action], { directory: dir });
			const result = parse(raw);
			expect(
				result.success,
				`${action} should fail closed without a graph`,
			).toBe(false);
			expect(typeof result.error, `${action} typed error`).toBe('string');
			expect(
				(result.error as string).length,
				`${action} error text`,
			).toBeGreaterThan(0);
		}
	}, 120_000);
});
