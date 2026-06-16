<script lang="ts">
	interface Parameter {
		name: string;
		channel: string;
		unit: string;
		min: number | null;
		max: number | null;
		target: number | null;
		required: boolean;
	}

	interface Assay {
		_id: string;
		name: string;
		skuCode: string;
	}

	interface OpticalConfirmation {
		assay?: { _id?: string; name?: string; skuCode?: string } | null;
		parameters?: Parameter[];
		locked?: boolean;
		lockedBy?: { _id?: string; username?: string } | null;
		lockedAt?: string | null;
		version?: number;
	}

	interface Props {
		data: {
			opticalConfirmation: OpticalConfirmation | null;
			assays: Assay[];
		};
	}

	let { data }: Props = $props();

	let assays = $derived(data.assays ?? []);
	let selectedAssaySku = $state<string>(data.opticalConfirmation?.assay?.skuCode ?? '');
	let isSavingAssay = $state(false);

	async function saveAssay() {
		isSavingAssay = true;
		message = null;
		try {
			const chosen = (data.assays ?? []).find((a) => a.skuCode === selectedAssaySku) ?? null;
			const res = await fetch('/api/validation/optical-confirmation/criteria', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					assay: chosen ? { _id: chosen._id, name: chosen.name, skuCode: chosen.skuCode } : null
				})
			});
			const body = await res.json();
			if (res.ok && body.success) {
				message = {
					type: 'success',
					text: chosen ? `Optical-confirmation assay set to ${chosen.skuCode}.` : 'Assay cleared.'
				};
			} else {
				message = { type: 'error', text: body.error ?? `Save failed (${res.status}).` };
			}
		} catch (err) {
			message = { type: 'error', text: err instanceof Error ? err.message : 'Save failed.' };
		} finally {
			isSavingAssay = false;
		}
	}

	function emptyRow(): Parameter {
		return { name: '', channel: '', unit: '', min: null, max: null, target: null, required: true };
	}

	function initRows(): Parameter[] {
		const params = data.opticalConfirmation?.parameters;
		if (params && params.length > 0) {
			return params.map((p) => ({
				name: p.name ?? '',
				channel: p.channel ?? '',
				unit: p.unit ?? '',
				min: p.min ?? null,
				max: p.max ?? null,
				target: p.target ?? null,
				required: p.required ?? true
			}));
		}
		return [emptyRow()];
	}

	let rows = $state<Parameter[]>(initRows());
	let locked = $state<boolean>(data.opticalConfirmation?.locked ?? false);
	let lockedByUsername = $state<string | null>(
		data.opticalConfirmation?.lockedBy?.username ?? null
	);
	let version = $state<number>(data.opticalConfirmation?.version ?? 1);

	let isSaving = $state(false);
	let isToggling = $state(false);
	let message = $state<{ type: 'success' | 'error'; text: string } | null>(null);

	function addRow() {
		rows = [...rows, emptyRow()];
	}

	function removeRow(index: number) {
		rows = rows.filter((_, i) => i !== index);
		if (rows.length === 0) rows = [emptyRow()];
	}

	async function save() {
		if (locked) {
			message = { type: 'error', text: 'Criteria are locked. Unlock as an admin to edit.' };
			return;
		}
		isSaving = true;
		message = null;
		try {
			const payload = {
				parameters: rows.map((r) => ({
					name: r.name,
					channel: r.channel,
					unit: r.unit,
					min: r.min === null || r.min === undefined ? null : Number(r.min),
					max: r.max === null || r.max === undefined ? null : Number(r.max),
					target: r.target === null || r.target === undefined ? null : Number(r.target),
					required: !!r.required
				}))
			};
			const res = await fetch('/api/validation/optical-confirmation/criteria', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(payload)
			});
			const body = await res.json();
			if (res.ok && body.success) {
				message = { type: 'success', text: 'Criteria saved successfully.' };
			} else {
				message = { type: 'error', text: body.error ?? `Save failed (${res.status}).` };
			}
		} catch (err) {
			message = { type: 'error', text: err instanceof Error ? err.message : 'Save failed.' };
		} finally {
			isSaving = false;
		}
	}

	async function toggleLock() {
		isToggling = true;
		message = null;
		const next = !locked;
		try {
			const res = await fetch('/api/validation/optical-confirmation/criteria/lock', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ locked: next })
			});
			const body = await res.json();
			if (res.ok && body.success) {
				locked = next;
				message = {
					type: 'success',
					text: next ? 'Criteria locked.' : 'Criteria unlocked.'
				};
			} else {
				message = { type: 'error', text: body.error ?? `Lock change failed (${res.status}).` };
			}
		} catch (err) {
			message = {
				type: 'error',
				text: err instanceof Error ? err.message : 'Lock change failed.'
			};
		} finally {
			isToggling = false;
		}
	}
</script>

