/**
 * r16 audit (P2, 7.1): concurrent context-map writes across processes.
 *
 * `saveContextMap` historically used a FIXED temp name
 * (`.swarm/context-map.tmp`) with no cross-process coordination. Two writers
 * that both LOADED the map before either saved lose one writer's whole
 * update (last rename wins), and two writers overlapping inside the save
 * itself could clobber the shared temp file (one rename installs the OTHER
 * writer's bytes, the second rename fails with ENOENT).
 *
 * The r16 repair has two halves:
 * - `saveContextMap` now persists through the canonical atomic writer
 *   (unique registered temp + fsync + rename), so no two writers ever share
 *   a temp artifact;
 * - the production mutation entry points
 *   (`updateContextMapAfterAgentLocked`, `promoteContextMapTaskReleaseLocked`,
 *   the reconciliation loop) wrap their whole load→mutate→save cycle in the
 *   EXISTING cross-process evidence lock (`withContextMapLock`), so
 *   participating writers serialize and cannot lose each other's updates.
 *
 * The uncoordinated RAW load→append→save cycle remains legal for
 * single-writer use (tests, tooling) and is pinned below as a documented
 * hazard — the lock is a coordinating layer, not a sandbox.
 *
 * Subprocess handling follows Invariant 3 (array-form spawn, stdin ignored,
 * timeout, bounded output, kill in finally).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	appendTaskHistory,
	createEmptyContextMap,
	loadContextMap,
	saveContextMap,
} from '../../../src/context-map/persistence';
import { bunSpawn } from '../../../src/utils/bun-compat.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const CHILD_TIMEOUT_MS = 60_000;
const CHILD_MAX_OUTPUT_BYTES = 8_192;

function makeTempProject(): string {
	const dir = canonicalMkdtemp('swarm-ctxmap-mp-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	return dir;
}

function seedBaseEntry(directory: string): void {
	saveContextMap(
		appendTaskHistory(createEmptyContextMap(), {
			task_id: '1.0',
			goal: '',
			files_touched: [],
			implementation_summary: 'base entry',
			final_status: 'pending',
		}),
		directory,
	);
}

function childEnv(
	dir: string,
	label: 'A' | 'B',
	extra: Record<string, string>,
): NodeJS.ProcessEnv {
	return {
		...process.env,
		SWARM_MP_DIR: dir,
		SWARM_MP_LABEL: label,
		SWARM_MP_PAU_SRC: pathToFileURL(
			path.resolve(process.cwd(), 'src/context-map/post-agent-update.ts'),
		).href,
		SWARM_MP_PERSISTENCE_SRC: pathToFileURL(
			path.resolve(process.cwd(), 'src/context-map/persistence.ts'),
		).href,
		...extra,
	};
}

function spawnChild(script: string, env: NodeJS.ProcessEnv) {
	return bunSpawn([process.execPath, '-e', script], {
		cwd: process.cwd(),
		env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: CHILD_TIMEOUT_MS,
		killProcessTree: true,
	});
}

async function readBounded(
	stream: ReadableStream<Uint8Array> | undefined,
): Promise<string> {
	if (!stream) return '';
	const reader = stream.getReader();
	let out = '';
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			out += new TextDecoder().decode(value);
			if (out.length > CHILD_MAX_OUTPUT_BYTES) {
				out = out.slice(0, CHILD_MAX_OUTPUT_BYTES);
				break;
			}
		}
	} finally {
		reader.releaseLock();
	}
	return out;
}

async function waitChild(
	child: ReturnType<typeof spawnChild>,
): Promise<{ code: number; stdout: string; stderr: string }> {
	const [stdout, stderr, code] = await Promise.all([
		readBounded(child.stdout),
		readBounded(child.stderr),
		child.exited,
	]);
	return { code, stdout, stderr };
}

/** Barrier-forced lost-update repro: both children LOAD the same base map
 * (barrier), then both save their own extension — the later rename wins and
 * the earlier writer's entry is lost. */
