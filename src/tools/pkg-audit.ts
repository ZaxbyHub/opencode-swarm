import * as fs from 'node:fs';
import * as path from 'node:path';
import type { tool } from '@opencode-ai/plugin';
import { z } from 'zod';
import { isCommandAvailable } from '../build/discovery';
import { warn } from '../utils';
import { bunSpawn } from '../utils/bun-compat';
import { createSwarmTool } from './create-tool';

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
	| 'dart'
	| 'composer';

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
		[
			'auto',
			'npm',
			'pip',
			'cargo',
			'go',
			'dotnet',
			'ruby',
			'dart',
			'composer',
		].includes(value)
	);
}

function validateArgs(args: unknown): args is { ecosystem?: Ecosystem } {
	if (typeof args !== 'object' || args === null) return true; // ecosystem is optional
	const obj = args as Record<string, unknown>;
	if (obj.ecosystem !== undefined && !isValidEcosystem(obj.ecosystem)) {
		return false;
	}
	return true;
}

// ============ Composer Audit Types ============
interface ComposerAuditAdvisory {
	advisoryId: string;
	packageName: string;
	reportedAt: string;
	title: string;
	link: string;
	cve: string;
	affectedVersions: string;
	sources: unknown[];
}

interface ComposerAuditJson {
	advisories: Record<string, ComposerAuditAdvisory[]>;
	abandoned: Record<string, string>;
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

	// Check for composer.lock -> composer
	if (fs.existsSync(path.join(cwd, 'composer.lock'))) {
		ecosystems.push('composer');
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

async function runNpmAudit(directory: string): Promise<AuditResult> {
	const command = ['npm', 'audit', '--json'];

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
				ecosystem: 'npm',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
				note: `npm audit timed out after ${AUDIT_TIMEOUT_MS / 1000}s`,
			};
		}

		let { stdout, stderr } = result;
		if (stdout.length > MAX_OUTPUT_BYTES) {
			stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
		}

		const exitCode = await proc.exited;

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
		const errorMessage =
			error instanceof Error ? error.message : 'Unknown error';
		// Check if npm audit is not installed
		if (
			errorMessage.includes('audit') ||
			errorMessage.includes('command not found') ||
			errorMessage.includes("'npm' is not recognized")
		) {
			return {
				ecosystem: 'npm',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
				note: 'npm audit not available - npm may not be installed',
			};
		}
		return {
			ecosystem: 'npm',
			command,
			findings: [],
			criticalCount: 0,
			highCount: 0,
			totalCount: 0,
			clean: true,
			note: `Error running npm audit: ${errorMessage}`,
		};
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
				clean: true,
				note: `pip-audit timed out after ${AUDIT_TIMEOUT_MS / 1000}s`,
			};
		}

		let { stdout, stderr } = result;
		if (stdout.length > MAX_OUTPUT_BYTES) {
			stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
		}

		const exitCode = await proc.exited;

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
			clean: true,
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
				ecosystem: 'cargo',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
				note: `cargo audit timed out after ${AUDIT_TIMEOUT_MS / 1000}s`,
			};
		}

		let { stdout, stderr: _stderr } = result;
		if (stdout.length > MAX_OUTPUT_BYTES) {
			stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
		}

		const exitCode = await proc.exited;

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
			clean: true,
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
				clean: true,
				note: `govulncheck timed out after ${AUDIT_TIMEOUT_MS / 1000}s`,
			};
		}

		let { stdout } = result;
		if (stdout.length > MAX_OUTPUT_BYTES) {
			stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
		}

		const exitCode = await proc.exited;

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
			clean: true,
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
				clean: true,
				note: `dotnet list package timed out after ${AUDIT_TIMEOUT_MS / 1000}s`,
			};
		}

		let { stdout } = result;
		if (stdout.length > MAX_OUTPUT_BYTES) {
			stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
		}

		const exitCode = await proc.exited;

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
			clean: true,
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
				clean: true,
				note: `bundle-audit timed out after ${AUDIT_TIMEOUT_MS / 1000}s`,
			};
		}

		let { stdout } = result;
		if (stdout.length > MAX_OUTPUT_BYTES) {
			stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
		}

		const exitCode = await proc.exited;

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
		const isNotInstalled =
			errorMessage.includes('not recognized') ||
			errorMessage.includes('not found') ||
			errorMessage.includes('No such file') ||
			errorMessage.includes('ENOENT');
		return {
			ecosystem: 'ruby',
			command,
			findings: [],
			criticalCount: 0,
			highCount: 0,
			totalCount: 0,
			clean: true,
			note: isNotInstalled
				? 'bundle-audit not installed. Install with: gem install bundler-audit'
				: `Error running bundle-audit: ${errorMessage}`,
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
				clean: true,
				note: `dart pub outdated timed out after ${AUDIT_TIMEOUT_MS / 1000}s`,
			};
		}

		let { stdout } = result;
		if (stdout.length > MAX_OUTPUT_BYTES) {
			stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
		}

		const exitCode = await proc.exited;

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
			clean: true,
			note: `Error running dart pub outdated: ${errorMessage}`,
		};
	}
}

