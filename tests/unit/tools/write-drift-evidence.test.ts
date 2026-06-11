/**
 * Tests for writeDriftEvidence tool
 */

import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from 'bun:test';
import fs, {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Plan } from '../../../src/config/plan-schema';
import {
	initLedger,
	loadLastApprovedPlan,
	readLedgerEvents,
} from '../../../src/plan/ledger';
// Import the function to test
import {
	executeWriteDriftEvidence,
	write_drift_evidence,
} from '../../../src/tools/write-drift-evidence';

function createTestPlan(): Plan {
	return {
		schema_version: '1.0.0',
		title: 'Drift Snapshot Test',
		swarm: 'drift-snapshot-swarm',
		current_phase: 1,
		phases: [
			{
				id: 1,
				name: 'Phase 1',
				status: 'in_progress',
				tasks: [
					{
						id: '1.1',
						phase: 1,
						status: 'pending',
						size: 'small',
						description: 'Task one',
						depends: [],
						files_touched: [],
					},
				],
			},
		],
	};
}

async function setupSwarmDirWithPlan(dir: string, plan: Plan): Promise<void> {
	await fs.promises.mkdir(path.join(dir, '.swarm'), { recursive: true });
	await fs.promises.writeFile(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify(plan, null, 2),
		'utf-8',
	);
	await initLedger(dir, `${plan.swarm}-${plan.title}`.replace(/\W/g, '_'));
}

