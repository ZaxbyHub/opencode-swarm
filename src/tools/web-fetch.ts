/**
 * web_fetch tool — owned by the architect for MODE: DEEP_RESEARCH source
 * reading (and available for any architect-driven research that needs full
 * document text rather than search snippets).
 *
 * web_search returns titled snippets; web_fetch retrieves the readable text of
 * a single URL so the architect can ground claims in primary sources. Results
 * are stored as `crawl` evidence documents (same cache as web_search) and the
 * returned `evidenceRef` can be cited in a research report.
 *
 * Config-gated on `council.general.enabled` — the same feature flag that opts a
 * project into external network research. Unlike web_search it does NOT require
 * a search API key, because it fetches arbitrary user/agent-supplied URLs
 * directly rather than calling a search provider.
 *
 * Security (this is the first arbitrary-URL fetcher in the repo, so it carries
 * its own SSRF + resource defenses — there is no provider host allowlist to
 * lean on):
 *   - http/https schemes only; file:, ftp:, data:, etc. are rejected.
 *   - The host is DNS-resolved and every resolved address is checked against
 *     loopback / private / link-local / unique-local / CGNAT / metadata ranges;
 *     literal-IP hosts are checked directly. This blocks cloud metadata
 *     (169.254.169.254) and internal services.
 *   - The socket is then PINNED to the exact validated IP (host = resolved
 *     address) while the original hostname is kept for the Host header and TLS
 *     SNI/certificate identity. There is no second name resolution at connect
 *     time, so DNS rebinding cannot swap in a private/metadata address after the
 *     check (TOCTOU), and HTTPS verification still validates the hostname.
 *   - Redirects are followed manually (the underlying request never auto-follows)
 *     and every hop is re-validated AND re-pinned, so a public URL cannot 302
 *     into the metadata endpoint or an internal host.
 *   - The body is streamed and aborted once it exceeds `max_bytes` of DECODED
 *     output (so a gzip bomb is bounded by decompressed size, not the
 *     advisory Content-Length header).
 *   - An AbortController enforces `timeout_ms`; the signal is always cleared in
 *     a finally block.
 *
 * Never throws — returns a structured `success: true | false` JSON string.
 */

import { lookup } from 'node:dns/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import * as zlib from 'node:zlib';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { loadPluginConfig } from '../config/loader';
import { writeEvidenceDocuments } from '../evidence/documents';
import { createSwarmTool } from './create-tool';
import { resolveWorkingDirectory } from './resolve-working-directory';

interface HttpRequestArgs {
	/** The URL to request. Used for path, Host header, and TLS SNI/identity. */
	url: URL;
	/**
	 * The pre-validated address to open the socket to. The connection is pinned
	 * to this exact IP so there is no second, unvalidated name resolution between
	 * the SSRF check and the connection (defeats DNS rebinding).
	 */
	pinnedAddress: string;
	signal: AbortSignal;
	headers: Record<string, string>;
}

interface RawHttpResponse {
	status: number;
	headers: Record<string, string | undefined>;
	/** Decoded (decompressed) body, streamed lazily so the byte cap bounds it. */
	body: AsyncIterable<Uint8Array> | null;
	/** Destroy the underlying socket/stream to close the connection early. */
	cancel?: () => void;
}

const DEFAULT_MAX_BYTES = 1_000_000;
const MAX_BYTES_HARD_CAP = 5_000_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
const MAX_TEXT_LENGTH = 50_000;

const ArgsSchema = z.object({
	url: z.string().min(1).max(2048),
	max_bytes: z.number().int().min(1024).max(MAX_BYTES_HARD_CAP).optional(),
	timeout_ms: z.number().int().min(1000).max(MAX_TIMEOUT_MS).optional(),
	working_directory: z.string().optional(),
});

interface WebFetchOk {
	success: true;
	url: string;
	finalUrl: string;
	status: number;
	contentType?: string;
	title?: string;
	text: string;
	truncated: boolean;
	/** Size of the returned buffer — capped at max_bytes, not bytes-from-wire. */
	bytesReturned: number;
	evidence: {
		stored: boolean;
		ref?: string;
		path?: string;
		error?: string;
	};
}

interface WebFetchFail {
	success: false;
	reason: string;
	message: string;
}

