/**
 * Anchor-strictness guarantees for `VERSION_PINNED_LEAF` (#2236, RC3).
 *
 * This regex is the leaf allowlist guarding a RECURSIVE DELETE
 * (`evictPluginCaches` -> `fs.rmSync(..., { recursive: true })`), so its
 * anchoring is a security property, not a style detail.
 *
 * Two concerns were raised in review and are pinned here rather than argued:
 *
 *  1. "`$` matches before a trailing newline, so `opencode-swarm@1.2.3\n`
 *     would be accepted." That is PCRE/Python behavior. In JavaScript, `$`
 *     WITHOUT the `m` flag anchors strictly at end-of-input, so the newline
 *     forms are rejected. Verified empirically, and pinned below so the
 *     guarantee cannot be lost by someone later adding `m`.
 *
 *  2. "The traversal test is vacuous because `path.join` normalizes
 *     `opencode-swarm@../../..` before the regex ever sees it." True of a test
 *     that routes through `path.join` — so these cases feed the raw strings
 *     DIRECTLY to the regex, proving the predicate itself rejects them and not
 *     merely that normalization happened to intervene upstream.
 *
 * A directory name may legally contain a newline on POSIX, so case 1 is
 * reachable input, not a hypothetical.
 */

import { describe, expect, test } from 'bun:test';
import { VERSION_PINNED_LEAF } from '../../../src/config/cache-paths.js';

describe('VERSION_PINNED_LEAF anchoring (#2236 recursive-delete allowlist)', () => {
	test('accepts the exact version-pinned shapes it exists to allow', () => {
		for (const leaf of [
			'opencode-swarm@1.2.3',
			'opencode-swarm@7.143.1',
			'opencode-swarm@1.2.3-rc.1',
			'opencode-swarm@1.2.3+build.5',
			'opencode-swarm@1.2.3-rc.1+build.5',
		]) {
			expect(VERSION_PINNED_LEAF.test(leaf)).toBe(true);
		}
	});

	test('has no `m` flag — the property the end-anchor strictness depends on', () => {
		// If `m` is ever added, `$` starts matching at internal line ends and
		// every newline case below silently becomes acceptable.
		expect(VERSION_PINNED_LEAF.flags).not.toContain('m');
	});

	test('rejects trailing- and embedded-newline forms', () => {
		for (const leaf of [
			'opencode-swarm@1.2.3\n',
			'opencode-swarm@1.2.3\nevil',
			'opencode-swarm@1.2.3\r\n',
			'\nopencode-swarm@1.2.3',
		]) {
			expect(VERSION_PINNED_LEAF.test(leaf)).toBe(false);
		}
	});

	test('rejects traversal payloads fed DIRECTLY to the predicate', () => {
		// Deliberately not routed through path.join: this asserts the regex
		// itself refuses them, independent of any upstream normalization.
		for (const leaf of [
			'opencode-swarm@../../..',
			'opencode-swarm@..',
			'opencode-swarm@1.2.3/../..',
			'opencode-swarm@1.2.3/evil',
			'opencode-swarm@1.2.3\\evil',
		]) {
			expect(VERSION_PINNED_LEAF.test(leaf)).toBe(false);
		}
	});

	test('rejects prefix-style near-misses that a startsWith check would admit', () => {
		// The predicate is deliberately NOT `startsWith('opencode-swarm@')`,
		// which would admit the traversal cases above.
		for (const leaf of [
			'opencode-swarm@latest-evil',
			'opencode-swarm@1.2',
			'opencode-swarm@1.2.3.4',
			'opencode-swarm@v1.2.3',
			'not-opencode-swarm@1.2.3',
			'opencode-swarm@1.2.3 ',
			'opencode-swarm@',
			'',
		]) {
			expect(VERSION_PINNED_LEAF.test(leaf)).toBe(false);
		}
	});
});
