import * as fs from 'node:fs';
import * as path from 'node:path';
import { isCommandAvailable } from '../build/discovery';
import { warn } from '../utils';
import {
	BunCompatOutputLimitError,
	bunSpawn,
	classifySpawnFailure,
} from '../utils/bun-compat';

// ============ Constants ============
const MAX_OUTPUT_BYTES = 52_428_800; // 50MB max output
const AUDIT_TIMEOUT_MS = 120_000; // 120 seconds

// ============ Types ============
type Severity = 'critical' | 'high' | 'moderate' | 'low' | 'info';
type Ecosystem =
	| 'auto'
	| 'npm'
	| 'pip'
	| 'cargo'
	| 'go'
	| 'dotnet'
	| 'ruby'
	| 'dart';

interface VulnerabilityFinding {
	package: string;
	installedVersion: string;
	patchedVersion: string | null;
	severity: Severity;
	title: string;
	cve: string | null;
	url: string | null;
}

interface AuditResult {
	ecosystem: string;
	command: string[];
	findings: VulnerabilityFinding[];
	criticalCount: number;
	highCount: number;
	totalCount: number;
	clean: boolean;
	note?: string;
}

interface CombinedAuditResult {
	ecosystems: string[];
	findings: VulnerabilityFinding[];
	criticalCount: number;
	highCount: number;
	totalCount: number;
	clean: boolean;
}

// ============ Validation ============
function isValidEcosystem(value: unknown): value is Ecosystem {
	return (
		typeof value === 'string' &&
		['auto', 'npm', 'pip', 'cargo', 'go', 'dotnet', 'ruby', 'dart'].includes(
			value,
		)
	);
}

// ============ File Detection ============
function detectEcosystems(directory: string): string[] {
	const ecosystems: string[] = [];
	const cwd = directory;

	// Check for package.json -> npm
	if (fs.existsSync(path.join(cwd, 'package.json'))) {
		ecosystems.push('npm');
	}

	// Check for pyproject.toml or requirements.txt -> pip
	if (
		fs.existsSync(path.join(cwd, 'pyproject.toml')) ||
		fs.existsSync(path.join(cwd, 'requirements.txt'))
	) {
		ecosystems.push('pip');
	}

	// Check for Cargo.toml -> cargo
	if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
		ecosystems.push('cargo');
	}

	// Check for go.mod -> go
	if (fs.existsSync(path.join(cwd, 'go.mod'))) {
		ecosystems.push('go');
	}

	// Check for .csproj or .sln -> dotnet
	try {
		const files = fs.readdirSync(cwd);
		if (files.some((f) => f.endsWith('.csproj') || f.endsWith('.sln'))) {
			ecosystems.push('dotnet');
		}
	} catch {
		// ignore unreadable directory
	}

	// Check for Gemfile or Gemfile.lock -> ruby
	if (
		fs.existsSync(path.join(cwd, 'Gemfile')) ||
		fs.existsSync(path.join(cwd, 'Gemfile.lock'))
	) {
		ecosystems.push('ruby');
	}

	// Check for pubspec.yaml -> dart
	if (fs.existsSync(path.join(cwd, 'pubspec.yaml'))) {
		ecosystems.push('dart');
	}

	return ecosystems;
}

// ============ NPM Audit ============
interface NpmVulnInfo {
	severity: string;
	range: string;
	fixAvailable:
		| boolean
		| {
				version: string;
		  };
	title?: string;
	cves?: string[];
	url?: string;
}

interface NpmAuditResponse {
	vulnerabilities?: Record<string, NpmVulnInfo>;
}

/**
 * FB-007b (PR #3163 feedback): the one place that turns "this npm scan did
 * not produce a result" into an `AuditResult`. Ports 7.x's single-classifier
 * contract (both failure channels — `proc.spawnError` and a caught throw —
 * route through here so the same real-world fault always reads the same),
 * with the 8.x fail-closed rule: `clean: true` is reserved EXCLUSIVELY for
 * genuinely-missing tooling; every other failure — including a
 * `BunCompatOutputLimitError` overflow — reports `clean: false` so an
 * unusable audit result can never read as "no vulnerabilities found".
 */
