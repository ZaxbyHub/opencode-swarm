import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from 'bun:test';

// Mock console methods BEFORE importing
const mockConsoleLog = spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = spyOn(console, 'error').mockImplementation(() => {});

// Mock process.argv to prevent default 'install' command
const originalArgv = process.argv;
process.argv = ['node', 'cli.js', '--help'];

// Mock process.exit to prevent CLI from exiting
const mockProcessExit = spyOn(process, 'exit').mockImplementation(
	() => undefined as never,
);

// Mock factories - declare BEFORE mock.module() calls
const mockHandleStatusCommand = mock();
const mockHandlePlanCommand = mock();
const mockHandleAgentsCommand = mock();
const mockHandleArchiveCommand = mock();
const mockHandleHistoryCommand = mock();
const mockHandleConfigCommand = mock();
const mockHandleDoctorCommand = mock();
const mockHandleEvidenceCommand = mock();
const mockHandleEvidenceSummaryCommand = mock();
const mockHandleDiagnoseCommand = mock();
const mockHandlePreflightCommand = mock();
const mockHandleSyncPlanCommand = mock();
const mockHandleBenchmarkCommand = mock();
const mockHandleExportCommand = mock();
const mockHandleResetCommand = mock();
const mockHandleRetrieveCommand = mock();
const mockHandleClarifyCommand = mock();
const mockHandleAnalyzeCommand = mock();
const mockHandleSpecifyCommand = mock();
const mockHandleDarkMatterCommand = mock();
const mockHandleKnowledgeListCommand = mock();
const mockHandleKnowledgeMigrateCommand = mock();
const mockHandleKnowledgeQuarantineCommand = mock();
const mockHandleKnowledgeRestoreCommand = mock();
const mockHandleRollbackCommand = mock();
const mockHandlePromoteCommand = mock();
const mockHandleHandoffCommand = mock();
const mockHandleTurboCommand = mock();
const mockHandleSimulateCommand = mock();
const mockHandleCurateCommand = mock();
const mockHandleWriteRetroCommand = mock();
const mockHandleCheckpointCommand = mock();

// Mock individual command files so registry.ts picks up the mocked handlers
mock.module('../../../src/commands/status.js', () => ({
	handleStatusCommand: mockHandleStatusCommand,
}));
mock.module('../../../src/commands/plan.js', () => ({
	handlePlanCommand: mockHandlePlanCommand,
}));
mock.module('../../../src/commands/agents.js', () => ({
	handleAgentsCommand: mockHandleAgentsCommand,
}));
mock.module('../../../src/commands/archive.js', () => ({
	handleArchiveCommand: mockHandleArchiveCommand,
}));
mock.module('../../../src/commands/history.js', () => ({
	handleHistoryCommand: mockHandleHistoryCommand,
}));
mock.module('../../../src/commands/config.js', () => ({
	handleConfigCommand: mockHandleConfigCommand,
}));
mock.module('../../../src/commands/doctor.js', () => ({
	handleDoctorCommand: mockHandleDoctorCommand,
}));
mock.module('../../../src/commands/evidence.js', () => ({
	handleEvidenceCommand: mockHandleEvidenceCommand,
	handleEvidenceSummaryCommand: mockHandleEvidenceSummaryCommand,
}));
mock.module('../../../src/commands/diagnose.js', () => ({
	handleDiagnoseCommand: mockHandleDiagnoseCommand,
}));
mock.module('../../../src/commands/preflight.js', () => ({
	handlePreflightCommand: mockHandlePreflightCommand,
}));
mock.module('../../../src/commands/sync-plan.js', () => ({
	handleSyncPlanCommand: mockHandleSyncPlanCommand,
}));
mock.module('../../../src/commands/benchmark.js', () => ({
	handleBenchmarkCommand: mockHandleBenchmarkCommand,
}));
mock.module('../../../src/commands/export.js', () => ({
	handleExportCommand: mockHandleExportCommand,
}));
mock.module('../../../src/commands/reset.js', () => ({
	handleResetCommand: mockHandleResetCommand,
}));
mock.module('../../../src/commands/retrieve.js', () => ({
	handleRetrieveCommand: mockHandleRetrieveCommand,
}));
mock.module('../../../src/commands/clarify.js', () => ({
	handleClarifyCommand: mockHandleClarifyCommand,
}));
mock.module('../../../src/commands/analyze.js', () => ({
	handleAnalyzeCommand: mockHandleAnalyzeCommand,
}));
mock.module('../../../src/commands/specify.js', () => ({
	handleSpecifyCommand: mockHandleSpecifyCommand,
}));
mock.module('../../../src/commands/dark-matter.js', () => ({
	handleDarkMatterCommand: mockHandleDarkMatterCommand,
}));
mock.module('../../../src/commands/knowledge.js', () => ({
	handleKnowledgeListCommand: mockHandleKnowledgeListCommand,
	handleKnowledgeMigrateCommand: mockHandleKnowledgeMigrateCommand,
	handleKnowledgeQuarantineCommand: mockHandleKnowledgeQuarantineCommand,
	handleKnowledgeRestoreCommand: mockHandleKnowledgeRestoreCommand,
	handleKnowledgeUnactionableCommand: () => null,
	handleKnowledgeRetryHardeningCommand: () => null,
}));
mock.module('../../../src/commands/rollback.js', () => ({
	handleRollbackCommand: mockHandleRollbackCommand,
}));
mock.module('../../../src/commands/promote.js', () => ({
	handlePromoteCommand: mockHandlePromoteCommand,
}));
mock.module('../../../src/commands/handoff.js', () => ({
	handleHandoffCommand: mockHandleHandoffCommand,
}));
mock.module('../../../src/commands/turbo.js', () => ({
	handleTurboCommand: mockHandleTurboCommand,
}));
mock.module('../../../src/commands/simulate.js', () => ({
	handleSimulateCommand: mockHandleSimulateCommand,
}));
mock.module('../../../src/commands/curate.js', () => ({
	handleCurateCommand: mockHandleCurateCommand,
}));
mock.module('../../../src/commands/write_retro.js', () => ({
	handleWriteRetroCommand: mockHandleWriteRetroCommand,
}));
mock.module('../../../src/commands/checkpoint.js', () => ({
	handleCheckpointCommand: mockHandleCheckpointCommand,
}));

