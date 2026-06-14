import { afterEach, describe, expect, test } from 'bun:test';
import * as os from 'node:os';
import { Readable } from 'node:stream';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import {
	_internals,
	extractTitle,
	htmlToText,
	isBlockedAddress,
	web_fetch,
} from './web-fetch';

const DIR = os.tmpdir();

const original = { ..._internals };

afterEach(() => {
	_internals.httpRequest = original.httpRequest;
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

/** Build a one-chunk decoded body stream for the httpRequest seam. */
function bodyOf(text: string | null): AsyncIterable<Uint8Array> | null {
	if (text === null) return null;
	const bytes = new TextEncoder().encode(text);
	return (async function* () {
		yield bytes;
	})();
}

/** Stub _internals.httpRequest with a single canned response. */
function stubHttp(
	status: number,
	headers: Record<string, string | undefined>,
	body: string | null,
) {
	_internals.httpRequest = (async () => ({
		status,
		headers,
		body: bodyOf(body),
		cancel: () => {},
	})) as unknown as typeof _internals.httpRequest;
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
		stubHttp(302, { location: 'http://169.254.169.254/' }, null);
		const res = await run({ url: 'https://example.com/redirect' });
		expect(res.success).toBe(false);
		expect(res.reason).toBe('blocked_host');
	});

	test('pins the socket to the validated resolved IP, not the hostname (DNS-rebinding defense)', async () => {
		enableCouncil();
		stubEvidence();
		_internals.dnsLookup = (async () => [
			{ address: '93.184.216.34' },
		]) as unknown as typeof _internals.dnsLookup;
		let seen: { pinnedAddress: string; host: string } | undefined;
		_internals.httpRequest = (async (a: {
			url: URL;
			pinnedAddress: string;
		}) => {
			seen = { pinnedAddress: a.pinnedAddress, host: a.url.hostname };
			return {
				status: 200,
				headers: { 'content-type': 'text/html' },
				body: bodyOf('<p>ok</p>'),
				cancel: () => {},
			};
		}) as unknown as typeof _internals.httpRequest;
		const res = await run({ url: 'https://example.com/page' });
		expect(res.success).toBe(true);
		// The connection target is the pre-validated IP; the hostname is kept only
		// for the Host header and TLS SNI/identity. There is no second name
		// resolution that a rebinding attacker could flip to a private address.
		expect(seen?.pinnedAddress).toBe('93.184.216.34');
		expect(seen?.host).toBe('example.com');
	});
});

