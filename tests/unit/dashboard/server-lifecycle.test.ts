/**
 * Dashboard lifecycle tests (issue #2509 AC1/AC2/AC7): start/close, port
 * conflict disable-with-notice, absent-DB bounded views, large-store caps,
 * bounded registry. Real server + real store APIs on ephemeral loopback
 * ports; no mock.module.
 */

import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import {
	closeDashboardServerForRoot,
	closeDashboardServerForRootIfOwner,
	type DashboardHandle,
	getDashboardHandle,
	startDashboardServer,
} from '../../../src/dashboard/index.js';
import { appendObservabilityEventDb } from '../../../src/db/observability-event-store.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { createObservation } from '../../../src/observability/index.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const s = net.createServer();
		s.listen(0, '127.0.0.1', () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => resolve(p));
		});
	});
}

/**
 * Bind with bounded retry over fresh ephemeral ports (review round 2, C20):
 * the close-then-rebind freePort() probe has a TOCTOU window — another
 * process can claim the port before we listen. Three attempts make an
 * EADDRINUSE here a real bug instead of a flake.
 */
async function startOnFreePort(dir: string): Promise<DashboardHandle> {
	let lastStatus = 'untried';
	for (let attempt = 0; attempt < 3; attempt++) {
		const handle = await startDashboardServer({
			port: await freePort(),
			host: '127.0.0.1',
			directory: dir,
		});
		if (handle.listening) return handle;
		lastStatus = handle.status;
		await handle.close();
	}
	throw new Error(
		`no bindable ephemeral port after 3 attempts (${lastStatus})`,
	);
}

function reachable(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const r = http.request(
			{ host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 1500 },
			(res) => {
				res.resume();
				res.on('end', () => resolve(true));
			},
		);
		r.on('timeout', () => {
			r.destroy();
			resolve(false);
		});
		r.on('error', () => resolve(false));
		r.end();
	});
}

function getBody(urlStr: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const u = new URL(urlStr);
		const r = http.request(
			{ host: u.hostname, port: u.port, path: u.pathname, timeout: 6000 },
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c: Buffer) => chunks.push(c));
				res.on('end', () =>
					resolve({
						status: res.statusCode ?? 0,
						body: Buffer.concat(chunks).toString('utf8'),
					}),
				);
			},
		);
		r.on('timeout', () => {
			r.destroy();
			reject(new Error('timeout'));
		});
		r.on('error', reject);
		r.end();
	});
}

const tempDirs: string[] = [];

afterEach(() => {
	try {
		closeAllProjectDbs();
	} catch {
		// best-effort
	}
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Windows EBUSY on sqlite sidecars — best-effort cleanup
		}
	}
});

afterAll(() => {
	try {
		closeAllProjectDbs();
	} catch {
		// best-effort
	}
});

