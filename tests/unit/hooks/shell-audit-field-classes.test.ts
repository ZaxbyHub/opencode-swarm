/**
 * Field content-class ratchet for the shell-audit schema (issue #2040
 * requirement 8: "new audit fields declare redaction/content class").
 *
 * Mechanically derives every field of every GuardrailDecisionEntry interface
 * from the SOURCE of src/hooks/guardrails/audit-log.ts (types are erased at
 * runtime, so the ratchet scans the declarations) and asserts:
 *  - the declared field set exactly equals SHELL_AUDIT_FIELD_CLASSES keys
 *    (a NEW field without a content class fails this test)
 *  - a stale class entry for a removed field also fails
 *  - legacy shell entries stay EXACTLY five fields (SC-119)
 *  - commandHash is classified and never part of the legacy shell shape
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
	type GuardrailDecisionEntry,
	SHELL_AUDIT_FIELD_CLASSES,
} from '../../../src/hooks/guardrails/audit-log';

const SOURCE = readFileSync(
	join(
		import.meta.dir,
		'..',
		'..',
		'..',
		'src',
		'hooks',
		'guardrails',
		'audit-log.ts',
	),
	'utf-8',
);

/** Extract the declared field names of a decision interface from source. */
function interfaceFields(name: string): string[] {
	const start = SOURCE.indexOf(`export interface ${name} `);
	expect(start).toBeGreaterThan(-1); // interface must exist
	const bodyStart = SOURCE.indexOf('{', start);
	let depth = 0;
	let bodyEnd = -1;
	for (let i = bodyStart; i < SOURCE.length; i += 1) {
		if (SOURCE[i] === '{') depth += 1;
		if (SOURCE[i] === '}') {
			depth -= 1;
			if (depth === 0) {
				bodyEnd = i;
				break;
			}
		}
	}
	expect(bodyEnd).toBeGreaterThan(bodyStart);
	const body = SOURCE.slice(bodyStart + 1, bodyEnd);
	const fields: string[] = [];
	for (const line of body.split('\n')) {
		const match = line.match(/^\t([A-Za-z_][A-Za-z_0-9]*):/);
		if (match) fields.push(match[1]!);
	}
	return fields;
}

const UNION_INTERFACES = [
	'ShellDecision',
	'FileWriteDecision',
	'ScopeViolationDecision',
	'DestructiveBlockDecision',
	'SandboxWrapDecision',
	'SandboxSkipDecision',
] as const;

/**
 * Fields that appear in PERSISTED lines but not on the in-memory entry
 * interfaces (added at line-shaping time in audit-log.ts). The class map
 * covers everything that can land on disk.
 */
const PERSISTED_ONLY_FIELDS = ['commandHash'] as const;

describe('SHELL_AUDIT_FIELD_CLASSES ratchet (issue #2040 requirement 8)', () => {
	test('every declared decision field has a content class; no stale classes exist', () => {
		const declared = new Set<string>(PERSISTED_ONLY_FIELDS);
		for (const name of UNION_INTERFACES) {
			for (const field of interfaceFields(name)) {
				declared.add(field);
			}
		}
		const classified = new Set(Object.keys(SHELL_AUDIT_FIELD_CLASSES));

		const missing = [...declared].filter((f) => !classified.has(f));
		const stale = [...classified].filter((f) => !declared.has(f));

		expect(missing).toEqual([]); // new field without a declared class
		expect(stale).toEqual([]); // class for a field that no longer exists
	});

	test('legacy shell entries stay EXACTLY five persisted fields (SC-119)', () => {
		// The in-memory interface carries the `type` discriminator; it is
		// stripped at write time, so the PERSISTED shape is the other five.
		const shellFields = interfaceFields('ShellDecision').filter(
			(f) => f !== 'type',
		);
		expect(shellFields.sort()).toEqual(
			['command', 'sessionID', 'agent', 'tool', 'ts'].sort(),
		);
		expect(shellFields).not.toContain('commandHash');
	});

	test('commandHash is classified as content-hash on typed command entries only', () => {
		expect(SHELL_AUDIT_FIELD_CLASSES['commandHash']).toBe('content-hash');
		const typedCommandBearers = [
			'DestructiveBlockDecision',
			'SandboxWrapDecision',
			'SandboxSkipDecision',
		];
		for (const name of typedCommandBearers) {
			expect(interfaceFields(name)).toContain('command');
		}
		// Path-bearing entries do NOT carry commands.
		expect(interfaceFields('FileWriteDecision')).not.toContain('commandHash');
		expect(interfaceFields('ScopeViolationDecision')).not.toContain(
			'commandHash',
		);
	});

	test('every class value is from the closed set', () => {
		const allowed = new Set([
			'timestamp',
			'identifier',
			'decision-type',
			'redacted-command',
			'redacted-path',
			'enum',
			'free-text-redacted',
			'content-hash',
		]);
		for (const cls of Object.values(SHELL_AUDIT_FIELD_CLASSES)) {
			expect(allowed.has(cls)).toBe(true);
		}
	});

	test('the union still discriminates on the six documented types', () => {
		// Compile-time sanity: the union member exists and is constructible.
		const entry: GuardrailDecisionEntry = {
			type: 'sandbox_skip',
			ts: '2026-01-01T00:00:00.000Z',
			sessionID: 's',
			agent: 'a',
			tool: 't',
			command: 'c',
			executorMechanism: 'none',
			skipReason: 'r',
		};
		expect(entry.type).toBe('sandbox_skip');
	});
});
