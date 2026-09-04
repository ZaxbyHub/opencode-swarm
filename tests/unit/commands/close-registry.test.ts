import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
	COMMAND_REGISTRY,
	resolveCommand,
} from '../../../src/commands/registry.js';

describe('close/finalize registry wiring', () => {
	it('advertises --skill-review on finalize and the deprecated close alias', () => {
		expect(COMMAND_REGISTRY.finalize.args).toContain('--skill-review');
		expect(COMMAND_REGISTRY.close.args).toContain('--skill-review');
	});

	it('passes sessionID through finalize and dereferences the close alias', () => {
		const source = readFileSync('src/commands/registry.ts', 'utf-8');

		const closeHandlerCalls =
			source.match(
				/handleCloseCommand\(ctx\.directory,\s*ctx\.args,\s*\{\s*sessionID: ctx\.sessionID,\s*\}\)/g,
			) ?? [];

		// #2493: close is a pure alias — finalize's handler (the single
		// remaining call site above) runs for both spellings, so sessionID
		// still reaches handleCloseCommand through the dereferenced entry.
		expect(closeHandlerCalls.length).toBeGreaterThanOrEqual(1);
		expect(COMMAND_REGISTRY.close.handler).toBeUndefined();
		expect(COMMAND_REGISTRY.close.aliasOf).toBe('finalize');
		const resolved = resolveCommand(['close']);
		expect(typeof resolved?.entry.handler).toBe('function');
		expect(resolved?.entry.handler).toBe(COMMAND_REGISTRY.finalize.handler);
	});
});
