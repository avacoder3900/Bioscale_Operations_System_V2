<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	interface Arm {
		name: string;
		assayId: string;
		assayName?: string;
	}
	interface Experiment {
		_id: string;
		name: string;
		program?: string;
		folderId?: string;
		arms: Arm[];
	}
	interface Cartridge {
		_id: string;
		status?: string | null;
		assayId?: string | null;
		serialNumber?: string | null;
		experiment?: string | null;
		arm?: string | null;
	}
	interface VerifiedRow {
		_id: string;
		status?: string | null;
		assayId?: string | null;
		serialNumber?: string | null;
		experiment?: string | null;
		arm?: string | null;
	}
	interface Props {
		data: {
			experiments: Experiment[];
			cartridges: Cartridge[];
			dbName: string;
		};
	}

	let { data }: Props = $props();

	let cartridges = $state<Cartridge[]>(data.cartridges ?? []);
	let selectedExperimentId = $state('');
	let selectedArmIndex = $state('');
	let barcodesText = $state('');
	let busy = $state(false);
	let errorMessage = $state<string | null>(null);
	let result = $state<{
		updated: number;
		skipped: { barcode: string; reason: string }[];
		verified: VerifiedRow[];
		assayId: string;
		experiment: string;
		arm: string;
		dbName: string;
	} | null>(null);

	let selectedExperiment = $derived(data.experiments.find((e) => e._id === selectedExperimentId) ?? null);
	let arms = $derived(selectedExperiment?.arms ?? []);
	let selectedArm = $derived(selectedArmIndex !== '' ? arms[Number(selectedArmIndex)] : null);
	let parsedBarcodes = $derived(barcodesText.split(/[\n,]/).map((b) => b.trim()).filter(Boolean));
	let isValid = $derived(!!selectedExperimentId && selectedArmIndex !== '' && parsedBarcodes.length > 0);

	function statusColor(s?: string | null) {
		if (s === 'linked' || s === 'completed') return 'text-[var(--color-tron-green)]';
		if (s === 'underway') return 'text-[var(--color-tron-cyan)]';
		if (s === 'cancelled') return 'text-[var(--color-tron-red)]';
		return '';
	}

	async function register() {
		if (!isValid || busy) return;
		busy = true;
		errorMessage = null;
		result = null;
		try {
			const res = await fetch('/api/validation/optical-confirmation/cartridges', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					experimentId: selectedExperimentId,
					armIndex: Number(selectedArmIndex),
					barcodes: parsedBarcodes
				})
			});
			const r = await res.json();
			if (!res.ok || r.error) {
				errorMessage = r.error ?? 'Add to arm failed';
				return;
			}
			result = {
				updated: r.updated ?? 0,
				skipped: r.skipped ?? [],
				verified: r.verified ?? [],
				assayId: r.assayId,
				experiment: r.experiment,
				arm: r.arm,
				dbName: r.dbName
			};
			barcodesText = '';
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
		<h1 class="tron-heading text-2xl font-bold">Optical Confirmation — Add Cartridges to an Experiment Arm</h1>
		<p class="tron-text-muted mt-1">
			Assign cartridges to an experiment → arm so the SPU runs (and completes) the optical scan. This
			stamps the runnable research shape (status linked + assay + folder/experiment/arm + serialNumber)
			onto <span class="font-mono">cartridge_records</span> and registers them on the arm.
		</p>
		<p class="tron-text-muted mt-1 text-xs">
			Database: <span class="font-mono text-[var(--color-tron-cyan)]">{data.dbName}</span>
		</p>
	</div>

	<div class="tron-card p-6">
		<h2 class="tron-heading mb-4 text-lg font-semibold">Register barcodes</h2>

		<div class="space-y-4">
			<!-- Experiment -->
			<div>
				<label for="experiment" class="tron-text-muted mb-2 block text-sm font-medium">
					Experiment <span class="text-[var(--color-tron-red)]">*</span>
				</label>
				<select
					id="experiment"
					bind:value={selectedExperimentId}
					onchange={() => (selectedArmIndex = '')}
					class="tron-input w-full rounded-lg px-4 py-3"
				>
					<option value="">— Select an experiment —</option>
					{#each data.experiments as e (e._id)}
						<option value={e._id}>{e.name}{e.program ? ` · ${e.program}` : ''}</option>
					{/each}
				</select>
			</div>

			<!-- Arm -->
			<div>
				<label for="arm" class="tron-text-muted mb-2 block text-sm font-medium">
					Arm <span class="text-[var(--color-tron-red)]">*</span>
				</label>
				<select
					id="arm"
					bind:value={selectedArmIndex}
					disabled={!selectedExperiment}
					class="tron-input w-full rounded-lg px-4 py-3 disabled:opacity-50"
				>
					<option value="">— Select an arm —</option>
					{#each arms as a, i (a.name + i)}
						<option value={String(i)}>{a.name} · assay {a.assayId}{a.assayName ? ` (${a.assayName})` : ''}</option>
					{/each}
				</select>
				{#if selectedArm}
					<p class="mt-1 text-xs text-[var(--color-tron-green)]">
						✓ Assay <span class="font-mono">{selectedArm.assayId}</span> · folder {selectedExperiment?.folderId}
					</p>
				{/if}
			</div>

			<!-- Barcodes -->
			<div>
				<label for="barcodes" class="tron-text-muted mb-2 block text-sm font-medium">
					Barcodes <span class="text-[var(--color-tron-red)]">*</span>
					<span class="tron-text-muted">— one per line (cartridge _id / scanned barcode)</span>
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
				{busy ? 'Adding…' : `Add ${parsedBarcodes.length || ''} cartridge(s) to arm`}
			</button>
			{#if !isValid}
				<p class="tron-text-muted text-center text-xs">
					Need — experiment: {selectedExperimentId ? '✓' : '✗'} · arm: {selectedArmIndex !== '' ? '✓' : '✗'} · barcodes: {parsedBarcodes.length > 0 ? '✓' : '✗'}
				</p>
			{/if}
		</div>
	</div>

	<!-- Verification -->
	{#if result}
		<div class="tron-card p-6">
			<div class="flex flex-wrap items-center gap-3">
				<span class="rounded-full bg-[var(--color-tron-green)]/20 px-3 py-1 text-sm font-semibold text-[var(--color-tron-green)]">✓ Verified in MongoDB</span>
				<span class="tron-text-secondary text-sm">
					database <span class="font-mono text-[var(--color-tron-cyan)]">{result.dbName}</span> · {result.updated} cartridge(s) added to
					<span class="font-medium">{result.experiment} / {result.arm}</span> · assay <span class="font-mono">{result.assayId}</span>
					{#if result.skipped.length > 0}· {result.skipped.length} skipped{/if}
				</span>
			</div>

			{#if result.verified.length > 0}
				<div class="mt-4 overflow-x-auto">
					<table class="w-full text-sm">
						<thead class="bg-[var(--color-tron-bg-secondary)]">
							<tr class="text-left">
								<th class="tron-text-muted p-2">Cartridge _id</th>
								<th class="tron-text-muted p-2">status</th>
								<th class="tron-text-muted p-2">assayId</th>
								<th class="tron-text-muted p-2">serialNumber</th>
								<th class="tron-text-muted p-2">arm</th>
							</tr>
						</thead>
						<tbody>
							{#each result.verified as row (row._id)}
								<tr class="border-t border-[var(--color-tron-border)]">
									<td class="p-2 font-mono">{row._id}</td>
									<td class="p-2 font-mono {statusColor(row.status)}">{row.status ?? '—'}</td>
									<td class="p-2 font-mono text-[var(--color-tron-cyan)]">{row.assayId ?? '—'}</td>
									<td class="tron-text-muted p-2 font-mono">{row.serialNumber ?? '—'}</td>
									<td class="tron-text-muted p-2">{row.arm ?? '—'}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}

			{#if result.skipped.length > 0}
				<p class="tron-text-muted mt-3 text-sm">Skipped:</p>
				<ul class="tron-text-muted mt-1 list-inside list-disc text-xs">
					{#each result.skipped as s (s.barcode)}
						<li><span class="font-mono">{s.barcode}</span> — {s.reason}</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}

	<!-- Existing -->
	<div class="tron-card">
		<div class="flex items-center justify-between border-b border-[var(--color-tron-border)] p-4">
			<h2 class="tron-heading text-lg font-semibold">Optical-Test Cartridges</h2>
			<span class="tron-text-muted text-sm">{cartridges.length} shown</span>
		</div>
		{#if cartridges.length === 0}
			<p class="tron-text-muted p-4 text-sm">No optical-test cartridges yet.</p>
		{:else}
			<div class="max-h-96 overflow-y-auto">
				<table class="w-full text-sm">
					<thead class="sticky top-0 bg-[var(--color-tron-bg-secondary)]">
						<tr class="text-left">
							<th class="tron-text-muted p-2">Cartridge _id</th>
							<th class="tron-text-muted p-2">status</th>
							<th class="tron-text-muted p-2">assayId</th>
							<th class="tron-text-muted p-2">serialNumber</th>
							<th class="tron-text-muted p-2">arm</th>
						</tr>
					</thead>
					<tbody>
						{#each cartridges as c (c._id)}
							<tr class="border-t border-[var(--color-tron-border)]">
								<td class="p-2 font-mono">{c._id}</td>
								<td class="p-2 font-mono {statusColor(c.status)}">{c.status ?? '—'}</td>
								<td class="p-2 font-mono">{c.assayId ?? '—'}</td>
								<td class="tron-text-muted p-2 font-mono">{c.serialNumber ?? '—'}</td>
								<td class="tron-text-muted p-2">{c.arm ?? '—'}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</div>
</div>
