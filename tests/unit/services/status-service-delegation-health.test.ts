/**
 * Issue #2034 / #1659 — /swarm status delegation-ledger health section:
 * getStatusData population, formatStatusMarkdown rendering, and the
 * no-plan-branch contract (clean repos stay byte-identical; incidents render).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { recordDelegationRecoveryObservation } from '../../../src/background/delegation-health';
import {
	compactBackgroundDelegations,
	recordPendingDelegation,
} from '../../../src/background/pending-delegations';
import {
	formatStatusMarkdown,
	getStatusData,
} from '../../../src/services/status-service';
import { createSafeTestDir } from '../../helpers/safe-test-dir';

const { dir, cleanup } = createSafeTestDir('swarm-status-deleg-');
afterEach(cleanup);
beforeEach(() => {
	fs.rmSync(path.join(dir, '.swarm'), { recursive: true, force: true });
});

const AGENTS = {};

describe('status-service delegation health (#2034/#1659)', () => {
	it('getStatusData omits the section for a clean repo', async () => {
		const status = await getStatusData(dir, AGENTS);
		expect(status.delegationLedgerHealth).toBeUndefined();
	});

	it('getStatusData populates the section once a checkpoint exists', async () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		await recordPendingDelegation(dir, {
			correlationId: 'sess_a',
			jobId: null,
			subagentSessionId: 'sess_a',
			parentSessionId: 'sess_parent',
			callID: 'call_a',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
		});
		const compact = await compactBackgroundDelegations(dir, { force: true });
		expect(compact.status).toBe('compacted');

		const status = await getStatusData(dir, AGENTS);
		expect(status.delegationLedgerHealth).toBeDefined();
		expect(status.delegationLedgerHealth!.checkpoint?.sequence).toBe(1);
	});

	it('formatStatusMarkdown renders the section with checkpoint + recovery + uncertainty', async () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		await recordPendingDelegation(dir, {
			correlationId: 'sess_b',
			jobId: null,
			subagentSessionId: 'sess_b',
			parentSessionId: 'sess_parent',
			callID: 'call_b',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
		});
		await compactBackgroundDelegations(dir, { force: true });
		recordDelegationRecoveryObservation(dir, {
			source: 'checkpoint+tail',
			ok: false,
			reason:
				'background delegation ledger exceeds the 4194304-byte recovery bound',
		});

		const status = await getStatusData(dir, AGENTS);
		const markdown = formatStatusMarkdown(status as never);
		expect(markdown).toContain('**Background Delegations**');
		expect(markdown).toContain('Checkpoint #1');
		expect(markdown).toContain('Recovery: checkpoint+tail (FAILED');
		expect(markdown).toContain('Last uncertainty');
		expect(markdown).toContain('4194304');
	});

	it('a durable uncertainty renders in the no-plan branch with no active plan', async () => {
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

		const status = await getStatusData(dir, AGENTS);
		expect(status.hasPlan).toBe(false);
		expect(status.delegationLedgerHealth?.lastUncertainty).toBeDefined();
		// The no-plan markdown contract is exercised through the command test
		// (see tests/unit/commands/status-delegation-health.test.ts).
		expect(status.delegationLedgerHealth!.ledger.limitBytes).toBe(4194304);
	});

	it('pressure band reflects a growing tail', async () => {
		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		await recordPendingDelegation(dir, {
			correlationId: 'sess_c',
			jobId: null,
			subagentSessionId: 'sess_c',
			parentSessionId: 'sess_parent',
			callID: 'call_c',
			normalizedAgent: 'reviewer',
			swarmPrefixedAgent: 'reviewer',
			planTaskId: null,
			evidenceTaskId: null,
		});
		await compactBackgroundDelegations(dir, { force: true });
		fs.appendFileSync(
			path.join(dir, '.swarm', 'background-delegations.jsonl'),
			`${'x'.repeat(300 * 1024)}\n`,
		);
		const status = await getStatusData(dir, AGENTS);
		expect(status.delegationLedgerHealth!.ledger.band).toBe('nominal');
	});
});
