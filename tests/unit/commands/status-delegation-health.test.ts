/**
 * Issue #2034 / #1659 — PRODUCTION command test: `/swarm status` via
 * handleStatusCommand must surface delegation-ledger health, including the
 * no-plan branch, while clean-repo output stays byte-identical (pinned).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { recordDelegationRecoveryObservation } from '../../../src/background/delegation-health';
import {
	compactBackgroundDelegations,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import { handleStatusCommand } from '../../../src/services/status-service';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { dir, cleanup } = createSafeTestDir('swarm-cmd-deleg-');
afterEach(cleanup);
beforeEach(() => {
	fs.rmSync(path.join(dir, '.swarm'), { recursive: true, force: true });
});

const AGENTS = {};

describe('/swarm status delegation health (production command)', () => {
	it('clean repo: no-plan output stays byte-identical (regression pin)', async () => {
		const result = await handleStatusCommand(dir, AGENTS);
		expect(result).toBe('No active swarm plan found.');
	});

	it('no-plan branch renders the durable uncertainty after an incident', async () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'background-delegations.jsonl'),
			'',
		);
		recordDelegationRecoveryObservation(dir, {
			source: 'legacy-ledger',
			ok: false,
			reason:
				'background delegation ledger exceeds the 4194304-byte recovery bound',
		});

		const result = await handleStatusCommand(dir, AGENTS);
		expect(result).toContain('No active swarm plan found.');
		expect(result).toContain('**Background Delegations**');
		expect(result).toContain('recovery bound');
		expect(result).toContain('Last uncertainty');
	});

	it('no-plan branch renders checkpoint state after compaction', async () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		await recordPendingDelegation(dir, {
			correlationId: 'sess_cmd',
			jobId: null,
			subagentSessionId: 'sess_cmd',
			parentSessionId: 'sess_parent',
			callID: 'call_cmd',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
		});
		const compact = await compactBackgroundDelegations(dir, { force: true });
		expect(compact.status).toBe('compacted');

		const result = await handleStatusCommand(dir, AGENTS);
		expect(result).toContain('**Background Delegations**');
		expect(result).toContain('Checkpoint #1');
		expect(result).toContain('1 live');
	});

	it('a quiet healthy tail with no checkpoint and no uncertainty stays silent', async () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'background-delegations.jsonl'),
			'',
		);
		const result = await handleStatusCommand(dir, AGENTS);
		expect(result).toBe('No active swarm plan found.');
	});
});
