import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	BACKGROUND_DELEGATION_FALLBACK_DIR,
	listDelegationFallbacks,
} from '../../../src/background/pending-delegations';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

function artifact(correlationId: string): string {
	return JSON.stringify({
		schemaVersion: 1,
		correlationId,
		createdAt: 1,
		record: {
			schemaVersion: 1,
			correlationId,
			jobId: null,
			subagentSessionId: correlationId,
			parentSessionId: 'parent',
			callID: `call-${correlationId}`,
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
			status: 'pending',
			createdAt: 1,
			updatedAt: 1,
		},
	});
}

describe('pending delegation fallback ordering', () => {
	test('lists fallback owners in code-unit filename order after reversed enumeration', async () => {
		const { dir, cleanup } = createSafeTestDir('pending-ordering-');
		const originalReadDirectory = _internals.readFallbackDirectory;
		try {
			fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
			const fallbackDir = path.join(
				dir,
				'.swarm',
				BACKGROUND_DELEGATION_FALLBACK_DIR,
			);
			fs.mkdirSync(fallbackDir);
			for (const correlationId of ['first', 'second']) {
				const digest = createHash('sha256').update(correlationId).digest('hex');
				fs.writeFileSync(
					path.join(fallbackDir, `${digest}.json`),
					artifact(correlationId),
				);
			}
			const entries = fs.readdirSync(fallbackDir, { withFileTypes: true });
			const reversed = [...entries].reverse();
			_internals.readFallbackDirectory = () => reversed;

			const owners = await listDelegationFallbacks(dir);
			const expected = [...entries]
				.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
				.map((entry) => entry.name);
			const actual = owners.map(
				(owner) =>
					`${createHash('sha256').update(owner.correlationId).digest('hex')}.json`,
			);
			expect(actual).toEqual(expected);
		} finally {
			_internals.readFallbackDirectory = originalReadDirectory;
			cleanup();
		}
	});
});
