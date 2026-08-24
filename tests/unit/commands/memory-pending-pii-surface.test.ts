import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import { handleMemoryPendingCommand } from '../../../src/commands/memory';
import { DEFAULT_MEMORY_CONFIG, MemoryGateway } from '../../../src/memory';
import { evictAndClose } from '../../../src/memory/provider-pool';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = canonicalMkdtemp('swarm-pending-pii-');
});

afterEach(async () => {
	evictAndClose(tmpDir);
	await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * PRR-035 (PR #2310 feedback, final-critic coverage item): the detect-only
 * PII summary stored on proposal metadata must be SURFACED by
 * /swarm memory pending — types/counts/score only, never matched text.
 */
describe('/swarm memory pending PII summary surface (PRR-035)', () => {
	test('a pii-annotated proposal renders pii-score with counts, no matched text', async () => {
		const gateway = new MemoryGateway(
			{ directory: tmpDir, sessionID: 'session-a', agentRole: 'coder' },
			{
				config: {
					...DEFAULT_MEMORY_CONFIG,
					enabled: true,
					provider: 'sqlite',
					redaction: {
						rejectDurableSecrets: true,
						detectPii: true,
						piiDetector: 'regex' as const,
						rejectDurablePii: false,
						piiThreshold: 0.7,
					},
				},
			},
		);
		await gateway.propose({
			operation: 'add',
			kind: 'repo_convention',
			text: 'Escalation contact is escalation-pending@example-corp.com per policy.',
			rationale: 'Escalation convention.',
			evidenceRefs: ['docs/policy.md'],
		});
		await gateway.dispose();

		const out = await handleMemoryPendingCommand(tmpDir, []);
		expect(out).toContain('## Swarm Memory Pending');
		expect(out).toContain('pii-score=0.90 (emailx1)');
		// The summary must never carry the matched text.
		expect(out).not.toContain('escalation-pending@example-corp.com');
	});

	test('a proposal without PII findings renders no pii-score', async () => {
		const gateway = new MemoryGateway(
			{ directory: tmpDir, sessionID: 'session-a', agentRole: 'coder' },
			{
				config: {
					...DEFAULT_MEMORY_CONFIG,
					enabled: true,
					provider: 'sqlite',
					redaction: {
						rejectDurableSecrets: true,
						detectPii: true,
						piiDetector: 'regex' as const,
						rejectDurablePii: false,
						piiThreshold: 0.7,
					},
				},
			},
		);
		await gateway.propose({
			operation: 'add',
			kind: 'repo_convention',
			text: 'This repository uses bun for all test execution.',
			rationale: 'Test command convention.',
			evidenceRefs: ['package.json'],
		});
		await gateway.dispose();

		const out = await handleMemoryPendingCommand(tmpDir, []);
		expect(out).toContain('## Swarm Memory Pending');
		expect(out).not.toContain('pii-score=');
	});
});
