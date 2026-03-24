<script lang="ts">
	import { enhance } from '$app/forms';

	interface Props {
		data: {
			recentSessions: Array<{
				id: string;
				status: string;
				barcode: string | null;
				createdAt: string;
				config: {
					durationSeconds: number;
					intervalSeconds: number;
					minTemp: number;
					maxTemp: number;
				} | null;
			}>;
		};
		form: {
			success?: boolean;
			sessionId?: string;
			error?: string;
		} | null;
	}

	let { data, form }: Props = $props();

	// Form state using Svelte 5 runes
	let duration = $state(60);
	let durationUnit = $state<'seconds' | 'minutes'>('seconds');
	let interval = $state(1);
	let minTemp = $state(20);
	let maxTemp = $state(40);
	let isSubmitting = $state(false);

	// Computed duration in seconds
	let durationSeconds = $derived(durationUnit === 'minutes' ? duration * 60 : duration);

	// Validation
	let errors = $derived({
		duration: duration <= 0 ? 'Duration must be positive' : null,
		interval:
			interval <= 0
				? 'Interval must be positive'
				: interval > durationSeconds
					? 'Interval cannot exceed duration'
					: null,
		range: minTemp >= maxTemp ? 'Min temperature must be less than max' : null
	});

	let isValid = $derived(!errors.duration && !errors.interval && !errors.range);

	function formatDuration(seconds: number): string {
		if (seconds >= 60) {
			const mins = Math.floor(seconds / 60);
			const secs = seconds % 60;
			return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
		}
		return `${seconds}s`;
	}

	function formatDate(dateStr: string): string {
		return new Date(dateStr).toLocaleString();
	}

	function getStatusBadge(status: string) {
		switch (status) {
			case 'completed':
				return {
					class: 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]',
					label: 'Passed'
				};
			case 'failed':
				return {
					class: 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]',
					label: 'Failed'
				};
			case 'in_progress':
				return {
					class: 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]',
					label: 'In Progress'
				};
			default:
				return {
					class: 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]',
					label: 'Pending'
				};
		}
	}
</script>

