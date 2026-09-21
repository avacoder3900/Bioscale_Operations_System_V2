<script lang="ts">
	import { STATUS_META, type KanbanStatus } from '$lib/shared/kanban-status';

	interface Props {
		status: string;
		class?: string;
	}

	let { status, class: className = '' }: Props = $props();

	let meta = $derived(
		STATUS_META[status as KanbanStatus] ?? { label: status, color: '#6b7280', tier: 1 as const }
	);
</script>

<span
	class="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium {className}"
	style="color: {meta.color}; border-color: {meta.color}40; background: {meta.color}15;"
>
	<span class="h-1.5 w-1.5 rounded-full" style="background: {meta.color};"></span>
	{meta.label}
</span>
