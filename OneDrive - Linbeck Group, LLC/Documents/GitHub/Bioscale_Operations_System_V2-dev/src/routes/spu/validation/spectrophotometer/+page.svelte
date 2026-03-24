<script lang="ts">
	interface Props {
		data: {
			recentSessions: Array<{
				id: string;
				status: string;
				startedAt: string | null;
				completedAt: string | null;
				createdAt: string;
				barcode: string | null;
				username: string | null;
			}>;
			stats: {
				total: number;
				passed: number;
				failed: number;
				inProgress: number;
			};
		};
	}

	let { data }: Props = $props();

	function formatDate(dateStr: string): string {
		return new Date(dateStr).toLocaleString();
	}

	function getStatusBadge(status: string) {
		switch (status) {
			case 'completed':
				return { class: 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]', label: 'Passed' };
			case 'failed':
				return { class: 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]', label: 'Failed' };
			case 'in_progress':
				return { class: 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]', label: 'In Progress' };
			default:
				return { class: 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]', label: 'Waiting' };
		}
	}
</script>

<div class="space-y-8">
	<!-- Back Link -->
	<a
		href="/spu/validation"
		class="tron-text-muted flex items-center gap-2 text-sm transition-colors hover:text-[var(--color-tron-cyan)]"
	>
		<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7" />
		</svg>
		Back to Validation
	</a>

	<!-- Header -->
	<div class="flex items-center justify-between">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Spectrophotometer Validation</h1>
			<p class="tron-text-muted mt-1">
				Validate spectrophotometer optical calibration
			</p>
		</div>

		<a
			href="/spu/validation/spectrophotometer/history"
			class="tron-text-muted flex items-center gap-2 text-sm transition-colors hover:text-[var(--color-tron-cyan)]"
		>
			View history
			<svg class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
			</svg>
		</a>
	</div>

	<!-- Statistics Cards -->
	<div class="grid grid-cols-2 gap-4 md:grid-cols-4">
		<div class="tron-card p-4">
			<span class="tron-text-muted block text-xs uppercase">Total Tests</span>
			<span class="tron-heading text-2xl font-bold">{data.stats.total}</span>
		</div>
		<div class="tron-card p-4">
			<span class="tron-text-muted block text-xs uppercase">Passed</span>
			<span class="text-2xl font-bold text-[var(--color-tron-green)]">{data.stats.passed}</span>
		</div>
		<div class="tron-card p-4">
			<span class="tron-text-muted block text-xs uppercase">Failed</span>
			<span class="text-2xl font-bold text-[var(--color-tron-red)]">{data.stats.failed}</span>
		</div>
		<div class="tron-card p-4">
			<span class="tron-text-muted block text-xs uppercase">In Progress</span>
			<span class="text-2xl font-bold text-[var(--color-tron-cyan)]">{data.stats.inProgress}</span>
		</div>
	</div>

	<!-- Start Test Card -->
	<div class="tron-card border-[var(--color-tron-cyan)] p-8 text-center">
		<div class="mx-auto mb-6 rounded-full bg-[var(--color-tron-cyan)]/10 p-6 w-fit">
			<svg class="h-16 w-16 text-[var(--color-tron-cyan)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
			</svg>
		</div>

		<h2 class="tron-heading text-xl font-semibold mb-2">Ready to Start</h2>
		<p class="tron-text-muted mb-6 max-w-md mx-auto">
			Click below to start a new validation session. You will then connect to the SPU device via USB
			serial to automatically run the spectrophotometer laser test sequence.
		</p>

		<form method="POST" action="?/start">
			<button
				type="submit"
				class="tron-btn-primary inline-flex items-center gap-3 px-8 py-4 text-lg font-semibold transition-all hover:scale-105"
			>
				<svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
				</svg>
				Start Spectrophotometer Test
			</button>
		</form>

		<p class="tron-text-muted text-sm mt-4">
			Requires Chrome or Edge browser for USB serial connection
		</p>
	</div>

	<!-- Recent Tests -->
	<div class="tron-card">
		<div class="border-b border-[var(--color-tron-border)] p-4 flex items-center justify-between">
			<h2 class="tron-heading text-lg font-semibold">Recent Tests</h2>
			{#if data.recentSessions.length > 0}
				<a
					href="/spu/validation/spectrophotometer/history"
					class="text-sm text-[var(--color-tron-cyan)] hover:underline"
				>
					View all
				</a>
			{/if}
		</div>

		{#if data.recentSessions.length === 0}
			<div class="p-8 text-center">
				<svg class="mx-auto h-12 w-12 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
				</svg>
				<p class="tron-text-muted mt-4">No spectrophotometer tests yet</p>
				<p class="tron-text-muted mt-1 text-sm">Start your first test using the button above</p>
			</div>
		{:else}
			<div class="divide-y divide-[var(--color-tron-border)]">
				{#each data.recentSessions as session (session.id)}
					{@const statusBadge = getStatusBadge(session.status)}
					<a
						href="/spu/validation/spectrophotometer/{session.id}"
						class="flex items-center justify-between p-4 transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
					>
						<div class="flex flex-col">
							<span class="tron-heading font-mono font-medium">{session.barcode ?? 'No barcode'}</span>
							<span class="tron-text-muted text-sm">
								{session.username ?? 'Unknown'} - {formatDate(session.createdAt)}
							</span>
						</div>
						<span class="rounded-full px-2 py-1 text-xs font-medium {statusBadge.class}">
							{statusBadge.label}
						</span>
					</a>
				{/each}
			</div>
		{/if}
	</div>
</div>
