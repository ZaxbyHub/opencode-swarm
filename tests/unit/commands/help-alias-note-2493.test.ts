/**
 * `/swarm help <alias>` alias note (#2493 review F-08).
 *
 * resolveCommand returns the DEREFERENCED canonical entry, so detailed help
 * for a pure alias printed the alias key as the title with the canonical
 * command's description/details and no hint they differ. handleHelpCommand
 * now appends an explicit alias note.
 */
import { describe, expect, test } from 'bun:test';
import { handleHelpCommand } from '../../../src/commands/registry';

describe('/swarm help alias note (#2493 review F-08)', () => {
	test('help for a pure alias appends a deprecated-alias note', async () => {
		const out = await handleHelpCommand({
			args: ['plan'],
			directory: process.cwd(),
			sessionID: 's1',
		} as unknown as Parameters<typeof handleHelpCommand>[0]);
		expect(out).toContain('## /swarm plan');
		expect(out).toContain('deprecated alias for `/swarm show-plan`');
	});

	test('help for a canonical command has no alias note', async () => {
		const out = await handleHelpCommand({
			args: ['show-plan'],
			directory: process.cwd(),
			sessionID: 's1',
		} as unknown as Parameters<typeof handleHelpCommand>[0]);
		expect(out).toContain('## /swarm show-plan');
		expect(out.toLowerCase()).not.toContain('deprecated alias');
	});
});
