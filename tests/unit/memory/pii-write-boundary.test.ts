import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadDatabaseCtor } from '../../../src/db/sqlite-loader';
import {
	DEFAULT_MEMORY_CONFIG,
	MemoryGateway,
	MemoryValidationError,
	resolveSqliteDatabasePath,
} from '../../../src/memory';
import { evictAndClose } from '../../../src/memory/provider-pool';

let tmpDir: string;

beforeEach(async () => {
	tmpDir = await fs.realpath(
		await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-memory-pii-')),
	);
});

afterEach(async () => {
	evictAndClose(tmpDir);
	await fs.rm(tmpDir, { recursive: true, force: true });
});

function sqliteConfig() {
	return {
		...DEFAULT_MEMORY_CONFIG,
		enabled: true,
		provider: 'sqlite' as const,
	};
}

interface EventRow {
	operation: string;
	target_id: string;
	reason: string | null;
}

function readEvents(): EventRow[] {
	const dbPath = resolveSqliteDatabasePath(tmpDir, sqliteConfig());
	const db = new (loadDatabaseCtor())(dbPath);
	try {
		return db
			.query<EventRow, []>(
				'SELECT operation, target_id, reason FROM memory_events ORDER BY rowid ASC',
			)
			.all();
	} finally {
		db.close();
	}
}

