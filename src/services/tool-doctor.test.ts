import { afterEach, describe, expect, mock, test } from 'bun:test';
import { AGENT_TOOL_MAP } from '../config/constants';
import { TOOL_NAMES } from '../tools/tool-names';
import { checkAgentToolMapAlignment, runToolDoctor } from './tool-doctor';

/**
 * As of #507 tool registration is DERIVED from the single-source TOOL_MANIFEST
 * (TOOL_NAMES, AGENT_TOOL_MAP, and the plugin tool object all come from it), so
 * "tool declared but not registered" drift is structurally impossible. These
 * tests assert (a) the derivation is coherent end-to-end, (b) the doctor no
 * longer depends on parsing src/index.ts source, and (c) the detection LOGIC
 * still flags a tool that is absent from a given registered set — the original
 * 6.66.0 council-regression guard, now exercised directly against the checker.
 */
describe('runToolDoctor — tool registration coherence', () => {
	test('reports no registration or alignment errors against the real manifest', () => {
		const result = runToolDoctor(process.cwd());

		const registrationErrors = result.findings.filter(
			(f) =>
				(f.id.startsWith('missing-tool-registration-') ||
					f.id.startsWith('agent-tool-map-mismatch-')) &&
				f.severity === 'error',
		);
		expect(registrationErrors).toEqual([]);
	});

	test('is derivation-backed: needs no src/index.ts and never returns plugin-src-unavailable', () => {
		// Point pluginRoot at a non-existent path — the doctor must not care,
		// because it derives registered keys from the manifest module, not source.
		const result = runToolDoctor(process.cwd(), '/nonexistent/plugin/root');

		expect(
			result.findings.find((f) => f.id === 'plugin-src-unavailable'),
		).toBeUndefined();
		const registrationErrors = result.findings.filter((f) =>
			f.id.startsWith('missing-tool-registration-'),
		);
		expect(registrationErrors).toEqual([]);
		expect(() => runToolDoctor(process.cwd())).not.toThrow();
	});
});

describe('checkAgentToolMapAlignment — detection logic', () => {
	test('flags every AGENT_TOOL_MAP tool absent from the registered set', () => {
		// Synthetic registered set missing everything → every assigned tool flagged.
		const findings = checkAgentToolMapAlignment(new Set<string>());
		expect(findings.length).toBeGreaterThan(0);
		expect(
			findings.every(
				(f) =>
					f.id.startsWith('agent-tool-map-mismatch-') && f.severity === 'error',
			),
		).toBe(true);
	});

	test('reports no findings when every assigned tool is registered', () => {
		// The full set of assigned tools → nothing missing.
		const allAssigned = new Set<string>(Object.values(AGENT_TOOL_MAP).flat());
		expect(checkAgentToolMapAlignment(allAssigned)).toEqual([]);
	});

	test('flags exactly the tools missing from a partial set', () => {
		const assigned = [...new Set(Object.values(AGENT_TOOL_MAP).flat())];
		const present = new Set(assigned.slice(1)); // drop the first assigned tool
		const dropped = assigned[0];
		const findings = checkAgentToolMapAlignment(present);
		expect(findings.length).toBeGreaterThan(0);
		expect(findings.every((f) => f.currentValue === dropped)).toBe(true);
	});
});

describe('runToolDoctor — binary readiness', () => {
	afterEach(() => {
		mock.restore();
	});

	test('reports warn finding for each binary not found on PATH', () => {
		mock.module('../../src/build/discovery', () => ({
			isCommandAvailable: () => false,
		}));

		const result = runToolDoctor(process.cwd());

		const binaryFindings = result.findings.filter(
			(f) => f.id.startsWith('missing-binary-') && f.severity === 'warn',
		);
		expect(binaryFindings.length).toBeGreaterThan(0);
		expect(result.summary.warn).toBeGreaterThan(0);
	});

	test('reports no binary findings when all binaries available', () => {
		mock.module('../../src/build/discovery', () => ({
			isCommandAvailable: () => true,
		}));

		const result = runToolDoctor(process.cwd());

		const binaryFindings = result.findings.filter((f) =>
			f.id.startsWith('missing-binary-'),
		);
		expect(binaryFindings.length).toBe(0);
	});
});

// Sanity: the manifest registers exactly the TOOL_NAMES set (guards the
// derivation the doctor relies on).
test('every TOOL_NAME is covered by the doctor with no error', () => {
	const result = runToolDoctor(process.cwd());
	for (const name of TOOL_NAMES) {
		expect(
			result.findings.find((f) => f.id === `missing-tool-registration-${name}`),
		).toBeUndefined();
	}
});
