import { describe, expect, test } from 'bun:test';
import { getValidatedFiles } from '../../../../src/turbo/lean/partition-common';

describe('getValidatedFiles', () => {
	test('keeps scopes relative when the macOS workspace lives below /private', () => {
		const workspace = '/private/var/folders/test/opencode-swarm';

		expect(getValidatedFiles(['src/a.ts'], workspace)).toEqual([
			['src/a.ts'],
			0,
		]);
	});

	test('normalizes an absolute scope inside the workspace to its relative path', () => {
		const workspace = '/private/var/folders/test/opencode-swarm';

		expect(
			getValidatedFiles(
				['/private/var/folders/test/opencode-swarm/src/a.ts'],
				workspace,
			),
		).toEqual([['src/a.ts'], 0]);
	});

	test('rejects an absolute scope outside the workspace', () => {
		const workspace = '/private/var/folders/test/opencode-swarm';

		expect(
			getValidatedFiles(['/private/var/folders/test/other/a.ts'], workspace),
		).toEqual([[], 1]);
	});
});