/**
 * Decide whether a single resolved IP address must be blocked because it points
 * at a loopback, private, link-local, unique-local, CGNAT, or reserved target.
 * Handles IPv4, IPv6, and IPv4-mapped IPv6 (::ffff:a.b.c.d).
 */
export function isBlockedAddress(address: string): boolean {
	const family = isIP(address);
	if (family === 4) return isBlockedIPv4(address);
	if (family === 6) return isBlockedIPv6(address);
	// Not a recognizable IP literal — treat as blocked rather than guess.
	return true;
}

function isBlockedIPv4(address: string): boolean {
	const parts = address.split('.');
	if (parts.length !== 4) return true;
	const octets = parts.map((p) => Number(p));
	if (octets.some((o) => !Number.isInteger(o) || o < 0 || o > 255)) return true;
	const [a, b] = octets;
	if (a === 0) return true; // 0.0.0.0/8
	if (a === 10) return true; // private
	if (a === 127) return true; // loopback
	if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254
	if (a === 172 && b >= 16 && b <= 31) return true; // private
	if (a === 192 && b === 168) return true; // private
	if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
	if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18.0.0/15
	if (a === 192 && b === 0 && octets[2] === 0) return true; // 192.0.0.0/24 IETF protocol assignments (RFC 6890)
	if (a === 192 && b === 0 && octets[2] === 2) return true; // TEST-NET-1 192.0.2.0/24
	if (a === 198 && b === 51 && octets[2] === 100) return true; // TEST-NET-2 198.51.100.0/24
	if (a === 203 && b === 0 && octets[2] === 113) return true; // TEST-NET-3 203.0.113.0/24
	if (a === 192 && b === 88 && octets[2] === 99) return true; // 6to4 relay anycast 192.88.99.0/24
	if (a >= 224) return true; // multicast + reserved (224.0.0.0/4, 240.0.0.0/4)
	return false;
}

/**
 * Expand an IPv6 literal to its 8 hextets, handling `::` compression and an
 * embedded IPv4 tail (`::ffff:1.2.3.4`). Returns null on malformed input. This
 * is the robust replacement for string-prefix matching — `new URL` normalizes
 * `[::ffff:169.254.169.254]` to the hex form `::ffff:a9fe:a9fe`, which a dotted
 * regex misses, so we must parse structurally.
 */
function expandIPv6(input: string): number[] | null {
	let s = input.toLowerCase().split('%')[0]; // strip zone id
	if (!s) return null;
	// Convert a trailing embedded IPv4 (e.g. ::ffff:1.2.3.4) to two hextets.
	if (s.includes('.')) {
		const colon = s.lastIndexOf(':');
		if (colon === -1) return null;
		const v4 = s.slice(colon + 1).split('.');
		if (v4.length !== 4) return null;
		const o = v4.map((p) => Number(p));
		if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
		const h1 = ((o[0] << 8) | o[1]).toString(16);
		const h2 = ((o[2] << 8) | o[3]).toString(16);
		s = `${s.slice(0, colon + 1)}${h1}:${h2}`;
	}
	const halves = s.split('::');
	if (halves.length > 2) return null;
	const parseGroups = (part: string): number[] | null => {
		if (part === '') return [];
		const groups = part.split(':');
		const out: number[] = [];
		for (const g of groups) {
			if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
			out.push(Number.parseInt(g, 16));
		}
		return out;
	};
	const head = parseGroups(halves[0]);
	if (head === null) return null;
	if (halves.length === 2) {
		const tail = parseGroups(halves[1]);
		if (tail === null) return null;
		const missing = 8 - head.length - tail.length;
		if (missing < 1) return null; // `::` must stand for at least one zero group
		return [...head, ...new Array<number>(missing).fill(0), ...tail];
	}
	return head.length === 8 ? head : null;
}

