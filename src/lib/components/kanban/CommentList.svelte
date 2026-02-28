<script lang="ts">
	import { enhance } from '$app/forms';
	import TronButton from '$lib/components/ui/TronButton.svelte';

	interface Comment {
		id: string;
		content: string;
		createdAt: Date | string;
		createdBy: string | null;
		authorName: string | null;
	}

	interface Props {
		comments: Comment[];
		taskId: string;
	}

	let { comments, taskId }: Props = $props();
	let submitting = $state(false);
	let commentText = $state('');

	function formatDate(date: Date | string): string {
		return new Date(date).toLocaleDateString('en-US', {
			month: 'short',
			day: 'numeric',
			hour: 'numeric',
			minute: '2-digit'
		});
	}
</script>

<!-- Add comment form -->
<form
	method="POST"
	action="?/addComment"
	use:enhance={() => {
		submitting = true;
		return async ({ result, update }) => {
			submitting = false;
			if (result.type === 'success') {
				commentText = '';
			}
			await update();
		};
	}}
>
	<div class="mb-3">
		<textarea
			name="content"
			class="tron-input w-full"
			rows="2"
			placeholder="Add a comment..."
			bind:value={commentText}
			required
		></textarea>
	</div>
	<div class="mb-4">
		<TronButton type="submit" variant="primary" disabled={submitting || !commentText.trim()}>
			{submitting ? 'Posting...' : 'Post Comment'}
		</TronButton>
	</div>
</form>

<!-- Comment list -->
{#if comments.length === 0}
	<p class="tron-text-muted text-xs">No comments yet.</p>
{:else}
	<div class="space-y-3">
		{#each comments as comment (comment.id)}
			<div
				class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)] p-3"
			>
				<div class="mb-1 flex items-center justify-between gap-2">
					<span class="text-xs font-medium" style="color: var(--color-tron-cyan);">
						{comment.authorName ?? 'Unknown'}
					</span>
					<span class="tron-text-muted text-xs">{formatDate(comment.createdAt)}</span>
				</div>
				<p class="tron-text-primary text-sm whitespace-pre-wrap">{comment.content}</p>
			</div>
		{/each}
	</div>
{/if}
