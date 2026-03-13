<script lang="ts">
	interface LogEntry {
		id: string;
		taskId: string | null;
		action: string;
		details: unknown;
		createdAt: Date | string;
		createdBy: string | null;
		authorName: string | null;
	}

	interface Props {
		entries: LogEntry[];
	}

	let { entries }: Props = $props();

	const actionLabels: Record<string, string> = {
		task_created: 'Created',
		task_moved: 'Moved',
		task_updated: 'Updated',
		task_archived: 'Archived',
		task_assigned: 'Assigned',
		task_tag_added: 'Tag Added',
		task_tag_removed: 'Tag Removed',
		comment_added: 'Comment'
	};

	const actionColors: Record<string, string> = {
		task_created: '#00ff88',
		task_moved: '#00d4ff',
		task_updated: '#ff6600',
		task_archived: '#ff3366',
		task_assigned: '#a855f7',
		task_tag_added: '#00d4ff',
		task_tag_removed: '#a0a0a0',
		comment_added: '#00d4ff'
	};

	function formatTime(date: Date | string): string {
		return new Date(date).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}

	function getDescription(entry: LogEntry): string {
		if (!entry.details || typeof entry.details !== 'object') return '';
		const details = entry.details as Record<string, string>;

		if (entry.action === 'task_moved') {
			const from = details.fromStatus ?? '?';
			const to = details.toStatus ?? '?';
			return `${from} → ${to}`;
		}
		if (details.description) return details.description;
		if (details.title) return details.title;
		return '';
	}
</script>

{#if entries.length === 0}
	<p class="tron-text-muted text-xs">No activity yet.</p>
{:else}
	<div class="space-y-2">
		{#each entries as entry (entry.id)}
			{@const color = actionColors[entry.action] ?? '#a0a0a0'}
			<div class="flex gap-3 text-xs">
				<div class="flex flex-col items-center">
					<div class="h-2 w-2 rounded-full" style="background: {color};"></div>
					<div class="w-px flex-1 bg-[var(--color-tron-border)]"></div>
				</div>
				<div class="min-w-0 flex-1 pb-2">
					<div class="flex items-center gap-2">
						<span
							class="rounded px-1.5 py-0.5 text-[10px] font-bold uppercase"
							style="background: {color}20; color: {color};"
						>
							{actionLabels[entry.action] ?? entry.action}
						</span>
						<span class="tron-text-muted">{entry.authorName ?? 'System'}</span>
					</div>
					{#if getDescription(entry)}
						<p class="tron-text-muted mt-0.5 truncate">{getDescription(entry)}</p>
					{/if}
					<p class="tron-text-muted mt-0.5 opacity-60">{formatTime(entry.createdAt)}</p>
				</div>
			</div>
		{/each}
	</div>
{/if}