describe('web_fetch — fetching and extraction', () => {
	test('fetches html, strips to text, extracts title, stores evidence', async () => {
		enableCouncil();
		publicDns();
		stubEvidence('evidence-cache:evd_abc');
		stubHttp(
			200,
			{ 'content-type': 'text/html; charset=utf-8' },
			'<html><head><title>Hello &amp; World</title></head><body><script>bad()</script><p>First.</p><p>Second.</p></body></html>',
		);
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

	test('rejects unsupported content types and cancels the stream', async () => {
		enableCouncil();
		publicDns();
		let cancelCalled = false;
		_internals.httpRequest = (async () => ({
			status: 200,
			headers: { 'content-type': 'image/png' },
			body: bodyOf('binary'),
			cancel: () => {
				cancelCalled = true;
			},
		})) as unknown as typeof _internals.httpRequest;
		const res = await run({ url: 'https://example.com/image.png' });
		expect(res.success).toBe(false);
		expect(res.reason).toBe('unsupported_content_type');
		expect(cancelCalled).toBe(true);
	});

	test('reports HTTP errors', async () => {
		enableCouncil();
		publicDns();
		stubHttp(500, { 'content-type': 'text/html' }, 'nope');
		const res = await run({ url: 'https://example.com/boom' });
		expect(res.success).toBe(false);
		expect(res.reason).toBe('http_error');
	});

	test('caps the response body and marks it truncated', async () => {
		enableCouncil();
		publicDns();
		stubEvidence();
		// 50 × 100-byte chunks (5000 bytes). With a 1024 cap the reader must stop
		// mid-stream (after ~11 chunks) and mark the result truncated.
		const chunk = new TextEncoder().encode('a'.repeat(100));
		_internals.httpRequest = (async () => ({
			status: 200,
			headers: { 'content-type': 'text/plain' },
			body: (async function* () {
				for (let i = 0; i < 50; i++) yield chunk;
			})(),
			cancel: () => {},
		})) as unknown as typeof _internals.httpRequest;
		const res = await run({ url: 'https://example.com/big', max_bytes: 1024 });
		expect(res.success).toBe(true);
		expect(res.truncated).toBe(true);
		expect(res.bytesReturned).toBe(1024);
	});

	test('follows a redirect to an allowed host', async () => {
		enableCouncil();
		publicDns();
		stubEvidence();
		let call = 0;
		_internals.httpRequest = (async () => {
			call += 1;
			if (call === 1) {
				return {
					status: 301,
					headers: { location: 'https://example.com/final' },
					body: null,
					cancel: () => {},
				};
			}
			return {
				status: 200,
				headers: { 'content-type': 'text/html' },
				body: bodyOf('<p>done</p>'),
				cancel: () => {},
			};
		}) as unknown as typeof _internals.httpRequest;
		const res = await run({ url: 'https://example.com/start' });
		expect(res.success).toBe(true);
		expect(res.finalUrl).toBe('https://example.com/final');
		expect(res.text).toContain('done');
	});

	test('reports a timeout when the request is aborted', async () => {
		enableCouncil();
		publicDns();
		_internals.httpRequest = ((args: { signal: AbortSignal }) =>
			new Promise((_resolve, reject) => {
				args.signal.addEventListener('abort', () =>
					reject(new DOMException('aborted', 'AbortError')),
				);
			})) as unknown as typeof _internals.httpRequest;
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
			'192.0.0.1', // 192.0.0.0/24 IETF protocol assignments (RFC 6890)
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
			'::7f00:1', // deprecated IPv4-compatible form of 127.0.0.1
			'::c000:201', // deprecated IPv4-compatible form of 192.0.2.1 (TEST-NET-1)
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

	test('handles many unclosed <script openers without catastrophic slowdown (regression: ReDoS)', () => {
		// Smoke test: the previous lazy-regex strip was O(n²) and hung for
		// minutes on large inputs. The indexOf-based implementation finds the
		// first unclosed opener, fails to find a closer, and breaks in O(n) —
		// so 1.4 MB of '<script' repetitions must complete well under 1 s.
		// (The 1 s budget is a catastrophic-failure guard, not a complexity proof.)
		const start = Date.now();
		const out = htmlToText('<script'.repeat(200_000));
		expect(Date.now() - start).toBeLessThan(1000);
		expect(out).toBe('');
	});
});

describe('extractTitle', () => {
	test('extracts a simple title', () => {
		expect(extractTitle('<html><head><title>Hello</title></head></html>')).toBe(
			'Hello',
		);
	});

	test('decodes HTML entities in the title', () => {
		expect(extractTitle('<title>A &amp; B</title>')).toBe('A & B');
	});

	test('returns undefined when no title element is present', () => {
		expect(
			extractTitle('<html><body><p>no title</p></body></html>'),
		).toBeUndefined();
	});

	test('returns undefined for unclosed title tag (no </title>)', () => {
		expect(extractTitle('<title>open but never closed')).toBeUndefined();
	});

	test('handles large input without closing </title> without catastrophic slowdown (regression: ReDoS)', () => {
		// The previous /<title[^>]*>([\s\S]*?)<\/title>/i regex was O(n²) on
		// unclosed title tags — same ReDoS class as the stripSpans fix.
		// The indexOf scan must complete in well under 100 ms on 1.4 MB input.
		const start = Date.now();
		const result = extractTitle('<title'.repeat(200_000));
		expect(Date.now() - start).toBeLessThan(100);
		expect(result).toBeUndefined();
	});
});

describe('web_fetch — content encoding (gzip)', () => {
	test('decompresses a gzip response and applies the byte cap on decoded output', async () => {
		enableCouncil();
		publicDns();
		stubEvidence();
		// 5 KB of 'x' compressed to gzip — well under 5 KB compressed,
		// well over the 1024-byte max_bytes cap when decoded.
		const compressed = gzipSync(Buffer.from('x'.repeat(5000)));
		_internals.httpRequest = (async () => ({
			status: 200,
			headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
			body: Readable.from([compressed]),
			cancel: () => {},
		})) as unknown as typeof _internals.httpRequest;
		const res = await run({
			url: 'https://example.com/big.gz',
			max_bytes: 1024,
		});
		expect(res.success).toBe(true);
		expect(res.truncated).toBe(true);
		expect(res.bytesReturned).toBe(1024);
	});

	test('decompresses a gzip response and returns the full content when under cap', async () => {
		enableCouncil();
		publicDns();
		stubEvidence();
		const plaintext = 'Hello from gzip!';
		const compressed = gzipSync(Buffer.from(plaintext));
		_internals.httpRequest = (async () => ({
			status: 200,
			headers: { 'content-type': 'text/plain', 'content-encoding': 'gzip' },
			body: Readable.from([compressed]),
			cancel: () => {},
		})) as unknown as typeof _internals.httpRequest;
		const res = await run({ url: 'https://example.com/page.gz' });
		expect(res.success).toBe(true);
		expect(res.truncated).toBe(false);
		expect(res.text).toContain(plaintext);
	});

	test('decompresses a brotli response and returns the full content', async () => {
		enableCouncil();
		publicDns();
		stubEvidence();
		const plaintext = 'Hello from brotli!';
		const compressed = brotliCompressSync(Buffer.from(plaintext));
		_internals.httpRequest = (async () => ({
			status: 200,
			headers: { 'content-type': 'text/plain', 'content-encoding': 'br' },
			body: Readable.from([compressed]),
			cancel: () => {},
		})) as unknown as typeof _internals.httpRequest;
		const res = await run({ url: 'https://example.com/page.br' });
		expect(res.success).toBe(true);
		expect(res.truncated).toBe(false);
		expect(res.text).toContain(plaintext);
	});
});

describe('web_fetch — redirect and DNS edge cases', () => {
	test('re-pins socket to new IP on each redirect hop (multi-hop re-pinning)', async () => {
		enableCouncil();
		stubEvidence();
		let dnsCall = 0;
		_internals.dnsLookup = (async () => {
			dnsCall += 1;
			return [{ address: dnsCall === 1 ? '93.184.216.34' : '104.18.0.123' }];
		}) as unknown as typeof _internals.dnsLookup;
		const seen: string[] = [];
		_internals.httpRequest = (async (a: { pinnedAddress: string }) => {
			seen.push(a.pinnedAddress);
			if (seen.length === 1) {
				return {
					status: 302,
					headers: { location: 'https://cdn.example.com/page' },
					body: null,
					cancel: () => {},
				};
			}
			return {
				status: 200,
				headers: { 'content-type': 'text/html' },
				body: bodyOf('<p>done</p>'),
				cancel: () => {},
			};
		}) as unknown as typeof _internals.httpRequest;
		const res = await run({ url: 'https://example.com/start' });
		expect(res.success).toBe(true);
		expect(seen[0]).toBe('93.184.216.34');
		expect(seen[1]).toBe('104.18.0.123');
	});

	test('returns too_many_redirects after exceeding MAX_REDIRECTS hops', async () => {
		enableCouncil();
		publicDns();
		let hop = 0;
		_internals.httpRequest = (async () => ({
			status: 302,
			headers: { location: `https://example.com/step${(hop += 1)}` },
			body: null,
			cancel: () => {},
		})) as unknown as typeof _internals.httpRequest;
		const res = await run({ url: 'https://example.com/start' });
		expect(res.success).toBe(false);
		expect(res.reason).toBe('too_many_redirects');
	});

	test('returns dns_failure when dnsLookup throws on initial fetch', async () => {
		enableCouncil();
		_internals.dnsLookup = (async () => {
			throw new Error('ENOTFOUND notfound.example.com');
		}) as unknown as typeof _internals.dnsLookup;
		const res = await run({ url: 'https://notfound.example.com/page' });
		expect(res.success).toBe(false);
		expect(res.reason).toBe('dns_failure');
	});

	test('returns dns_failure when dnsLookup returns no addresses', async () => {
		enableCouncil();
		_internals.dnsLookup =
			(async () => []) as unknown as typeof _internals.dnsLookup;
		const res = await run({ url: 'https://example.com/page' });
		expect(res.success).toBe(false);
		expect(res.reason).toBe('dns_failure');
	});

	test('returns dns_failure when dnsLookup throws during redirect re-validation', async () => {
		enableCouncil();
		let dnsCall = 0;
		_internals.dnsLookup = (async () => {
			dnsCall += 1;
			if (dnsCall === 1) return [{ address: '93.184.216.34' }];
			throw new Error('ENOTFOUND cdn.example.com');
		}) as unknown as typeof _internals.dnsLookup;
		_internals.httpRequest = (async () => ({
			status: 302,
			headers: { location: 'https://cdn.example.com/page' },
			body: null,
			cancel: () => {},
		})) as unknown as typeof _internals.httpRequest;
		const res = await run({ url: 'https://example.com/start' });
		expect(res.success).toBe(false);
		expect(res.reason).toBe('dns_failure');
	});

	test('blocks redirect to IPv6-mapped metadata address in Location header', async () => {
		enableCouncil();
		publicDns();
		_internals.httpRequest = (async () => ({
			status: 302,
			headers: { location: 'http://[::ffff:169.254.169.254]/' },
			body: null,
			cancel: () => {},
		})) as unknown as typeof _internals.httpRequest;
		const res = await run({ url: 'https://example.com/redirect' });
		expect(res.success).toBe(false);
		expect(res.reason).toBe('blocked_host');
	});

	test('blocks when any resolved address is private (mixed public+private DNS)', async () => {
		enableCouncil();
		_internals.dnsLookup = (async () => [
			{ address: '93.184.216.34' },
			{ address: '10.0.0.1' },
		]) as unknown as typeof _internals.dnsLookup;
		const res = await run({ url: 'https://example.com/page' });
		expect(res.success).toBe(false);
		expect(res.reason).toBe('blocked_host');
	});
});

describe('web_fetch — byte cap boundary', () => {
	test('does not truncate when response is exactly max_bytes', async () => {
		enableCouncil();
		publicDns();
		stubEvidence();
		const exact = new Uint8Array(1024).fill('x'.charCodeAt(0));
		_internals.httpRequest = (async () => ({
			status: 200,
			headers: { 'content-type': 'text/plain' },
			body: (async function* () {
				yield exact;
			})(),
			cancel: () => {},
		})) as unknown as typeof _internals.httpRequest;
		const res = await run({
			url: 'https://example.com/exact',
			max_bytes: 1024,
		});
		expect(res.success).toBe(true);
		expect(res.truncated).toBe(false);
		expect(res.bytesReturned).toBe(1024);
	});

	test('accepts max_bytes at the hard cap (5_000_000)', async () => {
		enableCouncil();
		publicDns();
		stubEvidence();
		stubHttp(200, { 'content-type': 'text/plain' }, 'hi');
		const res = await run({
			url: 'https://example.com/page',
			max_bytes: 5_000_000,
		});
		expect(res.success).toBe(true);
		expect(res.truncated).toBe(false);
	});

	test('accepts timeout_ms at the hard cap (30_000)', async () => {
		enableCouncil();
		publicDns();
		stubEvidence();
		stubHttp(200, { 'content-type': 'text/plain' }, 'hi');
		const res = await run({
			url: 'https://example.com/page',
			timeout_ms: 30_000,
		});
		expect(res.success).toBe(true);
	});
});

describe('web_fetch — evidence failure', () => {
	test('returns success:true with evidence.stored:false when writeEvidenceDocuments throws', async () => {
		enableCouncil();
		publicDns();
		_internals.writeEvidenceDocuments = (async () => {
			throw new Error('disk full');
		}) as unknown as typeof _internals.writeEvidenceDocuments;
		stubHttp(200, { 'content-type': 'text/plain' }, 'some content');
		const res = await run({ url: 'https://example.com/page' });
		expect(res.success).toBe(true);
		expect(res.evidence.stored).toBe(false);
		expect(res.evidence.error).toContain('disk full');
	});
});
