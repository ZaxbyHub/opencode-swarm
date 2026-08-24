import { describe, expect, test } from 'bun:test';
import { gateDenialDiscriminator } from '../../../src/hooks/gate-denial-tracker';

describe('gate denial discriminator — plan-task identity (issue #2103 workstream C)', () => {
	test('denials for different strict plan tasks to the same role do not share a streak key', () => {
		const a = gateDenialDiscriminator('task', {
			subagent_type: 'coder',
			task_id: '3.2.1',
		});
		const b = gateDenialDiscriminator('task', {
			subagent_type: 'coder',
			task_id: '3.2.2',
		});
		expect(a).not.toBe(b);
	});

	test('a retry of the same strict task shares the streak key', () => {
		const a = gateDenialDiscriminator('task', {
			subagent_type: 'mega_coder',
			taskId: '1.1',
		});
		const b = gateDenialDiscriminator('task', {
			subagent_type: 'coder',
			task_id: '1.1',
		});
		expect(a).toBe(b);
	});

	test('non-strict task ids and prose never become part of the key (bounded cardinality)', () => {
		const base = gateDenialDiscriminator('task', { subagent_type: 'coder' });
		const withProse = gateDenialDiscriminator('task', {
			subagent_type: 'coder',
			task_id: 'do arbitrary stuff now please',
		});
		expect(withProse).toBe(base);
	});

	test('discriminator stays bounded', () => {
		const d = gateDenialDiscriminator('task', {
			subagent_type: 'coder',
			task_id: '12.34.56',
		});
		expect(d.length).toBeLessThanOrEqual(64);
	});
});
