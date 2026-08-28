import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	_internals,
	BACKGROUND_DELEGATIONS_FILE,
	type LegacyCoderSettlementReconciler,
	readDelegations,
	registerLegacyCoderSettlementReconciler,
	scanDelegationsForRecovery,
} from '../../../src/background/pending-delegations';
import { createSafeTestDir } from '../../helpers/safe-test-dir';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

describe('legacy settlement registry and record compatibility', () => {
	afterEach(() => {
		_internals.resetLegacyCoderSettlementReconcilers();
	});

	test('refreshing a registration makes it the newest bounded entry', () => {
		const root = canonicalMkdtemp('legacy-reconciler-registry-');
		try {
			const callback = (async () => true) as LegacyCoderSettlementReconciler;
			const paths = Array.from({ length: 33 }, (_, index) =>
				path.join(root, String(index)),
			);

			for (const directory of paths.slice(0, 32)) {
				registerLegacyCoderSettlementReconciler(directory, callback);
			}
			const beforeRefresh =
				_internals.getLegacyCoderSettlementReconcilerOrder();
			const oldest = beforeRefresh[0];
			registerLegacyCoderSettlementReconciler(
				path.join(paths[0]!, '.'),
				callback,
			);
			const afterRefresh = _internals.getLegacyCoderSettlementReconcilerOrder();
			expect(afterRefresh.at(-1)).toBe(oldest);

			registerLegacyCoderSettlementReconciler(paths[32]!, callback);
			expect(_internals.getLegacyCoderSettlementReconciler(paths[0]!)).toBe(
				callback,
			);
			expect(
				_internals.getLegacyCoderSettlementReconciler(paths[1]!),
			).toBeUndefined();
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('strict recovery remains uncertain when a newer reader adds an unknown field', () => {
		const safe = createSafeTestDir('legacy-reconciler-schema-');
		try {
			const swarmDir = path.join(safe.dir, '.swarm');
			fs.mkdirSync(swarmDir, { recursive: true });
			const record = {
				schemaVersion: 3,
				correlationId: 'correlation',
				jobId: null,
				subagentSessionId: 'subagent',
				parentSessionId: 'parent',
				callID: 'call',
				normalizedAgent: 'coder',
				swarmPrefixedAgent: 'coder',
				planTaskId: null,
				evidenceTaskId: null,
				status: 'completed',
				createdAt: 1,
				updatedAt: 1,
				futureField: 'new-reader-only',
			};
			fs.writeFileSync(
				path.join(swarmDir, BACKGROUND_DELEGATIONS_FILE),
				`${JSON.stringify(record)}\n`,
			);

			expect(readDelegations(safe.dir)).toEqual([]);
			expect(scanDelegationsForRecovery(safe.dir).status).toBe('uncertain');
		} finally {
			safe.cleanup();
		}
	});
});