function isBlockedIPv6(raw: string): boolean {
	const h = expandIPv6(raw);
	if (!h) return true; // unparseable → block rather than guess
	if (h.every((x) => x === 0)) return true; // :: unspecified
	if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true; // ::1 loopback
	// IPv4-mapped (::ffff:0:0/96) and deprecated IPv4-compatible (::a.b.c.d):
	// validate the embedded v4 address regardless of decimal/hex spelling.
	// Mapped form: first five hextets zero, sixth = 0xffff. Compat form: all
	// six leading hextets zero (excluding :: and ::1 themselves).
	const mappedV4 = h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff;
	const compatV4 =
		h.slice(0, 6).every((x) => x === 0) && !(h[6] === 0 && h[7] <= 1);
	if (mappedV4 || compatV4) {
		const v4 = `${h[6] >> 8}.${h[6] & 0xff}.${h[7] >> 8}.${h[7] & 0xff}`;
		return isBlockedIPv4(v4);
	}
	const first = h[0];
	if (first >= 0xfc00 && first <= 0xfdff) return true; // fc00::/7 unique-local
	if (first >= 0xfe80 && first <= 0xfebf) return true; // fe80::/10 link-local
	if (first >= 0xff00) return true; // ff00::/8 multicast
	return false;
}

/**
 * Validate a URL string for fetching: http/https only, and the host must not
 * resolve to a blocked address. Returns the parsed URL on success.
 */
async function validateFetchUrl(
	candidate: string,
	dnsLookup: typeof lookup,
): Promise<
	| { ok: true; url: URL; address: string }
	| { ok: false; reason: string; message: string }
> {
	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return {
			ok: false,
			reason: 'invalid_url',
			message: `Not a valid URL: ${candidate}`,
		};
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		return {
			ok: false,
			reason: 'blocked_scheme',
			message: `Only http and https URLs are allowed (got "${url.protocol}").`,
		};
	}
	const host = url.hostname.replace(/^\[|\]$/g, ''); // unwrap [::1] form
	if (isIP(host)) {
		if (isBlockedAddress(host)) {
			return {
				ok: false,
				reason: 'blocked_host',
				message: `Refusing to fetch a private, loopback, or reserved address: ${host}`,
			};
		}
		return { ok: true, url, address: host };
	}
	let resolved: Array<{ address: string }>;
	try {
		resolved = await dnsLookup(host, { all: true });
	} catch (err) {
		return {
			ok: false,
			reason: 'dns_failure',
			message: `Could not resolve host "${host}": ${err instanceof Error ? err.message : String(err)}`,
		};
	}
	if (resolved.length === 0) {
		return {
			ok: false,
			reason: 'dns_failure',
			message: `Host "${host}" resolved to no addresses.`,
		};
	}
	for (const { address } of resolved) {
		if (isBlockedAddress(address)) {
			return {
				ok: false,
				reason: 'blocked_host',
				message: `Host "${host}" resolves to a private, loopback, or reserved address (${address}).`,
			};
		}
	}
	// All resolved addresses passed the block check; pin the first one.
	return { ok: true, url, address: resolved[0].address };
}

function isAllowedContentType(contentType: string | null): boolean {
	if (!contentType) return true; // many servers omit it; allow and decode as text
	const type = contentType.split(';')[0].trim().toLowerCase();
	if (type.startsWith('text/')) return true;
	if (type === 'application/json' || type === 'application/xml') return true;
	if (
		type === 'application/xhtml+xml' ||
		type.endsWith('+json') ||
		type.endsWith('+xml')
	) {
		return true;
	}
	return false;
}

/**
 * Extract the document <title>, if present. Uses a forward indexOf scan so
 * there is no regex backtracking on large inputs — a lazy
 * `/<title[^>]*>([\s\S]*?)<\/title>/i` is O(n²) on unclosed title tags
 * (same ReDoS class as the `stripSpans` fix).
 */
export function extractTitle(html: string): string | undefined {
	const lower = html.toLowerCase();
	const start = lower.indexOf('<title');
	if (start === -1) return undefined;
	const tagEnd = lower.indexOf('>', start);
	if (tagEnd === -1) return undefined;
	const contentStart = tagEnd + 1;
	const end = lower.indexOf('</title', contentStart);
	if (end === -1) return undefined;
	const content = html.slice(contentStart, end);
	const title = decodeEntities(content.replace(/\s+/g, ' ').trim());
	return title || undefined;
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' ',
	'#39': "'",
};