<div class="mx-auto max-w-5xl space-y-6 p-6">
	<div>
		<h1 class="tron-heading text-2xl font-bold">Optical Confirmation Criteria</h1>
		<p class="tron-text-muted mt-1">
			Edit the pass/fail ranges for optical confirmation parameters. Admin only.
		</p>
	</div>

	{#if message}
		{#if message.type === 'success'}
			<div
				class="rounded-lg border border-[var(--color-tron-green)]/30 bg-[var(--color-tron-green)]/10 p-4 text-[var(--color-tron-green)]"
			>
				{message.text}
			</div>
		{:else}
			<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-[var(--color-tron-red)]">
				{message.text}
			</div>
		{/if}
	{/if}

	{#if locked}
		<div class="rounded-lg border border-[var(--color-tron-red)]/30 bg-[var(--color-tron-red)]/10 p-4">
			<div class="flex items-center gap-2">
				<span
					class="rounded-full bg-[var(--color-tron-red)]/20 px-2 py-1 text-xs font-medium text-[var(--color-tron-red)]"
					>Locked</span
				>
				<span class="text-[var(--color-tron-red)]">
					These criteria are locked{lockedByUsername ? ` by ${lockedByUsername}` : ''} (version {version}).
				</span>
			</div>
			<p class="tron-text-muted mt-2 text-sm">
				Editing while locked requires an admin. Unlock to make changes, then save.
			</p>
		</div>
	{/if}

	<div class="tron-card p-6">
		<h2 class="tron-heading mb-2 text-lg font-semibold">Optical Confirmation Assay</h2>
		<p class="tron-text-muted mb-4 text-sm">
			The single assay stamped onto every optical-test cartridge at capture. Pick it from the assay
			catalog.
		</p>
		<div class="flex flex-wrap items-end gap-4">
			<div class="min-w-64 flex-1">
				<label for="ocAssay" class="tron-text-muted mb-2 block text-sm font-medium">Assay</label>
				<select
					id="ocAssay"
					bind:value={selectedAssaySku}
					class="tron-input w-full rounded-lg px-4 py-3"
				>
					<option value="">— None —</option>
					{#each assays as a (a._id)}
						<option value={a.skuCode}>{a.name} ({a.skuCode})</option>
					{/each}
				</select>
			</div>
			<button
				type="button"
				onclick={saveAssay}
				disabled={isSavingAssay}
				class="rounded-lg bg-[var(--color-tron-orange)] px-6 py-3 font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90 disabled:cursor-not-allowed disabled:opacity-50"
			>
				{isSavingAssay ? 'Saving…' : 'Set Assay'}
			</button>
		</div>
		{#if !selectedAssaySku}
			<p class="mt-2 text-xs text-[var(--color-tron-red)]">
				No assay set — batch capture is blocked until you set one.
			</p>
		{/if}
	</div>

	<div class="tron-card">
		<div
			class="flex items-center justify-between border-b border-[var(--color-tron-border)] p-4"
		>
			<h2 class="tron-heading text-lg font-semibold">Parameters</h2>
			<button
				type="button"
				onclick={addRow}
				disabled={locked}
				class="tron-btn-secondary rounded-lg px-4 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-50"
			>
				+ Add Row
			</button>
		</div>

		<div class="overflow-x-auto p-4">
			<table class="w-full text-sm">
				<thead>
					<tr class="text-left">
						<th class="tron-text-muted p-2">Name</th>
						<th class="tron-text-muted p-2">Channel</th>
						<th class="tron-text-muted p-2">Unit</th>
						<th class="tron-text-muted p-2">Min</th>
						<th class="tron-text-muted p-2">Max</th>
						<th class="tron-text-muted p-2">Target</th>
						<th class="tron-text-muted p-2">Required</th>
						<th class="tron-text-muted p-2"></th>
					</tr>
				</thead>
				<tbody>
					{#each rows as row, i (i)}
						<tr class="border-t border-[var(--color-tron-border)]">
							<td class="p-2">
								<input
									type="text"
									bind:value={row.name}
									disabled={locked}
									class="tron-input w-full rounded-lg px-3 py-2 disabled:opacity-50"
								/>
							</td>
							<td class="p-2">
								<input
									type="text"
									bind:value={row.channel}
									disabled={locked}
									class="tron-input w-full rounded-lg px-3 py-2 disabled:opacity-50"
								/>
							</td>
							<td class="p-2">
								<input
									type="text"
									bind:value={row.unit}
									disabled={locked}
									class="tron-input w-full rounded-lg px-3 py-2 disabled:opacity-50"
								/>
							</td>
							<td class="p-2">
								<input
									type="number"
									step="any"
									bind:value={row.min}
									disabled={locked}
									class="tron-input w-24 rounded-lg px-3 py-2 disabled:opacity-50"
								/>
							</td>
							<td class="p-2">
								<input
									type="number"
									step="any"
									bind:value={row.max}
									disabled={locked}
									class="tron-input w-24 rounded-lg px-3 py-2 disabled:opacity-50"
								/>
							</td>
							<td class="p-2">
								<input
									type="number"
									step="any"
									bind:value={row.target}
									disabled={locked}
									class="tron-input w-24 rounded-lg px-3 py-2 disabled:opacity-50"
								/>
							</td>
							<td class="p-2 text-center">
								<input
									type="checkbox"
									bind:checked={row.required}
									disabled={locked}
									class="h-4 w-4 disabled:opacity-50"
								/>
							</td>
							<td class="p-2">
								<button
									type="button"
									onclick={() => removeRow(i)}
									disabled={locked}
									class="text-[var(--color-tron-red)] disabled:cursor-not-allowed disabled:opacity-50"
									aria-label="Remove row"
								>
									Remove
								</button>
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	</div>

	<div class="flex flex-wrap items-center gap-4">
		<button
			type="button"
			onclick={save}
			disabled={locked || isSaving}
			class="flex items-center justify-center gap-3 rounded-lg bg-[var(--color-tron-orange)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90 disabled:cursor-not-allowed disabled:opacity-50"
		>
			{isSaving ? 'Saving…' : 'Save Criteria'}
		</button>

		<button
			type="button"
			onclick={toggleLock}
			disabled={isToggling}
			class="flex items-center justify-center gap-3 rounded-lg bg-[var(--color-tron-cyan)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-cyan)]/90 disabled:cursor-not-allowed disabled:opacity-50"
		>
			{isToggling ? 'Working…' : locked ? 'Unlock' : 'Lock'}
		</button>
	</div>
</div>
