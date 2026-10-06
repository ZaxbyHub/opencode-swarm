/**
 * One-time retirement of Epic v1 session state (`/swarm epic status`):
 * v1 rows deleted, `.swarm/epic-state.json` archived to `.imported`, an
 * advisory when a session was still on — and NEVER an auto-opened epic.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	listCoordinationStates,
	transitionCoordinationState,
} from '../../../src/db/coordination-store';
import { closeAllProjectDbs } from '../../../src/db/project-db';
import {
	describeLegacyEpicMigration,
	LEGACY_EPIC_SESSION_NAMESPACE,
	retireLegacyEpicSessionState,
} from '../../../src/epic/legacy-migration';
import { epicSentinelExists, inspectEpic } from '../../../src/epic/lifecycle';
import { canonicalMkdtemp } from '../../helpers/tmpdir';

let dir: string;

beforeEach(() => {
	dir = canonicalMkdtemp('epic-legacy-');
	fs.mkdirSync(path.join(dir, '.swarm'), { recursive: true });
});

afterEach(() => {
	closeAllProjectDbs();
	fs.rmSync(dir, { recursive: true, force: true });
});

function v1Row(sessionID: string, active: boolean): void {
	transitionCoordinationState(dir, {
		namespace: LEGACY_EPIC_SESSION_NAMESPACE,
		entityKey: sessionID,
		expectedRevision: null,
		generation: 1,
		status: active ? 'active' : 'inactive',
		payload: JSON.stringify({ sessionID, active }),
	});
}

describe('retireLegacyEpicSessionState', () => {
	test('nothing to retire ⇒ empty result, no files, no DB', () => {
		const result = retireLegacyEpicSessionState(dir);
		expect(result).toEqual({
			rowsRemoved: 0,
			activeSessions: 0,
			fileArchivedTo: null,
			errors: [],
		});
		expect(describeLegacyEpicMigration(result)).toEqual([]);
		expect(fs.existsSync(path.join(dir, '.swarm', 'swarm.db'))).toBe(false);
	});

	test('v1 rows + projection are retired once, with an advisory; no epic is opened', () => {
		v1Row('ses_a', true);
		v1Row('ses_b', false);
		fs.writeFileSync(
			path.join(dir, '.swarm', 'epic-state.json'),
			JSON.stringify({
				version: 1,
				sessions: { ses_a: { active: true }, ses_b: { active: false } },
			}),
		);
		const result = retireLegacyEpicSessionState(dir);
		expect(result).toEqual({
			rowsRemoved: 2,
			activeSessions: 1,
			fileArchivedTo: path.join('.swarm', 'epic-state.json.imported'),
			errors: [],
		});
		expect(listCoordinationStates(dir, LEGACY_EPIC_SESSION_NAMESPACE)).toEqual(
			[],
		);
		expect(fs.existsSync(path.join(dir, '.swarm', 'epic-state.json'))).toBe(
			false,
		);
		const lines = describeLegacyEpicMigration(result).join('\n');
		expect(lines).toContain('### Legacy Epic v1 state');
		expect(lines).toContain('Nothing was opened automatically');
		expect(lines).toContain('`/swarm epic start`');
		// Never auto-open.
		expect(epicSentinelExists(dir)).toBe(false);
		expect(inspectEpic(dir).rowKeys).toEqual([]);
		// Idempotent: a second pass finds nothing.
		expect(retireLegacyEpicSessionState(dir).rowsRemoved).toBe(0);
	});

	test('an existing .imported archive is never overwritten', () => {
		const swarm = path.join(dir, '.swarm');
		fs.writeFileSync(path.join(swarm, 'epic-state.json.imported'), 'old');
		fs.writeFileSync(path.join(swarm, 'epic-state.json'), 'not json');
		const result = retireLegacyEpicSessionState(dir);
		expect(result.fileArchivedTo).toBe(
			path.join('.swarm', 'epic-state.json.imported.1'),
		);
		expect(
			fs.readFileSync(path.join(swarm, 'epic-state.json.imported'), 'utf-8'),
		).toBe('old');
		expect(result.activeSessions).toBe(0);
	});
});
