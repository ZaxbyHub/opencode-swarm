import { describe, expect, test } from 'bun:test';
import {
	NPM_DIST_TAGS_URL,
	resolveNpmLatestTag,
} from '../../../scripts/check-host-contract';

function fakeFetch(
	body: string,
	init: ResponseInit = { status: 200 },
	seen: string[] = [],
): typeof fetch {
	return (async (input: string | URL | Request) => {
		seen.push(String(input));
		return new Response(body, init);
	}) as typeof fetch;
}

describe('host-contract check: npm latest-tag resolution', () => {
	test('reads `latest` from the small dist-tags endpoint, not the full packument', async () => {
		const seen: string[] = [];
		const tag = await resolveNpmLatestTag(
			fakeFetch(
				'{"latest":"1.18.35","beta":"2.0.0-beta.1"}',
				{ status: 200 },
				seen,
			),
		);
		expect(tag).toBe('1.18.35');
		expect(seen).toEqual([NPM_DIST_TAGS_URL]);
		expect(NPM_DIST_TAGS_URL).toContain(
			'/-/package/@opencode-ai/plugin/dist-tags',
		);
	});

	test('an oversized response (the 27 MB packument failure class) resolves to no tag', async () => {
		const huge = `{"latest":"1.0.0","pad":"${'x'.repeat(70 * 1024)}"}`;
		expect(await resolveNpmLatestTag(fakeFetch(huge))).toBe('');
	});

	test('a non-OK status, missing latest, or invalid JSON resolves to no tag', async () => {
		expect(await resolveNpmLatestTag(fakeFetch('{}', { status: 404 }))).toBe(
			'',
		);
		expect(await resolveNpmLatestTag(fakeFetch('{"beta":"2.0.0"}'))).toBe('');
		expect(await resolveNpmLatestTag(fakeFetch('{"latest":7}'))).toBe('');
		expect(await resolveNpmLatestTag(fakeFetch('not json'))).toBe('');
	});

	test('a thrown fetch resolves to no tag', async () => {
		const throwing = (async () => {
			throw new Error('network down');
		}) as unknown as typeof fetch;
		expect(await resolveNpmLatestTag(throwing)).toBe('');
	});
});
