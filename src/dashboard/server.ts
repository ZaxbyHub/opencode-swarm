/**
 * Loopback HTTP server for the opt-in dashboard (issue #2509).
 *
 * Portability: `node:http` ONLY — the bundle must stay Node-ESM-loadable
 * (AGENTS invariant 2); no Bun-specific server API exists anywhere in the
 * dashboard.
 *
 * Security boundary (AC3/AC6/AC7):
 * - GET/HEAD only; every other method is 405 — the server has NO
 *   state-changing verb, which is the CSRF policy (a cross-site request
 *   can only ever re-read what its origin checks already block).
 * - Host allowlist (DNS-rebinding defense): the Host header hostname must be
 *   a loopback name (127.0.0.1 / localhost / ::1); the server itself only
 *   ever binds 127.0.0.1. This is the loopback inverse of the house
 *   `url-security` private-host blocklist posture.
 * - Origin allowlist: a present Origin header must parse to a loopback host.
 * - Capability token: every route requires the per-boot token via query
 *   (`token`/`t`/`cap`/`capability`) or path (`/{token}/…`, `/t/{token}/…`);
 *   comparison is constant-time over SHA-256 digests. Failure is a plain 404.
 * - Responses are fully materialized, byte-capped, `no-store`, `nosniff`.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer, type Server } from 'node:http';
import { renderDashboardHtml } from './assets.js';
import {
	renderDelegationsView,
	renderGatesView,
	renderLanesView,
	renderOverviewView,
	renderStatusView,
	renderTasksView,
	renderTimelineView,
} from './views.js';

/** Hard byte cap for any single response body (AC3/AC7 bounded responses). */
const MAX_RESPONSE_BYTES = 256 * 1024;
/** Request-header timeout — a stalled client can never pin a socket. */
const REQUEST_HEADERS_TIMEOUT_MS = 10_000;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

const TOKEN_QUERY_KEYS = ['token', 't', 'cap', 'capability'] as const;

export interface DashboardRouteContext {
	directory: string;
	token: string;
}

type JsonBody = Record<string, unknown>;

export interface DashboardRequestOutcome {
	status: number;
	body: string;
	contentType: string;
}

function isLoopbackHost(hostname: string): boolean {
	const bare = hostname
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, '');
	return LOOPBACK_HOSTS.has(bare);
}

/** Host header → loopback hostname decision (port suffix tolerated). */
export function hostHeaderAllowed(hostHeader: string | undefined): boolean {
	if (!hostHeader) return false;
	const hostPart = hostHeader.split(':')[0] ?? hostHeader;
	return isLoopbackHost(hostPart);
}

/** Origin header (when present) → loopback origin decision. */
export function originHeaderAllowed(originHeader: string | undefined): boolean {
	if (originHeader === undefined || originHeader === '') return true;
	try {
		const parsed = new URL(originHeader);
		return isLoopbackHost(parsed.hostname);
	} catch {
		return false;
	}
}

/** Constant-time token comparison over fixed-length digests. */
export function tokenMatches(expected: string, presented: string): boolean {
	if (presented.length === 0 || presented.length > 512) return false;
	const a = createHash('sha256').update(expected).digest();
	const b = createHash('sha256').update(presented).digest();
	return timingSafeEqual(a, b);
}

/**
 * Extract (token, route) from a request URL. Accepts the token as a query
 * parameter (`token|t|cap|capability`) or as the first path segment
 * (`/{token}/route`) or under the explicit prefix (`/t/{token}/route`).
 */
export function extractTokenAndRoute(
	rawUrl: string,
): { token: string; route: string } | null {
	let parsed: URL;
	try {
		parsed = new URL(rawUrl, 'http://127.0.0.1');
	} catch {
		return null;
	}
	for (const key of TOKEN_QUERY_KEYS) {
		const value = parsed.searchParams.get(key);
		if (value) return { token: value, route: parsed.pathname };
	}
	const segments = parsed.pathname.split('/').filter((s) => s.length > 0);
	if (segments.length === 0) return null;
	const first = segments[0] === 't' ? segments[1] : segments[0];
	if (!first || first.length < 8) return null;
	const restStart = segments[0] === 't' ? 2 : 1;
	const route = `/${segments.slice(restStart).join('/')}`;
	return { token: first, route };
}

