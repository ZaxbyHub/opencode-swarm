/**
 * Tests for auto-proceed inclusion in SWARM_COMMAND_TOOL_COMMANDS and
 * SWARM_COMMAND_TOOL_ALLOWLIST (Phase 1 auto-proceed changes).
 *
 * Covers:
 * - 'auto-proceed' is in SWARM_COMMAND_TOOL_COMMANDS
 * - 'auto-proceed' is in SWARM_COMMAND_TOOL_ALLOWLIST
 */

import { describe, expect, test } from 'bun:test';
import {
	HUMAN_ONLY_SWARM_COMMANDS,
	SWARM_COMMAND_TOOL_ALLOWLIST,
	SWARM_COMMAND_TOOL_COMMANDS,
} from '../../../src/commands/tool-policy';

describe('SWARM_COMMAND_TOOL_COMMANDS includes auto-proceed', () => {
	test("'auto-proceed' is present in SWARM_COMMAND_TOOL_COMMANDS", () => {
		expect(
			(SWARM_COMMAND_TOOL_COMMANDS as readonly string[]).includes(
				'auto-proceed',
			),
		).toBe(true);
	});
});

describe('SWARM_COMMAND_TOOL_ALLOWLIST includes auto-proceed', () => {
	test("'auto-proceed' is present in SWARM_COMMAND_TOOL_ALLOWLIST", () => {
		expect(SWARM_COMMAND_TOOL_ALLOWLIST.has('auto-proceed')).toBe(true);
	});
});

describe('auto-proceed is consistently present in both lists', () => {
	test('auto-proceed appears in both SWARM_COMMAND_TOOL_COMMANDS and SWARM_COMMAND_TOOL_ALLOWLIST', () => {
		const inCommands = (
			SWARM_COMMAND_TOOL_COMMANDS as readonly string[]
		).includes('auto-proceed');
		const inAllowlist = SWARM_COMMAND_TOOL_ALLOWLIST.has('auto-proceed');
		expect(inCommands).toBe(true);
		expect(inAllowlist).toBe(true);
	});
});

describe('state-changing consolidation command policy', () => {
	test('consolidate is explicitly excluded from swarm_command allowlist', () => {
		expect(SWARM_COMMAND_TOOL_ALLOWLIST.has('consolidate')).toBe(false);
		expect(
			(SWARM_COMMAND_TOOL_COMMANDS as readonly string[]).includes(
				'consolidate',
			),
		).toBe(false);
		expect(HUMAN_ONLY_SWARM_COMMANDS.has('consolidate')).toBe(true);
	});
});