describe('dashboard lifecycle', () => {
	it('starts, writes the status file, and closes with connection-refused', async () => {
		const dir = canonicalMkdtemp('dash-life-start');
		tempDirs.push(dir);
		const handle = await startOnFreePort(dir);
		expect(handle.listening).toBe(true);
		expect(handle.enabled).toBe(true);
		expect(handle.status).toBe('listening');
		expect(typeof handle.port).toBe('number');
		// Tokened URL shape.
		expect(handle.url).toContain(`/t/${handle.token}/`);

		// Status file: listening, port present, NO token on disk.
		const statusPath = `${dir}/.swarm/dashboard-status.json`;
		expect(existsSync(statusPath)).toBe(true);
		const record = JSON.parse(readFileSync(statusPath, 'utf8')) as {
			status: string;
			port: number | null;
			url: string | null;
		};
		expect(record.status).toBe('listening');
		expect(record.port).toBe(handle.port);
		expect(record.url).toBe(`http://127.0.0.1:${handle.port}`);
		expect(readFileSync(statusPath, 'utf8')).not.toContain(
			handle.token ?? '###',
		);

		// Live in the shared registry for the command.
		expect(getDashboardHandle(dir)?.listening).toBe(true);

		expect(await reachable(handle.port as number)).toBe(true);
		await handle.close();
		// Idempotent close.
		await handle.close();
		let alive = true;
		for (let i = 0; i < 12; i++) {
			await new Promise((r) => setTimeout(r, 250));
			if (!(await reachable(handle.port as number))) {
				alive = false;
				break;
			}
		}
		expect(alive).toBe(false);
		expect(getDashboardHandle(dir)).toBeNull();
		// Stopped status recorded.
		const stopped = JSON.parse(readFileSync(statusPath, 'utf8')) as {
			status: string;
		};
		expect(stopped.status).toBe('stopped');
	});

	it('disable-with-notice on port conflict: no throw, no port, notice file + handle signals', async () => {
		const dir = canonicalMkdtemp('dash-life-conflict');
		tempDirs.push(dir);
		const blocker = http.createServer(() => {
			/* occupy */
		});
		const occupied = await new Promise<number>((resolve) => {
			blocker.listen(0, '127.0.0.1', () =>
				resolve((blocker.address() as { port: number }).port),
			);
		});
		try {
			const handle = await startDashboardServer({
				port: occupied,
				host: '127.0.0.1',
				directory: dir,
			});
			expect(handle.listening).toBe(false);
			expect(handle.enabled).toBe(false);
			expect(handle.status).toBe('disabled_port_conflict');
			expect(handle.port).toBeUndefined();
			expect(handle.url).toBeUndefined();
			expect(handle.token).toBeUndefined();
			const statusPath = `${dir}/.swarm/dashboard-status.json`;
			expect(existsSync(statusPath)).toBe(true);
			const record = JSON.parse(readFileSync(statusPath, 'utf8')) as {
				status: string;
			};
			expect(record.status).toBe('disabled_port_conflict');
			// close() on a disabled handle is a safe no-op.
			await handle.close();
		} finally {
			blocker.close();
		}
	});

	it('serves bounded unavailable views when swarm.db is absent', async () => {
		const dir = canonicalMkdtemp('dash-life-nodb');
		tempDirs.push(dir);
		// No .swarm at all — the dashboard must not materialize one just to
		// answer (the status file write at start is the sanctioned exception).
		const handle = await startOnFreePort(dir);
		try {
			const base = `http://127.0.0.1:${handle.port}/t/${handle.token}`;
			for (const p of [
				'/api/overview',
				'/api/gates',
				'/api/timeline',
				'/api/status',
			]) {
				const res = await getBody(`${base}${p}`);
				expect(res.status).toBe(200);
				expect(Buffer.byteLength(res.body, 'utf8')).toBeLessThan(64 * 1024);
			}
			const overview = JSON.parse(
				(await getBody(`${base}/api/overview`)).body,
			) as { dbHealth: { kind: string }; timeline: { available: boolean } };
			expect(overview.dbHealth.kind).toBe('absent');
			expect(overview.timeline.available).toBe(false);
		} finally {
			await handle.close();
		}
	});

	it('serves the NEWEST events past the row window (latest-N, F-D)', async () => {
		const dir = canonicalMkdtemp('dash-life-newest');
		tempDirs.push(dir);
		// Small payloads so the response never hits the byte cap — this
		// isolates the latest-N semantics from the shrink path.
		for (let i = 0; i < 320; i++) {
			const ev = createObservation('gate_passed', {
				sessionId: `new-sess-${i % 8}`,
				taskId: `new-task-${i}`,
				gate: `DASHNEW-${i}`,
			});
			appendObservabilityEventDb(dir, ev);
		}
		const handle = await startOnFreePort(dir);
		try {
			const base = `http://127.0.0.1:${handle.port}/t/${handle.token}`;
			const res = await getBody(`${base}/api/timeline`);
			expect(res.status).toBe(200);
			const timeline = JSON.parse(res.body) as {
				events: Array<{ payload: string }>;
				totalMatching: number;
				truncated: boolean;
			};
			expect(timeline.totalMatching).toBe(320);
			expect(timeline.events.length).toBe(100);
			expect(timeline.truncated).toBe(true);
			const markers = new Set(
				timeline.events.flatMap((e) => e.payload.match(/DASHNEW-\d+/g) ?? []),
			);
			// The window must be the NEWEST 100 (rowids 220..319), not the
			// oldest — the pre-fix ASC-5000 window showed stale events here.
			expect(markers.has('DASHNEW-319')).toBe(true);
			expect(markers.has('DASHNEW-0')).toBe(false);
		} finally {
			await handle.close();
		}
	});

	it('bounds large stores: row caps, byte caps, and VALID JSON under the cap', async () => {
		const dir = canonicalMkdtemp('dash-life-big');
		tempDirs.push(dir);
		// Seed 320 events with marker-bearing payloads (mirrors frozen C7(c)).
		for (let i = 0; i < 320; i++) {
			const ev = createObservation('gate_passed', {
				sessionId: `big-sess-${i % 8}`,
				taskId: `big-task-${i}`,
				gate: `DASHBIG-${i}-${'x'.repeat(4000)}`,
			});
			appendObservabilityEventDb(dir, ev);
		}
		const handle = await startOnFreePort(dir);
		try {
			const base = `http://127.0.0.1:${handle.port}/t/${handle.token}`;
			const timelineRes = await getBody(`${base}/api/timeline`);
			expect(timelineRes.status).toBe(200);
			// The structural shrink keeps every response UNDER the real cap and
			// PARSEABLE (review round 2, F-B/C8: the old assertions were 2x
			// loose and never parsed the body, so a splice that produced invalid
			// JSON was invisible).
			expect(Buffer.byteLength(timelineRes.body, 'utf8')).toBeLessThan(
				256 * 1024,
			);
			const timeline = JSON.parse(timelineRes.body) as {
				events: Array<{ payload: string }>;
				totalMatching: number;
				truncated: boolean;
				responseTruncated?: boolean;
			};
			expect(timeline.events.length).toBeLessThanOrEqual(100);
			expect(timeline.totalMatching).toBe(320);
			// The structural shrink drops array tails to fit the cap — assert
			// the surviving set respects the row bound (the F-D newest-window
			// semantics are covered by the small-payload test above, which
			// does not fire the shrink).
			const markers = new Set(
				timeline.events.flatMap((e) => e.payload.match(/DASHBIG-\d+/g) ?? []),
			);
			expect(markers.size).toBeLessThanOrEqual(100);
			expect(timeline.truncated).toBe(true);

			const overviewRes = await getBody(`${base}/api/overview`);
			expect(Buffer.byteLength(overviewRes.body, 'utf8')).toBeLessThan(
				256 * 1024,
			);
			// The overview must parse even when the shrink loop fired.
			const overview = JSON.parse(overviewRes.body) as {
				timeline: { events: unknown[] };
				responseTruncated?: boolean;
			};
			expect(Array.isArray(overview.timeline.events)).toBe(true);
		} finally {
			await handle.close();
		}
	});

	it('closeDashboardServerForRoot is the sync cleanup path (dispose/exit)', async () => {
		const dir = canonicalMkdtemp('dash-life-rootclose');
		tempDirs.push(dir);
		const handle = await startOnFreePort(dir);
		expect(handle.listening).toBe(true);
		closeDashboardServerForRoot(dir);
		expect(getDashboardHandle(dir)).toBeNull();
		let alive = true;
		for (let i = 0; i < 12; i++) {
			await new Promise((r) => setTimeout(r, 250));
			if (!(await reachable(handle.port as number))) {
				alive = false;
				break;
			}
		}
		expect(alive).toBe(false);
		// Closing an unknown root is a no-op.
		expect(() => closeDashboardServerForRoot(dir)).not.toThrow();
	});

	it('closeDashboardServerForRootIfOwner skips a newer instance (F-A)', async () => {
		const dir = canonicalMkdtemp('dash-life-owner');
		tempDirs.push(dir);
		// Instance A starts; instance B later restarts the same root (B wins
		// the registry). A's stale dispose must NOT tear down B's listener.
		const handleA = await startDashboardServer({
			port: await freePort(),
			host: '127.0.0.1',
			directory: dir,
		});
		const handleB = await startDashboardServer({
			port: await freePort(),
			host: '127.0.0.1',
			directory: dir,
		});
		expect(handleA.listening).toBe(true);
		expect(handleB.listening).toBe(true);
		expect(getDashboardHandle(dir)?.port).toBe(handleB.port);
		// A's stale close: owner mismatch → skip.
		expect(closeDashboardServerForRootIfOwner(dir, handleA)).toBe(false);
		expect(getDashboardHandle(dir)?.port).toBe(handleB.port);
		expect(await reachable(handleB.port as number)).toBe(true);
		// B's own close: owner match → closes.
		expect(closeDashboardServerForRootIfOwner(dir, handleB)).toBe(true);
		expect(getDashboardHandle(dir)).toBeNull();
		expect(await reachable(handleB.port as number)).toBe(false);
		// A's handle is now dead too (the restart purged it before binding B).
		await handleA.close();
		await handleB.close();
	});

	it('evicts the oldest root at the registry cap WITH a live close (C16)', async () => {
		const roots: { dir: string; handle: DashboardHandle }[] = [];
		try {
			// MAX_REGISTRY_ENTRIES is 8: the 9th start must evict (and close)
			// the oldest.
			for (let i = 0; i < 9; i++) {
				const dir = canonicalMkdtemp(`dash-life-evict-${i}`);
				tempDirs.push(dir);
				const handle = await startOnFreePort(dir);
				expect(handle.listening).toBe(true);
				roots.push({ dir, handle });
			}
			// The oldest root was evicted: no registry entry, listener closed.
			expect(getDashboardHandle(roots[0].dir)).toBeNull();
			let oldestAlive = true;
			for (let i = 0; i < 12; i++) {
				await new Promise((r) => setTimeout(r, 250));
				if (!(await reachable(roots[0].handle.port as number))) {
					oldestAlive = false;
					break;
				}
			}
			expect(oldestAlive).toBe(false);
			// The newest root is untouched.
			expect(getDashboardHandle(roots[8].dir)?.listening).toBe(true);
		} finally {
			for (const { dir, handle } of roots) {
				void handle.close();
				closeDashboardServerForRoot(dir);
			}
		}
	});

	it('rejects invalid start options without binding', async () => {
		const off1 = await startDashboardServer({
			port: 0,
			directory: 'unused',
		});
		expect(off1.status).toBe('disabled_invalid_options');
		const off2 = await startDashboardServer({ port: 8000, directory: '' });
		expect(off2.status).toBe('disabled_invalid_options');
	});
});