describe('PII write boundary (#1466)', () => {
	test("default config keeps today's behavior — PII-bearing proposals are accepted", async () => {
		const gateway = new MemoryGateway(
			{ directory: tmpDir, sessionID: 'session-a', agentRole: 'coder' },
			{ config: sqliteConfig() },
		);
		const proposal = await gateway.propose({
			operation: 'add',
			kind: 'repo_convention',
			text: 'Release contact is release-engineering@example-corp.com per policy.',
			rationale: 'Contact convention.',
			evidenceRefs: ['docs/policy.md'],
		});
		expect(proposal.status).toBe('pending');
		expect(proposal.metadata.pii).toBeUndefined();
	});

	test('rejectDurablePii rejects PII-bearing durable proposals and logs pii_rejected without matched text', async () => {
		const gateway = new MemoryGateway(
			{ directory: tmpDir, sessionID: 'session-a', agentRole: 'coder' },
			{
				config: {
					...sqliteConfig(),
					redaction: {
						rejectDurableSecrets: true,
						detectPii: false,
						piiDetector: 'regex' as const,
						rejectDurablePii: true,
						piiThreshold: 0.7,
					},
				},
			},
		);
		let thrown: unknown;
		try {
			await gateway.propose({
				operation: 'add',
				kind: 'repo_convention',
				text: 'Onboarding owner is onboarding-owner@example-corp.com always.',
				rationale: 'Owner convention.',
				evidenceRefs: ['docs/onboarding.md'],
			});
		} catch (err) {
			thrown = err;
		}
		expect(thrown).toBeInstanceOf(MemoryValidationError);
		expect((thrown as MemoryValidationError).code).toBe('memory_pii_rejected');
		expect((thrown as Error).message).toContain('email');

		const events = readEvents();
		const rejection = events.filter((e) => e.operation === 'pii_rejected');
		expect(rejection).toHaveLength(1);
		// The audit row must carry types/score only — never the matched text.
		expect(rejection[0].reason).toContain('email');
		expect(rejection[0].reason).not.toContain(
			'onboarding-owner@example-corp.com',
		);
	});

	test('detectPii without rejectDurablePii annotates the proposal summary only', async () => {
		const gateway = new MemoryGateway(
			{ directory: tmpDir, sessionID: 'session-a', agentRole: 'coder' },
			{
				config: {
					...sqliteConfig(),
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
		const proposal = await gateway.propose({
			operation: 'add',
			kind: 'repo_convention',
			text: 'Escalation contact is escalation@example-corp.com per policy.',
			rationale: 'Escalation convention.',
			evidenceRefs: ['docs/policy.md'],
		});
		expect(proposal.status).toBe('pending');
		expect(proposal.metadata.pii).toEqual({
			score: 0.9,
			countsByType: { email: 1 },
		});
	});

	test('score exactly at threshold does not reject (exceeds is strict)', async () => {
		const gateway = new MemoryGateway(
			{ directory: tmpDir, sessionID: 'session-a', agentRole: 'coder' },
			{
				config: {
					...sqliteConfig(),
					redaction: {
						rejectDurableSecrets: true,
						detectPii: false,
						piiDetector: 'regex' as const,
						rejectDurablePii: true,
						piiThreshold: 0.9,
					},
				},
			},
		);
		const proposal = await gateway.propose({
			operation: 'add',
			kind: 'repo_convention',
			text: 'Build sheriff is sheriff@example-corp.com this week.',
			rationale: 'Sheriff convention.',
			evidenceRefs: ['docs/policy.md'],
		});
		expect(proposal.status).toBe('pending');
	});

	test('upsertCurated durable records are covered by the same enforcement', async () => {
		const gateway = new MemoryGateway(
			{ directory: tmpDir, sessionID: 'session-a', agentRole: 'curator' },
			{
				config: {
					...sqliteConfig(),
					redaction: {
						rejectDurableSecrets: true,
						detectPii: false,
						piiDetector: 'regex' as const,
						rejectDurablePii: true,
						piiThreshold: 0.7,
					},
				},
			},
		);
		// Build a fully valid durable record (id/contentHash consistent) with
		// PII-bearing text directly through the gateway's record factory.
		const record = gateway.createRecord({
			kind: 'repo_convention',
			text: 'Owner is owner@example-corp.com for this area.',
			source: { type: 'file', filePath: 'docs/policy.md' },
		});
		await expect(gateway.upsertCurated(record)).rejects.toThrow(
			'PII threshold',
		);
		expect(readEvents().some((e) => e.operation === 'pii_rejected')).toBe(true);
	});

	test('ephemeral records are not subject to durable PII rejection', async () => {
		const gateway = new MemoryGateway(
			{ directory: tmpDir, sessionID: 'session-a', agentRole: 'coder' },
			{
				config: {
					...sqliteConfig(),
					redaction: {
						rejectDurableSecrets: true,
						detectPii: false,
						piiDetector: 'regex' as const,
						rejectDurablePii: true,
						piiThreshold: 0.7,
					},
				},
			},
		);
		const proposal = await gateway.propose({
			operation: 'add',
			kind: 'scratch',
			text: 'Reminder: ping me@example-corp.com after the demo.',
			rationale: 'Scratch note.',
			evidenceRefs: [],
		});
		expect(proposal.status).toBe('pending');
	});

	test('curator update decisions with PII-bearing patch text are rejected (final-critic item 1)', async () => {
		const gateway = new MemoryGateway(
			{ directory: tmpDir, sessionID: 'session-a', agentRole: 'curator_phase' },
			{
				config: {
					...sqliteConfig(),
					redaction: {
						rejectDurableSecrets: true,
						detectPii: false,
						piiDetector: 'regex' as const,
						rejectDurablePii: true,
						piiThreshold: 0.7,
					},
				},
			},
		);
		const record = gateway.createRecord({
			kind: 'repo_convention',
			text: 'Clean convention text.',
			source: { type: 'file', filePath: 'docs/policy.md' },
		});
		await gateway.upsertCurated(record);
		const proposal = await gateway.propose({
			operation: 'update',
			kind: 'repo_convention',
			targetMemoryId: record.id,
			text: 'Clean updated text.',
			rationale: 'Refine the convention wording.',
			evidenceRefs: ['docs/policy.md'],
		});
		await expect(
			gateway.applyCuratorDecision({
				action: 'update',
				proposalId: proposal.id,
				targetMemoryId: record.id,
				patch: {
					text: 'New owner is curator-update@example-corp.com for this area.',
				},
				reason: 'refresh convention',
			}),
		).rejects.toThrow('PII threshold');
		expect(readEvents().some((e) => e.operation === 'pii_rejected')).toBe(true);
		await gateway.dispose();
	});
});