function decodeEntities(text: string): string {
	return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
		const key = body.toLowerCase();
		if (key in NAMED_ENTITIES) return NAMED_ENTITIES[key];
		if (body.startsWith('#x') || body.startsWith('#X')) {
			const code = Number.parseInt(body.slice(2), 16);
			return Number.isFinite(code) ? safeFromCodePoint(code) : whole;
		}
		if (body.startsWith('#')) {
			const code = Number.parseInt(body.slice(1), 10);
			return Number.isFinite(code) ? safeFromCodePoint(code) : whole;
		}
		return whole;
	});
}

function safeFromCodePoint(code: number): string {
	try {
		return String.fromCodePoint(code);
	} catch {
		return '';
	}
}

/**
 * Remove every `open … close` span with a linear forward scan. Unlike a lazy
 * `/<open>[\s\S]*?<close>/` regex (which is O(n²) and catastrophically slow on
 * many unclosed openers — a ReDoS vector on attacker-controlled HTML), each
 * `indexOf` advances monotonically, so the whole pass is O(n). An unterminated
 * opener drops the remainder of the document.
 */
function stripSpans(input: string, open: string, close: string): string {
	const lower = input.toLowerCase();
	let out = '';
	let i = 0;
	while (i < input.length) {
		const start = lower.indexOf(open, i);
		if (start === -1) {
			out += input.slice(i);
			break;
		}
		out += input.slice(i, start);
		const end = lower.indexOf(close, start + open.length);
		if (end === -1) break; // unterminated — drop the rest
		i = end + close.length;
	}
	return out;
}

/** Strip HTML to readable plain text. Dependency-free; not a full reader. */
export function htmlToText(html: string): string {
	let withoutScripts = stripSpans(html, '<script', '</script>');
	withoutScripts = stripSpans(withoutScripts, '<style', '</style>');
	withoutScripts = stripSpans(withoutScripts, '<noscript', '</noscript>');
	withoutScripts = stripSpans(withoutScripts, '<!--', '-->');
	const withBreaks = withoutScripts
		.replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer)>/gi, '\n')
		.replace(/<br\s*\/?>/gi, '\n');
	const noTags = withBreaks.replace(/<[^>]+>/g, ' ');
	const decoded = decodeEntities(noTags);
	return decoded
		.replace(/[ \t\f\v]+/g, ' ')
		.replace(/\s*\n\s*/g, '\n')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

interface FetchOutcome {
	status: number;
	finalUrl: string;
	contentType: string | null;
	bytes: Uint8Array;
	truncated: boolean;
}

function makeAbortError(): Error {
	try {
		return new DOMException('The operation was aborted', 'AbortError');
	} catch {
		const err = new Error('The operation was aborted');
		err.name = 'AbortError';
		return err;
	}
}

/**
 * Perform a single GET over node:http/node:https with the socket pinned to a
 * pre-validated IP. The original hostname is preserved for the Host header and
 * (for https) for TLS SNI + certificate identity, so connecting to the IP does
 * NOT weaken certificate verification. Because we never re-resolve the hostname
 * at connect time, DNS rebinding cannot swap in a private/metadata address after
 * validateFetchUrl has approved the resolved address.
 *
 * Redirects are NOT followed here (handled by boundedFetch). Content-Encoding is
 * decoded so the byte cap bounds DECODED output (a gzip bomb is bounded by the
 * decompressed size, not the advisory Content-Length): the decoder only produces
 * as fast as the consumer pulls, and boundedFetch stops pulling at the cap.
 */
