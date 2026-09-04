/**
 * Decision-drift visibility in /swarm status (issue #2493 W9b).
 *
 * Covers getStatusData populating `decisionDrift` (staleCount /
 * contradictionCount / lastDecisionAt) via analyzeDecisionDrift over
 * .swarm/context.md, formatStatusMarkdown rendering the
 * **Decision drift detected** line, the no-plan fallback in
 * handleStatusCommand, and the `decision_drift_detection` config gate.
 *
 * Env-isolated (createIsolatedTestEnv) because the gate reads
 * loadPluginConfig(), which consults the user config dir — without
 * isolation a developer config could flip the gate under the test.
 */

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	formatStatusMarkdown,
	getStatusData,
	handleStatusCommand,
} from '../../../src/services/status-service';
import { createIsolatedTestEnv } from '../../helpers/isolated-test-env';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let tmpDir: string;
let cleanupEnv: (() => void) | null = null;

beforeAll(() => {
	cleanupEnv = createIsolatedTestEnv().cleanup;
});

afterAll(() => {
	cleanupEnv?.();
	cleanupEnv = null;
});

beforeEach(() => {
	tmpDir = canonicalMkdtemp('status-decision-drift-');
	fs.mkdirSync(path.join(tmpDir, '.swarm'), { recursive: true });
});

afterEach(() => {
	try {
		fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5 });
	} catch {
		// best effort (Windows EBUSY tolerance)
	}
});

function writePlanCurrentPhase3(): void {
	fs.writeFileSync(
		path.join(tmpDir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Test Plan',
			swarm: 'test',
			current_phase: 3,
			phases: [
				{ id: 1, name: 'Phase 1', status: 'complete', tasks: [] },
				{ id: 2, name: 'Phase 2', status: 'complete', tasks: [] },
				{ id: 3, name: 'Phase 3', status: 'in_progress', tasks: [] },
			],
		}),
	);
}

/** Two Phase-1 "use vs do not use" decisions under a Phase-3 plan → 2 stale + ≥1 contradiction. */
const DRIFT_CONTEXT = [
	'## Phase 1',
	'',
	'## Decisions',
	'- Use Redis for caching Phase 1 [2026-01-10T08:00:00Z]',
	'- Do not use Redis for caching Phase 1 [2026-02-20T10:15:00Z]',
].join('\n');

/** One confirmed, current-phase decision → no drift. */
const CLEAN_CONTEXT = [
	'## Decisions',
	'- ✅ Use PostgreSQL for the primary datastore [confirmed]',
].join('\n');

describe('getStatusData decisionDrift (#2493 W9b)', () => {
	test('populates counts + lastDecisionAt for stale/contradictory decisions (flag defaults on)', async () => {
		writePlanCurrentPhase3();
		fs.writeFileSync(path.join(tmpDir, '.swarm', 'context.md'), DRIFT_CONTEXT);
		const data = await getStatusData(tmpDir, {});
		expect(data.hasPlan).toBe(true);
		expect(data.decisionDrift).toBeDefined();
		expect(data.decisionDrift?.staleCount).toBe(2);
		expect(data.decisionDrift?.contradictionCount).toBeGreaterThanOrEqual(1);
		expect(data.decisionDrift?.lastDecisionAt).toBe('2026-02-20T10:15:00Z');
	});

	test('renders the drift line in formatStatusMarkdown', async () => {
		writePlanCurrentPhase3();
		fs.writeFileSync(path.join(tmpDir, '.swarm', 'context.md'), DRIFT_CONTEXT);
		const md = formatStatusMarkdown(await getStatusData(tmpDir, {}));
		expect(md).toContain('**Decision drift detected**');
		expect(md).toContain('2 stale');
		expect(md).toContain('contradictory');
		expect(md).toContain('last decision 2026-02-20T10:15:00Z');
		expect(md).toContain('.swarm/context.md');
	});

	test('clean context → decisionDrift absent and no drift line', async () => {
		writePlanCurrentPhase3();
		fs.writeFileSync(path.join(tmpDir, '.swarm', 'context.md'), CLEAN_CONTEXT);
		const data = await getStatusData(tmpDir, {});
		expect(data.decisionDrift).toBeUndefined();
		expect(formatStatusMarkdown(data)).not.toContain(
			'**Decision drift detected**',
		);
	});

	test('decision_drift_detection: false disables the computation', async () => {
		fs.mkdirSync(path.join(tmpDir, '.opencode'), { recursive: true });
		fs.writeFileSync(
			path.join(tmpDir, '.opencode', 'opencode-swarm.json'),
			JSON.stringify({
				automation: { capabilities: { decision_drift_detection: false } },
			}),
		);
		fs.writeFileSync(path.join(tmpDir, '.swarm', 'context.md'), DRIFT_CONTEXT);
		const data = await getStatusData(tmpDir, {});
		expect(data.decisionDrift).toBeUndefined();
		expect(formatStatusMarkdown(data)).not.toContain(
			'**Decision drift detected**',
		);
	});

	test('no context.md → decisionDrift absent (fail-open)', async () => {
		writePlanCurrentPhase3();
		const data = await getStatusData(tmpDir, {});
		expect(data.decisionDrift).toBeUndefined();
	});
});

describe('handleStatusCommand no-plan fallback (#2493 W9b)', () => {
	test('renders the drift line even without an active plan', async () => {
		fs.writeFileSync(path.join(tmpDir, '.swarm', 'context.md'), DRIFT_CONTEXT);
		const md = await handleStatusCommand(tmpDir, {});
		expect(md).toContain('No active swarm plan found.');
		expect(md).toContain('**Decision drift detected**');
		expect(md).toContain('2 stale');
	});

	test('clean context keeps the no-plan output byte-identical', async () => {
		fs.writeFileSync(path.join(tmpDir, '.swarm', 'context.md'), CLEAN_CONTEXT);
		const md = await handleStatusCommand(tmpDir, {});
		expect(md).toBe('No active swarm plan found.');
	});
});