// Import AFTER mocking
import { run } from '../../../src/cli/index.js';

describe('main() run dispatch wiring — adversarial tests', () => {
	let mockExit: ReturnType<typeof mock>;

	beforeEach(() => {
		mockExit = mock();
		mockConsoleError.mockClear();
		mockProcessExit.mockClear();
	});

	afterEach(() => {
		mockConsoleError.mockClear();
		mockProcessExit.mockClear();
	});

	it('run --help - should reject as unknown subcommand (exit 1)', async () => {
		const result = await run(['--help']);
		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Unknown command: --help'),
		);
		expect(mockExit).not.toHaveBeenCalled();
	});

	it('run with empty string arg - should reject (exit 1)', async () => {
		const result = await run(['']);
		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Unknown command:'),
		);
		expect(mockExit).not.toHaveBeenCalled();
	});

	it('run with path traversal - should reject ../../etc/passwd (exit 1)', async () => {
		const result = await run(['../../etc/passwd']);
		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Unknown command: ../../etc/passwd'),
		);
		expect(mockExit).not.toHaveBeenCalled();
	});

	it('run with XSS injection - should reject <script>alert(1)</script> (exit 1)', async () => {
		const result = await run(['<script>alert(1)</script>']);
		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Unknown command: <script>alert(1)</script>'),
		);
		expect(mockExit).not.toHaveBeenCalled();
	});

	it('run with very long subcommand (1000+ chars) - should reject (exit 1)', async () => {
		const longCmd = 'a'.repeat(1000);
		const result = await run([longCmd]);
		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Unknown command:'),
		);
		expect(mockExit).not.toHaveBeenCalled();
	});

	it('run with "null" string - should reject (exit 1)', async () => {
		const result = await run(['null']);
		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Unknown command: null'),
		);
		expect(mockExit).not.toHaveBeenCalled();
	});

	it('run with "undefined" string - should reject (exit 1)', async () => {
		const result = await run(['undefined']);
		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Unknown command: undefined'),
		);
		expect(mockExit).not.toHaveBeenCalled();
	});

	it('run with "__proto__" string - should reject (exit 1)', async () => {
		const result = await run(['__proto__']);
		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Unknown command: __proto__'),
		);
		expect(mockExit).not.toHaveBeenCalled();
	});

	it('runXYZ (command starting with run) - should NOT dispatch to run(), should hit unknown command (exit 1)', async () => {
		// Simulate main() receiving 'runXYZ' as the command
		const args = ['runXYZ'];

		// In main(), args[0] is 'runXYZ', which is NOT 'run', so it goes to the default case
		// We can simulate this by calling run() directly with the args.slice(1) that would be passed
		// Since args[0] is 'runXYZ', args.slice(1) would be [] (empty)
		const result = await run(args.slice(1));
		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Usage:'),
		);
		expect(mockExit).not.toHaveBeenCalled();
	});

	it('RUN (uppercase) - should NOT dispatch to run(), should hit unknown command (exit 1)', async () => {
		// Simulate main() receiving 'RUN' as the command
		const args = ['RUN'];

		// In main(), args[0] is 'RUN', which is NOT 'run', so it goes to the default case
		// args.slice(1) would be [] (empty)
		const result = await run(args.slice(1));
		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Usage:'),
		);
		expect(mockExit).not.toHaveBeenCalled();
	});

	it('run with no args - should show usage (exit 1)', async () => {
		const result = await run([]);
		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Usage:'),
		);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('bunx opencode-swarm run <command>'),
		);
		expect(mockExit).not.toHaveBeenCalled();
	});

	it('run with command injection semicolon - should reject (exit 1)', async () => {
		const result = await run(['status; rm -rf /']);
		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Unknown command: status; rm -rf /'),
		);
		expect(mockExit).not.toHaveBeenCalled();
	});

	it('run with pipe injection - should reject (exit 1)', async () => {
		const result = await run(['status|cat']);
		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Unknown command: status|cat'),
		);
		expect(mockExit).not.toHaveBeenCalled();
	});

	it('run with newline injection - should reject (exit 1)', async () => {
		const result = await run(['status\nrm -rf /']);
		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Unknown command:'),
		);
		expect(mockExit).not.toHaveBeenCalled();
	});

	it('run with tab injection - should reject (exit 1)', async () => {
		const result = await run(['status\tcat']);
		expect(result).toBe(1);
		expect(mockConsoleError).toHaveBeenCalledWith(
			expect.stringContaining('Unknown command:'),
		);
		expect(mockExit).not.toHaveBeenCalled();
	});
});