function performHttpRequest(args: HttpRequestArgs): Promise<RawHttpResponse> {
	const { url, pinnedAddress, signal, headers } = args;
	const isHttps = url.protocol === 'https:';
	const port = url.port ? Number(url.port) : isHttps ? 443 : 80;
	const hostNoBrackets = url.hostname.replace(/^\[|\]$/g, '');
	const useSni = isHttps && isIP(hostNoBrackets) === 0;
	const options: https.RequestOptions = {
		host: pinnedAddress,
		port,
		path: `${url.pathname}${url.search}`,
		method: 'GET',
		headers: { Host: url.host, ...headers },
	};
	// SNI + cert identity track the hostname, not the pinned IP, so TLS still
	// verifies against the name the user asked for.
	if (useSni) options.servername = url.hostname;

	return new Promise<RawHttpResponse>((resolve, reject) => {
		let req: http.ClientRequest;
		const onResponse = (res: http.IncomingMessage) => {
			const normHeaders: Record<string, string | undefined> = {};
			for (const [key, value] of Object.entries(res.headers)) {
				normHeaders[key] = Array.isArray(value) ? value[0] : value;
			}
			// Absorb late 'error' events on early break (byte-cap, cancel).
			// Decompression is applied in boundedFetch so it is testable via stubs.
			res.on('error', () => {});
			resolve({
				status: res.statusCode ?? 0,
				headers: normHeaders,
				body: res as unknown as AsyncIterable<Uint8Array>,
				cancel: () => req.destroy(),
			});
		};
		req = isHttps
			? https.request(options, onResponse)
			: http.request(options, onResponse);
		const onAbort = () => req.destroy(makeAbortError());
		if (signal.aborted) req.destroy(makeAbortError());
		else signal.addEventListener('abort', onAbort, { once: true });
		req.on('error', reject);
		req.end();
	});
}

/**
 * Drive performHttpRequest with manual redirect handling, per-hop SSRF
 * re-validation + IP re-pinning, an AbortController timeout, and a streamed byte
 * cap on decoded output.
 */
async function boundedFetch(
	start: { url: URL; address: string },
	maxBytes: number,
	timeoutMs: number,
	deps: typeof _internals,
): Promise<
	| { ok: true; outcome: FetchOutcome }
	| { ok: false; reason: string; message: string }
> {
	let current = start;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			let raw: RawHttpResponse;
			try {
				raw = await deps.httpRequest({
					url: current.url,
					pinnedAddress: current.address,
					signal: controller.signal,
					headers: {
						Accept:
							'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
					},
				});
			} catch (err) {
				if (controller.signal.aborted) {
					return {
						ok: false,
						reason: 'timeout',
						message: `Fetch exceeded ${timeoutMs}ms for ${current.url.toString()}`,
					};
				}
				return {
					ok: false,
					reason: 'network_error',
					message: err instanceof Error ? err.message : String(err),
				};
			}

			if (raw.status >= 300 && raw.status < 400) {
				const location = raw.headers.location;
				raw.cancel?.();
				if (!location) {
					return {
						ok: false,
						reason: 'bad_redirect',
						message: `Redirect ${raw.status} with no Location header.`,
					};
				}
				let next: URL;
				try {
					next = new URL(location, current.url);
				} catch {
					return {
						ok: false,
						reason: 'bad_redirect',
						message: `Invalid redirect target: ${location}`,
					};
				}
				const revalidated = await validateFetchUrl(
					next.toString(),
					deps.dnsLookup,
				);
				if (!revalidated.ok) return revalidated;
				if (hop === MAX_REDIRECTS) {
					return {
						ok: false,
						reason: 'too_many_redirects',
						message: `Exceeded ${MAX_REDIRECTS} redirect hops.`,
					};
				}
				current = { url: revalidated.url, address: revalidated.address };
				continue;
			}

			if (raw.status < 200 || raw.status >= 300) {
				raw.cancel?.();
				return {
					ok: false,
					reason: 'http_error',
					message: `HTTP ${raw.status} for ${current.url.toString()}`,
				};
			}

			const contentType = raw.headers['content-type'] ?? null;
			if (!isAllowedContentType(contentType)) {
				raw.cancel?.();
				return {
					ok: false,
					reason: 'unsupported_content_type',
					message: `Refusing to read non-text content type "${contentType}".`,
				};
			}

			// Apply Content-Encoding decompression after the content-type check.
			// Moving decompression here (not in performHttpRequest) makes the path
			// testable: stubs returning a Readable are piped through the decoder;
			// async-generator stubs (which are not Readable instances) bypass it.
			// The byte cap bounds *decoded* output, bounding decompression bombs.
			let activeBody: AsyncIterable<Uint8Array> | null = raw.body;
			if (raw.body !== null && (raw.body as unknown) instanceof Readable) {
				const encoding = (raw.headers['content-encoding'] ?? '').toLowerCase();
				let decoder: Readable | null = null;
				if (encoding === 'gzip' || encoding === 'x-gzip')
					decoder = (raw.body as unknown as Readable).pipe(zlib.createGunzip());
				else if (encoding === 'deflate')
					decoder = (raw.body as unknown as Readable).pipe(
						zlib.createInflate(),
					);
				else if (encoding === 'br')
					decoder = (raw.body as unknown as Readable).pipe(
						zlib.createBrotliDecompress(),
					);
				if (decoder) {
					// Absorb late teardown errors on early break (same rationale as
					// the res.on('error') in performHttpRequest).
					decoder.on('error', () => {});
					activeBody = decoder as unknown as AsyncIterable<Uint8Array>;
				}
			}
			let body: { bytes: Uint8Array; truncated: boolean };
			try {
				body = await readBounded(activeBody, maxBytes);
			} catch (err) {
				raw.cancel?.();
				if (controller.signal.aborted) {
					return {
						ok: false,
						reason: 'timeout',
						message: `Fetch exceeded ${timeoutMs}ms while reading the body of ${current.url.toString()}`,
					};
				}
				return {
					ok: false,
					reason: 'network_error',
					message: err instanceof Error ? err.message : String(err),
				};
			}
			raw.cancel?.();
			return {
				ok: true,
				outcome: {
					status: raw.status,
					finalUrl: current.url.toString(),
					contentType,
					bytes: body.bytes,
					truncated: body.truncated,
				},
			};
		}
		return {
			ok: false,
			reason: 'too_many_redirects',
			message: `Exceeded ${MAX_REDIRECTS} redirect hops.`,
		};
	} finally {
		clearTimeout(timer);
	}
}

