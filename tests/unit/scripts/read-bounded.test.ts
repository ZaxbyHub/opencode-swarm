import { describe, expect, test } from 'bun:test';
import {
	readBounded,
	readBoundedResult,
} from '../../../scripts/lib/read-bounded';

/** A Response whose body is the given chunks, with no Content-Length. */
function chunked(
	chunks: Uint8Array[],
	state: { pulled: number; cancelled: boolean },
): Response {
	let i = 0;
	// highWaterMark 0: nothing is pulled until the consumer asks for it.
	const stream = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				if (i >= chunks.length) {
					controller.close();
					return;
				}
				state.pulled++;
				controller.enqueue(chunks[i++]);
			},
			cancel() {
				state.cancelled = true;
			},
		},
		{ highWaterMark: 0 },
	);
	return new Response(stream);
}

const enc = new TextEncoder();

describe('readBounded (streaming, shared by check-host-contract and drift-check)', () => {
	test('returns the full text when the body fits the cap, across chunk boundaries', async () => {
		const state = { pulled: 0, cancelled: false };
		// A multi-byte character split across two chunks must still decode.
		const bytes = enc.encode('héllo wörld');
		const res = chunked([bytes.slice(0, 2), bytes.slice(2)], state);
		expect(await readBounded(res, 64)).toBe('héllo wörld');
		expect(state.cancelled).toBe(false);
	});

	test('a chunked body without Content-Length that exceeds the cap is rejected without being fully pulled', async () => {
		const state = { pulled: 0, cancelled: false };
		const chunks = Array.from({ length: 1000 }, () =>
			enc.encode('x'.repeat(10)),
		);
		const res = chunked(chunks, state);
		expect(res.headers.get('content-length')).toBeNull();
		const result = await readBoundedResult(res, 25);
		expect(result).toEqual({ ok: false, reason: 'oversize' });
		// 3 chunks (30 bytes) cross the 25-byte cap; the other ~997 are never read.
		expect(state.pulled).toBeLessThan(10);
		expect(state.cancelled).toBe(true);
		expect(
			await readBounded(chunked(chunks, { pulled: 0, cancelled: false }), 25),
		).toBeNull();
	});

	test('a declared Content-Length over the cap fails fast without touching the body', async () => {
		const state = { pulled: 0, cancelled: false };
		const res = chunked([enc.encode('hi')], state);
		const lying = new Response(res.body, {
			headers: { 'content-length': '999' },
		});
		expect(await readBoundedResult(lying, 10)).toEqual({
			ok: false,
			reason: 'oversize',
		});
		expect(state.pulled).toBe(0);
	});

	test('a body exactly at the cap is accepted; one byte over is not', async () => {
		expect(await readBounded(new Response('a'.repeat(10)), 10)).toBe(
			'a'.repeat(10),
		);
		expect(await readBounded(new Response('a'.repeat(11)), 10)).toBeNull();
	});

	test('an erroring stream fails closed as unreadable', async () => {
		const erroring = () =>
			new Response(
				new ReadableStream<Uint8Array>({
					pull() {
						throw new Error('socket reset');
					},
				}),
			);
		expect(await readBoundedResult(erroring(), 10)).toEqual({
			ok: false,
			reason: 'unreadable',
		});
		expect(await readBounded(erroring(), 10)).toBeNull();
	});

	test('a body-less response reads as the empty string and a body-less oversize arrayBuffer is rejected', async () => {
		expect(await readBounded(new Response(null, { status: 200 }), 10)).toBe('');
		const fake = {
			headers: { get: () => null },
			body: null,
			arrayBuffer: async () => enc.encode('a'.repeat(11)).buffer,
		} as unknown as Response;
		expect(await readBounded(fake, 10)).toBeNull();
	});
});