function auditFailure(
	ecosystem: string,
	toolLabel: string,
	command: string[],
	error: unknown,
): AuditResult {
	const base = {
		ecosystem,
		command,
		findings: [] as VulnerabilityFinding[],
		criticalCount: 0,
		highCount: 0,
		totalCount: 0,
	};
	// Output-budget overflow: the audit payload was never fully captured, so
	// the result is unusable — never clean.
	if (error instanceof BunCompatOutputLimitError) {
		return {
			...base,
			clean: false,
			note: `${toolLabel} output exceeded the ${error.limit}-byte capture budget; audit result unusable`,
		};
	}
	const message = error instanceof Error ? error.message : 'Unknown error';
	// Typed cwd failure is checked FIRST and deliberately never collapses into
	// the tool-missing note (7.x #2236 contract): "the working directory is
	// gone" must not be reported as "npm is missing".
	if (classifySpawnFailure(error) === 'cwd-missing') {
		return {
			...base,
			clean: false,
			note: `Error running ${toolLabel}: ${message}`,
		};
	}
	// The designed not-installed arm: the scanner's own error text says so,
	// or the spawn-failure classifier positively identified the BINARY as
	// missing (ENOENT with a usable cwd). This is the ONLY clean:true arm.
	if (
		message.includes(toolLabel) ||
		message.includes('command not found') ||
		message.includes('is not recognized') ||
		classifySpawnFailure(error) === 'binary-missing'
	) {
		return {
			...base,
			clean: true,
			note: `${toolLabel} not available - the tool may not be installed`,
		};
	}
	return {
		...base,
		clean: false,
		note: `Error running ${toolLabel}: ${message}`,
	};
}

async function runNpmAudit(directory: string): Promise<AuditResult> {
	const command = ['npm', 'audit', '--json'];

	try {
		const proc = bunSpawn(command, {
			// #2705 (7.x parity): a never-closed stdin pipe can block child
			// exit under Bun on Windows (v7.3.3 class).
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			cwd: directory,
			// FB-007b: bound the compat layer's buffered capture to the same
			// budget this scanner already truncates against, so an oversized
			// audit payload surfaces as a catchable BunCompatOutputLimitError
			// (→ clean:false) instead of an unbounded buffer.
			maxBuffer: MAX_OUTPUT_BYTES,
		});

		const timeoutPromise = new Promise<'timeout'>((resolve) =>
			setTimeout(() => resolve('timeout'), AUDIT_TIMEOUT_MS),
		);
		const result = await Promise.race([
			Promise.all([proc.stdout.text(), proc.stderr.text()]).then(
				([stdout, stderr]) => ({ stdout, stderr }),
			),
			timeoutPromise,
		]);

		if (result === 'timeout') {
			proc.kill();
			return {
				ecosystem: 'npm',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: false,
				note: `npm audit timed out after ${AUDIT_TIMEOUT_MS / 1000}s`,
			};
		}

		let { stdout, stderr } = result;
		if (stdout.length > MAX_OUTPUT_BYTES) {
			stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
		}

		const exitCode = await proc.exited;

		// FB-007b (7.x parity): a spawn failure (missing npm, or a cwd that no
		// longer exists) resolves `exited` non-zero with empty output. Check the
		// `spawnError` channel explicitly — through the SAME classifier the
		// catch below uses — instead of relying on `JSON.parse('')` throwing
		// incidentally, so a missing npm lands in the designed not-installed
		// arm no matter which channel surfaced the fault.
		if (proc.spawnError) {
			return auditFailure('npm', 'npm audit', command, proc.spawnError);
		}

		// If exit code is 0, there are no vulnerabilities
		if (exitCode === 0) {
			return {
				ecosystem: 'npm',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
			};
		}

		// Parse JSON output
		let jsonOutput = stdout;
		// npm audit sometimes outputs progress to stderr, try to find JSON
		const jsonMatch =
			stdout.match(/\{[\s\S]*\}/) || stderr.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			jsonOutput = jsonMatch[0];
		}

		const response = JSON.parse(jsonOutput) as NpmAuditResponse;
		const findings: VulnerabilityFinding[] = [];

		if (response.vulnerabilities) {
			for (const [pkgName, vuln] of Object.entries(response.vulnerabilities)) {
				let patchedVersion: string | null = null;
				if (vuln.fixAvailable && typeof vuln.fixAvailable === 'object') {
					patchedVersion = vuln.fixAvailable.version;
				} else if (vuln.fixAvailable === true) {
					patchedVersion = 'latest';
				}

				const severity = mapNpmSeverity(vuln.severity);

				findings.push({
					package: pkgName,
					installedVersion: vuln.range,
					patchedVersion,
					severity,
					title: vuln.title || `Vulnerability in ${pkgName}`,
					cve: vuln.cves && vuln.cves.length > 0 ? vuln.cves[0] : null,
					url: vuln.url || null,
				});
			}
		}

		const criticalCount = findings.filter(
			(f) => f.severity === 'critical',
		).length;
		const highCount = findings.filter((f) => f.severity === 'high').length;

		return {
			ecosystem: 'npm',
			command,
			findings,
			criticalCount,
			highCount,
			totalCount: findings.length,
			clean: findings.length === 0,
		};
	} catch (error) {
		return auditFailure('npm', 'npm audit', command, error);
	}
}

function mapNpmSeverity(severity: string): Severity {
	switch (severity.toLowerCase()) {
		case 'critical':
			return 'critical';
		case 'high':
			return 'high';
		case 'moderate':
			return 'moderate';
		case 'low':
			return 'low';
		default:
			return 'info';
	}
}

// ============ pip-audit ============
interface PipAuditVuln {
	id: string;
	aliases: string[];
	fix_versions: string[];
}