async function readBounded(
	body: AsyncIterable<Uint8Array> | null,
	maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (!body) return { bytes: new Uint8Array(0), truncated: false };
	const chunks: Uint8Array[] = [];
	let received = 0;
	let truncated = false;
	// Breaking the for-await invokes the iterator's return(), which destroys the
	// underlying stream — combined with raw.cancel?.() in boundedFetch this halts
	// decompression and closes the socket, bounding a decompression bomb.
	for await (const value of body) {
		if (!value || value.byteLength === 0) continue;
		chunks.push(value);
		received += value.byteLength;
		// Strictly greater: a stream whose final chunk lands exactly on the cap
		// and then completes is NOT truncated. More data → received exceeds the
		// cap on the next read → truncated.
		if (received > maxBytes) {
			truncated = true;
			break;
		}
	}
	const merged = new Uint8Array(Math.min(received, maxBytes));
	let offset = 0;
	for (const chunk of chunks) {
		if (offset >= merged.length) break;
		const slice = chunk.subarray(0, merged.length - offset);
		merged.set(slice, offset);
		offset += slice.byteLength;
	}
	return { bytes: merged, truncated };
}

export const web_fetch: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Fetch the readable text of a single http(s) URL for architect-driven deep research (MODE: DEEP_RESEARCH). ' +
		'Returns decoded page text (HTML stripped to plain text), the document title, the final URL after redirects, ' +
		'and an evidence reference stored alongside web_search results. Use it to read primary sources that web_search ' +
		'only surfaces as snippets. Config-gated on council.general.enabled; no search API key required. ' +
		'Blocks private/loopback/link-local/metadata addresses (re-validated across redirects), enforces a timeout, ' +
		'and caps the response body size.',
	args: {
		url: z
			.string()
			.min(1)
			.max(2048)
			.describe('Absolute http(s) URL to fetch (1–2048 chars).'),
		max_bytes: z
			.number()
			.int()
			.min(1024)
			.max(MAX_BYTES_HARD_CAP)
			.optional()
			.describe(
				`Max decoded response bytes to read (1024..${MAX_BYTES_HARD_CAP}, default ${DEFAULT_MAX_BYTES}).`,
			),
		timeout_ms: z
			.number()
			.int()
			.min(1000)
			.max(MAX_TIMEOUT_MS)
			.optional()
			.describe(
				`Request timeout in ms (1000..${MAX_TIMEOUT_MS}, default ${DEFAULT_TIMEOUT_MS}).`,
			),
		working_directory: z
			.string()
			.optional()
			.describe(
				'Project root for config resolution and evidence storage. Optional.',
			),
	},
	execute: async (args, directory) => {
		const parsed = ArgsSchema.safeParse(args);
		if (!parsed.success) {
			const fail: WebFetchFail = {
				success: false,
				reason: 'invalid_args',
				message: parsed.error.issues
					.map((i) => `${i.path.join('.')}: ${i.message}`)
					.join('; '),
			};
			return JSON.stringify(fail, null, 2);
		}

		const dirResult = resolveWorkingDirectory(
			parsed.data.working_directory,
			directory,
		);
		if (!dirResult.success) {
			const fail: WebFetchFail = {
				success: false,
				reason: 'invalid_working_directory',
				message: dirResult.message,
			};
			return JSON.stringify(fail, null, 2);
		}

		const config = _internals.loadPluginConfig(dirResult.directory);
		const generalConfig = config.council?.general;
		if (!generalConfig || generalConfig.enabled !== true) {
			const fail: WebFetchFail = {
				success: false,
				reason: 'council_general_disabled',
				message:
					'web_fetch is disabled - set council.general.enabled: true in the resolved config: global ~/.config/opencode/opencode-swarm.json or project .opencode/opencode-swarm.json.',
			};
			return JSON.stringify(fail, null, 2);
		}

		const validated = await validateFetchUrl(
			parsed.data.url,
			_internals.dnsLookup,
		);
		if (!validated.ok) {
			const fail: WebFetchFail = {
				success: false,
				reason: validated.reason,
				message: validated.message,
			};
			return JSON.stringify(fail, null, 2);
		}

		const maxBytes = parsed.data.max_bytes ?? DEFAULT_MAX_BYTES;
		const timeoutMs = parsed.data.timeout_ms ?? DEFAULT_TIMEOUT_MS;
		const result = await boundedFetch(
			{ url: validated.url, address: validated.address },
			maxBytes,
			timeoutMs,
			_internals,
		);
		if (!result.ok) {
			const fail: WebFetchFail = {
				success: false,
				reason: result.reason,
				message: result.message,
			};
			return JSON.stringify(fail, null, 2);
		}

		const { outcome } = result;
		const raw = new TextDecoder('utf-8', { fatal: false }).decode(
			outcome.bytes,
		);
		const isHtml =
			(outcome.contentType ?? '').toLowerCase().includes('html') ||
			/<html|<!doctype html/i.test(raw);
		const title = isHtml ? extractTitle(raw) : undefined;
		const bodyText = isHtml
			? htmlToText(raw)
			: raw.replace(/\s*\n\s*/g, '\n').trim();
		const text =
			bodyText.length > MAX_TEXT_LENGTH
				? `${bodyText.slice(0, MAX_TEXT_LENGTH)}…`
				: bodyText;
		const textTruncated =
			outcome.truncated || bodyText.length > MAX_TEXT_LENGTH;

		const evidence = await captureFetchEvidence(
			dirResult.directory,
			outcome.finalUrl,
			title,
			text,
		);

		const ok: WebFetchOk = {
			success: true,
			url: parsed.data.url,
			finalUrl: outcome.finalUrl,
			status: outcome.status,
			contentType: outcome.contentType ?? undefined,
			title,
			text,
			truncated: textTruncated,
			bytesReturned: outcome.bytes.byteLength,
			evidence,
		};
		return JSON.stringify(ok, null, 2);
	},
});

async function captureFetchEvidence(
	directory: string,
	url: string,
	title: string | undefined,
	text: string,
): Promise<{ stored: boolean; ref?: string; path?: string; error?: string }> {
	try {
		const written = await _internals.writeEvidenceDocuments(directory, [
			{
				sourceType: 'crawl',
				url,
				title,
				text,
				createdBy: 'web_fetch',
			},
		]);
		return {
			stored: written.records.length > 0,
			ref: written.refs[0],
			path: written.path,
		};
	} catch (err) {
		return {
			stored: false,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}

export const _internals: {
	httpRequest: (args: HttpRequestArgs) => Promise<RawHttpResponse>;
	dnsLookup: typeof lookup;
	loadPluginConfig: typeof loadPluginConfig;
	writeEvidenceDocuments: typeof writeEvidenceDocuments;
} = {
	httpRequest: performHttpRequest,
	dnsLookup: lookup,
	loadPluginConfig,
	writeEvidenceDocuments,
};