describe('executeWriteDriftEvidence', () => {
	let tempDir: string;

	beforeEach(async () => {
		// Create a temp directory for each test
		tempDir = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), 'drift-evidence-test-'),
		);
	});

	afterEach(async () => {
		// Clean up temp directory
		try {
			await fs.promises.rm(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	// Test 1: Positive integer phase validation
	test('rejects non-positive phase numbers', async () => {
		const result = await executeWriteDriftEvidence(
			{ phase: 0, verdict: 'APPROVED', summary: 'test summary' },
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.phase).toBe(0);
		expect(parsed.message).toBe('Invalid phase: must be a positive integer');
	});

	test('rejects negative phase numbers', async () => {
		const result = await executeWriteDriftEvidence(
			{ phase: -1, verdict: 'APPROVED', summary: 'test summary' },
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.phase).toBe(-1);
		expect(parsed.message).toBe('Invalid phase: must be a positive integer');
	});

	test('rejects non-integer phase numbers', async () => {
		const result = await executeWriteDriftEvidence(
			{ phase: 1.5, verdict: 'APPROVED', summary: 'test summary' },
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.message).toBe('Invalid phase: must be a positive integer');
	});

	// Test 2: Invalid verdict rejection
	test('rejects invalid verdict values', async () => {
		const result = await executeWriteDriftEvidence(
			{ phase: 1, verdict: 'INVALID_VERDICT' as any, summary: 'test summary' },
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.message).toBe(
			"Invalid verdict: must be 'APPROVED' or 'NEEDS_REVISION'",
		);
	});

	// Test 3: Empty summary rejection
	test('rejects empty summary', async () => {
		const result = await executeWriteDriftEvidence(
			{ phase: 1, verdict: 'APPROVED', summary: '' },
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.message).toBe('Invalid summary: must be a non-empty string');
	});

	test('rejects whitespace-only summary', async () => {
		const result = await executeWriteDriftEvidence(
			{ phase: 1, verdict: 'APPROVED', summary: '   ' },
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(false);
		expect(parsed.message).toBe('Invalid summary: must be a non-empty string');
	});

	// Test 4: APPROVED verdict normalization to 'approved'
	test('normalizes APPROVED verdict to approved', async () => {
		const result = await executeWriteDriftEvidence(
			{ phase: 5, verdict: 'APPROVED', summary: 'All changes verified' },
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(true);
		expect(parsed.verdict).toBe('approved');
		expect(parsed.phase).toBe(5);
	});

	// Test 5: NEEDS_REVISION verdict normalization to 'rejected'
	test('normalizes NEEDS_REVISION verdict to rejected', async () => {
		const result = await executeWriteDriftEvidence(
			{ phase: 3, verdict: 'NEEDS_REVISION', summary: 'Changes need revision' },
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(true);
		expect(parsed.verdict).toBe('rejected');
		expect(parsed.phase).toBe(3);
	});

	// Test 6: Successful write with approved verdict
	test('writes evidence file successfully with approved verdict', async () => {
		const result = await executeWriteDriftEvidence(
			{
				phase: 1,
				verdict: 'APPROVED',
				summary: 'Phase 1 drift verification passed',
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(true);
		expect(parsed.phase).toBe(1);
		expect(parsed.verdict).toBe('approved');
		expect(parsed.message).toBe(
			'Drift evidence written to .swarm/evidence/1/drift-verifier.json',
		);

		// Verify file was created in correct location
		const expectedPath = path.join(
			tempDir,
			'.swarm',
			'evidence',
			'1',
			'drift-verifier.json',
		);
		const fileExists = await fs.promises
			.access(expectedPath)
			.then(() => true)
			.catch(() => false);
		expect(fileExists).toBe(true);

		// Verify the content includes gate-contract format
		const fileContent = await fs.promises.readFile(expectedPath, 'utf-8');
		const parsedContent = JSON.parse(fileContent);
		expect(parsedContent.entries).toBeArrayOfSize(1);
		expect(parsedContent.entries[0].type).toBe('drift-verification');
		expect(parsedContent.entries[0].verdict).toBe('approved');
		expect(parsedContent.entries[0].summary).toBe(
			'Phase 1 drift verification passed',
		);
		expect(parsedContent.entries[0].timestamp).toBeString();
	});

	// Test 7: Successful write with rejected verdict
	test('writes evidence file successfully with rejected verdict', async () => {
		const result = await executeWriteDriftEvidence(
			{
				phase: 2,
				verdict: 'NEEDS_REVISION',
				summary: 'Phase 2 drift issues found',
			},
			tempDir,
		);
		const parsed = JSON.parse(result);

		expect(parsed.success).toBe(true);
		expect(parsed.phase).toBe(2);
		expect(parsed.verdict).toBe('rejected');

		// Verify the content includes rejected verdict
		const expectedPath = path.join(
			tempDir,
			'.swarm',
			'evidence',
			'2',
			'drift-verifier.json',
		);
		const fileContent = await fs.promises.readFile(expectedPath, 'utf-8');
		const parsedContent = JSON.parse(fileContent);
		expect(parsedContent.entries[0].verdict).toBe('rejected');
		expect(parsedContent.entries[0].summary).toBe('Phase 2 drift issues found');
	});

	// Test 8: Atomic write pattern (temp + rename)
	test('uses atomic write pattern with temp file and rename', async () => {
		// Spy on fs.promises.writeFile and fs.promises.rename to verify atomic pattern
		const writeFileSpy = spyOn(fs.promises, 'writeFile');
		const renameSpy = spyOn(fs.promises, 'rename');

		await executeWriteDriftEvidence(
			{ phase: 7, verdict: 'APPROVED', summary: 'Atomic write test' },
			tempDir,
		);

		// Verify atomic write pattern: write to temp then rename
		expect(writeFileSpy).toHaveBeenCalledTimes(1);
		expect(renameSpy).toHaveBeenCalledTimes(1);

		const tempPath = writeFileSpy.mock.calls[0][0] as string;
		const renameFrom = renameSpy.mock.calls[0][0] as string;
		const renameTo = renameSpy.mock.calls[0][1] as string;

		// Temp file should be in the evidence directory with .tmp extension
		expect(tempPath).toContain('.swarm');
		expect(tempPath).toContain('.drift-verifier.json.tmp');

		// Rename from temp to final location
		expect(renameFrom).toBe(tempPath);
		expect(renameTo).toBe(
			path.join(tempDir, '.swarm', 'evidence', '7', 'drift-verifier.json'),
		);

		writeFileSpy.mockRestore();
		renameSpy.mockRestore();
	});

	test('summary is trimmed in output', async () => {
		await executeWriteDriftEvidence(
			{ phase: 1, verdict: 'APPROVED', summary: '  trimmed summary  ' },
			tempDir,
		);

		const expectedPath = path.join(
			tempDir,
			'.swarm',
			'evidence',
			'1',
			'drift-verifier.json',
		);
		const fileContent = await fs.promises.readFile(expectedPath, 'utf-8');
		const parsedContent = JSON.parse(fileContent);
		expect(parsedContent.entries[0].summary).toBe('trimmed summary');
	});

	describe('critic-approved immutable plan snapshot', () => {
		test('takes a critic_approved snapshot on APPROVED verdict when plan.json exists', async () => {
			const plan = createTestPlan();
			await setupSwarmDirWithPlan(tempDir, plan);

			const result = await executeWriteDriftEvidence(
				{
					phase: 1,
					verdict: 'APPROVED',
					summary: 'All checks pass',
				},
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.approvedSnapshot).toBeDefined();
			expect(typeof parsed.approvedSnapshot.seq).toBe('number');
			expect(typeof parsed.approvedSnapshot.timestamp).toBe('string');
			expect(parsed.snapshotError).toBeUndefined();

			// Verify the ledger has a critic_approved snapshot event
			const events = await readLedgerEvents(tempDir);
			const approved = events.filter(
				(e) => e.event_type === 'snapshot' && e.source === 'critic_approved',
			);
			expect(approved.length).toBe(1);
			expect(approved[0].seq).toBe(parsed.approvedSnapshot.seq);

			// Verify loadLastApprovedPlan returns the embedded plan
			const loaded = await loadLastApprovedPlan(tempDir);
			expect(loaded).not.toBeNull();
			expect(loaded?.plan.swarm).toBe(plan.swarm);
			expect(loaded?.approval).toMatchObject({
				phase: 1,
				verdict: 'APPROVED',
				summary: 'All checks pass',
			});
		});

		test('does NOT take a snapshot on NEEDS_REVISION verdict', async () => {
			const plan = createTestPlan();
			await setupSwarmDirWithPlan(tempDir, plan);

			const result = await executeWriteDriftEvidence(
				{
					phase: 1,
					verdict: 'NEEDS_REVISION',
					summary: 'Regression found',
				},
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.verdict).toBe('rejected');
			expect(parsed.approvedSnapshot).toBeUndefined();

			const events = await readLedgerEvents(tempDir);
			const approved = events.filter(
				(e) => e.event_type === 'snapshot' && e.source === 'critic_approved',
			);
			expect(approved.length).toBe(0);
		});

		test('reports snapshotError when plan.json is missing but still succeeds', async () => {
			// No plan.json, no ledger — the drift evidence write should still
			// succeed, and snapshotError should be surfaced.
			const result = await executeWriteDriftEvidence(
				{
					phase: 1,
					verdict: 'APPROVED',
					summary: 'Approved without a plan',
				},
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.verdict).toBe('approved');
			expect(parsed.approvedSnapshot).toBeUndefined();
			expect(parsed.snapshotError).toBe('plan.json not available for snapshot');
		});

		test('drift evidence file write succeeds even when snapshot path throws', async () => {
			// plan.json exists but the ledger is missing → initLedger was never
			// called. takeSnapshotEvent will throw because ledger is not
			// initialized. The drift evidence file should still be written.
			await fs.promises.mkdir(path.join(tempDir, '.swarm'), {
				recursive: true,
			});
			await fs.promises.writeFile(
				path.join(tempDir, '.swarm', 'plan.json'),
				JSON.stringify(createTestPlan(), null, 2),
				'utf-8',
			);

			const result = await executeWriteDriftEvidence(
				{
					phase: 1,
					verdict: 'APPROVED',
					summary: 'Ledger unavailable scenario',
				},
				tempDir,
			);
			const parsed = JSON.parse(result);

			expect(parsed.success).toBe(true);
			expect(parsed.verdict).toBe('approved');
			expect(parsed.approvedSnapshot).toBeUndefined();
			expect(parsed.snapshotError).toMatch(/Ledger not initialized/);

			// Evidence file must still exist
			const evidencePath = path.join(
				tempDir,
				'.swarm',
				'evidence',
				'1',
				'drift-verifier.json',
			);
			const fileExists = await fs.promises
				.access(evidencePath)
				.then(() => true)
				.catch(() => false);
			expect(fileExists).toBe(true);
		});
	});
});

describe('write_drift_evidence provenance write-through', () => {
	let tempDir: string;

	type ExecuteFn = (
		args: unknown,
		ctx: { directory: string },
	) => Promise<string>;

	function run(args: unknown): Promise<string> {
		return (write_drift_evidence.execute as unknown as ExecuteFn)(args, {
			directory: tempDir,
		});
	}

	beforeEach(() => {
		tempDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'swarm-dve-')));
		mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	test('persists provenance fields when provided', async () => {
		const out = await run({
			phase: 1,
			verdict: 'APPROVED',
			summary: 'Drift verification passed',
			provenanceAgentName: 'critic_drift_verifier',
			provenanceSessionId: 'sess-drift-123',
		});
		const parsed = JSON.parse(out);
		expect(parsed.success).toBe(true);

		const evidencePath = path.join(tempDir, '.swarm', 'evidence', '1');
		expect(existsSync(evidencePath)).toBe(true);

		const evidenceFile = path.join(evidencePath, 'drift-verifier.json');
		const content = readFileSync(evidenceFile, 'utf-8');
		const evidence = JSON.parse(content);

		expect(evidence.entries).toHaveLength(1);
		const entry = evidence.entries[0];
		expect(entry.provenance).toBeDefined();
		expect(entry.provenance.agent_name).toBe('critic_drift_verifier');
		expect(entry.provenance.session_id).toBe('sess-drift-123');
		expect(entry.provenance.captured_at).toBeDefined();
	});

	test('omits provenance when not provided', async () => {
		const out = await run({
			phase: 1,
			verdict: 'APPROVED',
			summary: 'Drift verification passed',
		});
		const parsed = JSON.parse(out);
		expect(parsed.success).toBe(true);

		const evidencePath = path.join(tempDir, '.swarm', 'evidence', '1');
		const evidenceFile = path.join(evidencePath, 'drift-verifier.json');
		const content = readFileSync(evidenceFile, 'utf-8');
		const evidence = JSON.parse(content);

		expect(evidence.entries[0].provenance).toBeUndefined();
	});

	test('persists provenance with only agent_name', async () => {
		const out = await run({
			phase: 1,
			verdict: 'APPROVED',
			summary: 'Drift verification passed',
			provenanceAgentName: 'critic_drift_verifier',
		});
		expect(JSON.parse(out).success).toBe(true);

		const evidencePath = path.join(tempDir, '.swarm', 'evidence', '1');
		const evidenceFile = path.join(evidencePath, 'drift-verifier.json');
		const content = readFileSync(evidenceFile, 'utf-8');
		const evidence = JSON.parse(content);

		const entry = evidence.entries[0];
		expect(entry.provenance).toBeDefined();
		expect(entry.provenance.agent_name).toBe('critic_drift_verifier');
		expect(entry.provenance.session_id).toBeUndefined();
		expect(entry.provenance.captured_at).toBeDefined();
	});
});
