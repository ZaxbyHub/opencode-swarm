/**
 * Dashboard lifecycle tests (issue #2509 AC1/AC2/AC7): start/close, port
 * conflict disable-with-notice, absent-DB bounded views, large-store caps,
 * bounded registry. Real server + real store APIs on ephemeral loopback
 * ports; no mock.module.
 */

import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import * as http from 'node:http';
import * as net from 'node:net';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { canonicalMkdtemp } from '../../helpers/tmpdir';
import {
	closeDashboardServerForRoot,
	getDashboardHandle,
	type DashboardHandle,
	startDashboardServer,
} from '../../../src/dashboard/index.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { appendObservabilityEventDb } from '../../../src/db/observability-event-store.js';
import { createObservation } from '../../../src/observability/index.js';

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const s = net.createServer();
		s.listen(0, '127.0.0.1', () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => resolve(p));
		});
	});
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

let tempDirs: string[] = [];

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
		const handle = await startDashboardServer({
			port: await freePort(),
			host: '127.0.0.1',
			directory: dir,
		});
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
		const handle = await startDashboardServer({
			port: await freePort(),
			host: '127.0.0.1',
			directory: dir,
		});
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

	it('bounds large stores: row caps and byte caps on the timeline', async () => {
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
		const handle = await startDashboardServer({
			port: await freePort(),
			host: '127.0.0.1',
			directory: dir,
		});
		try {
			const base = `http://127.0.0.1:${handle.port}/t/${handle.token}`;
			const timelineRes = await getBody(`${base}/api/timeline`);
			expect(timelineRes.status).toBe(200);
			expect(Buffer.byteLength(timelineRes.body, 'utf8')).toBeLessThan(
				512 * 1024,
			);
			const timeline = JSON.parse(timelineRes.body) as {
				events: Array<{ payload: string }>;
				totalMatching: number;
			};
			expect(timeline.events.length).toBeLessThanOrEqual(100);
			expect(timeline.totalMatching).toBe(320);
			const markers = new Set(
				(timeline.body ?? timelineRes.body).match(/DASHBIG-\d+/g) ?? [],
			);
			expect(markers.size).toBeLessThanOrEqual(100);

			const overviewRes = await getBody(`${base}/api/overview`);
			expect(Buffer.byteLength(overviewRes.body, 'utf8')).toBeLessThan(
				512 * 1024,
			);
		} finally {
			await handle.close();
		}
	});

	it('closeDashboardServerForRoot is the sync cleanup path (dispose/exit)', async () => {
		const dir = canonicalMkdtemp('dash-life-rootclose');
		tempDirs.push(dir);
		const handle = await startDashboardServer({
			port: await freePort(),
			host: '127.0.0.1',
			directory: dir,
		});
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
