/**
 * Epic v2 seam in `buildParallelExecutionGuidance`: while an epic is open
 * the Epic banner + `epic_next_wave` own dispatch guidance, so the
 * whole-phase parallel/serial advisory is suppressed. With no epic the
 * guidance text is unchanged, and the probe is only consulted after the
 * existing `parallelization disabled ⇒ null` early return.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import { _internals } from '../../../src/hooks/delegation-gate';
import { ensureAgentSession, resetSwarmState } from '../../../src/state';
import { openEpicForTest } from '../../helpers/epic-lifecycle';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

const realProbe = _internals.isEpicOpenForProject;
let dir: string;

function writePlan(parallel: boolean): void {
	const task = (id: string) => ({
		id,
		phase: 1,
		status: 'pending',
		size: 'small',
		description: `Task ${id}`,
		depends: [],
		files_touched: [`src/${id}.ts`],
	});
	fs.writeFileSync(
		path.join(dir, '.swarm', 'plan.json'),
		JSON.stringify({
			schema_version: '1.0.0',
			title: 'Guidance Plan',
			swarm: 'guidance-swarm',
			current_phase: 1,
			migration_status: 'native',
			execution_profile: {
				parallelization_enabled: parallel,
				max_concurrent_tasks: 4,
			},
			phases: [
				{
					id: 1,
					name: 'Phase 1',
					status: 'in_progress',
					tasks: [task('1.1'), task('1.2')],
				},
			],
		}),
	);
}

async function guidance(): Promise<string | null> {
	const session = ensureAgentSession('ses_guidance', 'architect', dir);
	return _internals.buildParallelExecutionGuidance(
		dir,
		'ses_guidance',
		session,
	);
}

beforeEach(() => {
	resetSwarmState();
	dir = canonicalMkdtemp('epic-guidance-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
	fs.mkdirSync(path.join(dir, '.opencode'), { recursive: true });
	fs.writeFileSync(
		path.join(dir, '.opencode', 'opencode-swarm.json'),
		JSON.stringify({
			epic: { mode: { enabled: true } },
		}),
	);
});

afterEach(() => {
	_internals.isEpicOpenForProject = realProbe;
	resetSwarmState();
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('parallel guidance × open epic', () => {
	test('no epic ⇒ the standard guidance is produced', async () => {
		writePlan(true);
		const text = await guidance();
		expect(text).not.toBeNull();
	});

	test('epic open (real lifecycle) ⇒ guidance suppressed', async () => {
		writePlan(true);
		const before = await guidance();
		openEpicForTest(dir);
		expect(await guidance()).toBeNull();
		expect(before).not.toBeNull();
	});

	test('parallelization disabled ⇒ null before the probe is consulted', async () => {
		writePlan(false);
		let probes = 0;
		_internals.isEpicOpenForProject = () => {
			probes += 1;
			return true;
		};
		expect(await guidance()).toBeNull();
		expect(probes).toBe(0);
	});
});
