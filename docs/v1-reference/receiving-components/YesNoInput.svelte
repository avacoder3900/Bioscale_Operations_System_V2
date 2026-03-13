<script lang="ts">
	interface Props {
		value: string | null;
		acceptableAnswer: string;
		onchange: (value: 'yes' | 'no') => void;
	}

	let { value, acceptableAnswer, onchange }: Props = $props();

	function buttonClass(option: 'yes' | 'no'): string {
		if (value !== option) return 'border border-[var(--color-tron-border)] hover:bg-white/5';
		const isPass = option === acceptableAnswer;
		return isPass
			? 'bg-green-500/20 text-green-400 ring-1 ring-green-500/50'
			: 'bg-red-500/20 text-red-400 ring-1 ring-red-500/50';
	}
</script>

<div class="flex gap-2">
	<button
		type="button"
		onclick={() => onchange('yes')}
		class="flex-1 rounded px-4 py-3 text-sm font-medium transition {buttonClass('yes')}"
	>
		Yes
	</button>
	<button
		type="button"
		onclick={() => onchange('no')}
		class="flex-1 rounded px-4 py-3 text-sm font-medium transition {buttonClass('no')}"
	>
		No
	</button>
</div>