<div class="space-y-8">
	<!-- Header -->
	<div>
		<h1 class="tron-heading text-2xl font-bold">Thermocouple Validation</h1>
		<p class="tron-text-muted mt-1">Configure and run temperature sensor validation tests</p>
	</div>

	<!-- Configuration Form -->
	<div class="tron-card p-6">
		<h2 class="tron-heading mb-6 text-lg font-semibold">Test Configuration</h2>

		<form
			method="POST"
			action="?/configure"
			use:enhance={() => {
				isSubmitting = true;
				return async ({ update }) => {
					await update();
					isSubmitting = false;
				};
			}}
			class="space-y-6"
		>
			<!-- Duration Row -->
			<div class="grid gap-6 md:grid-cols-2">
				<div>
					<label for="duration" class="tron-text-muted mb-2 block text-sm font-medium">
						Test Duration
					</label>
					<div class="flex gap-2">
						<input
							type="number"
							id="duration"
							name="duration"
							bind:value={duration}
							min="1"
							class="tron-input flex-1 rounded-lg px-4 py-3 text-lg"
							class:border-[var(--color-tron-red)]={errors.duration}
						/>
						<select
							name="durationUnit"
							bind:value={durationUnit}
							class="tron-input rounded-lg px-4 py-3"
						>
							<option value="seconds">seconds</option>
							<option value="minutes">minutes</option>
						</select>
					</div>
					{#if errors.duration}
						<p class="mt-1 text-sm text-[var(--color-tron-red)]">{errors.duration}</p>
					{/if}
				</div>

				<div>
					<label for="interval" class="tron-text-muted mb-2 block text-sm font-medium">
						Sampling Interval (seconds)
					</label>
					<input
						type="number"
						id="interval"
						name="interval"
						bind:value={interval}
						min="1"
						step="0.1"
						class="tron-input w-full rounded-lg px-4 py-3 text-lg"
						class:border-[var(--color-tron-red)]={errors.interval}
					/>
					{#if errors.interval}
						<p class="mt-1 text-sm text-[var(--color-tron-red)]">{errors.interval}</p>
					{/if}
					<p class="tron-text-muted mt-1 text-xs">
						~{Math.ceil(durationSeconds / interval)} readings expected
					</p>
				</div>
			</div>

			<!-- Temperature Range Row -->
			<div>
				<label class="tron-text-muted mb-2 block text-sm font-medium">
					Expected Temperature Range (°C)
				</label>
				<div class="flex items-center gap-4">
					<div class="flex-1">
						<label for="minTemp" class="sr-only">Minimum Temperature</label>
						<div class="relative">
							<input
								type="number"
								id="minTemp"
								name="minTemp"
								bind:value={minTemp}
								step="0.1"
								class="tron-input w-full rounded-lg px-4 py-3 text-lg"
								class:border-[var(--color-tron-red)]={errors.range}
							/>
							<span class="tron-text-muted absolute top-1/2 right-4 -translate-y-1/2 text-sm">
								min
							</span>
						</div>
					</div>
					<span class="tron-text-muted text-xl">—</span>
					<div class="flex-1">
						<label for="maxTemp" class="sr-only">Maximum Temperature</label>
						<div class="relative">
							<input
								type="number"
								id="maxTemp"
								name="maxTemp"
								bind:value={maxTemp}
								step="0.1"
								class="tron-input w-full rounded-lg px-4 py-3 text-lg"
								class:border-[var(--color-tron-red)]={errors.range}
							/>
							<span class="tron-text-muted absolute top-1/2 right-4 -translate-y-1/2 text-sm">
								max
							</span>
						</div>
					</div>
				</div>
				{#if errors.range}
					<p class="mt-1 text-sm text-[var(--color-tron-red)]">{errors.range}</p>
				{/if}
				<p class="tron-text-muted mt-2 text-xs">
					Test passes if all readings stay within this range
				</p>
			</div>

			<!-- Hidden field for computed duration in seconds -->
			<input type="hidden" name="durationSeconds" value={durationSeconds} />

			<!-- Error Message -->
			{#if form?.error}
				<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-[var(--color-tron-red)]">
					{form.error}
				</div>
			{/if}

			<!-- Start Button -->
			<button
				type="submit"
				disabled={!isValid || isSubmitting}
				class="flex w-full items-center justify-center gap-3 rounded-lg bg-[var(--color-tron-orange)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{#if isSubmitting}
					<svg class="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
						<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"
						></circle>
						<path
							class="opacity-75"
							fill="currentColor"
							d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
						></path>
					</svg>
					Starting Test...
				{:else}
					<svg class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
						/>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							stroke-width="2"
							d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
						/>
					</svg>
					Start Test
				{/if}
			</button>
		</form>

		<!-- Quick presets -->
		<div class="mt-6 border-t border-[var(--color-tron-border)] pt-6">
			<p class="tron-text-muted mb-3 text-sm font-medium">Quick Presets</p>
			<div class="flex flex-wrap gap-2">
				<button
					type="button"
					onclick={() => {
						duration = 30;
						durationUnit = 'seconds';
						interval = 1;
						minTemp = 20;
						maxTemp = 40;
					}}
					class="rounded-lg bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-orange)]/20 hover:text-[var(--color-tron-orange)]"
				>
					Quick (30s)
				</button>
				<button
					type="button"
					onclick={() => {
						duration = 2;
						durationUnit = 'minutes';
						interval = 1;
						minTemp = 36;
						maxTemp = 38;
					}}
					class="rounded-lg bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-orange)]/20 hover:text-[var(--color-tron-orange)]"
				>
					Body Temp (2m)
				</button>
				<button
					type="button"
					onclick={() => {
						duration = 5;
						durationUnit = 'minutes';
						interval = 5;
						minTemp = 15;
						maxTemp = 30;
					}}
					class="rounded-lg bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-orange)]/20 hover:text-[var(--color-tron-orange)]"
				>
					Room Temp (5m)
				</button>
				<button
					type="button"
					onclick={() => {
						duration = 10;
						durationUnit = 'minutes';
						interval = 10;
						minTemp = 2;
						maxTemp = 8;
					}}
					class="rounded-lg bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-orange)]/20 hover:text-[var(--color-tron-orange)]"
				>
					Refrigerator (10m)
				</button>
			</div>
		</div>
	</div>

	<!-- Recent Tests -->
	<div class="tron-card">
		<div class="flex items-center justify-between border-b border-[var(--color-tron-border)] p-4">
			<h2 class="tron-heading text-lg font-semibold">Recent Tests</h2>
			<a
				href="/spu/validation/thermocouple/history"
				class="text-sm text-[var(--color-tron-orange)] hover:underline"
			>
				View all →
			</a>
		</div>

		{#if data.recentSessions.length === 0}
			<div class="p-8 text-center">
				<svg
					class="mx-auto h-12 w-12 text-[var(--color-tron-text-secondary)]"
					fill="none"
					viewBox="0 0 24 24"
					stroke="currentColor"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
					/>
				</svg>
				<p class="tron-text-muted mt-4">No thermocouple tests yet</p>
				<p class="tron-text-muted mt-1 text-sm">Configure and start a test above</p>
			</div>
		{:else}
			<div class="divide-y divide-[var(--color-tron-border)]">
				{#each data.recentSessions as session (session.id)}
					{@const statusBadge = getStatusBadge(session.status)}
					<a
						href="/spu/validation/thermocouple/{session.id}"
						class="flex items-center justify-between p-4 transition-colors hover:bg-[var(--color-tron-bg-tertiary)]"
					>
						<div class="flex flex-col">
							<span class="tron-heading font-medium">
								{session.barcode ?? session.id.slice(0, 8)}
							</span>
							<span class="tron-text-muted text-sm">
								{#if session.config}
									{formatDuration(session.config.durationSeconds)} @ {session.config
										.intervalSeconds}s interval · {session.config.minTemp}°C - {session.config
										.maxTemp}°C
								{:else}
									No config data
								{/if}
							</span>
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
