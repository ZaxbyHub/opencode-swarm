import { afterEach, describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import {
	_internals,
	htmlToText,
	isBlockedAddress,
	web_fetch,
} from './web-fetch';

const DIR = os.tmpdir();

const original = { ..._internals };

afterEach(() => {
	_internals.fetch = original.fetch;
	_internals.dnsLookup = original.dnsLookup;
	_internals.loadPluginConfig = original.loadPluginConfig;
	_internals.writeEvidenceDocuments = original.writeEvidenceDocuments;
});

function enableCouncil() {
	_internals.loadPluginConfig = (() => ({
		council: { general: { enabled: true } },
	})) as typeof _internals.loadPluginConfig;
}

function stubEvidence(ref = 'evidence-cache:evd_test') {
	_internals.writeEvidenceDocuments = (async () => ({
		path: '.swarm/evidence-cache/documents.jsonl',
		records: [{ ref }],
		refs: [ref],
	})) as unknown as typeof _internals.writeEvidenceDocuments;
}

function publicDns() {
	_internals.dnsLookup = (async () => [
		{ address: '93.184.216.34' },
	]) as unknown as typeof _internals.dnsLookup;
}

async function run(args: Record<string, unknown>) {
	const out = await (
		web_fetch as unknown as {
			execute: (a: unknown, ctx: { directory: string }) => Promise<string>;
		}
	).execute(args, { directory: DIR });
	return JSON.parse(out);
}

describe('web_fetch — gating and arg validation', () => {
	test('rejects missing url with invalid_args', async () => {
		enableCouncil();
		const res = await run({});
		expect(res.success).toBe(false);
		expect(res.reason).toBe('invalid_args');
	});

	test('refuses when council.general.enabled is false', async () => {
		_internals.loadPluginConfig = (() => ({
			council: { general: { enabled: false } },
		})) as typeof _internals.loadPluginConfig;
		const res = await run({ url: 'https://example.com' });
		expect(res.success).toBe(false);
		expect(res.reason).toBe('council_general_disabled');
	});
});

describe('web_fetch — SSRF defenses', () => {
	test('blocks non-http(s) schemes', async () => {
		enableCouncil();
		const res = await run({ url: 'file:///etc/passwd' });
		expect(res.success).toBe(false);
		expect(res.reason).toBe('blocked_scheme');
	});

	test('blocks the cloud metadata IP literal', async () => {
		enableCouncil();
		const res = await run({ url: 'http://169.254.169.254/latest/meta-data/' });
		expect(res.success).toBe(false);
		expect(res.reason).toBe('blocked_host');
	});

	test('blocks loopback / private literals', async () => {
		enableCouncil();
		for (const url of [
			'http://127.0.0.1/',
			'http://10.0.0.5/',
			'http://192.168.1.1/',
			'http://[::1]/',
		]) {
			const res = await run({ url });
			expect(res.success).toBe(false);
			expect(res.reason).toBe('blocked_host');
		}
	});

	test('blocks IPv4-mapped IPv6 literals routed through new URL (regression: ::ffff hex form)', async () => {
		enableCouncil();
		// new URL('http://[::ffff:169.254.169.254]/') normalizes the host to the
		// hex form ::ffff:a9fe:a9fe — a dotted-decimal regex misses it. The
		// expander must still resolve the embedded v4 and block the metadata IP.
		for (const url of [
			'http://[::ffff:169.254.169.254]/latest/meta-data/',
			'http://[::ffff:127.0.0.1]/',
			'http://[::ffff:10.0.0.1]/',
		]) {
			const res = await run({ url });
			expect(res.success).toBe(false);
			expect(res.reason).toBe('blocked_host');
		}
	});

	test('blocks hostnames that resolve to a private address', async () => {
		enableCouncil();
		_internals.dnsLookup = (async () => [
			{ address: '10.1.2.3' },
		]) as unknown as typeof _internals.dnsLookup;
		const res = await run({ url: 'https://internal.example.com' });
		expect(res.success).toBe(false);
		expect(res.reason).toBe('blocked_host');
	});

	test('blocks a redirect that points at a private address (re-validated)', async () => {
		enableCouncil();
		publicDns();
		stubEvidence();
		_internals.fetch = (async () =>
			new Response(null, {
				status: 302,
				headers: { location: 'http://169.254.169.254/' },
			})) as unknown as typeof _internals.fetch;
		const res = await run({ url: 'https://example.com/redirect' });
		expect(res.success).toBe(false);
		expect(res.reason).toBe('blocked_host');
	});
});

describe('web_fetch — fetching and extraction', () => {
	test('fetches html, strips to text, extracts title, stores evidence', async () => {
		enableCouncil();
		publicDns();
		stubEvidence('evidence-cache:evd_abc');
		_internals.fetch = (async () =>
			new Response(
				'<html><head><title>Hello &amp; World</title></head><body><script>bad()</script><p>First.</p><p>Second.</p></body></html>',
				{
					status: 200,
					headers: { 'content-type': 'text/html; charset=utf-8' },
				},
			)) as unknown as typeof _internals.fetch;
		const res = await run({ url: 'https://example.com/page' });
		expect(res.success).toBe(true);
		expect(res.title).toBe('Hello & World');
		expect(res.text).toContain('First.');
		expect(res.text).toContain('Second.');
		expect(res.text).not.toContain('bad()');
		expect(res.text).not.toContain('<p>');
		expect(res.evidence.stored).toBe(true);
		expect(res.evidence.ref).toBe('evidence-cache:evd_abc');
		expect(res.finalUrl).toBe('https://example.com/page');
	});

	test('rejects unsupported content types', async () => {
		enableCouncil();
		publicDns();
		_internals.fetch = (async () =>
			new Response('binary', {
				status: 200,
				headers: { 'content-type': 'image/png' },
			})) as unknown as typeof _internals.fetch;
		const res = await run({ url: 'https://example.com/image.png' });
		expect(res.success).toBe(false);
		expect(res.reason).toBe('unsupported_content_type');
	});

	test('reports HTTP errors', async () => {
		enableCouncil();
		publicDns();
		_internals.fetch = (async () =>
			new Response('nope', {
				status: 500,
				headers: { 'content-type': 'text/html' },
			})) as unknown as typeof _internals.fetch;
		const res = await run({ url: 'https://example.com/boom' });
		expect(res.success).toBe(false);
		expect(res.reason).toBe('http_error');
	});

	test('caps the response body and marks it truncated', async () => {
		enableCouncil();
		publicDns();
		stubEvidence();
		const big = 'a'.repeat(5000);
		_internals.fetch = (async () =>
			new Response(big, {
				status: 200,
				headers: { 'content-type': 'text/plain' },
			})) as unknown as typeof _internals.fetch;
		const res = await run({ url: 'https://example.com/big', max_bytes: 1024 });
		expect(res.success).toBe(true);
		expect(res.truncated).toBe(true);
		expect(res.bytesRead).toBe(1024);
	});

	test('follows a redirect to an allowed host', async () => {
		enableCouncil();
		publicDns();
		stubEvidence();
		let call = 0;
		_internals.fetch = (async () => {
			call += 1;
			if (call === 1) {
				return new Response(null, {
					status: 301,
					headers: { location: 'https://example.com/final' },
				});
			}
			return new Response('<p>done</p>', {
				status: 200,
				headers: { 'content-type': 'text/html' },
			});
		}) as unknown as typeof _internals.fetch;
		const res = await run({ url: 'https://example.com/start' });
		expect(res.success).toBe(true);
		expect(res.finalUrl).toBe('https://example.com/final');
		expect(res.text).toContain('done');
	});

	test('reports a timeout when the request is aborted', async () => {
		enableCouncil();
		publicDns();
		_internals.fetch = ((_url: string, opts: { signal: AbortSignal }) =>
			new Promise((_resolve, reject) => {
				opts.signal.addEventListener('abort', () =>
					reject(new DOMException('aborted', 'AbortError')),
				);
			})) as unknown as typeof _internals.fetch;
		const res = await run({
			url: 'https://example.com/slow',
			timeout_ms: 1000,
		});
		expect(res.success).toBe(false);
		expect(res.reason).toBe('timeout');
	});
});

describe('isBlockedAddress', () => {
	test('blocks loopback, private, link-local, CGNAT, multicast', () => {
		for (const ip of [
			'127.0.0.1',
			'0.0.0.0',
			'10.0.0.1',
			'172.16.0.1',
			'172.31.255.255',
			'192.168.0.1',
			'169.254.169.254',
			'100.64.0.1',
			'224.0.0.1',
			'192.0.2.5',
			'198.51.100.5',
			'203.0.113.5',
			'192.88.99.1',
			'::1',
			'::',
			'fc00::1',
			'fd12::1',
			'fe80::1',
			'::ffff:127.0.0.1',
			'::ffff:a9fe:a9fe', // hex-compressed IPv4-mapped 169.254.169.254
			'::ffff:7f00:1', // hex-compressed IPv4-mapped 127.0.0.1
			'0:0:0:0:0:ffff:a9fe:a9fe', // fully expanded mapped form
		]) {
			expect(isBlockedAddress(ip)).toBe(true);
		}
	});

	test('allows public addresses', () => {
		for (const ip of [
			'93.184.216.34',
			'8.8.8.8',
			'172.32.0.1',
			'2606:4700::1111',
		]) {
			expect(isBlockedAddress(ip)).toBe(false);
		}
	});

	test('blocks unparsable input', () => {
		expect(isBlockedAddress('not-an-ip')).toBe(true);
	});
});

describe('htmlToText', () => {
	test('removes script/style and decodes entities', () => {
		const out = htmlToText(
			'<style>.x{}</style><div>A &amp; B</div><script>x</script><p>C</p>',
		);
		expect(out).toContain('A & B');
		expect(out).toContain('C');
		expect(out).not.toContain('.x{}');
		expect(out).not.toContain('<div>');
	});

	test('converts block boundaries to newlines', () => {
		const out = htmlToText('<p>one</p><p>two</p>');
		expect(out).toBe('one\ntwo');
	});

	test('handles many unclosed <script openers in linear time (regression: ReDoS)', () => {
		// The previous lazy-regex strip was O(n²) and hung for minutes on this
		// input. The linear indexOf scan must finish in milliseconds.
		const start = Date.now();
		const out = htmlToText('<script'.repeat(200_000));
		expect(Date.now() - start).toBeLessThan(1000);
		expect(out).toBe('');
	});
});
