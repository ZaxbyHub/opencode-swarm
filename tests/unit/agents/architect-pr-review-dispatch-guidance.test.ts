import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('architect PR review staged-dispatch guidance', () => {
	test('makes enabled tier-M/L canary and fanout an explicit exception to one-call wave guidance', () => {
		const source = readFileSync(
			join(process.cwd(), 'src/agents/architect.ts'),
			'utf8',
		);

		expect(source).toContain(
			'The explicit exception is an active PR_REVIEW with enabled tier-M/L staged resilience',
		);
		expect(source).toContain(
			'send the singleton canary as one call, then send only its unresolved fanout as a second call',
		);
		expect(source).toContain(
			'each admissible base wave uses one \\`dispatch_lanes_async\\` call',
		);
		expect(source).toContain(
			'one singleton canary call followed by one unresolved-only fanout call',
		);
		expect(source).not.toContain(
			'launch the base lanes with one \\`dispatch_lanes_async\\` call when available',
		);
	});
});
