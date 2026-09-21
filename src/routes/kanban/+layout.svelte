<script lang="ts">
	import type { Snippet } from 'svelte';
	import GridBackground from '$lib/components/ui/GridBackground.svelte';
	import KanbanNav from '$lib/components/kanban/KanbanNav.svelte';

	interface Props {
		children: Snippet;
		data: {
			user: { id: string; username: string };
		};
	}

	let { children, data }: Props = $props();
	// KB2-15: the old secondary header nav (Analytics | Projects | Archive) is
	// gone — every destination lives on the single KanbanNav row below.
</script>

<GridBackground>
	<div class="min-h-screen">
		<!-- Header -->
		<header class="border-b border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
			<div class="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
				<div class="flex h-16 items-center justify-between">
					<div class="flex items-center gap-3">
						<div
							class="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--color-tron-cyan)]"
						>
							<svg
								class="h-6 w-6 text-[var(--color-tron-bg-primary)]"
								fill="none"
								viewBox="0 0 24 24"
								stroke="currentColor"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M9 17V7m0 10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2h2a2 2 0 012 2m0 10a2 2 0 002 2h2a2 2 0 002-2M9 7a2 2 0 012-2h2a2 2 0 012 2m0 10V7"
								/>
							</svg>
						</div>
						<div>
							<h1 class="tron-text-primary tron-heading text-xl font-bold">Kanban Board</h1>
							<p class="tron-text-muted text-xs">Task Management</p>
						</div>
					</div>
				</div>
			</div>
		</header>

		<!-- Main Content -->
		<main class="mx-auto max-w-[90rem] px-4 py-8 sm:px-6 lg:px-8">
			<KanbanNav />
			{@render children()}
		</main>
	</div>
</GridBackground>
