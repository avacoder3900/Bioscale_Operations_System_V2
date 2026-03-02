<script lang="ts">
	interface DiffEntry {
		type: 'added' | 'removed' | 'unchanged' | 'modified';
		oldInstruction?: string;
		newInstruction?: string;
		index: number;
	}

	interface Props {
		diff: DiffEntry[];
		oldLabel?: string;
		newLabel?: string;
	}

	let { diff, oldLabel = 'Previous', newLabel = 'Current' }: Props = $props();

	const opcodeNames: Record<string, string> = {
		'0': 'START_TEST',
		'1': 'DELAY',
		'2': 'MOVE_MICRONS',
		'3': 'OSCILLATE',
		'10': 'SET_SENSOR_PARAMS',
		'11': 'BASELINE_SCANS',
		'14': 'TEST_SCANS',
		'15': 'SENSOR_READING',
		'16': 'CONTINUOUS_SCANS',
		'20': 'REPEAT_BEGIN',
		'21': 'REPEAT_END',
		'99': 'END_TEST'
	};

	function humanize(instruction: string): string {
		const parts = instruction.split(':');
		const opcode = parts[0];
		const name = opcodeNames[opcode] ?? `OP_${opcode}`;
		const args = parts[1] ?? '';
		return args ? `${name}(${args})` : name;
	}

	let hasChanges = $derived(diff.some((d) => d.type !== 'unchanged'));
</script>

<div class="bcode-diff">
	{#if !hasChanges}
		<p class="no-changes">No differences found</p>
	{:else}
		<div class="diff-header">
			<span class="diff-label old">{oldLabel}</span>
			<span class="diff-label new">{newLabel}</span>
		</div>
		<div class="diff-body">
			{#each diff as entry (entry.index)}
				<div class="diff-row {entry.type}">
					<div class="diff-cell old">
						{#if entry.type === 'removed' || entry.type === 'modified' || entry.type === 'unchanged'}
							<span class="instruction-index">{entry.index}</span>
							<code class="instruction">{entry.oldInstruction}</code>
							<span class="human">{humanize(entry.oldInstruction!)}</span>
						{/if}
					</div>
					<div class="diff-cell new">
						{#if entry.type === 'added' || entry.type === 'modified' || entry.type === 'unchanged'}
							<span class="instruction-index">{entry.index}</span>
							<code class="instruction">{entry.newInstruction}</code>
							<span class="human">{humanize(entry.newInstruction!)}</span>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<style>
	.bcode-diff {
		border: 1px solid var(--color-tron-border);
		border-radius: 0.5rem;
		overflow: hidden;
		font-size: 0.8125rem;
	}

	.no-changes {
		padding: 1.5rem;
		text-align: center;
		color: var(--color-tron-text-secondary);
	}

	.diff-header {
		display: grid;
		grid-template-columns: 1fr 1fr;
		border-bottom: 1px solid var(--color-tron-border);
		background-color: rgba(0, 0, 0, 0.3);
	}

	.diff-label {
		padding: 0.5rem 0.75rem;
		font-weight: 600;
		color: var(--color-tron-text-secondary);
		font-size: 0.75rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
	}

	.diff-label.old {
		border-right: 1px solid var(--color-tron-border);
	}

	.diff-body {
		max-height: 24rem;
		overflow-y: auto;
	}

	.diff-row {
		display: grid;
		grid-template-columns: 1fr 1fr;
		border-bottom: 1px solid rgba(255, 255, 255, 0.04);
	}

	.diff-row:last-child {
		border-bottom: none;
	}

	.diff-cell {
		padding: 0.375rem 0.75rem;
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 2rem;
	}

	.diff-cell.old {
		border-right: 1px solid var(--color-tron-border);
	}

	.diff-row.unchanged .diff-cell {
		opacity: 0.5;
	}

	.diff-row.modified .diff-cell.old {
		background-color: rgba(255, 100, 100, 0.08);
	}

	.diff-row.modified .diff-cell.new {
		background-color: rgba(100, 255, 100, 0.08);
	}

	.diff-row.removed .diff-cell.old {
		background-color: rgba(255, 100, 100, 0.12);
	}

	.diff-row.added .diff-cell.new {
		background-color: rgba(100, 255, 100, 0.12);
	}

	.instruction-index {
		color: var(--color-tron-text-secondary);
		opacity: 0.5;
		font-size: 0.6875rem;
		min-width: 1.25rem;
		text-align: right;
	}

	.instruction {
		font-family: monospace;
		color: var(--color-tron-cyan);
		font-size: 0.75rem;
	}

	.diff-row.removed .instruction {
		color: var(--color-tron-red);
	}

	.diff-row.added .instruction {
		color: var(--color-tron-green);
	}

	.human {
		color: var(--color-tron-text-secondary);
		font-size: 0.6875rem;
		margin-left: auto;
		white-space: nowrap;
	}
</style>
