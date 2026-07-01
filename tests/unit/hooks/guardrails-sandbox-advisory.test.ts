import { afterEach, describe, expect, it, mock } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as realExecutor from '../../../src/sandbox/executor';

const warnMock = mock((..._args: unknown[]) => {});
const originalConsoleWarn = console.warn;
const getExecutorMock = mock(async () => ({
	isAvailable: () => false,
	mechanism: 'none',
}));

mock.module('../../../src/sandbox/executor', () => ({
	...realExecutor,
	getExecutor: getExecutorMock,
}));

const { createGuardrailsHooks } = await import('../../../src/hooks/guardrails');

async function waitForFile(filePath: string, timeoutMs = 1_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (fs.existsSync(filePath)) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

describe('guardrails sandbox advisory', () => {
	const originalDebug = process.env.OPENCODE_SWARM_DEBUG;

	afterEach(() => {
		warnMock.mockClear();
		getExecutorMock.mockClear();
		getExecutorMock.mockImplementation(async () => ({
			isAvailable: () => false,
			mechanism: 'none',
		}));
		if (originalDebug === undefined) {
			delete process.env.OPENCODE_SWARM_DEBUG;
		} else {
			process.env.OPENCODE_SWARM_DEBUG = originalDebug;
		}
		console.warn = originalConsoleWarn;
		warnMock.mockReset();
	});

	it('emits a one-time warning and writes a sandbox skip audit entry when the executor is unavailable', async () => {
		const tempDir = fs.realpathSync(
			fs.mkdtempSync(path.join(os.tmpdir(), 'guardrails-sandbox-advisory-')),
		);

		process.env.OPENCODE_SWARM_DEBUG = '1';
		console.warn = warnMock as typeof console.warn;

		try {
			const hooks = createGuardrailsHooks(tempDir, undefined, {
				enabled: true,
				max_tool_calls: 200,
				max_duration_minutes: 30,
				idle_timeout_minutes: 60,
				max_repetitions: 10,
				max_consecutive_errors: 5,
				warning_threshold: 0.75,
				shell_audit_log: true,
				profiles: undefined,
			});

			await hooks.toolBefore(
				{ tool: 'bash', sessionID: 'sandbox-session', callID: 'call-1' },
				{ args: { command: 'echo hi' } },
			);

			expect(warnMock).toHaveBeenCalledTimes(1);

			const auditPath = path.join(
				tempDir,
				'.swarm',
				'session',
				'shell-audit.jsonl',
			);
			await waitForFile(auditPath);
			expect(fs.existsSync(auditPath)).toBe(true);
			const contents = fs.readFileSync(auditPath, 'utf-8');
			expect(contents).toContain('"type":"sandbox_skip"');
			expect(contents).toContain('"skipReason":"executor not available"');
		} finally {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
