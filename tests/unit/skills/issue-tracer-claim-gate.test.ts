import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Text pin for the issue-tracer v3.0.2 parallel-session claim gate (rules 13-14,
// the Phase 0 claim gate, the Phase 1 / 2.5 / 5 re-checks) and for the
// three-tree version lockstep. The progressive-disclosure ratchet only caps the
// entry file's line count; it pins no content, so deleting the binding clauses
// would otherwise keep CI green. Needles are whitespace-normalized so they
// survive markdown line wrapping.
const ROOT = join(import.meta.dir, '..', '..', '..');
const TRACER = join(ROOT, '.opencode', 'skills', 'issue-tracer');
const flat = (path: string) => readFileSync(path, 'utf-8').replace(/\s+/g, ' ');

describe('issue-tracer claim gate pin (SKILL.md rules 13-14)', () => {
	const skill = flat(join(TRACER, 'SKILL.md'));

	test('rule 13 carries its load-bearing clauses', () => {
		expect(skill).toContain(
			'13. Claim before you work, and treat an active claim as a live lock',
		);
		expect(skill).toContain('`**Agent claim:** session=<token> issues=#a,#b`');
		expect(skill).toContain(
			'never self-authorize continuation by reasoning the claim is your own earlier session',
		);
		expect(skill).toContain('lineage is undecidable');
		expect(skill).toContain(
			"a trusted-author `**Claim released` comment ends a token claim only when it carries that claim's token",
		);
		expect(skill).toContain('crossed claims halt both sessions');
		expect(skill).toContain('`claim: not_applicable`');
		expect(skill).toContain('not rule-12 publication');
		// The halt directives are the binding behavior: inverting them (STOP -> proceed)
		// must turn this suite red, not only deleting the clause.
		expect(skill).toContain('means STOP and ask the user');
		expect(skill).toContain(
			'any closing or work-naming open pull request on the issue other than your own trace',
		);
	});

	test('rule 14 carries its load-bearing clauses', () => {
		expect(skill).toContain(
			'14. On discovering a parallel trace or PR for the same issues: an open parallel PR means halt and ask the user',
		);
		expect(skill).toContain(
			"never force-push a parallel session's published head",
		);
		expect(skill).toContain('publish under a renamed branch');
	});

	test('the gate table and the phase bullets point at the gate', () => {
		expect(skill).toContain(
			'the claim gate ran and `tools:` records `session=<token>` or `claim: not_applicable (<reason>)`',
		);
		expect(skill).toContain(
			'Run the claim gate (see `references/phase-0-setup.md`)',
		);
		expect(skill).toContain(
			're-check claims and work-in-flight PRs (`references/phase-1-intake.md`)',
		);
		expect(skill).toContain(
			'Before publishing the anchor comment, re-fetch the issue thread',
		);
		expect(skill).toContain('Pre-publication collision check:');
		expect(skill).toContain('(never force-push)');
		expect(skill).toContain('means stop and ask the user');
		expect(skill).toContain(
			'halt and surface it to the user instead of publishing',
		);
		expect(skill).toContain(
			'An open parallel PR is a collision - halt and ask the user',
		);
	});
});

describe('issue-tracer claim gate reference pin (phase-0-setup.md)', () => {
	const phase0 = flat(join(TRACER, 'references', 'phase-0-setup.md'));

	test('the claim gate section and its five steps exist', () => {
		expect(phase0).toContain('## Claim gate (claim before you work)');
		expect(phase0).toContain(
			'Claim patterns: `Agent claim`, `Working this issue`, `Claiming for active work`',
		);
		expect(phase0).toContain('release pattern: `Claim released`');
		expect(phase0).toContain(
			'its author association is `OWNER`, `MEMBER`, or `COLLABORATOR`',
		);
		expect(phase0).toContain('inside the ~72h claim window');
		expect(phase0).toContain('a `Refs #N`-only PR is absent');
		expect(phase0).toContain('READ BACK:');
		// Halt directives: inverting STOP -> proceed must turn the suite red.
		expect(phase0).toContain('STOP and ask the user if EITHER holds');
		expect(phase0).toContain('is treated as ACTIVE (fail-closed)');
		expect(phase0).toContain('cannot be completed, STOP and ask the user');
		expect(phase0).toContain('never proceed with a partial claim set');
		expect(phase0).toContain(
			'a closing-PR reference halts you whatever its author',
		);
		expect(phase0).toContain('128 random bits');
		expect(phase0).toContain('record the token FIRST');
		expect(phase0).toContain(
			'the tiebreak is a recommendation to the user, never authority to proceed',
		);
	});

	test('failure handling is fail-closed and the permission endpoint is not used', () => {
		expect(phase0).toContain(
			'never read a failed or empty response as "no claims"',
		);
		expect(phase0).toContain(
			'Any other posting error — rate limit, SAML/SSO, network — is STOP and ask, never not_applicable',
		);
		expect(phase0).toContain(
			'Do not decide this with the `collaborators/<login>/permission` endpoint',
		);
		expect(phase0).toContain(
			'`trace-check.sh phase 0` WARNs when `tools:` records neither `session=<token>` nor `claim: not_applicable (<reason>)`',
		);
	});

	test('the tools: line contract documents the claim entry in both places', () => {
		const entry =
			'plus exactly one claim entry: session=<token> or claim: not_applicable (<reason, no commas>)';
		expect(phase0).toContain(entry);
		expect(flat(join(TRACER, 'references', 'evidence-artifacts.md'))).toContain(
			entry,
		);
	});

	test('Phase 1 and Phase 2.5 re-checks carry the claim rules', () => {
		expect(flat(join(TRACER, 'references', 'phase-1-intake.md'))).toContain(
			'Re-check the claim state from the Phase 0 claim gate',
		);
		const anchors = flat(join(TRACER, 'references', 'acceptance-checks.md'));
		expect(anchors).toContain('Before posting the anchor comment, re-fetch');
		expect(anchors).toContain('never by digest equality');
		expect(anchors).toContain(
			'Do not publish — halt and surface the collision to the user',
		);
		expect(flat(join(TRACER, 'references', 'phase-1-intake.md'))).toContain(
			'halt and surface it to the user (Non-Negotiable Rule 13)',
		);
	});
});

describe('issue-tracer version lockstep (references/install.md maintainer rule)', () => {
	const version = (path: string) => {
		const match = readFileSync(path, 'utf-8').match(
			/^\s+version:\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/m,
		);
		return match?.[1];
	};

	test('the canonical skill and both adapter shims declare the same metadata.version', () => {
		const canonical = version(join(TRACER, 'SKILL.md'));
		expect(canonical).toMatch(/^3\./);
		expect(
			version(join(ROOT, '.claude', 'skills', 'issue-tracer', 'SKILL.md')),
		).toBe(canonical);
		expect(
			version(join(ROOT, '.agents', 'skills', 'issue-tracer', 'SKILL.md')),
		).toBe(canonical);
	});
});
