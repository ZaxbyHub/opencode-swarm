/**
 * #3844 closeout round 4: the core-events writer redacts the free-text
 * carriers before it checks the line bound, and a redaction placeholder can
 * be LONGER than the credential it replaces — so an event whose free text
 * sat exactly on the bound was refused after the redaction, where the
 * un-redacted writer accepted it.
 *
 * The refusal contract is unchanged (an event that was ALREADY over the
 * bound is still refused); the redaction-induced growth is absorbed by
 * truncating the redacted (secret-free) carriers.
 *
 * Synthetic tokens only.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	appendCoreEventSync,
	appendCoreEventsSync,
	CORE_EVENT_LINE_TOO_LARGE,
	_internals as coreInternals,
} from '../../../src/events/core-events';

const LIMIT = coreInternals.limits.maxLineBytes;
// A URL userinfo GROWS the text (the placeholder is longer than the
// credential), so it is the shape that can push a near-limit line over.
const USERINFO = 'https://u:p@example.com';

function event(detail: string): Record<string, unknown> {
	return {
		type: 'probe.event',
		detail,
		message: '',
		summary: '',
		reason: '',
	};
}

function nearLimitDetail(): string {
	const base = Buffer.byteLength(`${JSON.stringify(event(''))}\n`, 'utf8') - 1;
	return 'y'.repeat(LIMIT - base - USERINFO.length - 1) + ' ' + USERINFO;
}

describe('#3844 the core-events writer fits a redacted line to the bound', () => {
	test('an event whose un-redacted line fits is still written', () => {
		const dir = realpathSync(
			mkdtempSync(path.join(os.tmpdir(), 'sw-3844-core-events-')),
		);
		try {
			const detail = nearLimitDetail();
			const rawBytes =
				Buffer.byteLength(`${JSON.stringify(event(detail))}\n`, 'utf8') - 1;
			expect(rawBytes).toBeLessThanOrEqual(LIMIT);
			// Before the fix this threw CORE_EVENT_LINE_TOO_LARGE: the
			// redaction grew the line past the bound.
			expect(() =>
				appendCoreEventSync(dir, event(detail) as never),
			).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test('an event whose UN-redacted line is over the bound is still refused', () => {
		const dir = realpathSync(
			mkdtempSync(path.join(os.tmpdir(), 'sw-3844-core-events-')),
		);
		try {
			const detail = 'y'.repeat(LIMIT + 16);
			expect(() => appendCoreEventSync(dir, event(detail) as never)).toThrow(
				CORE_EVENT_LINE_TOO_LARGE,
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);

	test('the batch writer fits a redacted line the same way', () => {
		const dir = realpathSync(
			mkdtempSync(path.join(os.tmpdir(), 'sw-3844-core-events-')),
		);
		try {
			const detail = nearLimitDetail();
			expect(() =>
				appendCoreEventsSync(dir, [event(detail)] as never),
			).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}, 60_000);
});
