<script lang="ts">
	interface Props {
		value: string | null;
		onchange: (value: 'pass' | 'fail') => void;
	}

	let { value, onchange }: Props = $props();
</script>

<div class="flex gap-2">
	<button
		type="button"
		onclick={() => onchange('pass')}
		class="flex-1 rounded px-4 py-3 text-sm font-medium transition {value === 'pass'
			? 'bg-green-500/20 text-green-400 ring-1 ring-green-500/50'
			: 'border border-[var(--color-tron-border)] hover:bg-white/5'}"
	>
		Pass
	</button>
	<button
		type="button"
		onclick={() => onchange('fail')}
		class="flex-1 rounded px-4 py-3 text-sm font-medium transition {value === 'fail'
			? 'bg-red-500/20 text-red-400 ring-1 ring-red-500/50'
			: 'border border-[var(--color-tron-border)] hover:bg-white/5'}"
	>
		Fail
	</button>
</div>
