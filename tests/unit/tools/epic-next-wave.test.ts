/**
 * epic_next_wave tool — registration reachability + execute contract
 * (Epic v2 C2). Removing any registration surface (metadata, manifest,
 * barrel, Epic opt-in map) fails this file; the tool takes no arguments and
 * forwards the framework session id to `runEpicNextWave`.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
	AGENT_TOOL_MAP,
	EPIC_AGENT_TOOL_MAP,
} from '../../../src/config/constants';
import { _internals, epic_next_wave } from '../../../src/tools/epic-next-wave';
import * as toolIndex from '../../../src/tools/index';
import { TOOL_MANIFEST } from '../../../src/tools/manifest';
import { TOOL_METADATA, TOOL_NAME_SET } from '../../../src/tools/tool-metadata';

const original = { ..._internals };

afterEach(() => {
	Object.assign(_internals, original);
});

describe('epic_next_wave registration', () => {
	test('metadata, derived names and the Epic opt-in map (architect only)', () => {
		expect(TOOL_METADATA.epic_next_wave.agents).toEqual([]);
		expect(TOOL_NAME_SET.has('epic_next_wave')).toBe(true);
		expect(AGENT_TOOL_MAP.architect).not.toContain('epic_next_wave');
		expect(EPIC_AGENT_TOOL_MAP.architect).toContain('epic_next_wave');
	});

	test('manifest thunk and barrel export resolve to the tool', () => {
		expect(TOOL_MANIFEST.epic_next_wave()).toBe(epic_next_wave);
		expect((toolIndex as Record<string, unknown>).epic_next_wave).toBe(
			epic_next_wave,
		);
	});

	test('takes no arguments', () => {
		expect(Object.keys(epic_next_wave.args)).toEqual([]);
	});
});

describe('epic_next_wave execute', () => {
	test('forwards the directory and session id and returns the JSON result', async () => {
		const calls: Array<[string, string | undefined]> = [];
		_internals.runEpicNextWave = (async (
			dir: string,
			sid: string | undefined,
		) => {
			calls.push([dir, sid]);
			return { status: 'epic-complete', message: 'done' };
		}) as never;
		const raw = await epic_next_wave.execute({}, {
			directory: '/project',
			sessionID: 'ses_arch',
		} as never);
		expect(JSON.parse(String(raw))).toEqual({
			status: 'epic-complete',
			message: 'done',
		});
		expect(calls).toEqual([['/project', 'ses_arch']]);
	});
});
