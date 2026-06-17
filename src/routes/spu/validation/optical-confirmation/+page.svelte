<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	interface Group {
		_id: string;
		name: string;
		color?: string;
	}
	interface Cartridge {
		_id: string; // = barcode
		assayId?: string | null;
		validationGroupId?: string | null;
		currentPhase?: string | null;
		assayCategorizedAt?: string | null;
	}
	interface VerifiedRow {
		_id: string;
		assayId?: string | null;
		assayCategory?: string | null;
		validationGroupId?: string | null;
		currentPhase?: string | null;
	}
	interface Props {
		data: {
			groups: Group[];
			cartridges: Cartridge[];
			dbName: string;
		};
	}

	let { data }: Props = $props();

	let cartridges = $state<Cartridge[]>(data.cartridges ?? []);
	let assayId = $state('');
	let groupName = $state('');
	let selectedGroupId = $state('');
	let groupSuggestions = $state<Group[]>([]);
	let barcodesText = $state('');
	let busy = $state(false);
	let errorMessage = $state<string | null>(null);
	let result = $state<{
		updated: number;
		skipped: { barcode: string; reason: string }[];
		verified: VerifiedRow[];
		assayId: string;
		groupName?: string;
		dbName: string;
	} | null>(null);

	const groupNameById = $derived(new Map((data.groups ?? []).map((g) => [g._id, g.name])));
	let parsedBarcodes = $derived(barcodesText.split(/[\n,]/).map((b) => b.trim()).filter(Boolean));
	let isValid = $derived(assayId.trim().length > 0 && parsedBarcodes.length > 0);

	async function searchGroups() {
		const q = groupName.trim();
		selectedGroupId = '';
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

	function groupLabel(id?: string | null): string {
		if (!id) return '—';
		return groupNameById.get(id) ?? result?.groupName ?? id;
	}

	async function register() {
		if (!isValid || busy) return;
		busy = true;
		errorMessage = null;
		result = null;
		try {
			const body: Record<string, unknown> = { barcodes: parsedBarcodes, assayId: assayId.trim() };
			if (selectedGroupId) body.groupId = selectedGroupId;
			else if (groupName.trim()) body.groupName = groupName.trim();

			const res = await fetch('/api/validation/optical-confirmation/cartridges', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			const r = await res.json();
			if (!res.ok || r.error) {
				errorMessage = r.error ?? 'Update failed';
				return;
			}
			result = {
				updated: r.updated ?? 0,
				skipped: r.skipped ?? [],
				verified: r.verified ?? [],
				assayId: r.assayId,
				groupName: r.groupName,
				dbName: r.dbName
			};
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
	<div>
		<h1 class="tron-heading text-2xl font-bold">Optical Confirmation — Cartridges</h1>
		<p class="tron-text-muted mt-1">
			Categorize cartridges as optical-test by writing an assay ID directly onto their
			<span class="font-mono">cartridge_records</span> documents.
		</p>
		<p class="tron-text-muted mt-1 text-xs">
			BIMS is connected to database: <span class="font-mono text-[var(--color-tron-cyan)]">{data.dbName}</span>
			— make sure that's the database you're inspecting.
		</p>
	</div>

	<!-- Register -->
	<div class="tron-card p-6">
		<h2 class="tron-heading mb-4 text-lg font-semibold">Set assay ID on cartridges</h2>

		<div class="space-y-4">
			<div>
				<label for="assayId" class="tron-text-muted mb-2 block text-sm font-medium">
					Assay ID <span class="text-[var(--color-tron-red)]">*</span>
				</label>
				<input
					id="assayId"
					type="text"
					bind:value={assayId}
					placeholder="Assay / validation ID to write onto each cartridge_records doc"
					class="tron-input w-full rounded-lg px-4 py-3 font-mono"
				/>
			</div>

			<!-- Validation group (optional) -->
			<div class="relative">
				<label for="group" class="tron-text-muted mb-2 block text-sm font-medium">
					Validation group <span class="tron-text-muted">(optional)</span>
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
							<button type="button" onclick={() => pickGroup(g)} class="block w-full px-4 py-2 text-left text-sm hover:bg-[var(--color-tron-cyan)]/10">{g.name}</button>
						{/each}
					</div>
				{/if}
				{#if groupName.trim() && !selectedGroupId}
					<p class="tron-text-muted mt-1 text-xs">Will create a new group <span class="font-medium">"{groupName.trim()}"</span>.</p>
				{:else if selectedGroupId}
					<p class="mt-1 text-xs text-[var(--color-tron-green)]">✓ Using existing group.</p>
				{/if}
			</div>

			<div>
				<label for="barcodes" class="tron-text-muted mb-2 block text-sm font-medium">
					Barcodes <span class="text-[var(--color-tron-red)]">*</span>
					<span class="tron-text-muted">— one per line (each must match an existing cartridge_records _id)</span>
				</label>
				<textarea
					id="barcodes"
					bind:value={barcodesText}
					rows="6"
					placeholder={'cartridge-id-1\ncartridge-id-2'}
					class="tron-input w-full rounded-lg px-4 py-3 font-mono text-sm"
				></textarea>
				<p class="tron-text-muted mt-1 text-xs">{parsedBarcodes.length} barcode(s) detected.</p>
			</div>

			{#if errorMessage}
				<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-[var(--color-tron-red)]">{errorMessage}</div>
			{/if}

			<button
				type="submit"
				onclick={register}
				disabled={!isValid || busy}
				class="flex w-full items-center justify-center gap-3 rounded-lg bg-[var(--color-tron-orange)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{busy ? 'Writing…' : `Set assay ID on ${parsedBarcodes.length || ''} cartridge(s)`}
			</button>
			{#if !isValid}
				<p class="tron-text-muted text-center text-xs">
					Need — assay ID: {assayId.trim() ? '✓' : '✗'} · barcodes: {parsedBarcodes.length > 0 ? '✓' : '✗'}
				</p>
			{/if}
		</div>
	</div>

	<!-- Mongo verification -->
	{#if result}
		<div class="tron-card p-6">
			<div class="flex flex-wrap items-center gap-3">
				<span class="rounded-full bg-[var(--color-tron-green)]/20 px-3 py-1 text-sm font-semibold text-[var(--color-tron-green)]">
					✓ Verified in MongoDB
				</span>
				<span class="tron-text-secondary text-sm">
					database <span class="font-mono text-[var(--color-tron-cyan)]">{result.dbName}</span> ·
					collection <span class="font-mono">cartridge_records</span> ·
					{result.updated} updated{#if result.skipped.length > 0} · {result.skipped.length} skipped{/if}
				</span>
			</div>
			<p class="tron-text-muted mt-2 text-sm">
				assayId written: <span class="font-mono text-[var(--color-tron-cyan)]">{result.assayId}</span>
				{#if result.groupName}· group <span class="font-medium">{result.groupName}</span>{/if}
			</p>

			{#if result.verified.length > 0}
				<div class="mt-4 overflow-x-auto">
					<table class="w-full text-sm">
						<thead class="bg-[var(--color-tron-bg-secondary)]">
							<tr class="text-left">
								<th class="tron-text-muted p-2">Cartridge _id (barcode)</th>
								<th class="tron-text-muted p-2">assayId (stored in Mongo)</th>
								<th class="tron-text-muted p-2">Group</th>
								<th class="tron-text-muted p-2">Phase</th>
							</tr>
						</thead>
						<tbody>
							{#each result.verified as row (row._id)}
								<tr class="border-t border-[var(--color-tron-border)]">
									<td class="p-2 font-mono">{row._id}</td>
									<td class="p-2 font-mono text-[var(--color-tron-cyan)]">{row.assayId ?? '—'}</td>
									<td class="tron-text-muted p-2">{groupLabel(row.validationGroupId)}</td>
									<td class="tron-text-muted p-2">{row.currentPhase ?? '—'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			{#if result.skipped.length > 0}
				<p class="tron-text-muted mt-3 text-sm">Skipped (no matching cartridge_records doc):</p>
				<ul class="tron-text-muted mt-1 list-inside list-disc text-xs">
					{#each result.skipped as s (s.barcode)}
						<li><span class="font-mono">{s.barcode}</span> — {s.reason}</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}

	<!-- Existing categorized cartridges -->
	<div class="tron-card">
		<div class="flex items-center justify-between border-b border-[var(--color-tron-border)] p-4">
			<h2 class="tron-heading text-lg font-semibold">Optical-Test Cartridges (assayId set)</h2>
			<span class="tron-text-muted text-sm">{cartridges.length} shown</span>
		</div>
		{#if cartridges.length === 0}
			<p class="tron-text-muted p-4 text-sm">No cartridge_records have an assayId set yet.</p>
		{:else}
			<div class="max-h-96 overflow-y-auto">
				<table class="w-full text-sm">
					<thead class="sticky top-0 bg-[var(--color-tron-bg-secondary)]">
						<tr class="text-left">
							<th class="tron-text-muted p-2">Cartridge _id</th>
							<th class="tron-text-muted p-2">assayId</th>
							<th class="tron-text-muted p-2">Group</th>
							<th class="tron-text-muted p-2">Phase</th>
						</tr>
					</thead>
					<tbody>
						{#each cartridges as c (c._id)}
							<tr class="border-t border-[var(--color-tron-border)]">
								<td class="p-2 font-mono">{c._id}</td>
								<td class="p-2 font-mono">{c.assayId ?? '—'}</td>
								<td class="tron-text-muted p-2">{groupLabel(c.validationGroupId)}</td>
								<td class="tron-text-muted p-2">{c.currentPhase ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>
