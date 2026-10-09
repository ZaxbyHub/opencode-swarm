/**
 * Bounded reads of a fetch `Response`, shared by `scripts/check-host-contract.ts`
 * and `scripts/drift-check.ts`.
 *
 * `AbortController` bounds TIME, not memory, so a hostile or runaway upstream
 * must not be buffered whole. The body is consumed as a stream and the read is
 * aborted the moment the running total passes the cap, so at most one chunk
 * beyond the cap is ever held. A declared `Content-Length` over the cap
 * fails fast before any body byte is read.
 */

export type BoundedReadResult =
	| { ok: true; text: string }
	| { ok: false; reason: 'oversize' | 'unreadable' };

/** Read `res` as UTF-8 text, aborting once more than `capBytes` have arrived. */
export async function readBoundedResult(
	res: Response,
	capBytes: number,
): Promise<BoundedReadResult> {
	try {
		const declared = Number(res.headers.get('content-length') ?? '0');
		if (Number.isFinite(declared) && declared > capBytes) {
			return { ok: false, reason: 'oversize' };
		}
		if (!res.body) {
			// No stream (null-body response): nothing to buffer unboundedly.
			const buf = await res.arrayBuffer();
			if (buf.byteLength > capBytes) return { ok: false, reason: 'oversize' };
			return { ok: true, text: new TextDecoder().decode(buf) };
		}
		const reader = res.body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > capBytes) {
					await reader.cancel().catch(() => undefined);
					return { ok: false, reason: 'oversize' };
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return { ok: true, text: new TextDecoder().decode(bytes) };
	} catch {
		return { ok: false, reason: 'unreadable' };
	}
}

/**
 * Fail-closed wrapper: the body text, or null when it is over the cap or the
 * read throws.
 */
export async function readBounded(
	res: Response,
	capBytes: number,
): Promise<string | null> {
	const result = await readBoundedResult(res, capBytes);
	return result.ok ? result.text : null;
}
