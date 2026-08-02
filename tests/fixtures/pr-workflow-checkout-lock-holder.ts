import { withPrWorkflowCheckoutMutationLock } from '../../src/hooks/pr-workflow-gate';

const directory = process.argv[2];
if (!directory)
	throw new Error('checkout-lock holder requires a project directory');

await withPrWorkflowCheckoutMutationLock(directory, async () => {
	process.stdout.write('LOCKED\n');
	await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
});
