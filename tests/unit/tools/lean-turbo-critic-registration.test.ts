/**
 * Production reachability guard for the lean_turbo_critic tool
 * (issue #2470 / #2007 acceptance criterion: "a guardrail fails if the
 * gate's verdict sources lose their producer again").
 *
 * Asserts the tool is present on every registration surface and that the
 * plugin tool object exposes an executable lean_turbo_critic — so removing
 * any single registration line fails this test.
 */

import { describe, expect, test } from 'bun:test';
import {
	TURBO_AGENT_TOOL_MAP,
	TURBO_TOOL_NAMES,
} from '../../../src/config/constants';
import * as toolIndex from '../../../src/tools/index';
import { lean_turbo_critic } from '../../../src/tools/lean-turbo-critic';
import { TOOL_MANIFEST } from '../../../src/tools/manifest';
import { TOOL_METADATA, TOOL_NAME_SET } from '../../../src/tools/tool-metadata';

describe('lean_turbo_critic registration (issue #2470/#2007 reachability guard)', () => {
	test('TOOL_METADATA entry exists with description and agents', () => {
		expect(TOOL_METADATA.lean_turbo_critic).toBeDefined();
		expect(TOOL_METADATA.lean_turbo_critic.description.length).toBeGreaterThan(
			0,
		);
		expect(Array.isArray(TOOL_METADATA.lean_turbo_critic.agents)).toBe(true);
	});

	test('derived TOOL_NAME_SET contains lean_turbo_critic', () => {
		expect(TOOL_NAME_SET.has('lean_turbo_critic')).toBe(true);
	});

	test('TOOL_MANIFEST has an executable handler thunk', () => {
		const handler = TOOL_MANIFEST.lean_turbo_critic;
		expect(typeof handler).toBe('function');
		const definition = handler();
		expect(typeof definition.execute).toBe('function');
	});

	test('the barrel export re-exports the tool object', () => {
		expect((toolIndex as Record<string, unknown>).lean_turbo_critic).toBe(
			lean_turbo_critic,
		);
	});

	test('TURBO_TOOL_NAMES includes the critic, so the architect tool map derives it', () => {
		expect([...TURBO_TOOL_NAMES]).toContain('lean_turbo_critic');
		expect(TURBO_AGENT_TOOL_MAP.architect).toContain('lean_turbo_critic');
	});

	test('the standalone tool object is executable (plugin-registration wiring model)', () => {
		expect(typeof lean_turbo_critic.execute).toBe('function');
	});
});
