<script lang="ts">
	import TronButton from '$lib/components/ui/TronButton.svelte';

	interface WipLimitInfo {
		assignee: string;
		assigneeId: string;
		limit: number;
		currentCount: number;
		currentTasks: { _id: string; title: string }[];
	}

	interface Props {
		info: WipLimitInfo;
		onclose: () => void;
	}

	let { info, onclose }: Props = $props();
</script>

<div
	class="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
	role="dialog"
	aria-modal="true"
	aria-labelledby="wip-limit-title"
>
	<div class="tron-card w-full max-w-md" style="max-height: 90vh; overflow-y: auto;">
		<div class="mb-3 flex items-start justify-between gap-3">
			<h2 id="wip-limit-title" class="text-lg font-bold" style="color: var(--color-tron-red);">
				{info.assignee} is at their WIP limit
			</h2>
		</div>

		<p class="tron-text-primary mb-4 text-sm">
			{info.assignee} already has <strong>{info.currentCount}</strong> task{info.currentCount === 1 ? '' : 's'}
			in WIP. Their limit is <strong>{info.limit}</strong>.
		</p>

		<p class="tron-text-muted mb-2 text-xs uppercase tracking-wide">
			Currently in WIP for {info.assignee}
		</p>
		<ul class="mb-4 space-y-1">
			{#each info.currentTasks as t (t._id)}
				<li>
					<a
						href="/kanban/task/{t._id}"
						class="text-sm hover:underline"
						style="color: var(--color-tron-cyan);"
					>
						{t.title}
					</a>
				</li>
			{/each}
		</ul>

		<p class="tron-text-muted mb-4 text-xs">
			Move one of these forward (Done) or backward (Ready) to free a slot, then try again.
		</p>

		<div class="flex justify-end">
			<TronButton variant="primary" onclick={onclose}>OK</TronButton>
		</div>
	</div>
</div>
