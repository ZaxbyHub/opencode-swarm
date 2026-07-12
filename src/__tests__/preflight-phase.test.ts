import {
	afterEach,
	beforeEach,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';

// Mock loadPlan. handlePreflightCommand imports `loadPlan` directly (there is no
// _internals seam for it), so a module mock is the only way to control it.
const mockLoadPlan = mock<() => Promise<{ current_phase?: number } | null>>();

// Mock the plan manager module BEFORE importing preflight-service so the direct
// `loadPlan` import inside handlePreflightCommand resolves to our mock.
mock.module('../plan/manager', () => ({
	loadPlan: mockLoadPlan,
}));

// Import after mocking. We intercept runPreflight through the `_internals` DI
// seam (see below) rather than mock.module: handlePreflightCommand invokes
// `_internals.runPreflight(...)`, so replacing the module-level export would NOT
// intercept the call — the real runPreflight would run and call loadPlan a
// second time via its evidence check, which is exactly the drift this test hit.
import {
	_internals,
	handlePreflightCommand,
	type PreflightReport,
} from '../services/preflight-service';

function makeReport(phase: number): PreflightReport {
	return {
		id: 'test-report',
		timestamp: Date.now(),
		phase,
		overall: 'pass',
		checks: [],
		totalDurationMs: 10,
		message: 'test',
	};
}

describe('handlePreflightCommand phase derivation', () => {
	let tempDir: string;
	let runPreflightSpy: ReturnType<
		typeof spyOn<typeof _internals, 'runPreflight'>
	>;

	beforeEach(async () => {
		tempDir = path.join(
			tmpdir(),
			'preflight-phase-test-' +
				Date.now() +
				'-' +
				Math.random().toString(36).slice(2),
		);
		// Create .swarm directory to pass validateDirectoryPath check in runPreflight
		await fs.promises.mkdir(path.join(tempDir, '.swarm'), { recursive: true });

		// Reset the loadPlan mock and install a fresh runPreflight spy per test.
		mockLoadPlan.mockReset();
		runPreflightSpy = spyOn(_internals, 'runPreflight');
	});

	afterEach(async () => {
		runPreflightSpy.mockRestore();
		try {
			await fs.promises.rm(tempDir, { force: true, recursive: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	test('runPreflight is called with phase 3 when loadPlan returns plan with current_phase = 3', async () => {
		mockLoadPlan.mockResolvedValueOnce({ current_phase: 3 });
		runPreflightSpy.mockResolvedValueOnce(makeReport(3));

		await handlePreflightCommand(tempDir, []);

		expect(mockLoadPlan).toHaveBeenCalledTimes(1);
		expect(runPreflightSpy).toHaveBeenCalledTimes(1);
		expect(runPreflightSpy).toHaveBeenCalledWith(tempDir, 3);
	});

	test('runPreflight is called with phase 1 when loadPlan returns null', async () => {
		mockLoadPlan.mockResolvedValueOnce(null);
		runPreflightSpy.mockResolvedValueOnce(makeReport(1));

		await handlePreflightCommand(tempDir, []);

		expect(mockLoadPlan).toHaveBeenCalledTimes(1);
		expect(runPreflightSpy).toHaveBeenCalledTimes(1);
		expect(runPreflightSpy).toHaveBeenCalledWith(tempDir, 1);
	});

	test('runPreflight is called with phase 1 when loadPlan returns plan with current_phase = undefined', async () => {
		mockLoadPlan.mockResolvedValueOnce({});
		runPreflightSpy.mockResolvedValueOnce(makeReport(1));

		await handlePreflightCommand(tempDir, []);

		expect(mockLoadPlan).toHaveBeenCalledTimes(1);
		expect(runPreflightSpy).toHaveBeenCalledTimes(1);
		expect(runPreflightSpy).toHaveBeenCalledWith(tempDir, 1);
	});
});