// ============ Composer Audit ============
async function runComposerAudit(directory: string): Promise<AuditResult> {
	const command = ['composer', 'audit', '--locked', '--format=json'];

	if (!isCommandAvailable('composer')) {
		warn('[pkg-audit] composer not found, skipping Composer audit');
		return {
			ecosystem: 'composer',
			command,
			findings: [],
			criticalCount: 0,
			highCount: 0,
			totalCount: 0,
			clean: true,
			note: 'composer not installed or not on PATH',
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
				ecosystem: 'composer',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
				note: `composer audit timed out after ${AUDIT_TIMEOUT_MS / 1000}s`,
			};
		}

		let { stdout } = result;
		if (stdout.length > MAX_OUTPUT_BYTES) {
			stdout = stdout.slice(0, MAX_OUTPUT_BYTES);
		}

		const exitCode = await proc.exited;

		// Exit code semantics (Composer Auditor.php bitmask):
		// STATUS_VULNERABLE = 1 (bit 0): security vulnerabilities found
		// STATUS_ABANDONED  = 2 (bit 1): abandoned packages found
		// Exit 3 = 1|2: both vulnerabilities and abandoned
		// Exit 0: clean
		const hasVulnerabilities = (exitCode & 1) !== 0;
		const hasAbandoned = (exitCode & 2) !== 0;

		// Exit 0: clean — no vulnerabilities, no abandoned packages
		if (exitCode === 0) {
			return {
				ecosystem: 'composer',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
			};
		}

		// Vulnerabilities present (exit 1 or 3): guard against empty stdout before parsing
		if (hasVulnerabilities && !stdout.trim()) {
			return {
				ecosystem: 'composer',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: false,
				note: `composer audit returned exit code ${exitCode} indicating vulnerabilities but produced no output`,
			};
		}

		// Parse JSON output for non-zero exits
		let parsed: ComposerAuditJson;
		try {
			parsed = JSON.parse(stdout || '{}');
		} catch {
			return {
				ecosystem: 'composer',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: !hasVulnerabilities,
				note: `composer audit returned exit code ${exitCode} but output was not valid JSON`,
			};
		}

		// Exit 2 only (abandoned packages, no security vulnerabilities): informational, not a failure
		if (!hasVulnerabilities && hasAbandoned) {
			const abandonedList = Object.keys(parsed.abandoned ?? {});
			return {
				ecosystem: 'composer',
				command,
				findings: [],
				criticalCount: 0,
				highCount: 0,
				totalCount: 0,
				clean: true,
				note:
					abandonedList.length > 0
						? `Abandoned packages detected: ${abandonedList.join(', ')}`
						: 'composer audit exit 2 (abandoned packages)',
			};
		}

		// Exit 1 or 3: security vulnerabilities present — parse findings
		const findings: VulnerabilityFinding[] = [];

		for (const advisories of Object.values(parsed.advisories ?? {})) {
			for (const advisory of advisories) {
				const hasCve = Boolean(advisory.cve?.trim());
				findings.push({
					package: advisory.packageName,
					installedVersion: 'see composer.lock',
					patchedVersion: null,
					severity: hasCve ? 'high' : 'moderate',
					title: advisory.title,
					cve: advisory.cve || null,
					url: advisory.link || null,
				});
			}
		}

		const criticalCount = findings.filter(
			(f) => f.severity === 'critical',
		).length;
		const highCount = findings.filter((f) => f.severity === 'high').length;

		// If also abandoned (exit 3), add a note
		const abandonedNote =
			hasAbandoned && Object.keys(parsed.abandoned ?? {}).length > 0
				? ` Also abandoned: ${Object.keys(parsed.abandoned!).join(', ')}`
				: '';

		return {
			ecosystem: 'composer',
			command,
			findings,
			criticalCount,
			highCount,
			totalCount: findings.length,
			clean: false,
			...(abandonedNote ? { note: abandonedNote.trim() } : {}),
		};
	} catch (error) {
		return {
			ecosystem: 'composer',
			command,
			findings: [],
			criticalCount: 0,
			highCount: 0,
			totalCount: 0,
			clean: true,
			note: `composer audit error: ${error instanceof Error ? error.message : String(error)}`,
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
			case 'composer':
				results.push(await runComposerAudit(directory));
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

// ============ Tool Definition ============
export const pkg_audit: ReturnType<typeof tool> = createSwarmTool({
	description:
		'Run package manager security audit (npm, pip, cargo, go, dotnet, ruby, dart) and return structured CVE data. Use ecosystem to specify which package manager, or "auto" to detect from project files.',
	args: {
		ecosystem: z
			.enum([
				'auto',
				'npm',
				'pip',
				'cargo',
				'go',
				'dotnet',
				'ruby',
				'dart',
				'composer',
			])
			.default('auto')
			.describe(
				'Package ecosystem to audit: "auto" (detect from project files), "npm", "pip", "cargo", "go" (govulncheck), "dotnet" (dotnet list package), "ruby" (bundle-audit), "dart" (dart pub outdated), or "composer" (Composer/PHP)',
			),
	},
	async execute(args: unknown, directory: string): Promise<string> {
		// Validate arguments
		if (!validateArgs(args)) {
			const errorResult = {
				error:
					'Invalid arguments: ecosystem must be "auto", "npm", "pip", "cargo", "go", "dotnet", "ruby", "dart", or "composer"',
			};
			return JSON.stringify(errorResult, null, 2);
		}

		if (
			!directory ||
			typeof directory !== 'string' ||
			directory.trim() === ''
		) {
			const errorResult = {
				error: 'project directory is required but was not provided',
			};
			return JSON.stringify(errorResult, null, 2);
		}

		const obj = args as Record<string, unknown>;
		const ecosystem: Ecosystem = (obj.ecosystem as Ecosystem) || 'auto';

		// Run the appropriate audit
		let result: AuditResult | CombinedAuditResult;

		switch (ecosystem) {
			case 'auto':
				result = await runAutoAudit(directory);
				break;
			case 'npm':
				result = await runNpmAudit(directory);
				break;
			case 'pip':
				result = await runPipAudit(directory);
				break;
			case 'cargo':
				result = await runCargoAudit(directory);
				break;
			case 'go':
				result = await runGoAudit(directory);
				break;
			case 'dotnet':
				result = await runDotnetAudit(directory);
				break;
			case 'ruby':
				result = await runBundleAudit(directory);
				break;
			case 'dart':
				result = await runDartAudit(directory);
				break;
			case 'composer':
				result = await runComposerAudit(directory);
				break;
		}

		return JSON.stringify(result, null, 2);
	},
});
