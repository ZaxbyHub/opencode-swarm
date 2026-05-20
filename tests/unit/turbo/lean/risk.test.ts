/**
 * Tests for Lean Turbo risk assessment.
 * File: tests/unit/turbo/lean/risk.test.ts
 */
import { describe, expect, test } from 'bun:test';
import type { LeanTurboConfig } from '../../../../src/config/schema';
import {
	assessTaskRisk,
	type TaskRiskAssessment,
} from '../../../../src/turbo/lean/risk';

describe('assessTaskRisk', () => {
	// Default config for tests
	const defaultConfig: LeanTurboConfig = {
		max_parallel_coders: 4,
		require_declared_scope: true,
		conflict_policy: 'serialize',
		degrade_on_risk: true,
		phase_reviewer: true,
		phase_critic: true,
		integrated_diff_required: true,
		allow_docs_only_without_reviewer: false,
		worktree_isolation: false,
	};

	const configNoRequireScope: LeanTurboConfig = {
		...defaultConfig,
		require_declared_scope: false,
	};

	test('normal files return normal category', () => {
		const result = assessTaskRisk(
			['src/feature.ts', 'src/module.ts'],
			true, // hasDeclaredScope
			false, // hasInvalidScope
			defaultConfig,
		);

		expect(result.category).toBe('normal');
		expect(result.files).toEqual([]);
	});

	test('package.json returns global category', () => {
		const result = assessTaskRisk(['package.json'], true, false, defaultConfig);

		expect(result.category).toBe('global');
		expect(result.reason).toBe('global file conflict');
		expect(result.files).toEqual(['package.json']);
	});

	test('package-lock.json returns global category', () => {
		const result = assessTaskRisk(
			['package-lock.json'],
			true,
			false,
			defaultConfig,
		);

		expect(result.category).toBe('global');
		expect(result.reason).toBe('global file conflict');
	});

	test('tsconfig.json returns global category', () => {
		const result = assessTaskRisk(
			['tsconfig.json'],
			true,
			false,
			defaultConfig,
		);

		expect(result.category).toBe('global');
		expect(result.reason).toBe('global file conflict');
	});

	test('src/index.ts barrel file returns global category', () => {
		const result = assessTaskRisk(['src/index.ts'], true, false, defaultConfig);

		expect(result.category).toBe('global');
		expect(result.reason).toBe('global file conflict');
	});

	test('protected path returns protected category', () => {
		const result = assessTaskRisk(
			['src/guardrails.ts'],
			true,
			false,
			defaultConfig,
		);

		expect(result.category).toBe('protected');
		expect(result.reason).toBe('protected path');
		expect(result.files).toEqual(['src/guardrails.ts']);
	});

	test('auth path returns protected category', () => {
		const result = assessTaskRisk(
			['src/auth/login.ts'],
			true,
			false,
			defaultConfig,
		);

		expect(result.category).toBe('protected');
		expect(result.reason).toBe('protected path');
	});

	test('no declared scope with require_declared_scope=true returns no-scope category', () => {
		const result = assessTaskRisk(
			['src/feature.ts'],
			false, // hasDeclaredScope
			false,
			defaultConfig,
		);

		expect(result.category).toBe('no-scope');
		expect(result.reason).toBe('undeclared scope');
	});

	test('no declared scope with require_declared_scope=false returns normal category', () => {
		const result = assessTaskRisk(
			['src/feature.ts'],
			false, // hasDeclaredScope
			false,
			configNoRequireScope,
		);

		expect(result.category).toBe('normal');
	});

	test('invalid scope entries return invalid-scope category', () => {
		const result = assessTaskRisk(
			['src/feature.ts'],
			true,
			true, // hasInvalidScope
			defaultConfig,
		);

		expect(result.category).toBe('invalid-scope');
		expect(result.reason).toBe('invalid scope entries');
	});

	test('priority: global files checked before protected paths', () => {
		// package.json is both global AND matches protected patterns
		const result = assessTaskRisk(['package.json'], true, false, defaultConfig);

		// Global should win (checked first)
		expect(result.category).toBe('global');
		expect(result.reason).toBe('global file conflict');
	});

	test('priority: protected paths checked before no-scope', () => {
		// Protected path with no declared scope
		const result = assessTaskRisk(
			['src/guardrails.ts'],
			false, // hasDeclaredScope
			false,
			defaultConfig,
		);

		// Protected should win (checked before no-scope)
		expect(result.category).toBe('protected');
	});

	test('priority: invalid-scope checked before no-scope', () => {
		const result = assessTaskRisk(
			['src/feature.ts'],
			true,
			true, // hasInvalidScope
			defaultConfig,
		);

		// Invalid-scope should win (using non-protected path)
		expect(result.category).toBe('invalid-scope');
	});

	test('empty files array with declared scope returns normal', () => {
		const result = assessTaskRisk([], true, false, defaultConfig);

		expect(result.category).toBe('normal');
	});

	test('empty files array without declared scope returns no-scope when required', () => {
		const result = assessTaskRisk([], false, false, defaultConfig);

		expect(result.category).toBe('no-scope');
	});

	test('empty files array without declared scope returns normal when not required', () => {
		const result = assessTaskRisk([], false, false, configNoRequireScope);

		expect(result.category).toBe('normal');
	});

	test('returns all global files in the files array', () => {
		const result = assessTaskRisk(
			['package.json', 'src/auth.ts', 'tsconfig.json'],
			true,
			false,
			defaultConfig,
		);

		expect(result.category).toBe('global');
		expect(result.files).toEqual(['package.json', 'tsconfig.json']);
	});

	test('returns all protected files in the files array', () => {
		const result = assessTaskRisk(
			['src/auth.ts', 'src/guardrails.ts', 'src/login.ts'],
			true,
			false,
			defaultConfig,
		);

		expect(result.category).toBe('protected');
		// src/auth.ts and src/guardrails.ts are protected, src/login.ts is not
		expect(result.files).toEqual(['src/auth.ts', 'src/guardrails.ts']);
	});

	test('.env file is protected', () => {
		const result = assessTaskRisk(['.env'], true, false, defaultConfig);

		expect(result.category).toBe('protected');
		expect(result.reason).toBe('protected path');
	});

	test('turbo.json is global', () => {
		const result = assessTaskRisk(['turbo.json'], true, false, defaultConfig);

		expect(result.category).toBe('global');
	});

	test('multiple files with mixed risk - global wins', () => {
		const result = assessTaskRisk(
			['src/auth.ts', 'package.json', 'src/login.ts'],
			true,
			false,
			defaultConfig,
		);

		expect(result.category).toBe('global');
	});
});

describe('TaskRiskAssessment type', () => {
	test('has correct structure for normal category', () => {
		const result = assessTaskRisk([], true, false, {
			max_parallel_coders: 4,
			require_declared_scope: true,
			conflict_policy: 'serialize',
			degrade_on_risk: true,
			phase_reviewer: true,
			phase_critic: true,
			integrated_diff_required: true,
			allow_docs_only_without_reviewer: false,
			worktree_isolation: false,
		});

		const assessment = result as TaskRiskAssessment;
		expect(assessment.category).toBe('normal');
		expect(assessment.reason).toBeUndefined();
		expect(Array.isArray(assessment.files)).toBe(true);
	});

	test('has correct structure for global category', () => {
		const result = assessTaskRisk(['package.json'], true, false, {
			max_parallel_coders: 4,
			require_declared_scope: true,
			conflict_policy: 'serialize',
			degrade_on_risk: true,
			phase_reviewer: true,
			phase_critic: true,
			integrated_diff_required: true,
			allow_docs_only_without_reviewer: false,
			worktree_isolation: false,
		});

		const assessment = result as TaskRiskAssessment;
		expect(assessment.category).toBe('global');
		expect(assessment.reason).toBe('global file conflict');
	});
});
