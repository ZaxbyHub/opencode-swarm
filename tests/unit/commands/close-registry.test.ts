import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { COMMAND_REGISTRY } from '../../../src/commands/registry.js';

describe('close/finalize registry wiring', () => {
	it('advertises --skill-review on finalize and the deprecated close alias', () => {
		expect(COMMAND_REGISTRY.finalize.args).toContain('--skill-review');
		expect(COMMAND_REGISTRY.close.args).toContain('--skill-review');
	});

	it('passes sessionID through finalize and close handlers', () => {
		const source = readFileSync('src/commands/registry.ts', 'utf-8');

		const closeHandlerCalls =
			source.match(
				/handleCloseCommand\(ctx\.directory,\s*ctx\.args,\s*\{\s*sessionID: ctx\.sessionID,\s*\}\)/g,
			) ?? [];

		expect(closeHandlerCalls.length).toBeGreaterThanOrEqual(2);
	});
});
