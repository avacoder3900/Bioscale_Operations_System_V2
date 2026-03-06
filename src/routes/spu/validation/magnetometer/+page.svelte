<script lang="ts">
	import { enhance } from '$app/forms';
	import TronCard from '$lib/components/ui/TronCard.svelte';
	import TronButton from '$lib/components/ui/TronButton.svelte';

	interface SpuCard {
		id: string;
		udi: string;
		particleDeviceId: string | null;
		status: string;
		latestTest: {
			id: string;
			overallPassed: boolean | null;
			status: string;
			createdAt: string | null;
			completedAt: string | null;
		} | null;
		totalTests: number;
		sortOrder: number;
	}

	interface Props {
		data: {
			spuCards: SpuCard[];
			stats: {
				totalSpus: number;
				totalTests: number;
				passedSpus: number;
				failedSpus: number;
				untestedSpus: number;
			};
			criteria: { minZ: number; maxZ: number };
		};
		form: any;
	}

	let { data, form }: Props = $props();

	let editingCriteria = $state(false);
	let savingCriteria = $state(false);

	function statusInfo(card: SpuCard): { label: string; color: string; icon: string } {
		if (!card.latestTest) return { label: 'UNTESTED', color: 'var(--color-tron-text-secondary)', icon: '⚪' };
		if (card.latestTest.overallPassed === true) return { label: 'PASS', color: 'var(--color-tron-green)', icon: '✅' };
		if (card.latestTest.overallPassed === false) return { label: 'FAIL', color: 'var(--color-tron-red)', icon: '❌' };
		if (card.latestTest.status === 'running') return { label: 'RUNNING', color: 'var(--color-tron-cyan)', icon: '⏳' };
		return { label: 'UNTESTED', color: 'var(--color-tron-text-secondary)', icon: '⚪' };
	}

	function formatDate(d: string | null): string {
		if (!d) return '—';
		return new Date(d).toLocaleDateString();
	}
</script>

<div class="space-y-6">
	<h2 class="tron-text-primary text-2xl font-bold">Magnetometer Validation</h2>

	{#if form?.error}
		<div class="rounded border border-[var(--color-tron-red)] bg-[rgba(255,0,0,0.1)] p-3">
			<p class="text-sm text-[var(--color-tron-red)]">{form.error}</p>
		</div>
	{/if}

	<!-- Stats -->
	<div class="grid grid-cols-2 gap-3 md:grid-cols-5">
		<TronCard>
			<div class="p-4 text-center">
				<div class="tron-text-muted text-xs uppercase">Total SPUs</div>
				<div class="tron-text-primary mt-1 text-2xl font-bold">{data.stats.totalSpus}</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="p-4 text-center">
				<div class="text-xs uppercase" style="color: var(--color-tron-red);">Failed</div>
				<div class="mt-1 text-2xl font-bold" style="color: var(--color-tron-red);">{data.stats.failedSpus}</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="p-4 text-center">
				<div class="tron-text-muted text-xs uppercase">Untested</div>
				<div class="tron-text-primary mt-1 text-2xl font-bold">{data.stats.untestedSpus}</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="p-4 text-center">
				<div class="text-xs uppercase" style="color: var(--color-tron-green);">Passed</div>
				<div class="mt-1 text-2xl font-bold" style="color: var(--color-tron-green);">{data.stats.passedSpus}</div>
			</div>
		</TronCard>
		<TronCard>
			<div class="p-4 text-center">
				<div class="tron-text-muted text-xs uppercase">Total Tests</div>
				<div class="tron-text-primary mt-1 text-2xl font-bold">{data.stats.totalTests}</div>
			</div>
		</TronCard>
	</div>

	<!-- Pass/Fail Criteria -->
	<TronCard>
		<div class="p-4">
			<div class="flex items-center justify-between">
				<h3 class="tron-text-primary font-bold">Pass/Fail Criteria (Z-axis)</h3>
				{#if !editingCriteria}
					<button type="button" onclick={() => (editingCriteria = true)} class="tron-text-muted text-xs underline">Edit</button>
				{/if}
			</div>

			{#if editingCriteria}
				<form
					method="POST"
					action="?/updateCriteria"
					use:enhance={() => {
						savingCriteria = true;
						return async ({ update }) => {
							savingCriteria = false;
							editingCriteria = false;
							await update();
						};
					}}
					class="mt-3 flex items-end gap-3"
				>
					<div class="flex-1">
						<label for="minZ" class="tron-label text-xs">Min Z</label>
						<input id="minZ" name="minZ" type="number" class="tron-input w-full" value={data.criteria.minZ} style="min-height: 44px;" />
					</div>
					<div class="flex-1">
						<label for="maxZ" class="tron-label text-xs">Max Z</label>
						<input id="maxZ" name="maxZ" type="number" class="tron-input w-full" value={data.criteria.maxZ} style="min-height: 44px;" />
					</div>
					<TronButton type="submit" variant="primary" disabled={savingCriteria} style="min-height: 44px;">
						{savingCriteria ? 'Saving…' : 'Save'}
					</TronButton>
					<button type="button" onclick={() => (editingCriteria = false)} class="tron-text-muted text-sm">Cancel</button>
				</form>
			{:else}
				<p class="tron-text-muted mt-2 text-sm">
					Z values must be between <strong class="tron-text-primary">{data.criteria.minZ}</strong> and <strong class="tron-text-primary">{data.criteria.maxZ}</strong> to pass.
				</p>
				{#if form?.criteriaUpdated}
					<p class="mt-1 text-xs" style="color: var(--color-tron-green);">✓ Criteria updated</p>
				{/if}
			{/if}
		</div>
	</TronCard>

	<!-- SPU Dashboard Grid -->
	<div>
		<h3 class="tron-text-primary mb-3 font-bold">SPU Status Dashboard</h3>
		{#if data.spuCards.length === 0}
			<TronCard>
				<div class="p-8 text-center">
					<p class="tron-text-muted">No SPUs with Particle devices found.</p>
					<p class="tron-text-muted mt-1 text-xs">Link devices to SPUs in the SPU management section.</p>
				</div>
			</TronCard>
		{:else}
			<div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
				{#each data.spuCards as card (card.id)}
					{@const info = statusInfo(card)}
					<a
						href="/spu/validation/magnetometer/spu/{card.id}"
						class="block rounded border p-4 transition-all hover:border-[var(--color-tron-cyan)] hover:shadow-lg"
						style="border-color: {info.color === 'var(--color-tron-text-secondary)' ? 'var(--color-tron-border)' : info.color}; background: var(--color-tron-bg-secondary);"
					>
						<!-- UDI -->
						<div class="tron-text-primary mb-3 font-mono text-sm font-bold">{card.udi}</div>

						<!-- Status Badge -->
						<div class="mb-3 flex items-center gap-2">
							<span class="text-lg">{info.icon}</span>
							<span class="text-sm font-bold" style="color: {info.color};">{info.label}</span>
						</div>

						<!-- Test info -->
						<div class="space-y-1">
							<div class="flex justify-between text-xs">
								<span class="tron-text-muted">Last test</span>
								<span class="tron-text-primary">
									{card.latestTest ? formatDate(card.latestTest.completedAt ?? card.latestTest.createdAt) : 'Never'}
								</span>
							</div>
							<div class="flex justify-between text-xs">
								<span class="tron-text-muted">Total tests</span>
								<span class="tron-text-primary">{card.totalTests}</span>
							</div>
						</div>
					</a>
				{/each}
			</div>
		{/if}
	</div>
</div>
