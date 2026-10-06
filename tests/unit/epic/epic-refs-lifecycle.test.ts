/**
 * Epic v2 C3 — the epic's refs across its lifecycle, on real git
 * repositories:
 *   - `/swarm epic start` writes `refs/swarm/epics/<epicKey>/base` → the
 *     start commit;
 *   - `/swarm epic close` captures every epic ref in the report and then
 *     deletes them, unless `epic.retain_refs: true` (kept, recorded);
 *   - `/swarm close` finalization (`finalizeOpenEpicOnSwarmClose`) deletes
 *     them after its report too;
 *   - `epic.retain_refs` is a strict boolean config key.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { handleEpicCommand } from '../../../src/commands/epic';
import { PluginConfigSchema } from '../../../src/config/schema';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { finalizeOpenEpicOnSwarmClose } from '../../../src/epic/close';
import { epicTaskRef } from '../../../src/epic/markers';
import { freezeClock, type Restore } from '../../helpers/test-clock';
import {
	completeAllTasks,
	git,
	restoreStartInternals,
	type StartedEpic,
	startedGitEpic,
	stubStartGlobals,
} from './epic-branch-fixture';

let epic: StartedEpic;
let started = false;
let restoreClock: Restore | null = null;

function refs(dir: string): string[] {
	return git(dir, ['for-each-ref', '--format=%(refname)', 'refs/swarm'])
		.split('\n')
		.filter((line) => line.length > 0);
}

function priorReport(dir: string): {
	refs: {
		entries: Record<string, string>;
		retained: boolean;
		deleteFailures: string[];
	};
} {
	const reportDir = path.join(dir, '.swarm', 'epic-prior', 'reports');
	const [name] = fs.readdirSync(reportDir);
	return JSON.parse(fs.readFileSync(path.join(reportDir, name), 'utf-8'));
}

async function open(config?: Record<string, unknown>): Promise<void> {
	epic = await startedGitEpic('epic-refs-', config);
	started = true;
	// A task ref as a closed wave would have written it.
	git(epic.dir, [
		'update-ref',
		epicTaskRef(epic.record.epicKey, '1.1'),
		epic.record.git.baseCommit ?? '',
	]);
}

beforeEach(() => {
	restoreClock = freezeClock({ isoNow: '2026-09-01T10:00:00.000Z' });
	stubStartGlobals();
});

afterEach(() => {
	restoreClock?.();
	restoreClock = null;
	restoreStartInternals();
	closeAllProjectDbs();
	if (started) fs.rmSync(epic.dir, { recursive: true, force: true });
	started = false;
});

describe('epic refs lifecycle', () => {
	test('start writes the base ref', async () => {
		await open();
		const prefix = `refs/swarm/epics/${epic.record.epicKey}`;
		expect(git(epic.dir, ['rev-parse', `${prefix}/base`]).trim()).toBe(
			epic.record.git.baseCommit ?? 'missing',
		);
	});

	test('close captures the refs in the report, then deletes them', async () => {
		await open();
		const before = refs(epic.dir).sort();
		expect(before).toHaveLength(2);
		await completeAllTasks(epic.dir);
		const closed = await handleEpicCommand(epic.dir, ['close'], 'ses_refs');
		expect(closed).toContain('Epic refs: 2 deleted');
		expect(refs(epic.dir)).toEqual([]);
		const report = priorReport(epic.dir);
		expect(Object.keys(report.refs.entries).sort()).toEqual(before);
		expect(report.refs).toMatchObject({ retained: false, deleteFailures: [] });
	});

	test('epic.retain_refs: true keeps them (and says so)', async () => {
		await open({
			epic: { mode: { enabled: true }, retain_refs: true },
		});
		await completeAllTasks(epic.dir);
		const closed = await handleEpicCommand(epic.dir, ['close'], 'ses_refs');
		expect(closed).toContain('Epic refs kept (`epic.retain_refs`): 2');
		expect(refs(epic.dir)).toHaveLength(2);
		expect(priorReport(epic.dir).refs.retained).toBe(true);
	});

	test('/swarm close finalization deletes the refs after its report', async () => {
		await open();
		const line = await finalizeOpenEpicOnSwarmClose(epic.dir, {
			epic: { mode: { enabled: true } },
		} as never);
		expect(line).toContain('abandoned-by-swarm-close');
		expect(refs(epic.dir)).toEqual([]);
		expect(Object.keys(priorReport(epic.dir).refs.entries)).toHaveLength(2);
	});
});

describe('epic.retain_refs config', () => {
	test('boolean accepted; anything else rejected by the strict schema', () => {
		const parse = (value: unknown) =>
			PluginConfigSchema.safeParse({
				epic: { mode: { enabled: true }, retain_refs: value },
			});
		expect(parse(true).success).toBe(true);
		expect(parse(false).success).toBe(true);
		expect(parse('yes').success).toBe(false);
	});
});
