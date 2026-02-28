<script lang="ts">
	interface Props {
		data: {
			recentSessions: Array<{
				id: string;
				type: string;
				status: string;
				startedAt: string | null;
				completedAt: string | null;
				createdAt: string;
				barcode: string | null;
				username: string | null;
			}>;
			stats: {
				spectrophotometer: { total: number; passed: number; failed: number };
				thermocouple: { total: number; passed: number; failed: number };
				magnetometer: { total: number; passed: number; failed: number };
			};
			barcodeStats: {
				today: number;
			};
		};
	}

	let { data }: Props = $props();

	const typeConfig = {
		spec: { label: 'Spectrophotometer', href: '/spu/validation/spectrophotometer', color: 'cyan' },
		thermo: { label: 'Thermocouple', href: '/spu/validation/thermocouple', color: 'orange' },
		mag: { label: 'Magnetometer', href: '/spu/validation/magnetometer', color: 'purple' }
	} as const;

	function getStatusBadge(status: string) {
		switch (status) {
			case 'completed':
				return { class: 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]', label: 'Passed' };
			case 'failed':
				return { class: 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]', label: 'Failed' };
			case 'in_progress':
				return { class: 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]', label: 'In Progress' };
			default:
				return { class: 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]', label: 'Pending' };
		}
	}

	function formatDate(dateStr: string): string {
		return new Date(dateStr).toLocaleString();
	}

	function getSessionUrl(type: string, id: string): string {
		const config = typeConfig[type as keyof typeof typeConfig];
		return `${config?.href ?? '/spu/validation'}/${id}`;
	}
</script>

