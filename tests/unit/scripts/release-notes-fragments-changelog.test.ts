/**
 * extractChangelogSection — CHANGELOG.md fallback source for
 * modeUpdateRelease (empty-release-body recovery).
 */

import { describe, expect, test } from 'bun:test';
import {
	extractChangelogSection,
	extractCommitShasFromBody,
} from '../../../scripts/release-notes-fragments.mjs';

const CHANGELOG = [
	'# Changelog',
	'',
	'## [7.146.2](https://github.com/ZaxbyHub/opencode-swarm/compare/v7.146.1...v7.146.2) (2026-08-24)',
	'',
	'### Bug Fixes',
	'',
	'* **knowledge-gate:** make ack format self-discoverable ([#2299](https://github.com/ZaxbyHub/opencode-swarm/issues/2299)) ([ba948b4](https://github.com/ZaxbyHub/opencode-swarm/commit/ba948b40159e1641d158d2efbd815abac1f94ad2))',
	'',
	'## [7.146.1](https://github.com/ZaxbyHub/opencode-swarm/compare/v7.146.0...v7.146.1) (2026-08-24)',
	'',
	'### Bug Fixes',
	'',
	'* **pr-review:** harden workflow resilience ([5c7bb9d](https://github.com/ZaxbyHub/opencode-swarm/commit/5c7bb9d9d0e21ad8da4ce79839a8f70991d4cbe3))',
	'* **workflow:** durable stage-a attribution ([5715242](https://github.com/ZaxbyHub/opencode-swarm/commit/5715242d62bc32af4242f4d714e3e364f235b01b))',
	'',
	'## [7.146.0](https://github.com/ZaxbyHub/opencode-swarm/compare/v7.145.2...v7.146.0) (2026-08-24)',
	'',
	'### Features',
	'',
	'* **memory:** Phase 6 privacy hardening',
	'',
].join('\n');

describe('extractChangelogSection', () => {
	test('extracts the exact section incl. heading and subheadings', () => {
		const section = extractChangelogSection(CHANGELOG, '7.146.1');
		expect(section).toContain('## [7.146.1]');
		expect(section).toContain('### Bug Fixes');
		expect(section).toContain('harden workflow resilience');
		expect(section).toContain('durable stage-a attribution');
	});

	test('first section stops at the next ## [ heading', () => {
		const section = extractChangelogSection(CHANGELOG, '7.146.2');
		expect(section).toContain('ack format self-discoverable');
		expect(section).not.toContain('harden workflow resilience');
	});

	test('last section extends to end of file', () => {
		const section = extractChangelogSection(CHANGELOG, '7.146.0');
		expect(section).toContain('Phase 6 privacy hardening');
	});

	test('version-not-found returns null', () => {
		expect(extractChangelogSection(CHANGELOG, '9.9.9')).toBeNull();
	});

	test('changelog without any ## [ headings returns null', () => {
		expect(
			extractChangelogSection('# Changelog\n\nplain text only', '1.0.0'),
		).toBeNull();
	});

	test('version prefix safety: 7.146.1 never matches a 7.146.10 heading', () => {
		const cl = [
			'## [7.146.10](https://x/compare/a...b) (2026-09-01)',
			'* newer entry',
			'',
		].join('\n');
		expect(extractChangelogSection(cl, '7.146.1')).toBeNull();
		expect(extractChangelogSection(cl, '7.146.10')).toContain('newer entry');
	});

	test('invalid inputs return null', () => {
		expect(extractChangelogSection(null, '1.0.0')).toBeNull();
		expect(extractChangelogSection(CHANGELOG, '')).toBeNull();
		expect(extractChangelogSection(CHANGELOG, null)).toBeNull();
	});

	test('extracted section feeds extractCommitShasFromBody (fallback chain)', () => {
		const section = extractChangelogSection(CHANGELOG, '7.146.1');
		const shas = extractCommitShasFromBody(section);
		expect(shas).toEqual([
			'5c7bb9d9d0e21ad8da4ce79839a8f70991d4cbe3',
			'5715242d62bc32af4242f4d714e3e364f235b01b',
		]);
	});
});