function htmlResponse(html: string): DashboardRequestOutcome {
	return { status: 200, body: html, contentType: 'text/html; charset=utf-8' };
}

function jsonResponse(body: JsonBody): DashboardRequestOutcome {
	return {
		status: 200,
		body: JSON.stringify(body),
		contentType: 'application/json; charset=utf-8',
	};
}

function byteCap(body: string): string {
	const bytes = Buffer.byteLength(body, 'utf8');
	if (bytes <= MAX_RESPONSE_BYTES) return body;
	// Trim from the end on a UTF-8 boundary and close the JSON object so the
	// payload stays parseable while never exceeding the hard cap.
	const trimmed = Buffer.from(body, 'utf8').subarray(0, MAX_RESPONSE_BYTES - 1);
	let text = trimmed.toString('utf8');
	const lastBrace = text.lastIndexOf('}');
	if (lastBrace > 0) text = `${text.slice(0, lastBrace)}}`;
	else text = text.replace(/[,\s]*$/, '');
	return text;
}

/**
 * Resolve one authorized route to its response. Read-only by construction:
 * the handlers only call the view layer.
 */
export async function resolveRoute(
	route: string,
	ctx: DashboardRouteContext,
): Promise<DashboardRequestOutcome> {
	switch (route) {
		case '/':
		case '':
		case '/index.html':
			return htmlResponse(renderDashboardHtml());
		case '/api/overview':
		case '/api/state':
		case '/api/dashboard':
			return jsonResponse(
				(await renderOverviewView(ctx.directory)) as unknown as JsonBody,
			);
		case '/api/gates':
			return jsonResponse(
				renderGatesView(ctx.directory) as unknown as JsonBody,
			);
		case '/api/delegations':
			return jsonResponse(
				renderDelegationsView(ctx.directory) as unknown as JsonBody,
			);
		case '/api/lanes':
			return jsonResponse(
				renderLanesView(ctx.directory) as unknown as JsonBody,
			);
		case '/api/tasks':
			return jsonResponse(
				(await renderTasksView(ctx.directory)) as unknown as JsonBody,
			);
		case '/api/timeline':
		case '/api/events':
			return jsonResponse(
				renderTimelineView(ctx.directory) as unknown as JsonBody,
			);
		case '/api/status':
		case '/api/summary':
			return jsonResponse(
				renderStatusView(ctx.directory) as unknown as JsonBody,
			);
		default:
			return {
				status: 404,
				body: '{"error":"not found"}',
				contentType: 'application/json; charset=utf-8',
			};
	}
}

function send(
	res: ServerResponse,
	status: number,
	contentType: string,
	body: string,
	headOnly: boolean,
): void {
	const payload = Buffer.from(body, 'utf8');
	res.writeHead(status, {
		'Content-Type': contentType,
		'Content-Length': String(payload.length),
		'Cache-Control': 'no-store',
		'X-Content-Type-Options': 'nosniff',
		'Referrer-Policy': 'no-referrer',
	});
	res.end(headOnly ? undefined : payload);
}

export interface DashboardServerOptions {
	port: number;
	host?: string;
	directory: string;
	token: string;
}

export interface DashboardServerHandle {
	server: Server;
	port: number;
}

/**
 * Create the dashboard request handler. Exported for direct testing; the
 * security middleware order is part of the frozen contract (method → host →
 * origin → token → route).
 */