const BARRIER_SCRIPT = `
const persistence = await import(process.env.SWARM_MP_PERSISTENCE_SRC);
const fs = await import('node:fs');
const path = await import('node:path');
const dir = process.env.SWARM_MP_DIR;
const label = process.env.SWARM_MP_LABEL;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const barrier = (name) => path.join(dir, name);
const waitBarrier = async (name) => {
	while (!fs.existsSync(barrier(name))) await sleep(5);
};
const mark = (name) => fs.writeFileSync(barrier(name), '1', 'utf-8');
const map = persistence.loadContextMap(dir) ?? persistence.createEmptyContextMap();
mark('ready-' + label);
await waitBarrier(label === 'A' ? 'ready-B' : 'ready-A');
persistence.saveContextMap(persistence.appendTaskHistory(map, {
	task_id: label === 'A' ? '1.1' : '1.2',
	goal: '',
	files_touched: [],
	implementation_summary: 'entry-' + label,
	final_status: 'pending',
}), dir);
mark('saved-' + label);
process.exit(0);
`;

/** Coordinated writer: each child performs OPS locked
 * load→append→save cycles with task ids disjoint from the other child's. */
const LOCKED_SCRIPT = `
const pau = await import(process.env.SWARM_MP_PAU_SRC);
const persistence = await import(process.env.SWARM_MP_PERSISTENCE_SRC);
const dir = process.env.SWARM_MP_DIR;
const label = process.env.SWARM_MP_LABEL;
const ops = Number(process.env.SWARM_MP_OPS);
for (let i = 0; i < ops; i++) {
	const taskId = label === 'A' ? '3.' + (i + 1) : '4.' + (i + 1);
	await pau.withContextMapLock(dir, 'mp-writer-' + label, taskId, () => {
		const map = persistence.loadContextMap(dir) ?? persistence.createEmptyContextMap();
		persistence.saveContextMap(persistence.appendTaskHistory(map, {
			task_id: taskId,
			goal: '',
			files_touched: [],
			implementation_summary: 'locked-' + label + '-' + i,
			final_status: 'pending',
		}), dir);
	});
}
process.exit(0);
`;

describe('context-map persistence under multi-process contention (r16 P2)', () => {
	let dir: string;
	beforeEach(() => {
		dir = makeTempProject();
		seedBaseEntry(dir);
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
	});

	test('uncoordinated load→append→save cycles lose one writer\u2019s update (documented hazard)', async () => {
		// This test PINS the documented limitation: the RAW persistence
		// functions are uncoordinated by design (single-writer use). Both
		// children load the same base map behind a barrier, then both save —
		// whichever rename lands last was built from the pre-save base and
		// necessarily drops the other child's entry. Production writers must
		// go through withContextMapLock (next test) — that is the fix.
		const a = spawnChild(BARRIER_SCRIPT, childEnv(dir, 'A', {}));
		const b = spawnChild(BARRIER_SCRIPT, childEnv(dir, 'B', {}));
		const [ra, rb] = await Promise.all([waitChild(a), waitChild(b)]);
		// The barrier protocol itself must have completed for both children.
		expect(ra.code).toBe(0);
		expect(rb.code).toBe(0);

		const history = loadContextMap(dir)?.task_history ?? {};
		// The base entry always survives...
		expect(history['1.0']?.implementation_summary).toBe('base entry');
		// ...and exactly ONE of the two writers' entries is lost — the
		// deterministic lost update this hazard produces.
		const survived = ['1.1', '1.2'].filter((id) => history[id] !== undefined);
		expect(survived).toHaveLength(1);
	});

	test(
		'coordinated writers never lose each other\u2019s entries (withContextMapLock)',
		async () => {
			const OPS = 25;
			const a = spawnChild(
				LOCKED_SCRIPT,
				childEnv(dir, 'A', { SWARM_MP_OPS: String(OPS) }),
			);
			const b = spawnChild(
				LOCKED_SCRIPT,
				childEnv(dir, 'B', { SWARM_MP_OPS: String(OPS) }),
			);
			const [ra, rb] = await Promise.all([waitChild(a), waitChild(b)]);
			expect(ra.code).toBe(0);
			expect(ra.stderr.trim()).toBe('');
			expect(rb.code).toBe(0);
			expect(rb.stderr.trim()).toBe('');

			const history = loadContextMap(dir)?.task_history ?? {};
			expect(history['1.0']?.implementation_summary).toBe('base entry');
			for (let i = 1; i <= OPS; i++) {
				expect(history[`3.${i}`]?.implementation_summary).toBe(
					`locked-A-${i - 1}`,
				);
				expect(history[`4.${i}`]?.implementation_summary).toBe(
					`locked-B-${i - 1}`,
				);
			}
			// No fixed-temp residue from the canonical writer.
			expect(fs.existsSync(path.join(dir, '.swarm', 'context-map.tmp'))).toBe(
				false,
			);
		},
		CHILD_TIMEOUT_MS + 30_000,
	);
});
