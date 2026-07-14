// @ts-nocheck
/**
 * Adversarial Security Tests for .github/workflows/ci.yml
 *
 * Tests for:
 * - Expression injection risks (${{ }} with user-controlled data)
 * - Action version pinning (tags vs SHA)
 * - GITHUB_TOKEN permissions declaration
 * - Secret exposure risks
 * - Command injection patterns in run: steps
 */

import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';

// ANSI color codes for terminal output
const colors = {
	red: '\x1b[31m',
	green: '\x1b[32m',
	yellow: '\x1b[33m',
	cyan: '\x1b[36m',
	reset: '\x1b[0m',
};

class WorkflowSecurityTester {
	constructor(filePath) {
		this.filePath = filePath;
		this.workflow = null;
		this.findings = [];
		this.testResults = [];
	}

	load() {
		try {
			const content = fs.readFileSync(this.filePath, 'utf8');
			this.workflow = yaml.load(content) as any;
			return true;
		} catch (error) {
			console.error(
				`${colors.red}ERROR: Failed to load workflow file: ${error.message}${colors.reset}`,
			);
			return false;
		}
	}

	/**
	 * TEST 1: Check for expression injection risks
	 * Verify that ${{ }} expressions don't use user-controlled data like:
	 * - github.event.commits[*].author.email
	 * - github.event.head_commit.message
	 * - github.event.pull_request.*.body
	 * Note: matrix.* values are excluded as they are author-controlled (defined in strategy.matrix)
	 */
	testExpressionInjection() {
		const testName = 'Expression Injection Risks';
		const result = { name: testName, passed: true, issues: [] };

		const dangerousContexts = [
			'github.event.commits',
			'github.event.head_commit.message',
			'github.event.pull_request',
			'github.event.issue',
			'github.event.comment',
			'github.event.review',
		];

		function checkExpressions(obj, path = '', inEnvBlock = false) {
			if (typeof obj === 'string') {
				// Check for expression syntax
				const expressionRegex = /\$\{\{[^}]+\}\}/g;
				const matches = obj.match(expressionRegex);

				if (matches) {
					for (const match of matches) {
						for (const dangerousCtx of dangerousContexts) {
							if (match.includes(dangerousCtx)) {
								if (inEnvBlock) {
									// Assigning a dangerous context to an `env:` var is
									// GitHub's own recommended mitigation for expression
									// injection (see "Using an intermediate environment
									// variable" in GitHub's security-hardening docs): the
									// value becomes a shell environment variable, not text
									// spliced into the run: script, so it cannot alter the
									// script's syntax. Still flag the same context when it
									// appears directly inline (e.g. in a `run:` string),
									// since that is the actually-dangerous placement.
									continue;
								}
								result.passed = false;
								result.issues.push({
									location: path,
									expression: match,
									risk: `Contains potentially user-controlled context: ${dangerousCtx}`,
								});
							}
						}
					}
				}
			} else if (Array.isArray(obj)) {
				obj.forEach((item, index) =>
					checkExpressions(item, `${path}[${index}]`, inEnvBlock),
				);
			} else if (obj && typeof obj === 'object') {
				Object.keys(obj).forEach((key) =>
					checkExpressions(
						obj[key],
						`${path}.${key}`,
						inEnvBlock || key === 'env',
					),
				);
			}
		}

		checkExpressions(this.workflow);