export function createDashboardRequestHandler(
	ctx: DashboardRouteContext,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
	return async (req, res) => {
		const method = (req.method ?? 'GET').toUpperCase();
		if (method !== 'GET' && method !== 'HEAD') {
			send(
				res,
				405,
				'application/json; charset=utf-8',
				'{"error":"method not allowed"}',
				false,
			);
			return;
		}
		const hostOk = hostHeaderAllowed(req.headers.host);
		if (!hostOk) {
			send(
				res,
				403,
				'application/json; charset=utf-8',
				'{"error":"forbidden host"}',
				false,
			);
			return;
		}
		if (!originHeaderAllowed(req.headers.origin)) {
			send(
				res,
				403,
				'application/json; charset=utf-8',
				'{"error":"forbidden origin"}',
				false,
			);
			return;
		}
		const extracted = extractTokenAndRoute(req.url ?? '/');
		const tokenOk =
			extracted !== null && tokenMatches(ctx.token, extracted.token);
		if (!tokenOk) {
			send(
				res,
				404,
				'application/json; charset=utf-8',
				'{"error":"not found"}',
				false,
			);
			return;
		}
		try {
			const outcome = await resolveRoute(extracted.route, ctx);
			send(
				res,
				outcome.status,
				outcome.contentType,
				byteCap(outcome.body),
				method === 'HEAD',
			);
		} catch (err) {
			send(
				res,
				500,
				'application/json; charset=utf-8',
				JSON.stringify({
					error: 'view failed',
					detail: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
				}),
				method === 'HEAD',
			);
		}
	};
}

/**
 * Bind the dashboard listener on the loopback interface. Resolves with the
 * bound port; rejects on bind errors (EADDRINUSE surfaces here). The server
 * is unref'd and every connection socket is unref'd + tracked so neither the
 * listener nor an idle browser tab can keep the host process alive.
 */
export function listenDashboardServer(
	options: DashboardServerOptions,
): Promise<DashboardServerHandle> {
	return new Promise((resolve, reject) => {
		const handler = createDashboardRequestHandler({
			directory: options.directory,
			token: options.token,
		});
		const server = createServer((req, res) => {
			void handler(req, res);
		});
		const sockets = new Set<{ destroy: () => void; unref?: () => void }>();
		server.on('connection', (socket) => {
			sockets.add(socket);
			socket.unref?.();
			socket.on('close', () => sockets.delete(socket));
		});
		server.headersTimeout = REQUEST_HEADERS_TIMEOUT_MS;
		server.requestTimeout = 60_000;
		server.once('error', (err) => reject(err));
		const host = options.host ?? '127.0.0.1';
		server.listen(options.port, host, () => {
			server.unref();
			const address = server.address();
			const port =
				typeof address === 'object' && address !== null
					? address.port
					: options.port;
			resolve({
				server,
				port,
				// Attach a close helper that tears down live sockets too so close()
				// observes as connection-refused immediately (keep-alive would
				// otherwise hold sockets open).
				...({} as Record<string, never>),
			} as DashboardServerHandle & { sockets: Set<{ destroy: () => void }> });
			// stash sockets for the closer (avoid widening the public type)
			(
				server as unknown as { dashboardSockets: typeof sockets }
			).dashboardSockets = sockets;
		});
	});
}

/**
 * Close a dashboard server: stop listening, destroy tracked sockets,
 * resolve once closed. Idempotent and never throws.
 */
export function closeDashboardServer(server: Server): Promise<void> {
	return new Promise((resolve) => {
		const sockets = (
			server as unknown as {
				dashboardSockets?: Set<{ destroy: () => void }>;
			}
		).dashboardSockets;
		if (sockets) {
			for (const socket of sockets) {
				try {
					socket.destroy();
				} catch {
					// already gone
				}
			}
			sockets.clear();
		}
		server.close(() => resolve(undefined));
		// Belt-and-braces: resolve even if close's callback never fires
		// (already-closed servers call it immediately, but never hang).
		setTimeout(resolve, 1_500).unref?.();
	});
}
