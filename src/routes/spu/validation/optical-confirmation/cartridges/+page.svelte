<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	interface Assay {
		_id?: string;
		name?: string;
		skuCode?: string;
	}
	interface Group {
		_id: string;
		name: string;
		color?: string;
	}
	interface Cartridge {
		_id: string;
		barcode: string;
		assay?: Assay | null;
		status?: string;
		groupId?: string | null;
		expirationDate?: string | null;
		createdAt?: string;
	}
	interface Props {
		data: {
			presetAssay: Assay | null;
			groups: Group[];
			cartridges: Cartridge[];
		};
	}

	let { data }: Props = $props();

	let cartridges = $state<Cartridge[]>(data.cartridges ?? []);
	let groupName = $state('');
	let selectedGroupId = $state(''); // set when an existing group is chosen
	let groupSuggestions = $state<Group[]>([]);
	let barcodesText = $state('');

	let busy = $state(false);
	let errorMessage = $state<string | null>(null);
	let resultSummary = $state<{ created: number; skipped: { barcode: string; reason: string }[] } | null>(null);

	const groupNameById = $derived(new Map((data.groups ?? []).map((g) => [g._id, g.name])));

	let parsedBarcodes = $derived(
		barcodesText
			.split(/[\n,]/)
			.map((b) => b.trim())
			.filter(Boolean)
	);
	let hasAssay = $derived(!!data.presetAssay?.skuCode);
	let isValid = $derived(hasAssay && parsedBarcodes.length > 0 && groupName.trim().length > 0);

	async function searchGroups() {
		const q = groupName.trim();
		selectedGroupId = ''; // typing means "not yet matched to an existing group"
		if (!q) {
			groupSuggestions = [];
			return;
		}
		try {
			const res = await fetch('/api/validation/optical-confirmation/groups?q=' + encodeURIComponent(q));
			const r = await res.json();
			groupSuggestions = r.groups ?? [];
		} catch {
			groupSuggestions = [];
		}
	}

	function pickGroup(g: Group) {
		selectedGroupId = g._id;
		groupName = g.name;
		groupSuggestions = [];
	}

	function statusBadge(status?: string) {
		switch (status) {
			case 'available':
				return { label: 'Available', class: 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]' };
			case 'in_use':
				return { label: 'In Use', class: 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]' };
			case 'depleted':
			case 'expired':
			case 'disposed':
				return { label: status, class: 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]' };
			case 'quarantine':
				return { label: 'Quarantine', class: 'bg-[var(--color-tron-orange)]/20 text-[var(--color-tron-orange)]' };
			default:
				return { label: status ?? 'unknown', class: 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]' };
		}
	}

	async function register() {
		if (!isValid || busy) return;
		busy = true;
		errorMessage = null;
		resultSummary = null;
		try {
			const body: Record<string, unknown> = { barcodes: parsedBarcodes };
			if (selectedGroupId) body.groupId = selectedGroupId;
			else body.groupName = groupName.trim();

			const res = await fetch('/api/validation/optical-confirmation/cartridges', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const r = await res.json();
			if (!res.ok || r.error) {
				errorMessage = r.error ?? 'Registration failed';
				return;
			}
			resultSummary = { created: (r.created ?? []).length, skipped: r.skipped ?? [] };
			barcodesText = '';
			groupSuggestions = [];
			await invalidateAll();
			cartridges = data.cartridges ?? [];
		} catch (err) {
			errorMessage = err instanceof Error ? err.message : 'Network error';
		} finally {
			busy = false;
		}
	}
</script>

<div class="space-y-6">
	<div class="flex items-start justify-between">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Optical-Test Cartridges</h1>
			<p class="tron-text-muted mt-1">
				Batch-register barcodes against the optical-confirmation assay and a validation group.
			</p>
		</div>
		<div class="flex gap-2">
			<a href="/spu/validation/optical-confirmation" class="tron-text-muted text-sm hover:text-[var(--color-tron-cyan)]">← Run page</a>
			<a href="/spu/validation/optical-confirmation/criteria" class="tron-text-muted text-sm hover:text-[var(--color-tron-orange)]">Criteria / assay</a>
		</div>
	</div>

	<!-- Preset assay -->
	<div class="tron-card p-6">
		<h2 class="tron-heading mb-2 text-lg font-semibold">Assay</h2>
		{#if hasAssay}
			<p class="text-[var(--color-tron-text-secondary)]">
				Every cartridge will be stamped with
				<span class="tron-heading font-medium">{data.presetAssay?.name}</span>
				(<span class="font-mono">{data.presetAssay?.skuCode}</span>).
			</p>
		{:else}
			<p class="text-[var(--color-tron-red)]">
				No optical-confirmation assay is set. Set it on the
				<a href="/spu/validation/optical-confirmation/criteria" class="underline">Criteria page</a> before registering cartridges.
			</p>
		{/if}
	</div>

	<!-- Batch register -->
	<div class="tron-card p-6">
		<h2 class="tron-heading mb-4 text-lg font-semibold">Register barcodes</h2>

		<div class="space-y-4">
			<!-- Validation group search -->
			<div class="relative">
				<label for="group" class="tron-text-muted mb-2 block text-sm font-medium">
					Validation group <span class="text-[var(--color-tron-red)]">*</span>
				</label>
				<input
					id="group"
					type="text"
					bind:value={groupName}
					oninput={searchGroups}
					placeholder="Search or type a new group name…"
					class="tron-input w-full rounded-lg px-4 py-3"
					autocomplete="off"
				/>
				{#if groupSuggestions.length > 0}
					<div class="absolute z-10 mt-1 w-full overflow-hidden rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
						{#each groupSuggestions as g (g._id)}
							<button
								type="button"
								onclick={() => pickGroup(g)}
								class="block w-full px-4 py-2 text-left text-sm hover:bg-[var(--color-tron-cyan)]/10"
							>
								{g.name}
							</button>
						{/each}
					</div>
				{/if}
				{#if groupName.trim() && !selectedGroupId}
					<p class="tron-text-muted mt-1 text-xs">
						Will create a new group <span class="font-medium">"{groupName.trim()}"</span>.
					</p>
				{:else if selectedGroupId}
					<p class="mt-1 text-xs text-[var(--color-tron-green)]">✓ Using existing group.</p>
				{/if}
			</div>

			<!-- Barcodes -->
			<div>
				<label for="barcodes" class="tron-text-muted mb-2 block text-sm font-medium">
					Barcodes <span class="text-[var(--color-tron-red)]">*</span>
					<span class="tron-text-muted">— one per line (or comma-separated)</span>
				</label>
				<textarea
					id="barcodes"
					bind:value={barcodesText}
					rows="6"
					placeholder={'OCA-0001\nOCA-0002\nOCA-0003'}
					class="tron-input w-full rounded-lg px-4 py-3 font-mono text-sm"
				></textarea>
				<p class="tron-text-muted mt-1 text-xs">{parsedBarcodes.length} barcode(s) detected.</p>
			</div>

			{#if errorMessage}
				<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-[var(--color-tron-red)]">{errorMessage}</div>
			{/if}

			{#if resultSummary}
				<div class="rounded-lg border border-[var(--color-tron-green)]/30 bg-[var(--color-tron-green)]/10 p-4">
					<p class="text-[var(--color-tron-green)]">Registered {resultSummary.created} cartridge(s).</p>
					{#if resultSummary.skipped.length > 0}
						<p class="tron-text-muted mt-2 text-sm">Skipped {resultSummary.skipped.length}:</p>
						<ul class="tron-text-muted mt-1 list-inside list-disc text-xs">
							{#each resultSummary.skipped as s (s.barcode)}
								<li><span class="font-mono">{s.barcode}</span> — {s.reason}</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/if}

			<button
				type="submit"
				onclick={register}
				disabled={!isValid || busy}
				class="flex w-full items-center justify-center gap-3 rounded-lg bg-[var(--color-tron-orange)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{busy ? 'Registering…' : `Register ${parsedBarcodes.length || ''} cartridge(s)`}
			</button>
			{#if !isValid}
				<p class="tron-text-muted text-center text-xs">
					Need — assay: {hasAssay ? '✓' : '✗ set on Criteria page'} · group: {groupName.trim() ? '✓' : '✗'} · barcodes: {parsedBarcodes.length > 0 ? '✓' : '✗'}
				</p>
			{/if}
		</div>
	</div>

	<!-- Existing cartridges -->
	<div class="tron-card">
		<div class="flex items-center justify-between border-b border-[var(--color-tron-border)] p-4">
			<h2 class="tron-heading text-lg font-semibold">Optical-Test Cartridges</h2>
			<span class="tron-text-muted text-sm">{cartridges.length} shown</span>
		</div>
		{#if cartridges.length === 0}
			<p class="tron-text-muted p-4 text-sm">No optical-test cartridges captured yet.</p>
		{:else}
			<div class="max-h-96 overflow-y-auto">
				<table class="w-full text-sm">
					<thead class="sticky top-0 bg-[var(--color-tron-bg-secondary)]">
						<tr class="text-left">
							<th class="tron-text-muted p-2">Barcode</th>
							<th class="tron-text-muted p-2">Group</th>
							<th class="tron-text-muted p-2">Assay</th>
							<th class="tron-text-muted p-2">Status</th>
						</tr>
					</thead>
					<tbody>
						{#each cartridges as c (c._id)}
							{@const badge = statusBadge(c.status)}
							<tr class="border-t border-[var(--color-tron-border)]">
								<td class="p-2 font-mono">{c.barcode}</td>
								<td class="tron-text-muted p-2">{c.groupId ? (groupNameById.get(c.groupId) ?? '—') : '—'}</td>
								<td class="tron-text-muted p-2">{c.assay?.skuCode ?? '—'}</td>
								<td class="p-2">
									<span class="rounded-full px-2 py-1 text-xs font-medium {badge.class}">{badge.label}</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>
