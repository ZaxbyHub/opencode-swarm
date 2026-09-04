import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { listCoordinationStates } from '../../../../src/db/coordination-store.js';
import { closeAllProjectDbs } from '../../../../src/db/project-db.js';
import {
	emptyPersisted,
	emptySessionState,
	isEpicModeActiveForProject,
	loadEpicSessionState,
	repairStateUnreadable,
	saveEpicSessionState,
} from '../../../../src/turbo/epic/state';
import { canonicalMkdtemp } from '../../../helpers/tmpdir.js';

const COORDINATION_NAMESPACE = 'turbo.epic.session';

let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('epic-state-sqlite-');
	repairStateUnreadable(dir);
});

afterEach(() => {
	repairStateUnreadable(dir);
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('epic state SQLite authority', () => {
	test('saveEpicSessionState stores one coordination row per session and refreshes the projection', () => {
		const state = emptySessionState('sess-epic');
		state.active = true;
		state.enabledAt = '2026-01-01T00:00:00.000Z';

		saveEpicSessionState(dir, state);

		const rows = listCoordinationStates(dir, COORDINATION_NAMESPACE);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.entityKey).toBe('sess-epic');

		const projected = JSON.parse(
			fs.readFileSync(path.join(dir, '.swarm', 'epic-state.json'), 'utf-8'),
		);
		expect(projected.sessions['sess-epic'].active).toBe(true);
	});

	test('legacy import archives the JSON file and project-scope status reads from SQLite afterwards', () => {
		const legacy = emptyPersisted();
		legacy.sessions['legacy-epic'] = {
			sessionID: 'legacy-epic',
			active: true,
			enabledAt: '2026-01-01T00:00:00.000Z',
		};

		fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
		fs.writeFileSync(
			path.join(dir, '.swarm', 'epic-state.json'),
			`${JSON.stringify(legacy, null, 2)}\n`,
			'utf-8',
		);

		expect(loadEpicSessionState(dir, 'legacy-epic')?.active).toBe(true);
		expect(isEpicModeActiveForProject(dir)).toBe(true);
		expect(listCoordinationStates(dir, COORDINATION_NAMESPACE)).toHaveLength(1);
		expect(fs.existsSync(path.join(dir, '.swarm', 'epic-state.json'))).toBe(
			true,
		);
		expect(
			fs.existsSync(path.join(dir, '.swarm', 'epic-state.json.imported')),
		).toBe(true);
	});

	test('repairs a mismatched projection without overwriting the cold archive', () => {
		const state = emptySessionState('archive-collision');
		state.active = true;
		saveEpicSessionState(dir, state);
		const filePath = path.join(dir, '.swarm', 'epic-state.json');
		const archivePath = `${filePath}.imported`;
		fs.writeFileSync(archivePath, 'original archive', 'utf-8');
		fs.writeFileSync(
			filePath,
			`${JSON.stringify(emptyPersisted())}\n`,
			'utf-8',
		);

		expect(loadEpicSessionState(dir, state.sessionID)?.active).toBe(true);
		expect(fs.readFileSync(archivePath, 'utf-8')).toBe('original archive');
		expect(fs.existsSync(`${archivePath}.1`)).toBe(true);
		expect(
			JSON.parse(fs.readFileSync(filePath, 'utf-8')).sessions[state.sessionID],
		).toBeDefined();
	});

	test('saving the same session twice advances revision/generation without duplicating rows', () => {
		const state = emptySessionState('sess-epic');
		state.active = true;
		saveEpicSessionState(dir, state);
		const first = listCoordinationStates(dir, COORDINATION_NAMESPACE)[0];

		state.lastDecision = {
			decidedAt: '2026-01-02T00:00:00.000Z',
			decision: 'promote',
			p: 0.1,
			blockingReasons: [],
		};
		saveEpicSessionState(dir, state);
		const rows = listCoordinationStates(dir, COORDINATION_NAMESPACE);
		const second = rows[0];

		expect(rows).toHaveLength(1);
		expect(second?.revision).toBeGreaterThan(first?.revision ?? 0);
		expect(second?.generation).toBeGreaterThan(first?.generation ?? 0);
		expect(loadEpicSessionState(dir, 'sess-epic')?.lastDecision?.decision).toBe(
			'promote',
		);
	});
});