		this.testResults.push(result);
		return result;
	}

	/**
	 * TEST 2: Check action version pinning
	 * Verify actions use SHA pinning for production workflows
	 * Note: Tags (v4, v2) are acceptable per project spec, but we should flag for review
	 */
	testActionVersionPinning() {
		const testName = 'Action Version Pinning';
		const result = { name: testName, passed: true, issues: [] };

		if (!this.workflow.jobs) {
			this.testResults.push(result);
			return result;
		}

		function findActions(obj, path = '') {
			if (obj && typeof obj === 'object') {
				if (obj.uses) {
					const actionRef = obj.uses;
					const [owner, repo, ref] = actionRef.split('@');

					// Check if it's a tag (not a SHA)
					if (ref && !ref.match(/^[a-f0-9]{40}$/i)) {
						// Tags are acceptable per project spec, but we flag for awareness
						result.issues.push({
							location: path,
							action: actionRef,
							severity: 'info',
							note: 'Action uses tag instead of SHA (acceptable per project spec)',
						});
					}
				}

				Object.keys(obj).forEach((key) =>
					findActions(obj[key], `${path}.${key}`),
				);
			}
		}

		Object.keys(this.workflow.jobs).forEach((jobName) => {
			findActions(this.workflow.jobs[jobName], `jobs.${jobName}`);
		});

		this.testResults.push(result);
		return result;
	}

	/**
	 * TEST 3: Check for GITHUB_TOKEN permissions
	 * Verify that permissions block is declared with principle of least privilege
	 */
	testPermissions() {
		const testName = 'GITHUB_TOKEN Permissions';
		const result = { name: testName, passed: false, issues: [] };

		if (!this.workflow.permissions) {
			result.issues.push({
				type: 'missing-permissions-block',
				severity: 'high',
				message:
					'No permissions block declared. Default GITHUB_TOKEN gets write permissions which may be excessive.',
			});
		} else {
			result.passed = true;
			result.issues.push({
				type: 'permissions-block-found',
				severity: 'info',
				message: 'Permissions block is declared',
			});

			// Check for overly permissive settings
			if (
				this.workflow.permissions === 'write-all' ||
				this.workflow.permissions === 'read-all'
			) {
				result.passed = false;
				result.issues.push({
					type: 'overly-permissive',
					severity: 'high',
					message: 'Permissions set to overly permissive mode',
				});
			}
		}

		this.testResults.push(result);
		return result;
	}

	/**
	 * TEST 4: Check for secret exposure risks
	 * Look for patterns that could leak secrets:
	 * - Direct use of secrets in expressions without proper masking
	 * - Secrets used in scripts that might log output
	 */
	testSecretExposure() {
		const testName = 'Secret Exposure Risks';
		const result = { name: testName, passed: true, issues: [] };

		function checkSecrets(obj, path = '') {
			if (typeof obj === 'string') {
				// Check for direct secret references in potentially unsafe contexts
				const secretInExpressionRegex = /\$\{\{ secrets\.[\w.-]+ \}\}/g;
				const matches = obj.match(secretInExpressionRegex);

				if (matches && path.includes('run')) {
					result.passed = false;
					result.issues.push({
						location: path,
						pattern: matches.join(', '),
						risk: 'Secret used in run: step may be exposed in logs',
					});
				}

				// Check for echo/print statements with variables
				const echoWithVars =
					/^(echo|print|Write-Host|console\.log)\s+.*\$\{/.test(obj);
				if (echoWithVars) {
					result.issues.push({
						location: path,
						severity: 'warning',
						note: 'Echo statement with variable - potential secret leak',
					});
				}
			} else if (Array.isArray(obj)) {
				obj.forEach((item, index) => checkSecrets(item, `${path}[${index}]`));
			} else if (obj && typeof obj === 'object') {
				Object.keys(obj).forEach((key) =>
					checkSecrets(obj[key], `${path}.${key}`),
				);
			}
		}

		checkSecrets(this.workflow);
		this.testResults.push(result);
		return result;
	}

	/**
	 * TEST 5: Check for command injection patterns in run: steps
	 * Look for unsafe command patterns:
	 * - Unquoted variables in commands
	 * - Command substitution backticks
	 * - Direct use of user input in commands
	 */
	testCommandInjection() {
		const testName = 'Command Injection Patterns';
		const result = { name: testName, passed: true, issues: [] };

		const dangerousPatterns = [
			{
				pattern: /\$[a-zA-Z_][\w]*\s*;/,
				risk: 'Variable in command context without proper quoting',
			},
			{ pattern: /`[^`]*`/, risk: 'Command substitution backticks' },
			{ pattern: /\$\([^)]*\)/, risk: 'Command substitution $()' },
			{
				pattern: /(?<!\|)\|(?!\|)\s*\$[\w(]/,
				risk: 'Pipe to command substitution or variable',
			},
			{
				pattern: />\s*\$\(/,
				risk: 'Output redirection with command substitution',
			},
		];

		if (!this.workflow.jobs) {
			this.testResults.push(result);
			return result;
		}

		function checkRunSteps(obj, path = '') {
			if (obj && typeof obj === 'object') {
				if (obj.run && typeof obj.run === 'string') {
					const command = obj.run;

					for (const { pattern, risk } of dangerousPatterns) {
						if (pattern.test(command)) {
							result.passed = false;
							result.issues.push({
								location: path,
								command: command.substring(0, 100),
								risk: risk,
							});
						}
					}

					// Check for expressions in run steps (potential injection)
					const exprInRun = /\$\{\{[^}]+\}\}/.test(command);
					if (exprInRun) {
						result.passed = false;
						result.issues.push({
							location: path,
							risk: 'Expression ${{ }} used in run: step - potential command injection vector',
						});
					}
				}

				Object.keys(obj).forEach((key) =>
					checkRunSteps(obj[key], `${path}.${key}`),
				);
			}
		}

		Object.keys(this.workflow.jobs).forEach((jobName) => {
			checkRunSteps(this.workflow.jobs[jobName], `jobs.${jobName}`);
		});

		this.testResults.push(result);
		return result;
	}

	/**
	 * TEST 6: Check for dangerous workflow triggers
	 * Look for overly permissive triggers
	 */
	testTriggers() {
		const testName = 'Workflow Trigger Safety';
		const result = { name: testName, passed: true, issues: [] };

		// Check if branches: ["**"] is used (triggers on ALL branches including wildcards)
		if (this.workflow.on) {
			['push', 'pull_request'].forEach((eventType) => {
				if (this.workflow.on[eventType]) {
					const branches = this.workflow.on[eventType].branches;
					if (Array.isArray(branches) && branches.includes('**')) {
						result.issues.push({
							event: eventType,
							branches: branches,
							severity: 'warning',
							risk: 'Triggered on all branches using "**" - may run on untrusted branches',
						});
					}
				}
			});
		}

		// Check for workflow_run trigger without proper filtering
		if (this.workflow.on?.workflow_run) {
			result.issues.push({
				severity: 'info',
				note: 'workflow_run trigger present - ensure proper filtering is in place',
			});
		}

		this.testResults.push(result);
		return result;
	}

	/**
	 * TEST 7: Check for resource exfiltration risks
	 * Look for patterns that could exfiltrate code or artifacts
	 */
	testResourceExfiltration() {
		const testName = 'Resource Exfiltration Risks';
		const result = { name: testName, passed: true, issues: [] };

		if (!this.workflow.jobs) {
			this.testResults.push(result);
			return result;
		}

		function checkExfiltration(obj, path = '') {
			if (obj && typeof obj === 'object') {
				// Check for upload-artifact with potentially sensitive paths
				if (obj.uses?.includes('upload-artifact')) {
					const pathVal = obj.with?.path;
					if (
						pathVal &&
						(pathVal.includes('node_modules') || pathVal.includes('.git'))
					) {
						result.passed = false;
						result.issues.push({
							location: path,
							artifact: obj.with.name || 'unnamed',
							path: pathVal,
							risk: 'Uploading sensitive directories (node_modules, .git)',
						});
					}
				}

				// Check for script execution with expressions
				if (obj.run) {
					if (
						obj.run.includes('curl') ||
						obj.run.includes('wget') ||
						obj.run.includes('Invoke-WebRequest')
					) {
						const hasExpr = /\$\{\{[^}]+\}\}/.test(obj.run);
						if (hasExpr) {
							result.passed = false;
							result.issues.push({
								location: path,
								risk: 'Network request with expression - potential SSRF or exfiltration',
							});
						}
					}
				}

				Object.keys(obj).forEach((key) =>
					checkExfiltration(obj[key], `${path}.${key}`),
				);
			}
		}

		Object.keys(this.workflow.jobs).forEach((jobName) => {
			checkExfiltration(this.workflow.jobs[jobName], `jobs.${jobName}`);
		});

		this.testResults.push(result);
		return result;
	}

	runAllTests() {
		if (!this.load()) {
			return false;
		}

		console.log(
			`\n${colors.cyan}=== ADVERSARIAL SECURITY TEST SUITE ===${colors.reset}`,
		);
		console.log(`${colors.cyan}Target: ${this.filePath}${colors.reset}\n`);

		this.testExpressionInjection();
		this.testActionVersionPinning();
		this.testPermissions();
		this.testSecretExposure();
		this.testCommandInjection();
		this.testTriggers();
		this.testResourceExfiltration();

		return true;
	}

	printResults() {
		console.log(`\n${colors.cyan}=== TEST RESULTS ===${colors.reset}\n`);

		let totalTests = 0;
		let passedTests = 0;
		let failedTests = 0;
		const allFailures = [];

		for (const result of this.testResults) {
			totalTests++;

			if (result.passed) {
				passedTests++;
				console.log(`${colors.green}✓ PASS${colors.reset}: ${result.name}`);
			} else {
				failedTests++;
				console.log(`${colors.red}✗ FAIL${colors.reset}: ${result.name}`);
			}

			// Print issues if any
			if (result.issues && result.issues.length > 0) {
				for (const issue of result.issues) {
					if (issue.severity === 'info') {
						console.log(
							`  ${colors.cyan}ℹ INFO${colors.reset}: ${issue.message || issue.note || issue.risk}`,
						);
						if (issue.location) console.log(`    Location: ${issue.location}`);
					} else {
						allFailures.push({
							test: result.name,
							...issue,
						});
						console.log(
							`  ${colors.red}⚠ ${issue.severity || 'FINDING'}${colors.reset}: ${issue.message || issue.risk}`,
						);
						if (issue.location) console.log(`    Location: ${issue.location}`);
						if (issue.expression || issue.command)
							console.log(`    Pattern: ${issue.expression || issue.command}`);
					}
				}
			}
		}

		console.log(`\n${colors.cyan}=== SUMMARY ===${colors.reset}`);
		console.log(`Total Tests: ${totalTests}`);
		console.log(`Passed: ${colors.green}${passedTests}${colors.reset}`);
		console.log(`Failed: ${colors.red}${failedTests}${colors.reset}`);

		// Overall verdict
		const verdict = failedTests === 0 ? 'PASS' : 'FAIL';
		const verdictColor = verdict === 'PASS' ? colors.green : colors.red;
		console.log(
			`\n${colors.cyan}VERDICT:${colors.reset} ${verdictColor}${verdict}${colors.reset}`,
		);

		return {
			verdict,
			totalTests,
			passedTests,
			failedTests,
			failures: allFailures,
		};
	}
}

describe('CI Workflow Security', () => {
	const workflowPath = path.join(
		import.meta.dir,
		'..',
		'..',
		'.github',
		'workflows',
		'ci.yml',
	);
	const tester = new WorkflowSecurityTester(workflowPath);
	tester.load();
	tester.runAllTests();

	for (const result of (tester as any).testResults) {
		test(result.name, () => {
			expect(result.passed).toBe(true);
		});
	}
});
