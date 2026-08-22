/**
 * Adversarial tests for phase-complete.ts loadEvidence callers — typed recovery only
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { ensureAgentSession, resetSwarmState } from '../../../src/state';

function retrospectiveRecovery(result: {
	gate_report?: {
		entries?: Array<{
			id: string;
			recovery?: {
				kind?: string;
				action?: string;
				args?: Record<string, unknown>;
			};
		}>;
	};
}) {
	const recovery = result.gate_report?.entries?.find(
		(entry) => entry.id === 'retrospective',
	)?.recovery;
	expect(recovery).toBeDefined();
	return recovery!;
}

const mockLoadEvidence =
	vi.fn<
		(
			dir: string,
			taskId: string,
		) => Promise<
			| {
					status: 'found';
					bundle: {
						schema_version: string;
						task_id: string;
						created_at: string;
						updated_at: string;
						entries: Array<{
							task_id: string;
							type: string;
							timestamp: string;
							agent: string;
							verdict: string;
							summary: string;
							phase_number: number;
							[key: string]: unknown;
						}>;
					};
			  }
			| { status: 'not_found' }
			| { status: 'invalid_schema'; errors: string[] }
		>
	>();
const mockListEvidenceTaskIds = vi.fn<(dir: string) => Promise<string[]>>();

vi.mock('../../../src/evidence/manager.js', () => ({
	loadEvidence: (...args: unknown[]) =>
		mockLoadEvidence(...(args as [string, string])),
	listEvidenceTaskIds: (...args: unknown[]) =>
		mockListEvidenceTaskIds(...(args as [string])),
}));

const { phase_complete } = await import('../../../src/tools/phase-complete.js');

describe('phase_complete - loadEvidence typed recovery adversarial testing', () => {
	let tempDir: string;
	let originalCwd: string;

	beforeEach(() => {
		resetSwarmState();
		vi.clearAllMocks();

		tempDir = fs.realpathSync(
			fs.mkdtempSync(
				path.join(os.tmpdir(), 'phase-complete-load-evidence-recovery-'),
			),
		);
		originalCwd = process.cwd();
		process.chdir(tempDir);

		fs.mkdirSync(path.join(tempDir, '.swarm'), { recursive: true });
		fs.mkdirSync(path.join(tempDir, '.opencode'), { recursive: true });

		fs.writeFileSync(
			path.join(tempDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				phase_complete: {
					enabled: true,
					required_agents: [],
					require_docs: false,
					policy: 'enforce',
				},
			}),
		);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
		resetSwarmState();
		vi.clearAllMocks();
	});

	describe('typed recovery — phase-number integrity', () => {
		test('embeds the numeric phase in recovery args', async () => {
			const phase = 1;
			ensureAgentSession('sess1');

			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });
			mockListEvidenceTaskIds.mockResolvedValue([]);

			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(retrospectiveRecovery(parsed)).toEqual({
				kind: 'tool',
				action: 'write_retro',
				args: { phase },
			});
		});

		test('handles a large phase number in recovery args', async () => {
			const phase = 999999999;
			ensureAgentSession('sess1');

			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });
			mockListEvidenceTaskIds.mockResolvedValue([]);

			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(retrospectiveRecovery(parsed).args).toEqual({ phase });
		});

		test('handles MAX_SAFE_INTEGER phase in recovery args', async () => {
			const phase = Number.MAX_SAFE_INTEGER;
			ensureAgentSession('sess1');

			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });
			mockListEvidenceTaskIds.mockResolvedValue([]);

			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(retrospectiveRecovery(parsed).args).toEqual({ phase });
		});

		test('recovery phase remains a number', async () => {
			const phase = 1;
			ensureAgentSession('sess1');

			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });
			mockListEvidenceTaskIds.mockResolvedValue([]);

			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			expect(typeof retrospectiveRecovery(parsed).args?.phase).toBe('number');
		});

		test('recovery contains no user-derived task identifier', async () => {
			const phase = 1;
			ensureAgentSession('sess1');

			mockLoadEvidence.mockResolvedValue({ status: 'not_found' });
			mockListEvidenceTaskIds.mockResolvedValue([]);

			const result = await phase_complete.execute({
				phase,
				sessionID: 'sess1',
			});
			const parsed = JSON.parse(result);

			const recovery = retrospectiveRecovery(parsed);
			expect(recovery.action).toBe('write_retro');
			expect(Object.keys(recovery.args ?? {})).toEqual(['phase']);
		});
	});
});