interface PipAuditPackage {
	name: string;
	version: string;
	vulns: PipAuditVuln[];
}

async function runPipAudit(directory: string): Promise<AuditResult> {
	const command = ['pip-audit', '--format=json'];

	try {
		const proc = bunSpawn(command, {
			stdout: 'pipe',
			stderr: 'pipe',
			cwd: directory,
		});

		const timeoutPromise = new Promise<'timeout'>((resolve) =>
			setTimeout(() => resolve('timeout'), AUDIT_TIMEOUT_MS),
		);
		const result = await Promise.race([
			Promise.all([proc.stdout.text(), proc.stderr.text()]).then(
				([stdout, stderr]) => ({ stdout, stderr }),
			),
			timeoutPromise,
		]);

		if (result === 'timeout') {
			proc.kill();
			return {
				ecosystem: 'pip',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: false,
				note: `pip-audit timed out after ${AUDIT_TIMEOUT_MS / 1000}s`,
			};
		}

		let { stdout, stderr } = result;
		if (stdout.length > MAX_OUTPUT_BYTES) {
			stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
		}

		const exitCode = await proc.exited;

		// Fail-closed parity with npm (FB-007b): a spawn failure (tool missing,
		// EINVAL/ENOENT) must never flow into "empty findings = clean" below.
		if (proc.spawnError !== null && proc.spawnError !== undefined) {
			return auditFailure('pip', 'pip-audit', command, proc.spawnError);
		}

		// If exit code is 0 and no output, no vulnerabilities
		if (exitCode === 0 && !stdout.trim()) {
			return {
				ecosystem: 'pip',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
			};
		}

		// Parse JSON output
		let packages: PipAuditPackage[] = [];
		try {
			const parsed = JSON.parse(stdout);
			// pip-audit returns an array directly or object with 'dependencies'
			if (Array.isArray(parsed)) {
				packages = parsed;
			} else if (parsed.dependencies) {
				packages = parsed.dependencies;
			}
		} catch {
			// If JSON parsing fails, check for error message
			if (
				stderr.includes('not installed') ||
				stdout.includes('not installed') ||
				stderr.includes('command not found')
			) {
				return {
					ecosystem: 'pip',
					command,
					findings: [],
					criticalCount: 0,
					highCount: 0,
					totalCount: 0,
					clean: true,
					note: 'pip-audit not installed. Install with: pip install pip-audit',
				};
			}
			// Otherwise, return clean with note
			return {
				ecosystem: 'pip',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
				note: `pip-audit output could not be parsed: ${stdout.slice(0, 200)}`,
			};
		}

		const findings: VulnerabilityFinding[] = [];

		for (const pkg of packages) {
			if (pkg.vulns && pkg.vulns.length > 0) {
				for (const vuln of pkg.vulns) {
					// Severity mapping: if aliases contains CVE -> high, else moderate
					const severity: Severity =
						vuln.aliases && vuln.aliases.length > 0 ? 'high' : 'moderate';

					findings.push({
						package: pkg.name,
						installedVersion: pkg.version,
						patchedVersion:
							vuln.fix_versions && vuln.fix_versions.length > 0
								? vuln.fix_versions[0]
								: null,
						severity,
						title: vuln.id,
						cve:
							vuln.aliases && vuln.aliases.length > 0 ? vuln.aliases[0] : null,
						url: vuln.id.startsWith('CVE-')
							? `https://nvd.nist.gov/vuln/detail/${vuln.id}`
							: null,
					});
				}
			}
		}

		const criticalCount = findings.filter(
			(f) => f.severity === 'critical',
		).length;
		const highCount = findings.filter((f) => f.severity === 'high').length;

		return {
			ecosystem: 'pip',
			command,
			findings,
			criticalCount,
			highCount,
			totalCount: findings.length,
			clean: findings.length === 0,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : 'Unknown error';
		if (
			errorMessage.includes('not found') ||
			errorMessage.includes('not recognized') ||
			errorMessage.includes('pip-audit')
		) {
			return {
				ecosystem: 'pip',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
				note: 'pip-audit not installed. Install with: pip install pip-audit',
			};
		}
		return {
			ecosystem: 'pip',
			command,
			findings: [],
			criticalCount: 0,
			highCount: 0,
			totalCount: 0,
			clean: false,
			note: `Error running pip-audit: ${errorMessage}`,
		};
	}
}

// ============ Cargo Audit ============
interface CargoAdvisory {
	package: string;
	title: string;
	id: string;
	aliases: string[];
	url: string;
	cvss: number;
}

interface CargoPackage {
	version: string;
}

interface CargoVersions {
	patched: string[];
}

interface CargoAdvisoryItem {
	advisory: CargoAdvisory;
	package: CargoPackage;
	versions: CargoVersions;
}

interface CargoVulnsList {
	list: CargoAdvisoryItem[];
}

interface CargoAuditResponse {
	vulnerabilities?: CargoVulnsList;
}

async function runCargoAudit(directory: string): Promise<AuditResult> {
	const command = ['cargo', 'audit', '--json'];

	try {
		const proc = _internals.spawnAuditProc(command, {
			stdout: 'pipe',
			stderr: 'pipe',
			cwd: directory,
		});

		const timeoutPromise = new Promise<'timeout'>((resolve) =>
			setTimeout(() => resolve('timeout'), _internals.auditTimeoutMs),
		);
		const result = await Promise.race([
			Promise.all([proc.stdout.text(), proc.stderr.text()]).then(
				([stdout, stderr]) => ({ stdout, stderr }),
			),
			timeoutPromise,
		]);

		if (result === 'timeout') {
			proc.kill();
			return {
				ecosystem: 'cargo',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: false,
				note: `cargo audit timed out after ${_internals.auditTimeoutMs / 1000}s`,
			};
		}

		let { stdout, stderr: _stderr } = result;
		if (stdout.length > MAX_OUTPUT_BYTES) {
			stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
		}

		const exitCode = await proc.exited;

		// Fail-closed parity with npm (FB-007b): a spawn failure (tool missing,
		// EINVAL/ENOENT) must never flow into "empty findings = clean" below.
		if (proc.spawnError !== null && proc.spawnError !== undefined) {
			return auditFailure('cargo', 'cargo audit', command, proc.spawnError);
		}

		// If exit code is 0, no vulnerabilities
		if (exitCode === 0) {
			return {
				ecosystem: 'cargo',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
			};
		}

		// Parse JSON output - cargo audit outputs multiple JSON objects, one per line
		const findings: VulnerabilityFinding[] = [];
		const lines = stdout.split('\n').filter((line) => line.trim());

		for (const line of lines) {
			try {
				const obj = JSON.parse(line) as CargoAuditResponse;
				if (obj.vulnerabilities?.list) {
					for (const item of obj.vulnerabilities.list) {
						const cvss = item.advisory.cvss || 0;
						const severity = mapCargoSeverity(cvss);

						findings.push({
							package: item.advisory.package,
							installedVersion: item.package.version,
							patchedVersion:
								item.versions.patched && item.versions.patched.length > 0
									? item.versions.patched[0]
									: null,
							severity,
							title: item.advisory.title,
							cve:
								item.advisory.aliases && item.advisory.aliases.length > 0
									? item.advisory.aliases[0]
									: item.advisory.id
										? item.advisory.id
										: null,
							url: item.advisory.url || null,
						});
					}
				}
			} catch {
				// Skip non-JSON lines
			}
		}

		const criticalCount = findings.filter(
			(f) => f.severity === 'critical',
		).length;
		const highCount = findings.filter((f) => f.severity === 'high').length;

		return {
			ecosystem: 'cargo',
			command,
			findings,
			criticalCount,
			highCount,
			totalCount: findings.length,
			clean: findings.length === 0,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : 'Unknown error';
		if (
			errorMessage.includes('not found') ||
			errorMessage.includes('not recognized') ||
			errorMessage.includes('cargo-audit')
		) {
			return {
				ecosystem: 'cargo',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
				note: 'cargo-audit not installed. Install with: cargo install cargo-audit',
			};
		}
		return {
			ecosystem: 'cargo',
			command,
			findings: [],
			criticalCount: 0,
			highCount: 0,
			totalCount: 0,
			clean: false,
			note: `Error running cargo audit: ${errorMessage}`,
		};
	}
}

function mapCargoSeverity(cvss: number): Severity {
	if (cvss >= 9.0) return 'critical';
	if (cvss >= 7.0) return 'high';
	if (cvss >= 4.0) return 'moderate';
	return 'low';
}

// ============ Go Audit (govulncheck) ============
interface GoOsvEntry {
	id: string;
	summary: string;
	aliases?: string[];
	references?: Array<{ type: string; url: string }>;
}

interface GoFinding {
	osv: string;
	trace: Array<{ module: string; version?: string; function?: string }>;
	fixed_by: string | null;
}

interface GoVulncheckLine {
	config?: unknown;
	progress?: unknown;
	osv?: GoOsvEntry;
	finding?: GoFinding;
}

async function runGoAudit(directory: string): Promise<AuditResult> {
	const command = ['govulncheck', '-json', './...'];

	if (!isCommandAvailable('govulncheck')) {
		warn('[pkg-audit] govulncheck not found, skipping Go audit');
		return {
			ecosystem: 'go',
			command,
			findings: [],
			criticalCount: 0,
			highCount: 0,
			totalCount: 0,
			clean: true,
			note: 'govulncheck not installed. Install with: go install golang.org/x/vuln/cmd/govulncheck@latest',
		};
	}

	try {
		const proc = bunSpawn(command, {
			stdout: 'pipe',
			stderr: 'pipe',
			cwd: directory,
		});

		const timeoutPromise = new Promise<'timeout'>((resolve) =>
			setTimeout(() => resolve('timeout'), AUDIT_TIMEOUT_MS),
		);
		const result = await Promise.race([
			Promise.all([proc.stdout.text(), proc.stderr.text()]).then(
				([stdout, stderr]) => ({ stdout, stderr }),
			),
			timeoutPromise,
		]);

		if (result === 'timeout') {
			proc.kill();
			return {
				ecosystem: 'go',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: false,
				note: `govulncheck timed out after ${AUDIT_TIMEOUT_MS / 1000}s`,
			};
		}

		let { stdout } = result;
		if (stdout.length > MAX_OUTPUT_BYTES) {
			stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
		}

		const exitCode = await proc.exited;

		// Fail-closed parity with npm (FB-007b): a spawn failure (tool missing,
		// EINVAL/ENOENT) must never flow into "empty findings = clean" below.
		if (proc.spawnError !== null && proc.spawnError !== undefined) {
			return auditFailure('go', 'govulncheck', command, proc.spawnError);
		}

		// govulncheck exits 0 = clean, 3 = vulnerabilities found, other = error
		if (exitCode !== 0 && exitCode !== 3) {
			return {
				ecosystem: 'go',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
				note: `govulncheck exited with code ${exitCode}`,
			};
		}

		if (exitCode === 0) {
			return {
				ecosystem: 'go',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
			};
		}

		// Parse govulncheck JSON Lines output
		const osvMap = new Map<string, GoOsvEntry>();
		const goFindings: GoFinding[] = [];

		const lines = stdout.split('\n').filter((line) => line.trim());
		for (const line of lines) {
			try {
				const obj = JSON.parse(line) as GoVulncheckLine;
				if (obj.osv) {
					osvMap.set(obj.osv.id, obj.osv);
				}
				if (obj.finding) {
					goFindings.push(obj.finding);
				}
			} catch {
				// skip non-JSON lines
			}
		}

		const findings: VulnerabilityFinding[] = [];
		for (const finding of goFindings) {
			const osv = osvMap.get(finding.osv);
			const hasCve = osv?.aliases?.some((a) => a.startsWith('CVE-')) ?? false;
			const severity: Severity = hasCve ? 'high' : 'moderate';
			const cve = osv?.aliases?.find((a) => a.startsWith('CVE-')) ?? null;
			const url =
				osv?.references?.find((r) => r.type === 'WEB')?.url ??
				`https://pkg.go.dev/vuln/${finding.osv}`;

			const trace0 = finding.trace[0];
			const pkgName = trace0?.module ?? finding.osv;
			const installedVersion = trace0?.version ?? 'unknown';

			findings.push({
				package: pkgName,
				installedVersion,
				patchedVersion: finding.fixed_by ?? null,
				severity,
				title: osv?.summary ?? finding.osv,
				cve,
				url,
			});
		}

		const criticalCount = findings.filter(
			(f) => f.severity === 'critical',
		).length;
		const highCount = findings.filter((f) => f.severity === 'high').length;

		return {
			ecosystem: 'go',
			command,
			findings,
			criticalCount,
			highCount,
			totalCount: findings.length,
			clean: findings.length === 0,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : 'Unknown error';
		return {
			ecosystem: 'go',
			command,
			findings: [],
			criticalCount: 0,
			highCount: 0,
			totalCount: 0,
			clean: false,
			note: `Error running govulncheck: ${errorMessage}`,
		};
	}
}

// ============ dotnet Audit ============
async function runDotnetAudit(directory: string): Promise<AuditResult> {
	const command = [
		'dotnet',
		'list',
		'package',
		'--vulnerable',
		'--include-transitive',
	];

	if (!isCommandAvailable('dotnet')) {
		warn('[pkg-audit] dotnet not found, skipping .NET audit');
		return {
			ecosystem: 'dotnet',
			command,
			findings: [],
			criticalCount: 0,
			highCount: 0,
			totalCount: 0,
			clean: true,
			note: 'dotnet CLI not installed. Install from: https://dotnet.microsoft.com/download',
		};
	}

	try {
		const proc = bunSpawn(command, {
			stdout: 'pipe',
			stderr: 'pipe',
			cwd: directory,
		});

		const timeoutPromise = new Promise<'timeout'>((resolve) =>
			setTimeout(() => resolve('timeout'), AUDIT_TIMEOUT_MS),
		);
		const result = await Promise.race([
			Promise.all([proc.stdout.text(), proc.stderr.text()]).then(
				([stdout, stderr]) => ({ stdout, stderr }),
			),
			timeoutPromise,
		]);

		if (result === 'timeout') {
			proc.kill();
			return {
				ecosystem: 'dotnet',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: false,
				note: `dotnet list package timed out after ${AUDIT_TIMEOUT_MS / 1000}s`,
			};
		}

		let { stdout } = result;
		if (stdout.length > MAX_OUTPUT_BYTES) {
			stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
		}

		const exitCode = await proc.exited;

		// Fail-closed parity with npm (FB-007b): a spawn failure (tool missing,
		// EINVAL/ENOENT) must never flow into "empty findings = clean" below.
		if (proc.spawnError !== null && proc.spawnError !== undefined) {
			return auditFailure(
				'dotnet',
				'dotnet list package',
				command,
				proc.spawnError,
			);
		}

		// Exit code 0 and no vulnerable packages header = clean
		if (
			exitCode !== 0 &&
			!stdout.includes('has the following vulnerable packages')
		) {
			return {
				ecosystem: 'dotnet',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
				note: `dotnet list package exited with code ${exitCode}`,
			};
		}

		// dotnet outputs text, not JSON — parse lines for vulnerable packages
		// Pattern: > PackageName  installedVersion  resolvedVersion  Severity  AdvisoryURL
		const vulnLinePattern =
			/^\s*>\s+(\S+)\s+\S+\s+(\S+)\s+(Critical|High|Moderate|Low)\s+(\S+)/i;
		const findings: VulnerabilityFinding[] = [];

		const lines = stdout.split('\n');
		for (const line of lines) {
			const match = line.match(vulnLinePattern);
			if (match) {
				const [, pkgName, resolvedVersion, severityStr, url] = match;
				const severity = mapDotnetSeverity(severityStr);
				findings.push({
					package: pkgName,
					installedVersion: resolvedVersion,
					patchedVersion: null,
					severity,
					title: `Vulnerable package: ${pkgName}`,
					cve: null,
					url,
				});
			}
		}

		const criticalCount = findings.filter(
			(f) => f.severity === 'critical',
		).length;
		const highCount = findings.filter((f) => f.severity === 'high').length;

		return {
			ecosystem: 'dotnet',
			command,
			findings,
			criticalCount,
			highCount,
			totalCount: findings.length,
			clean: findings.length === 0,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : 'Unknown error';
		return {
			ecosystem: 'dotnet',
			command,
			findings: [],
			criticalCount: 0,
			highCount: 0,
			totalCount: 0,
			clean: false,
			note: `Error running dotnet list package: ${errorMessage}`,
		};
	}
}

function mapDotnetSeverity(severity: string): Severity {
	switch (severity.toLowerCase()) {
		case 'critical':
			return 'critical';
		case 'high':
			return 'high';
		case 'moderate':
			return 'moderate';
		case 'low':
			return 'low';
		default:
			return 'info';
	}
}

// ============ Ruby Audit (bundle-audit) ============
interface BundleAuditAdvisory {
	id: string;
	cve?: string;
	url: string;
	title: string;
	cvss_v3?: number;
	cvss_v2?: number;
	patched_versions?: string[];
	criticality?: string;
}

interface BundleAuditResult {
	type: string;
	gem: { name: string; version: string };
	advisory: BundleAuditAdvisory;
}

interface BundleAuditResponse {
	results: BundleAuditResult[];
	ignored: string[];
}

async function runBundleAudit(directory: string): Promise<AuditResult> {
	const useBundleExec =
		!isCommandAvailable('bundle-audit') && isCommandAvailable('bundle');

	if (!isCommandAvailable('bundle-audit') && !isCommandAvailable('bundle')) {
		warn('[pkg-audit] bundle-audit not found, skipping Ruby audit');
		return {
			ecosystem: 'ruby',
			command: ['bundle-audit', 'check', '--format', 'json'],
			findings: [],
			criticalCount: 0,
			highCount: 0,
			totalCount: 0,
			clean: true,
			note: 'bundle-audit not installed. Install with: gem install bundler-audit',
		};
	}

	const command = useBundleExec
		? ['bundle', 'exec', 'bundle-audit', 'check', '--format', 'json']
		: ['bundle-audit', 'check', '--format', 'json'];

	try {
		const proc = bunSpawn(command, {
			stdout: 'pipe',
			stderr: 'pipe',
			cwd: directory,
		});

		const timeoutPromise = new Promise<'timeout'>((resolve) =>
			setTimeout(() => resolve('timeout'), AUDIT_TIMEOUT_MS),
		);
		const result = await Promise.race([
			Promise.all([proc.stdout.text(), proc.stderr.text()]).then(
				([stdout, stderr]) => ({ stdout, stderr }),
			),
			timeoutPromise,
		]);

		if (result === 'timeout') {
			proc.kill();
			return {
				ecosystem: 'ruby',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: false,
				note: `bundle-audit timed out after ${AUDIT_TIMEOUT_MS / 1000}s`,
			};
		}

		let { stdout } = result;
		if (stdout.length > MAX_OUTPUT_BYTES) {
			stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
		}

		const exitCode = await proc.exited;

		// Fail-closed parity with npm (FB-007b): a spawn failure (tool missing,
		// EINVAL/ENOENT) must never flow into "empty findings = clean" below.
		if (proc.spawnError !== null && proc.spawnError !== undefined) {
			return auditFailure('bundle', 'bundle audit', command, proc.spawnError);
		}

		// bundle-audit exits 0 = clean, 1 = vulnerabilities found, other = error
		if (exitCode !== 0 && exitCode !== 1) {
			return {
				ecosystem: 'ruby',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
				note: `bundle-audit failed with exit code ${exitCode}`,
			};
		}

		if (exitCode === 0) {
			return {
				ecosystem: 'ruby',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
			};
		}

		let response: BundleAuditResponse;
		try {
			response = JSON.parse(stdout) as BundleAuditResponse;
		} catch {
			return {
				ecosystem: 'ruby',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
				note: 'bundle-audit JSON output could not be parsed',
			};
		}

		const findings: VulnerabilityFinding[] = [];
		for (const item of response.results ?? []) {
			const adv = item.advisory;
			const severity = mapBundleSeverity(adv);
			findings.push({
				package: item.gem.name,
				installedVersion: item.gem.version,
				patchedVersion: adv.patched_versions?.[0] ?? null,
				severity,
				title: adv.title,
				cve: adv.cve ?? null,
				url: adv.url,
			});
		}

		const criticalCount = findings.filter(
			(f) => f.severity === 'critical',
		).length;
		const highCount = findings.filter((f) => f.severity === 'high').length;

		return {
			ecosystem: 'ruby',
			command,
			findings,
			criticalCount,
			highCount,
			totalCount: findings.length,
			clean: findings.length === 0,
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : 'Unknown error';
		return {
			ecosystem: 'ruby',
			command,
			findings: [],
			criticalCount: 0,
			highCount: 0,
			totalCount: 0,
			clean: false,
			note: `Error running bundle-audit: ${errorMessage}`,
		};
	}
}

function mapBundleSeverity(adv: BundleAuditAdvisory): Severity {
	if (adv.criticality) {
		switch (adv.criticality.toLowerCase()) {
			case 'critical':
				return 'critical';
			case 'high':
				return 'high';
			case 'medium':
				return 'moderate';
			case 'low':
				return 'low';
		}
	}
	const cvss = adv.cvss_v3 ?? adv.cvss_v2 ?? 0;
	if (cvss >= 9.0) return 'critical';
	if (cvss >= 7.0) return 'high';
	if (cvss >= 4.0) return 'moderate';
	return 'low';
}

// ============ Dart Audit (dart pub outdated) ============
interface DartPackageVersion {
	version: string;
	nullSafety?: boolean;
}

interface DartPackageEntry {
	package: string;
	current?: DartPackageVersion;
	upgradable?: DartPackageVersion;
	resolvable?: DartPackageVersion;
	latest?: DartPackageVersion;
}

interface DartPubOutdatedResponse {
	packages?: DartPackageEntry[];
}

async function runDartAudit(directory: string): Promise<AuditResult> {
	const dartBin = isCommandAvailable('dart')
		? 'dart'
		: isCommandAvailable('flutter')
			? 'flutter'
			: null;

	if (!dartBin) {
		warn('[pkg-audit] dart/flutter not found, skipping Dart audit');
		return {
			ecosystem: 'dart',
			command: ['dart', 'pub', 'outdated', '--json'],
			findings: [],
			criticalCount: 0,
			highCount: 0,
			totalCount: 0,
			clean: true,
			note: 'dart or flutter not installed. Install from: https://dart.dev/get-dart',
		};
	}

	const command = [dartBin, 'pub', 'outdated', '--json'];

	try {
		const proc = bunSpawn(command, {
			stdout: 'pipe',
			stderr: 'pipe',
			cwd: directory,
		});

		const timeoutPromise = new Promise<'timeout'>((resolve) =>
			setTimeout(() => resolve('timeout'), AUDIT_TIMEOUT_MS),
		);
		const result = await Promise.race([
			Promise.all([proc.stdout.text(), proc.stderr.text()]).then(
				([stdout, stderr]) => ({ stdout, stderr }),
			),
			timeoutPromise,
		]);

		if (result === 'timeout') {
			proc.kill();
			return {
				ecosystem: 'dart',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: false,
				note: `dart pub outdated timed out after ${AUDIT_TIMEOUT_MS / 1000}s`,
			};
		}

		let { stdout } = result;
		if (stdout.length > MAX_OUTPUT_BYTES) {
			stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
		}

		const exitCode = await proc.exited;

		// Fail-closed parity with npm (FB-007b): a spawn failure (tool missing,
		// EINVAL/ENOENT) must never flow into "empty findings = clean" below.
		if (proc.spawnError !== null && proc.spawnError !== undefined) {
			return auditFailure(
				'dart',
				'dart pub outdated',
				command,
				proc.spawnError,
			);
		}

		if (exitCode !== 0) {
			return {
				ecosystem: 'dart',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
				note: `dart pub outdated exited with code ${exitCode}`,
			};
		}

		let response: DartPubOutdatedResponse;
		try {
			response = JSON.parse(stdout) as DartPubOutdatedResponse;
		} catch {
			return {
				ecosystem: 'dart',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
				note: 'dart pub outdated JSON output could not be parsed',
			};
		}

		const findings: VulnerabilityFinding[] = [];
		for (const pkg of response.packages ?? []) {
			const current = pkg.current?.version;
			const latest = pkg.latest?.version;
			if (!current || !latest || current === latest) continue;
			if (!pkg.upgradable) continue;

			findings.push({
				package: pkg.package,
				installedVersion: current,
				patchedVersion: pkg.upgradable.version,
				severity: 'info',
				title: `Outdated package: ${pkg.package} (${current} → ${latest})`,
				cve: null,
				url: `https://pub.dev/packages/${pkg.package}`,
			});
		}

		const criticalCount = 0;
		const highCount = 0;

		return {
			ecosystem: 'dart',
			command,
			findings,
			criticalCount,
			highCount,
			totalCount: findings.length,
			clean: findings.length === 0,
			note: 'dart pub outdated reports outdated packages, not security vulnerabilities',
		};
	} catch (error) {
		const errorMessage =
			error instanceof Error ? error.message : 'Unknown error';
		return {
			ecosystem: 'dart',
			command,
			findings: [],
			criticalCount: 0,
			highCount: 0,
			totalCount: 0,
			clean: false,
			note: `Error running dart pub outdated: ${errorMessage}`,
		};
	}
}

// ============ Combined Audit ============
async function runAutoAudit(directory: string): Promise<CombinedAuditResult> {
	const ecosystems = detectEcosystems(directory);

	if (ecosystems.length === 0) {
		return {
			ecosystems: [],
			findings: [],
			criticalCount: 0,
			highCount: 0,
			totalCount: 0,
			clean: true,
		};
	}

	const results: AuditResult[] = [];

	for (const eco of ecosystems) {
		switch (eco) {
			case 'npm':
				results.push(await runNpmAudit(directory));
				break;
			case 'pip':
				results.push(await runPipAudit(directory));
				break;
			case 'cargo':
				results.push(await runCargoAudit(directory));
				break;
			case 'go':
				results.push(await runGoAudit(directory));
				break;
			case 'dotnet':
				results.push(await runDotnetAudit(directory));
				break;
			case 'ruby':
				results.push(await runBundleAudit(directory));
				break;
			case 'dart':
				results.push(await runDartAudit(directory));
				break;
		}
	}

	// Combine findings
	const allFindings: VulnerabilityFinding[] = [];
	let totalCritical = 0;
	let totalHigh = 0;

	for (const result of results) {
		allFindings.push(...result.findings);
		totalCritical += result.criticalCount;
		totalHigh += result.highCount;
	}

	return {
		ecosystems,
		findings: allFindings,
		criticalCount: totalCritical,
		highCount: totalHigh,
		totalCount: allFindings.length,
		clean: allFindings.length === 0,
	};
}

// ============ Main Function ============
export type {
	AuditResult,
	CombinedAuditResult,
	Ecosystem,
	Severity,
	VulnerabilityFinding,
};

/**
 * Run the package audit tool
 */
/**
 * Test seam (7.x `_internals` DI convention — never mock.module): lets
 * covered-tree tests inject a fake spawn result and a short timeout into
 * runCargoAudit. Only the cargo runner reads this seam (the arm the PR
 * #3163 feedback review pinned); the other runners keep the module
 * constants until a test needs injection.
 */
export const _internals = {
	spawnAuditProc: bunSpawn,
	auditTimeoutMs: AUDIT_TIMEOUT_MS,
};

/**
 * Exported for covered-tree tests (packages/core/tests/utils): asserts the
 * fail-closed contract of the cargo runner — a spawn failure (tool missing)
 * or a timeout must never report clean:true (issues #3150/#3163 feedback).
 */
export async function runCargoAuditForTest(
	directory: string,
): Promise<AuditResult> {
	return runCargoAudit(directory);
}

/**
 * Exported for covered-tree tests (packages/core/tests/utils): the shared
 * runner failure classifier. Pins the fail-closed contract added with
 * issues #3150/#3163 — overflow and unknown failures are clean:false;
 * only the genuinely-missing-tooling arm is clean:true.
 */
export function auditFailureForTest(
	ecosystem: string,
	toolLabel: string,
	command: string[],
	error: unknown,
): AuditResult {
	return auditFailure(ecosystem, toolLabel, command, error);
}

export async function runPkgAudit(
	ecosystem: Ecosystem,
	directory: string,
): Promise<AuditResult | CombinedAuditResult> {
	switch (ecosystem) {
		case 'auto':
			return await runAutoAudit(directory);
		case 'npm':
			return await runNpmAudit(directory);
		case 'pip':
			return await runPipAudit(directory);
		case 'cargo':
			return await runCargoAudit(directory);
		case 'go':
			return await runGoAudit(directory);
		case 'dotnet':
			return await runDotnetAudit(directory);
		case 'ruby':
			return await runBundleAudit(directory);
		case 'dart':
			return await runDartAudit(directory);
	}
}
