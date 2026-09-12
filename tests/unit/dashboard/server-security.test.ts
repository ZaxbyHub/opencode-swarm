/**
 * Dashboard security boundary tests (issue #2509 AC3/AC7): capability token,
 * Host/Origin validation, method policy, response headers, secret non-echo.
 *
 * Uses the real server module on an ephemeral loopback port with raw
 * node:http requests (full control of Host/Origin headers, like the frozen
 * acceptance checks). No mock.module; all state in canonicalMkdtemp dirs.
 */

import { afterAll, afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import {
	closeDashboardServerForRoot,
	type DashboardHandle,
	startDashboardServer,
} from '../../../src/dashboard/index.js';
import { appendObservabilityEventDb } from '../../../src/db/observability-event-store.js';
import { closeAllProjectDbs } from '../../../src/db/project-db.js';
import { createObservation } from '../../../src/observability/index.js';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const SECRET = 'SECRETCRED123';

type Resp = {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
};

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const s = net.createServer();
		s.listen(0, '127.0.0.1', () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => resolve(p));
		});
	});
}

function request(
	urlStr: string,
	method: string,
	headers: Record<string, string> = {},
): Promise<Resp> {
	return new Promise((resolve, reject) => {
		const u = new URL(urlStr);
		const r = http.request(
			{
				host: u.hostname,
				port: u.port || 80,
				path: u.pathname + u.search,
				method,
				headers,
				timeout: 6000,
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on('data', (c: Buffer) => chunks.push(c));
				res.on('end', () =>
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
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

const handles: { dir: string; handle: DashboardHandle }[] = [];
const tempDirs: string[] = [];

afterEach(() => {
	for (const { dir, handle } of handles.splice(0)) {
		void handle.close();
		closeDashboardServerForRoot(dir);
	}
	try {
		closeAllProjectDbs();
	} catch {
		// best-effort
	}
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// Windows EBUSY on sqlite sidecars — tempdir cleanup is best-effort
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

function newProject(name: string, seedSecrets: boolean): string {
	const dir = canonicalMkdtemp(name);
	tempDirs.push(dir);
	mkdirSync(`${dir}/.swarm`, { recursive: true });
	if (seedSecrets) {
		// Delegation record whose jobId carries a credential-shaped value.
		writeFileSync(
			`${dir}/.swarm/background-delegations.jsonl`,
			`${JSON.stringify({
				schemaVersion: 1,
				correlationId: 'sec-corr-77af',
				subagentSessionId: 'sec-corr-77af',
				parentSessionId: 'sec-parent',
				callID: 'sec-call',
				jobId: `token=${SECRET}`,
				normalizedAgent: 'coder',
				swarmPrefixedAgent: 'coder',
				planTaskId: 'sec-task',
				evidenceTaskId: 'sec-task',
				status: 'pending',
				createdAt: 1_700_000_000_000,
				updatedAt: 1_700_000_000_000,
			})}\n`,
		);
		// Observability event whose payload carries secrets.
		const ev = createObservation('gate_failed', {
			sessionId: 'sec-sess',
			taskId: 'sec-obs-task',
			reason: `api_key=${SECRET} postgres://u:${SECRET}@db/x`,
		});
		appendObservabilityEventDb(dir, ev);
	}
	return dir;
}

async function startOnEphemeralPort(dir: string): Promise<{
	handle: DashboardHandle;
	base: string;
}> {
	// Bounded retry over fresh ephemeral ports (review round 2, C20): the
	// freePort() probe has a TOCTOU window before we listen.
	let handle: DashboardHandle | null = null;
	for (let attempt = 0; attempt < 3; attempt++) {
		const candidate = await startDashboardServer({
			port: await freePort(),
			host: '127.0.0.1',
			directory: dir,
		});
		if (candidate.listening) {
			handle = candidate;
			break;
		}
		await candidate.close();
	}
	if (!handle) throw new Error('no bindable ephemeral port after 3 attempts');
	handles.push({ dir, handle });
	expect(handle.listening).toBe(true);
	expect(typeof handle.port).toBe('number');
	expect(typeof handle.token).toBe('string');
	return { handle, base: `http://127.0.0.1:${handle.port}` };
}

describe('dashboard security boundary', () => {
	it('binds loopback and accepts the token via query, /t/ path, and bare path', async () => {
		const dir = newProject('dash-sec-token', false);
		const { handle, base } = await startOnEphemeralPort(dir);
		const token = handle.token as string;

		const viaQuery = await request(`${base}/?token=${token}`);
		expect(viaQuery.status).toBe(200);
		expect(viaQuery.body).toContain('mission control');

		const viaTPrefix = await request(`${base}/t/${token}/`);
		expect(viaTPrefix.status).toBe(200);

		const viaBarePath = await request(`${base}/${token}/api/status`);
		expect(viaBarePath.status).toBe(200);
	});

	it('rejects missing and wrong tokens with 404 (no route disclosure)', async () => {
		const dir = newProject('dash-sec-tokendeny', false);
		const { handle, base } = await startOnEphemeralPort(dir);
		const token = handle.token as string;

		const bare = await request(`${base}/`);
		expect(bare.status).toBe(404);

		const wrong = await request(`${base}/?token=${'x'.repeat(token.length)}`);
		expect(wrong.status).toBe(404);

		const wrongPath = await request(`${base}/t/${'y'.repeat(32)}/`);
		expect(wrongPath.status).toBe(404);
	});

	it('rejects non-loopback Host headers with 403 (DNS-rebinding defense)', async () => {
		const dir = newProject('dash-sec-host', false);
		const { handle, base } = await startOnEphemeralPort(dir);

		const ok = await request(`${base}/?token=${handle.token}`, 'GET', {
			host: `127.0.0.1:${handle.port}`,
		});
		expect(ok.status).toBe(200);

		const evil = await request(`${base}/?token=${handle.token}`, 'GET', {
			host: 'evil.example.com',
		});
		expect(evil.status).toBe(403);

		const lanHost = await request(`${base}/?token=${handle.token}`, 'GET', {
			host: '192.168.1.5:8080',
		});
		expect(lanHost.status).toBe(403);
	});

	it('rejects foreign Origin headers with 403, accepts loopback Origin', async () => {
		const dir = newProject('dash-sec-origin', false);
		const { handle, base } = await startOnEphemeralPort(dir);

		const ok = await request(`${base}/?token=${handle.token}`, 'GET', {
			origin: `http://127.0.0.1:${handle.port}`,
		});
		expect(ok.status).toBe(200);

		const foreign = await request(`${base}/?token=${handle.token}`, 'GET', {
			origin: 'http://evil.example',
		});
		expect(foreign.status).toBe(403);

		const lanOrigin = await request(`${base}/?token=${handle.token}`, 'GET', {
			origin: 'http://192.168.1.5:9000',
		});
		expect(lanOrigin.status).toBe(403);
	});

	it('answers 405 for every non-GET method (CSRF/read-only red-line)', async () => {
		const dir = newProject('dash-sec-methods', false);
		const { handle, base } = await startOnEphemeralPort(dir);
		const url = `${base}/?token=${handle.token}`;

		for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
			const res = await request(url, method);
			expect(res.status).toBe(405);
		}
		// Same for a tokened API route.
		const apiRes = await request(
			`${base}/t/${handle.token}/api/overview`,
			'POST',
		);
		expect(apiRes.status).toBe(405);
	});

	it('sets no-store/nosniff on every response', async () => {
		const dir = newProject('dash-sec-headers', false);
		const { handle, base } = await startOnEphemeralPort(dir);

		const ok = await request(`${base}/t/${handle.token}/api/status`);
		expect(ok.status).toBe(200);
		expect(ok.headers['cache-control']).toBe('no-store');
		expect(ok.headers['x-content-type-options']).toBe('nosniff');
	});

	it('never echoes credential-shaped secrets from rendered state', async () => {
		const dir = newProject('dash-sec-secrets', true);
		const { handle, base } = await startOnEphemeralPort(dir);
		const token = handle.token as string;

		const viewPaths = [
			`/t/${token}/`,
			`/t/${token}/api/overview`,
			`/t/${token}/api/delegations`,
			`/t/${token}/api/timeline`,
			`/t/${token}/api/gates`,
			`/t/${token}/api/lanes`,
			`/t/${token}/api/tasks`,
			`/t/${token}/api/status`,
		];
		const bodies: string[] = [];
		for (const p of viewPaths) {
			const res = await request(`${base}${p}`);
			expect(res.status).toBe(200);
			bodies.push(res.body);
		}
		const union = bodies.join('\n');
		expect(union).not.toContain(SECRET);
		// The delegation itself IS rendered — sanitized, with markers intact.
		expect(union).toContain('sec-corr-77af');
	});
});
