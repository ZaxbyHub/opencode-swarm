import { describe, expect, test } from 'bun:test';
import { extname } from 'node:path';
import { LANGUAGE_REGISTRY } from '../../../src/lang/profiles';
import {
	getLanguageForExtension,
	isSupportedFile,
} from '../../../src/lang/registry';

/**
 * RECURRENCE GUARDRAIL — issue #1529, Phase 4.2 (sub-class of RC-11).
 *
 * Defect class: `src/lang/profiles.ts` declares the extensions a language
 * profile owns, while `src/lang/registry.ts` independently declares the
 * extensions `getParserForFile` / `isSupportedFile` will accept. Nothing tied
 * the two together, so a profile could claim an extension the registry did not
 * recognise — a file that the graph builder happily walks but that the parser
 * registry reports as unsupported.
 *
 * #1529 found the `.csx` instance. The Phase 4.2 sweep of this class then found
 * three more that were NOT part of the reported issue: `.pyw` (python),
 * `.rake` and `.gemspec` (ruby). All four are fixed; this test closes the class
 * so a fifth cannot be introduced silently.
 *
 * The assertion is deliberately BEHAVIORAL rather than an id-level set
 * comparison, because two legitimate patterns would make a naive parity check
 * fail:
 *   - a profile extension may be served by a DIFFERENT registry id
 *     (`.tsx` -> id 'tsx'; `.c`/`.h` -> id 'c'), and
 *   - a compound extension reduces under `extname` (`.blade.php` -> `.php`),
 *     so registering it verbatim would be unreachable/dead code.
 * What actually matters is: can a file with this extension be resolved at all?
 */
describe('profile/registry extension parity (issue #1529 recurrence guardrail)', () => {
	const profiles = LANGUAGE_REGISTRY.getAll().filter((p) => !p.parserOnly);

	test('registry covers every extension declared by a non-parserOnly profile', () => {
		const unresolvable: string[] = [];
		for (const profile of profiles) {
			for (const ext of profile.extensions) {
				// Mirror the real lookup: registry.ts keys off extname(), so a
				// compound extension must be checked in its reduced form.
				const effective = extname(`sample${ext}`).toLowerCase() || ext;
				if (!getLanguageForExtension(effective)) {
					unresolvable.push(`${profile.id}:${ext} (extname -> ${effective})`);
				}
			}
		}
		expect(
			unresolvable,
			'These extensions are declared by a language profile but are not resolvable ' +
				'through src/lang/registry.ts, so getParserForFile()/isSupportedFile() ' +
				'reject files the graph builder accepts. Add the extension to the matching ' +
				'languageDefinitions entry in src/lang/registry.ts (issue #1529, RC-11).',
		).toEqual([]);
	});

	test('isSupportedFile agrees for a representative file of every profile extension', () => {
		const rejected: string[] = [];
		for (const profile of profiles) {
			for (const ext of profile.extensions) {
				if (!isSupportedFile(`sample${ext}`)) {
					rejected.push(`${profile.id}:${ext}`);
				}
			}
		}
		expect(rejected).toEqual([]);
	});

	test('the four extensions fixed by issue #1529 resolve', () => {
		// .csx was the reported instance; the other three were found by the
		// Phase 4.2 sweep of the same class.
		for (const file of [
			'Script.csx',
			'module.pyw',
			'Rakefile.rake',
			'gem.gemspec',
		]) {
			expect(isSupportedFile(file), `${file} should be supported`).toBe(true);
		}
	});
});
