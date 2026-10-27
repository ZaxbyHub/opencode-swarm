/**
 * #3474 PRESERVING pin: the PowerShell read-only pipeline classification and
 * the exact-name write-command tables must not regress while the sibling
 * spelling gap is closed. The maintainer decision is KEEP exact-name (no
 * widening of the read-only allowlist): a read-only pipeline stays read-only,
 * and a pipeline containing a write cmdlet (directly or inside a script
 * block) is never classified read-only and still produces detected writes.
 * GREEN at base and must stay GREEN.
 */

import { describe, expect, it } from 'bun:test';
import {
	detectWindowsWrites,
	isPowerShellReadOnlyPipeline,
} from '../../../src/hooks/shell-write-detect';

describe('PowerShell read-only pipeline pin (#3474, exact-name tables are KEPT)', () => {
	it('classifies a Get-Content | Measure-Object pipeline as read-only', () => {
		expect(
			isPowerShellReadOnlyPipeline('Get-Content a.md | Measure-Object'),
		).toBe(true);
	});

	it('classifies a Get-ChildItem | Select-Object pipeline as read-only', () => {
		expect(
			isPowerShellReadOnlyPipeline('Get-ChildItem src | Select-Object Name'),
		).toBe(true);
	});

	it('never classifies a script-block Set-Content pipeline as read-only', () => {
		expect(
			isPowerShellReadOnlyPipeline(
				'Get-Content a.md | ForEach-Object { Set-Content out.txt $_ }',
			),
		).toBe(false);
	});

	it('never classifies an Out-File pipeline as read-only', () => {
		expect(
			isPowerShellReadOnlyPipeline('Get-ChildItem | Out-File out.txt'),
		).toBe(false);
	});

	it('never classifies a Copy-Item command as read-only', () => {
		expect(isPowerShellReadOnlyPipeline('Copy-Item a.md b.md')).toBe(false);
	});

	it('detects no writes for the read-only pipeline', () => {
		const analysis = detectWindowsWrites(
			'Get-Content a.md | Measure-Object',
			'powershell',
		);
		expect(analysis.hasWrites).toBe(false);
		expect(analysis.writes).toHaveLength(0);
	});

	it('still detects writes for the script-block Set-Content pipeline', () => {
		const analysis = detectWindowsWrites(
			'Get-Content a.md | ForEach-Object { Set-Content out.txt $_ }',
			'powershell',
		);
		expect(analysis.hasWrites).toBe(true);
		expect(analysis.writes.length).toBeGreaterThan(0);
	});

	// Round-2 negative rows — no widening from the other direction: near-miss
	// and path-qualified spellings of read-only cmdlets are NOT classified
	// read-only (they behave as unknown pipelines; no read-only parse
	// suppression fires for them).
	it('never classifies the near-miss cmdlet Get-Content2 as read-only', () => {
		expect(
			isPowerShellReadOnlyPipeline('Get-Content2 a.md | Measure-Object'),
		).toBe(false);
	});

	it('never classifies a path-qualified /usr/bin/Get-Content pipeline as read-only', () => {
		expect(
			isPowerShellReadOnlyPipeline(
				'/usr/bin/Get-Content a.md | Measure-Object',
			),
		).toBe(false);
	});
});
