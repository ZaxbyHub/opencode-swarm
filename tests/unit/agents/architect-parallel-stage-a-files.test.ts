/**
 * Parallel Stage A guidance: a pre_check_batch run is credited to the one
 * awaiting task whose planned files contain every checked file, so the
 * architect must pass exactly ONE task's files — never the union of the
 * parallel tasks' files (which matches no single task and credits nothing).
 */
import { describe, expect, test } from 'bun:test';
import { createArchitectAgent } from '../../../src/agents/architect';
import { EXECUTE_PROTOCOL } from './architect-mode-skill-helpers';

describe('parallel Stage A file guidance', () => {
	test('the parallel-mode exception tells the architect to pass one task files', () => {
		const prompt = createArchitectAgent('test-model').config.prompt ?? '';
		const start = prompt.indexOf('Separate parallel-mode exception');
		expect(start).toBeGreaterThan(-1);
		const section = prompt.slice(start, prompt.indexOf('\n', start));
		expect(section).toContain(
			"pass `files` = exactly THAT task's `files_touched`",
		);
		expect(section).toContain('never the union');
	});

	test('the execute protocol step 5i passes this task files_touched', () => {
		const start = EXECUTE_PROTOCOL.indexOf('5i. Run `pre_check_batch`');
		expect(start).toBeGreaterThan(-1);
		const step = EXECUTE_PROTOCOL.slice(
			start,
			EXECUTE_PROTOCOL.indexOf('\n', start),
		);
		expect(step).toContain("`files` = exactly THIS task's `files_touched`");
		expect(step).toContain('never the union');
	});
});