<div class="space-y-8">
	<!-- Header -->
	<div>
		<h1 class="tron-heading text-2xl font-bold">Device Validation</h1>
		<p class="tron-text-muted mt-1">
			Validate spectrophotometers, thermocouples, and magnetometers
		</p>
	</div>

	<!-- Quick Stats -->
	<div class="grid grid-cols-1 gap-4 md:grid-cols-3">
		<!-- Spectrophotometer Card -->
		<a
			href="/spu/validation/spectrophotometer"
			class="tron-card group block p-6 transition-all hover:border-[var(--color-tron-cyan)]"
		>
			<div class="flex items-center justify-between">
				<div>
					<h3 class="tron-text-muted text-sm font-medium">Spectrophotometer</h3>
					<p class="tron-heading mt-2 text-3xl font-bold">{data.stats.spectrophotometer.total}</p>
					<p class="tron-text-muted mt-1 text-sm">
						<span class="text-[var(--color-tron-green)]">{data.stats.spectrophotometer.passed} passed</span>
						{#if data.stats.spectrophotometer.failed > 0}
							<span class="mx-1">·</span>
							<span class="text-[var(--color-tron-red)]">{data.stats.spectrophotometer.failed} failed</span>
						{/if}
					</p>
				</div>
				<div class="rounded-lg bg-[var(--color-tron-cyan)]/10 p-3 transition-colors group-hover:bg-[var(--color-tron-cyan)]/20">
					<svg class="h-8 w-8 text-[var(--color-tron-cyan)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
					</svg>
				</div>
			</div>
			<div class="mt-4">
				<span class="text-sm text-[var(--color-tron-cyan)] group-hover:underline">Start test →</span>
			</div>
		</a>

		<!-- Thermocouple Card -->
		<a
			href="/spu/validation/thermocouple"
			class="tron-card group block p-6 transition-all hover:border-[var(--color-tron-orange)]"
		>
			<div class="flex items-center justify-between">
				<div>
					<h3 class="tron-text-muted text-sm font-medium">Thermocouple</h3>
					<p class="tron-heading mt-2 text-3xl font-bold">{data.stats.thermocouple.total}</p>
					<p class="tron-text-muted mt-1 text-sm">
						<span class="text-[var(--color-tron-green)]">{data.stats.thermocouple.passed} passed</span>
						{#if data.stats.thermocouple.failed > 0}
							<span class="mx-1">·</span>
							<span class="text-[var(--color-tron-red)]">{data.stats.thermocouple.failed} failed</span>
						{/if}
					</p>
				</div>
				<div class="rounded-lg bg-[var(--color-tron-orange)]/10 p-3 transition-colors group-hover:bg-[var(--color-tron-orange)]/20">
					<svg class="h-8 w-8 text-[var(--color-tron-orange)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
					</svg>
				</div>
			</div>
			<div class="mt-4">
				<span class="text-sm text-[var(--color-tron-orange)] group-hover:underline">Start test →</span>
			</div>
		</a>

		<!-- Magnetometer Card -->
		<a
			href="/spu/validation/magnetometer"
			class="tron-card group block p-6 transition-all hover:border-[var(--color-tron-purple)]"
		>
			<div class="flex items-center justify-between">
				<div>
					<h3 class="tron-text-muted text-sm font-medium">Magnetometer</h3>
					<p class="tron-heading mt-2 text-3xl font-bold">{data.stats.magnetometer.total}</p>
					<p class="tron-text-muted mt-1 text-sm">
						<span class="text-[var(--color-tron-green)]">{data.stats.magnetometer.passed} passed</span>
						{#if data.stats.magnetometer.failed > 0}
							<span class="mx-1">·</span>
							<span class="text-[var(--color-tron-red)]">{data.stats.magnetometer.failed} failed</span>
						{/if}
					</p>
				</div>
				<div class="rounded-lg bg-[var(--color-tron-purple)]/10 p-3 transition-colors group-hover:bg-[var(--color-tron-purple)]/20">
					<svg class="h-8 w-8 text-[var(--color-tron-purple)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 10V3L4 14h7v7l9-11h-7z" />
					</svg>
				</div>
			</div>
			<div class="mt-4">
				<span class="text-sm text-[var(--color-tron-purple)] group-hover:underline">Start test →</span>
			</div>
		</a>
	</div>

	<!-- Today's Stats -->
	<div class="tron-card p-4">
		<div class="flex items-center justify-between">
			<span class="tron-text-muted text-sm">Tests today</span>
			<span class="tron-heading text-lg font-bold">{data.barcodeStats.today}</span>
		</div>
	</div>

	<!-- Recent Validations -->
	<div class="tron-card">
		<div class="border-b border-[var(--color-tron-border)] p-4">
			<h2 class="tron-heading text-lg font-semibold">Recent Validations</h2>
		</div>

		{#if data.recentSessions.length === 0}
			<div class="p-8 text-center">
				<svg class="mx-auto h-12 w-12 text-[var(--color-tron-text-secondary)]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
				</svg>
				<p class="tron-text-muted mt-4">No validation tests yet</p>
				<p class="tron-text-muted mt-1 text-sm">Start a test using the cards above</p>
			</div>
		{:else}
			<div class="divide-y divide-[var(--color-tron-border)]">
				{#each data.recentSessions as session (session.id)}
					{@const statusBadge = getStatusBadge(session.status)}
					{@const config = typeConfig[session.type as keyof typeof typeConfig]}
					<a
						href={getSessionUrl(session.type, session.id)}
						class="flex items-center justify-between p-4 transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
					>
						<div class="flex items-center gap-4">
							<div class="flex flex-col">
								<span class="tron-heading font-medium">{session.barcode ?? 'No barcode'}</span>
								<span class="tron-text-muted text-sm">
									{config?.label ?? session.type} · {session.username ?? 'Unknown'}
								</span>
							</div>
						</div>
						<div class="flex items-center gap-4">
							<span class="tron-text-muted text-sm">{formatDate(session.createdAt)}</span>
							<span class="rounded-full px-2 py-1 text-xs font-medium {statusBadge.class}">
								{statusBadge.label}
							</span>
						</div>
					</a>
				{/each}
			</div>
		{/if}
	</div>
</div>
