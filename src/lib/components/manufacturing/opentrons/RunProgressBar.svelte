<script lang="ts">
	import { onMount } from 'svelte';

	interface Props {
		runStartTime: string;
		runEndTime: string;
	}

	let { runStartTime, runEndTime }: Props = $props();

	let now = $state(Date.now());
	let intervalId: ReturnType<typeof setInterval> | undefined;

	let start = $derived(new Date(runStartTime).getTime());
	let end = $derived(new Date(runEndTime).getTime());
	let totalMs = $derived(end - start);
	let elapsedMs = $derived(Math.max(0, now - start));
	let progress = $derived(totalMs > 0 ? Math.min(1, elapsedMs / totalMs) : 0);
	let isComplete = $derived(now >= end);

	let remainingMs = $derived(Math.max(0, end - now));
	let remainingMin = $derived(Math.floor(remainingMs / 60000));
	let remainingSec = $derived(Math.floor((remainingMs % 60000) / 1000));
	let remainingDisplay = $derived(
		isComplete
			? 'Complete'
			: `${String(remainingMin).padStart(2, '0')}:${String(remainingSec).padStart(2, '0')}`
	);

	onMount(() => {
		intervalId = setInterval(() => {
			now = Date.now();
		}, 1000);
		return () => {
			if (intervalId) clearInterval(intervalId);
		};
	});
</script>

<div class="space-y-1">
	<div class="flex items-center justify-between text-xs">
		<span class="text-[var(--color-tron-text-secondary)]">
			{isComplete ? 'Run complete' : 'Running...'}
		</span>
		<span
			class={isComplete
				? 'font-medium text-emerald-400'
				: 'font-mono text-[var(--color-tron-cyan)]'}
		>
			{remainingDisplay}
		</span>
	</div>
	<div
		class="h-2 overflow-hidden rounded-full bg-[var(--color-tron-bg)] border border-[var(--color-tron-border)]"
	>
		<div
			class="h-full rounded-full transition-all duration-1000 ease-linear {isComplete
				? 'bg-emerald-500'
				: 'bg-gradient-to-r from-[var(--color-tron-cyan)] to-emerald-500'}"
			style="width: {Math.round(progress * 100)}%"
		></div>
	</div>
	<div class="flex justify-between text-[10px] text-[var(--color-tron-text-secondary)]">
		<span>{Math.round(progress * 100)}%</span>
		<span>{Math.round(elapsedMs / 60000)}m / {Math.round(totalMs / 60000)}m</span>
	</div>
</div>
