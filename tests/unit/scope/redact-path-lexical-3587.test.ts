/**
 * #3587 review round: redactPath classifies profile shapes LEXICALLY on a
 * canonical slash-normalized form — normalization-created home shapes fold,
 * exact profile roots fold, and Windows-drive / UNC forms fold in either
 * separator flavor on ANY host. Output keeps the input's separator flavor.
 *
 * Every leg here is host-independent (no platform gates): the classification
 * no longer consults the host path module's absolute/normalize semantics.
 */
import { describe, expect, test } from 'bun:test';
import * as path from 'node:path';
import { redactPath } from '../../../src/scope/path-identity';

describe('3587 redactPath: normalization-created home shapes fold', () => {
	test.each([
		['/tmp/../home/alice/secret.txt', '~/secret.txt'],
		['/home/x/../alice/secret.txt', '~/secret.txt'],
		['/Users/../Users/alice/secret.txt', '~/secret.txt'],
	])('%p -> %p', (input, expected) => {
		// Pre-fix the matchers ran on the RAW string, so these normalized to a
		// profile path only after matching and leaked the account name.
		expect(redactPath(input)).toBe(expected);
	});
});

describe('3587 redactPath: exact profile roots fold', () => {
	test.each([
		['/home/alice', '~'],
		['/Users/alice', '~'],
		['/home/alice/', '~/'],
		['C:/Users/alice', '~'],
		['C:\\Users\\alice', '~'],
		['c:\\users\\alice', '~'],
	])('%p -> %p', (input, expected) => {
		expect(redactPath(input)).toBe(expected);
	});
});

describe('3587 redactPath: Windows forms fold on every host, flavor kept', () => {
	test.each([
		['C:/Users/alice/file', '~/file'],
		['C:\\Users\\alice\\file', '~\\file'],
		['//server/Users/alice/file', '~/file'],
		['\\\\server\\Users\\alice\\file', '~\\file'],
		// Share naming is case-insensitive (Windows convention).
		['\\\\server\\users\\alice\\file', '~\\file'],
		// F-004 contract (server folded, share/name kept) in both flavors.
		['\\\\server\\share\\user\\file', '~\\share\\user\\file'],
		['//server/share/user/file', '~/share/user/file'],
	])('%p -> %p', (input, expected) => {
		expect(redactPath(input)).toBe(expected);
	});
});

describe('3587 redactPath: over-redaction controls (pre-change host form)', () => {
	test.each([
		'/project/src/file.txt',
		'docs/home/alice/x.txt',
		'.git\\cfg.settings.json',
		'\\\\server\\share',
	])('%p renders exactly path.normalize(input)', (input) => {
		expect(redactPath(input)).toBe(path.normalize(input));
	});
});
