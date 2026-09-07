/**
 * Shared fixtures for the OTLP exporter suites (issue #2485).
 *
 * FR-006 sibling-module pattern (envelope-roundtrip-fixtures.ts precedent):
 * data-only helpers live outside *.test.ts files. This module deliberately
 * imports NO exporter code — only data modules and the telemetry bus — so the
 * fix can be verified by running the tests against
 * `src/observability/otlp-exporter.ts` without circular fixture dependence.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Structural stand-in for the exporter's OtlpExportConfig (kept LOCAL per the
 * approved-plan amendment: fixtures import no exporter code at all, so the
 * suite exercises only the real runtime module graph).
 */
export interface TestExportConfig {
	enabled: boolean;
	endpoint: string;
	convention: 'genai' | 'openinference';
	headers?: Record<string, string>;
	batchSize: number;
	flushIntervalMs: number;
	requestTimeoutMs: number;
	spoolMaxBytes: number;
	spoolMaxAgeMs: number;
	maxRetries: number;
	backoffBaseMs: number;
	backoffMaxMs: number;
	circuitThreshold: number;
	circuitCooldownMs: number;
}

/** Bounded test preset (fast, tiny budgets, loopback-only endpoint policy). */
export function testExportConfig(
	endpoint: string,
	overrides: Partial<TestExportConfig> = {},
): TestExportConfig {
	return {
		enabled: true,
		endpoint,
		convention: 'genai',
		batchSize: 4,
		flushIntervalMs: 60_000,
		requestTimeoutMs: 2_000,
		spoolMaxBytes: 64 * 1024,
		spoolMaxAgeMs: 24 * 60 * 60_000,
		maxRetries: 2,
		backoffBaseMs: 5,
		backoffMaxMs: 50,
		circuitThreshold: 3,
		circuitCooldownMs: 60_000,
		...overrides,
	};
}

/** Fresh project dir (never the repo's own .swarm). */
export function freshProjectDir(): string {
	return mkdtempSync(join(tmpdir(), 'otlp-2485-'));
}

export interface StubCollector {
	url: string;
	requests: Array<{ status: number; body: unknown }>;
	respond: (status: number, headers?: Record<string, string>) => void;
	close: () => Promise<void>;
}

/**
 * Loopback OTLP collector stub. Real HTTP on 127.0.0.1:0 — the same surface
 * production uses. Starts in 200-OK mode; `respond()` flips the status.
 */
export function startStubCollector(): Promise<StubCollector> {
	return new Promise((resolve) => {
		const requests: Array<{ status: number; body: unknown }> = [];
		let status = 200;
		let extraHeaders: Record<string, string> = {};
		const server = Bun.serve({
			port: 0,
			hostname: '127.0.0.1',
			async fetch(req) {
				const text = await req.text();
				let body: unknown = text;
				try {
					body = JSON.parse(text);
				} catch {
					/* keep raw */
				}
				requests.push({ status, body });
				return new Response('{}', {
					status,
					headers: extraHeaders,
				});
			},
		});
		resolve({
			url: `http://127.0.0.1:${server.port}`,
			requests,
			respond(nextStatus: number, headers: Record<string, string> = {}) {
				status = nextStatus;
				extraHeaders = headers;
			},
			async close() {
				server.stop(true);
			},
		});
	});
}

/** An ephemeral dead port (server opened then closed — connections refuse). */
export async function deadEndpointUrl(): Promise<string> {
	const stub = await startStubCollector();
	const url = stub.url;
	await stub.close();
	return url;
}

/** Extract spans from a stubbed OTLP/JSON request body (flat or nested). */
export function spansOf(body: unknown): Array<Record<string, unknown>> {
	if (typeof body !== 'object' || body === null) return [];
	const resourceSpans = (body as { resourceSpans?: unknown }).resourceSpans;
	if (!Array.isArray(resourceSpans)) return [];
	const spans: Array<Record<string, unknown>> = [];
	for (const rs of resourceSpans) {
		const direct = (rs as { spans?: unknown }).spans;
		if (Array.isArray(direct)) {
			spans.push(...(direct as Array<Record<string, unknown>>));
		}
		const scopeSpans = (rs as { scopeSpans?: unknown }).scopeSpans;
		if (Array.isArray(scopeSpans)) {
			for (const ss of scopeSpans) {
				const nested = (ss as { spans?: unknown }).spans;
				if (Array.isArray(nested)) {
					spans.push(...(nested as Array<Record<string, unknown>>));
				}
			}
		}
	}
	return spans;
}

/** Attribute keys of a span, from either OTLP array form or a flat record. */
export function attributeKeysOf(span: Record<string, unknown>): string[] {
	const attributes = span.attributes;
	if (Array.isArray(attributes)) {
		return attributes.map(
			(a) => (a as { key?: string }).key ?? '<missing-key>',
		);
	}
	if (typeof attributes === 'object' && attributes !== null) {
		return Object.keys(attributes);
	}
	return [];
}
