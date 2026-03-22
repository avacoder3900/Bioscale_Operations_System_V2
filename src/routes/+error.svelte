<script lang="ts">
	import { page } from '$app/stores';
	import { resolve } from '$app/paths';
</script>

<div class="flex flex-col items-center gap-4 py-12 text-center">
	<div
		class="flex h-16 w-16 items-center justify-center rounded-full border-2 border-[var(--color-tron-error)] bg-[var(--color-tron-error)]/10"
	>
		<svg class="h-8 w-8 text-[var(--color-tron-error)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				stroke-width="2"
				d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
			/>
		</svg>
	</div>

	<h2 class="text-xl font-semibold text-[var(--color-tron-text)]">
		{$page.status} Error
	</h2>
	<p class="max-w-md text-sm text-[var(--color-tron-text-secondary)]">
		{$page.error?.message ?? 'Something went wrong loading this page.'}
	</p>

	<div class="mt-4 flex gap-3">
		<button
			type="button"
			onclick={() => location.reload()}
			class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text)] transition-colors hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
		>
			Retry
		</button>
		<a
			href={resolve('/')}
			class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)] transition-opacity hover:opacity-90"
		>
			Back to SPU Dashboard
		</a>
	</div>
</div>
