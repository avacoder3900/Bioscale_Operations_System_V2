<script lang="ts">
	interface Props {
		value: string | null;
		notes: string;
		onchange: (value: 'pass' | 'fail', notes: string) => void;
	}

	let { value, notes, onchange }: Props = $props();

	let localNotes = $state('');
	let prevNotes = $state('');

	$effect.pre(() => {
		if (notes !== prevNotes) {
			localNotes = notes;
			prevNotes = notes;
		}
	});

	function handleClick(v: 'pass' | 'fail') {
		onchange(v, localNotes);
	}

	function handleNotes(e: Event) {
		localNotes = (e.target as HTMLTextAreaElement).value;
		if (value) onchange(value as 'pass' | 'fail', localNotes);
	}
</script>

<div class="space-y-2">
	<div class="flex gap-2">
		<button
			type="button"
			onclick={() => handleClick('pass')}
			class="flex-1 rounded px-4 py-3 text-sm font-medium transition {value === 'pass'
				? 'bg-green-500/20 text-green-400 ring-1 ring-green-500/50'
				: 'border border-[var(--color-tron-border)] hover:bg-white/5'}"
		>
			Pass
		</button>
		<button
			type="button"
			onclick={() => handleClick('fail')}
			class="flex-1 rounded px-4 py-3 text-sm font-medium transition {value === 'fail'
				? 'bg-red-500/20 text-red-400 ring-1 ring-red-500/50'
				: 'border border-[var(--color-tron-border)] hover:bg-white/5'}"
		>
			Fail
		</button>
	</div>
	<textarea
		placeholder="Optional notes..."
		value={localNotes}
		oninput={handleNotes}
		rows="2"
		class="tron-input w-full resize-none px-3 py-2 text-sm"
	></textarea>
</div>
