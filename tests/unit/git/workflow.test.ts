import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { runPRWorkflow } from '../../../src/git/index.js';

// Track createBranch calls for verification
const createBranchCalls: Array<{
	cwd: string;
	branchName: string;
	remote: string;
	laneEnv?: Record<string, string>;
	laneIndex?: number;
}> = [];

mock.module('../../../src/git/branch.js', () => ({
	isGitRepo: mock(),
	createBranch: (
		cwd: string,
		branchName: string,
		remote?: string,
		laneEnv?: Record<string, string>,
		laneIndex?: number,
	) => {
		createBranchCalls.push({
			cwd,
			branchName,
			remote: remote ?? 'origin',
			laneEnv,
			laneIndex,
		});
	},
}));

mock.module('../../../src/git/pr.js', () => ({
	isGhAvailable: mock(),
	isAuthenticated: mock(),
	createPullRequest: mock(),
	commitAndPush: mock(),
}));

// Import after mock setup
import { isGitRepo } from '../../../src/git/branch.js';
import {
	commitAndPush,
	createPullRequest,
	isAuthenticated,
	isGhAvailable,
} from '../../../src/git/pr.js';

describe('Task 7.3: Git workflow integration', () => {
	const mockCwd = '/test/cwd';

	beforeEach(() => {
		mock.restore();
		createBranchCalls.length = 0;
	});

	describe('runPRWorkflow checks git repo', () => {
		it('should return error when not a git repository', async () => {
			(isGitRepo as ReturnType<typeof mock>).mockReturnValue(false);

			const result = await runPRWorkflow(mockCwd, { title: 'Test PR' });

			expect(result.success).toBe(false);
			expect(result.error).toBe('Not a git repository');
			expect(isGitRepo).toHaveBeenCalledWith(mockCwd);
		});

		it('should proceed when directory is a git repository', async () => {
			(isGitRepo as ReturnType<typeof mock>).mockReturnValue(true);
			(isGhAvailable as ReturnType<typeof mock>).mockReturnValue(true);
			(isAuthenticated as ReturnType<typeof mock>).mockReturnValue(true);
			(createPullRequest as ReturnType<typeof mock>).mockResolvedValue({
				url: 'https://github.com/test/repo/pull/1',
				number: 1,
			});

			const result = await runPRWorkflow(mockCwd, { title: 'Test PR' });

			expect(result.success).toBe(true);
		});
	});

	describe('runPRWorkflow createBranch lane parameters', () => {
		it('passes laneEnv and laneIndex to createBranch when provided', async () => {
			(isGitRepo as ReturnType<typeof mock>).mockReturnValue(true);
			(isGhAvailable as ReturnType<typeof mock>).mockReturnValue(true);
			(isAuthenticated as ReturnType<typeof mock>).mockReturnValue(true);
			(commitAndPush as ReturnType<typeof mock>).mockResolvedValue(undefined);
			(createPullRequest as ReturnType<typeof mock>).mockResolvedValue({
				url: 'https://github.com/test/repo/pull/1',
				number: 1,
			});

			const laneEnv = { LANE_VAR: 'lane_value' };
			const result = await runPRWorkflow(mockCwd, {
				title: 'Test PR',
				branch: 'feature/test',
				laneEnv,
				laneIndex: 3,
			});

			expect(result.success).toBe(true);
			expect(createBranchCalls).toHaveLength(1);
			expect(createBranchCalls[0]).toEqual({
				cwd: mockCwd,
				branchName: 'feature/test',
				remote: 'origin',
				laneEnv,
				laneIndex: 3,
			});
		});

		it('passes only laneIndex to createBranch when laneEnv not provided', async () => {
			(isGitRepo as ReturnType<typeof mock>).mockReturnValue(true);
			(isGhAvailable as ReturnType<typeof mock>).mockReturnValue(true);
			(isAuthenticated as ReturnType<typeof mock>).mockReturnValue(true);
			(commitAndPush as ReturnType<typeof mock>).mockResolvedValue(undefined);
			(createPullRequest as ReturnType<typeof mock>).mockResolvedValue({
				url: 'https://github.com/test/repo/pull/1',
				number: 1,
			});

			const result = await runPRWorkflow(mockCwd, {
				title: 'Test PR',
				branch: 'feature/test',
				laneIndex: 5,
			});

			expect(result.success).toBe(true);
			expect(createBranchCalls).toHaveLength(1);
			expect(createBranchCalls[0]).toEqual({
				cwd: mockCwd,
				branchName: 'feature/test',
				remote: 'origin',
				laneEnv: undefined,
				laneIndex: 5,
			});
		});

		it('does not pass lane parameters when neither provided', async () => {
			(isGitRepo as ReturnType<typeof mock>).mockReturnValue(true);
			(isGhAvailable as ReturnType<typeof mock>).mockReturnValue(true);
			(isAuthenticated as ReturnType<typeof mock>).mockReturnValue(true);
			(commitAndPush as ReturnType<typeof mock>).mockResolvedValue(undefined);
			(createPullRequest as ReturnType<typeof mock>).mockResolvedValue({
				url: 'https://github.com/test/repo/pull/1',
				number: 1,
			});

			const result = await runPRWorkflow(mockCwd, {
				title: 'Test PR',
				branch: 'feature/test',
			});

			expect(result.success).toBe(true);
			expect(createBranchCalls).toHaveLength(1);
			expect(createBranchCalls[0]).toEqual({
				cwd: mockCwd,
				branchName: 'feature/test',
				remote: 'origin',
				laneEnv: undefined,
				laneIndex: undefined,
			});
		});
	});

	describe('runPRWorkflow checks gh CLI', () => {
		it('should return error when gh CLI is not available', async () => {
			(isGitRepo as ReturnType<typeof mock>).mockReturnValue(true);
			(isGhAvailable as ReturnType<typeof mock>).mockReturnValue(false);

			const result = await runPRWorkflow(mockCwd, { title: 'Test PR' });

			expect(result.success).toBe(false);
			expect(result.error).toBe('GitHub CLI (gh) not available');
		});

		it('should proceed when gh CLI is available', async () => {
			(isGitRepo as ReturnType<typeof mock>).mockReturnValue(true);
			(isGhAvailable as ReturnType<typeof mock>).mockReturnValue(true);
			(isAuthenticated as ReturnType<typeof mock>).mockReturnValue(true);
			(createPullRequest as ReturnType<typeof mock>).mockResolvedValue({
				url: 'https://github.com/test/repo/pull/1',
				number: 1,
			});

			const result = await runPRWorkflow(mockCwd, { title: 'Test PR' });

			expect(result.success).toBe(true);
			expect(isGhAvailable).toHaveBeenCalledWith(mockCwd);
		});
	});

	describe('runPRWorkflow checks authentication', () => {
		it('should return error when not authenticated with GitHub', async () => {
			(isGitRepo as ReturnType<typeof mock>).mockReturnValue(true);
			(isGhAvailable as ReturnType<typeof mock>).mockReturnValue(true);
			(isAuthenticated as ReturnType<typeof mock>).mockReturnValue(false);

			const result = await runPRWorkflow(mockCwd, { title: 'Test PR' });

			expect(result.success).toBe(false);
			expect(result.error).toBe(
				'Not authenticated with GitHub. Run: gh auth login',
			);
		});

		it('should proceed when authenticated with GitHub', async () => {
			(isGitRepo as ReturnType<typeof mock>).mockReturnValue(true);
			(isGhAvailable as ReturnType<typeof mock>).mockReturnValue(true);
			(isAuthenticated as ReturnType<typeof mock>).mockReturnValue(true);
			(createPullRequest as ReturnType<typeof mock>).mockResolvedValue({
				url: 'https://github.com/test/repo/pull/1',
				number: 1,
			});

			const result = await runPRWorkflow(mockCwd, { title: 'Test PR' });

			expect(result.success).toBe(true);
			expect(isAuthenticated).toHaveBeenCalledWith(mockCwd);
		});
	});

	describe('runPRWorkflow full flow', () => {
		it('should create PR successfully when all checks pass', async () => {
			(isGitRepo as ReturnType<typeof mock>).mockReturnValue(true);
			(isGhAvailable as ReturnType<typeof mock>).mockReturnValue(true);
			(isAuthenticated as ReturnType<typeof mock>).mockReturnValue(true);
			(commitAndPush as ReturnType<typeof mock>).mockResolvedValue(undefined);
			(createPullRequest as ReturnType<typeof mock>).mockResolvedValue({
				url: 'https://github.com/test/repo/pull/42',
				number: 42,
			});

			const result = await runPRWorkflow(mockCwd, {
				title: 'Add new feature',
				body: 'Feature description',
			});

			expect(result.success).toBe(true);
			expect(result.url).toBe('https://github.com/test/repo/pull/42');
			expect(result.number).toBe(42);
		});

		it('should handle PR creation failure gracefully', async () => {
			(isGitRepo as ReturnType<typeof mock>).mockReturnValue(true);
			(isGhAvailable as ReturnType<typeof mock>).mockReturnValue(true);
			(isAuthenticated as ReturnType<typeof mock>).mockReturnValue(true);
			(commitAndPush as ReturnType<typeof mock>).mockResolvedValue(undefined);
			(createPullRequest as ReturnType<typeof mock>).mockRejectedValue(
				new Error('PR creation failed'),
			);

			const result = await runPRWorkflow(mockCwd, { title: 'Test PR' });

			expect(result.success).toBe(false);
			expect(result.error).toContain('PR creation failed');
		});
	});
});
