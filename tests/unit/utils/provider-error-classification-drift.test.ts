/**
 * Issue #1896 (sub-issue 3) recurrence guardrail. The root cause of the missing
 * quota failover was THREE independently-maintained copies of the transient
 * provider-error regex, none of which recognized quota exhaustion. They are now
 * single-sourced in `src/utils/provider-error-classification.ts`.
 *
 * This test structurally prevents the class from returning: it fails if any other
 * source file re-introduces a local transient-provider regex (the signature that
 * had drifted). A new dispatch site that needs classification must import the
 * shared module instead of inventing its own — which also guarantees it inherits
 * the quota class.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';

const SRC_ROOT = path.join(import.meta.dir, '..', '..', '..', 'src');
const SHARED_MODULE = path.join(SRC_ROOT, 'utils', 'provider-error-classification.ts');

// The distinctive shape of the old duplicated regex: a rate-limit / HTTP-code
// alternation. Matching this in a source literal means a local copy was reborn.
const LOCAL_TRANSIENT_REGEX_SIGNATURE =
	/rate\.\?limit\|429\|500\|502\|503\|504\|529/;

function collectTsFiles(dir: string, out: string[]): void {
	for (const entry of readdirSync(dir)) {
		const full = path.join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			collectTsFiles(full, out);
		} else if (
			entry.endsWith('.ts') &&
			!entry.endsWith('.test.ts') &&
			!entry.endsWith('.d.ts')
		) {
			out.push(full);
		}
	}
}

describe('provider-error classifier is single-sourced (#1896 drift guardrail)', () => {
	it('no src file other than the shared module defines a local transient-provider regex', () => {
		const files: string[] = [];
		collectTsFiles(SRC_ROOT, files);
		const offenders = files.filter((file) => {
			if (path.resolve(file) === path.resolve(SHARED_MODULE)) return false;
			return LOCAL_TRANSIENT_REGEX_SIGNATURE.test(readFileSync(file, 'utf8'));
		});
		expect(offenders).toEqual([]);
	});

	it('the shared module DOES define the canonical transient regex (sanity)', () => {
		expect(
			LOCAL_TRANSIENT_REGEX_SIGNATURE.test(readFileSync(SHARED_MODULE, 'utf8')),
		).toBe(true);
	});
});
