import { describe, expect, test } from 'bun:test';
import {
	CLAUDE_CODE_CONFLICTS,
	CONFLICT_MAP,
	type CommandConflict,
	type ConflictSeverity,
	CRITICAL_CONFLICTS,
	HIGH_CONFLICTS,
} from './conflict-registry';

describe('conflict-registry structural tests', () => {
	const requiredFields: (keyof CommandConflict)[] = [
		'swarmCommand',
		'ccCommand',
		'severity',
		'ccBehavior',
		'swarmBehavior',
		'disambiguationNote',
	];

	const validSeverities: ConflictSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM'];

	test('1. CLAUDE_CODE_CONFLICTS has exactly 9 entries', () => {
		expect(CLAUDE_CODE_CONFLICTS.length).toBe(9);
	});

	test('2. All entries have non-empty strings for all required fields', () => {
		for (let i = 0; i < CLAUDE_CODE_CONFLICTS.length; i++) {
			const entry = CLAUDE_CODE_CONFLICTS[i];
			for (const field of requiredFields) {
				const value = entry[field];
				const valid = typeof value === 'string' && value.length > 0;
				expect(valid).toBe(true);
				if (!valid)
					console.warn(
						`Entry ${i} (${entry.swarmCommand}) has empty or missing field: ${field}`,
					);
			}
		}
	});

	test('3. Severity values are valid: exactly CRITICAL, HIGH, or MEDIUM', () => {
		for (const entry of CLAUDE_CODE_CONFLICTS) {
			expect(validSeverities).toContain(entry.severity);
		}
	});

	test('4. CRITICAL_CONFLICTS set contains exactly: show-plan, reset, checkpoint', () => {
		const criticalCommands = ['show-plan', 'reset', 'checkpoint'];
		expect(CRITICAL_CONFLICTS.size).toBe(3);
		for (const cmd of criticalCommands) {
			expect(CRITICAL_CONFLICTS.has(cmd)).toBe(true);
		}
	});

	test('5. HIGH_CONFLICTS set contains exactly: status, agents, config, export, doctor', () => {
		const highCommands = ['status', 'agents', 'config', 'export', 'doctor'];
		expect(HIGH_CONFLICTS.size).toBe(5);
		for (const cmd of highCommands) {
			expect(HIGH_CONFLICTS.has(cmd)).toBe(true);
		}
	});

	test('6. CONFLICT_MAP has size 9', () => {
		expect(CONFLICT_MAP.size).toBe(9);
	});

	test('7. Every swarmCommand in CLAUDE_CODE_CONFLICTS is a key in CONFLICT_MAP', () => {
		for (const entry of CLAUDE_CODE_CONFLICTS) {
			expect(CONFLICT_MAP.has(entry.swarmCommand)).toBe(true);
			const mapEntry = CONFLICT_MAP.get(entry.swarmCommand);
			expect(mapEntry).toBe(entry);
		}
	});

	test('8. CRITICAL_CONFLICTS, HIGH_CONFLICTS, and CONFLICT_MAP are all derived from same source', () => {
		// All commands in CRITICAL_CONFLICTS should have severity CRITICAL in the source
		for (const cmd of CRITICAL_CONFLICTS) {
			const sourceEntry = CLAUDE_CODE_CONFLICTS.find(
				(c) => c.swarmCommand === cmd,
			);
			expect(sourceEntry).toBeDefined();
			expect(sourceEntry!.severity).toBe('CRITICAL');
		}

		// All commands in HIGH_CONFLICTS should have severity HIGH in the source
		for (const cmd of HIGH_CONFLICTS) {
			const sourceEntry = CLAUDE_CODE_CONFLICTS.find(
				(c) => c.swarmCommand === cmd,
			);
			expect(sourceEntry).toBeDefined();
			expect(sourceEntry!.severity).toBe('HIGH');
		}

		// CONFLICT_MAP entries should match source
		for (const entry of CLAUDE_CODE_CONFLICTS) {
			const mapEntry = CONFLICT_MAP.get(entry.swarmCommand);
			expect(mapEntry).toEqual(entry);
		}

		// No overlap between CRITICAL and HIGH
		for (const cmd of CRITICAL_CONFLICTS) {
			expect(HIGH_CONFLICTS.has(cmd)).toBe(false);
		}
	});

	test('9. disambiguationNote values start with either "Use /swarm" or "NEVER invoke"', () => {
		for (const entry of CLAUDE_CODE_CONFLICTS) {
			const note = entry.disambiguationNote;
			const startsCorrectly =
				note.startsWith('Use /swarm') || note.startsWith('NEVER invoke');
			expect(startsCorrectly).toBe(true);
		}
	});
});
