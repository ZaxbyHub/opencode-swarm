import { describe, expect, test } from 'bun:test';
import { classifyCommand } from '../../../src/security/command-classifier.js';

describe('shared command classifier', () => {
	test('uses most severe compound segment', () => {
		const result = classifyCommand('echo safe && git reset --hard HEAD');
		expect(result.aggregate).toBe('destructive');
		expect(
			result.segments.some((entry) => entry.category === 'destructive'),
		).toBe(true);
	});

	test('classifies find -delete as destructive', () => {
		expect(classifyCommand('find . -delete').aggregate).toBe('destructive');
	});

	test('does not overstate bare mkfs without a typed filesystem suffix', () => {
		expect(classifyCommand('mkfs /dev/sdb').aggregate).toBe('unknown');
		expect(classifyCommand('mkfs.ext4 /dev/sdb').aggregate).toBe(
			'catastrophic',
		);
	});

	test('never treats substitutions or interpreter pipelines as safe', () => {
		expect(classifyCommand('echo $(cat file)').aggregate).toBe('unknown');
		expect(classifyCommand('printf payload | bash').aggregate).toBe('unknown');
	});

	test('normalizes wrappers and quote splicing', () => {
		expect(classifyCommand('bash -c "r""m -rf node_modules"').aggregate).toBe(
			'destructive',
		);
	});

	test('fails unknown on unmatched quotes and oversized commands', () => {
		expect(classifyCommand("echo 'unterminated").aggregate).toBe('unknown');
		expect(classifyCommand(`echo ${'x'.repeat(70_000)}`).aggregate).toBe(
			'unknown',
		);
	});

	test('returns an immutable bounded result without raw-command persistence', () => {
		const result = classifyCommand('git status');
		expect(result.aggregate).toBe('safe');
		expect(result.originalDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(Object.isFrozen(result)).toBe(true);
		expect(Object.isFrozen(result.segments)).toBe(true);
	});
});
