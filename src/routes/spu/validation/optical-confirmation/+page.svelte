<script lang="ts">
	import { invalidateAll } from '$app/navigation';

	interface CriteriaParam {
		name: string;
		channel: string;
		unit?: string;
		min?: number | null;
		max?: number | null;
		target?: number | null;
		required?: boolean;
	}

	interface Spu {
		_id: string;
		udi: string;
		status: string;
		validation?: {
			opticalConfirmation?: {
				status?: string;
				labCartridgeId?: string;
				cartridgeBarcode?: string;
				assay?: { _id?: string; name?: string; skuCode?: string };
			};
		};
	}

	interface Cartridge {
		_id: string;
		barcode: string;
		status: string;
		expirationDate?: string | null;
		assay?: { _id?: string; name?: string; skuCode?: string };
	}

	interface ResultRow {
		name: string;
		channel: string;
		unit?: string;
		value: number | null;
		min: number | null;
		max: number | null;
		passed: boolean;
	}

	interface Props {
		data: {
			spus: Spu[];
			cartridges: Cartridge[];
			criteria: { parameters?: CriteriaParam[]; locked?: boolean; version?: number } | null;
		};
	}

	let { data }: Props = $props();

	// --- form state ---
	let selectedSpuId = $state('');
	let selectedBarcode = $state('');
	let reason = $state('');
	let readingValues = $state<Record<string, string>>({});

	let result = $state<{ overallPassed: boolean; results: ResultRow[]; sessionId: string } | null>(
		null
	);
	let error = $state('');
	let busy = $state(false);

	// live "is this cartridge already used?" status for the scanned/selected barcode
	let cartridgeStatus = $state<{
		checking: boolean;
		exists: boolean;
		available?: boolean;
		status?: string;
		cartridgeType?: string;
	} | null>(null);

	// --- derived ---
	let selectedSpu = $derived(data.spus.find((s) => s._id === selectedSpuId) ?? null);
	let attachedOc = $derived(selectedSpu?.validation?.opticalConfirmation ?? null);
	let isAttached = $derived(!!attachedOc?.labCartridgeId);
	let parameters = $derived(data.criteria?.parameters ?? []);
	let hasCriteria = $derived(parameters.length > 0);

	function statusBadge(status: string | undefined) {
		switch (status) {
			case 'passed':
				return {
					class: 'bg-[var(--color-tron-green)]/20 text-[var(--color-tron-green)]',
					label: 'Passed'
				};
			case 'failed':
				return {
					class: 'bg-[var(--color-tron-red)]/20 text-[var(--color-tron-red)]',
					label: 'Failed'
				};
			default:
				return {
					class: 'bg-[var(--color-tron-text-secondary)]/20 text-[var(--color-tron-text-secondary)]',
					label: 'Pending'
				};
		}
	}

	async function postJson(url: string, body: unknown) {
		const res = await fetch(url, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body)
		});
		let payload: any = null;
		try {
			payload = await res.json();
		} catch {
			payload = null;
		}
		return { ok: res.ok, payload };
	}

	async function checkCartridge() {
		const b = selectedBarcode.trim();
		if (!b) {
			cartridgeStatus = null;
			return;
		}
		// fast path: anything in the available dropdown list is, by definition, available
		if (data.cartridges.find((c) => c.barcode === b)) {
			cartridgeStatus = { checking: false, exists: true, available: true, status: 'available', cartridgeType: 'optical_test' };
			return;
		}
		cartridgeStatus = { checking: true, exists: false };
		try {
			const res = await fetch('/api/validation/optical-confirmation/cartridges?barcode=' + encodeURIComponent(b));
			const r = await res.json();
			cartridgeStatus = {
				checking: false,
				exists: !!r.exists,
				available: r.exists ? !r.used : undefined,
				status: r.status,
				cartridgeType: r.cartridgeType
			};
		} catch {
			cartridgeStatus = null;
		}
	}

	async function attach() {
		error = '';
		if (!selectedSpuId) {
			error = 'Select an SPU first';
			return;
		}
		if (!selectedBarcode) {
			error = 'Select a cartridge to attach';
			return;
		}
		busy = true;
		const { ok, payload } = await postJson('/api/validation/optical-confirmation/attach', {
			spuId: selectedSpuId,
			cartridgeBarcode: selectedBarcode
		});
		busy = false;
		if (ok && payload?.success) {
			selectedBarcode = '';
			await invalidateAll();
		} else {
			error = payload?.error ?? 'Attach failed';
		}
	}

	async function detach() {
		error = '';
		if (!selectedSpuId) {
			error = 'Select an SPU first';
			return;
		}
		const r = (reason || '').trim();
		if (!r) {
			error = 'A reason is required to detach';
			return;
		}
		busy = true;
		const { ok, payload } = await postJson('/api/validation/optical-confirmation/detach', {
			spuId: selectedSpuId,
			reason: r
		});
		busy = false;
		if (ok && payload?.success) {
			reason = '';
			result = null;
			await invalidateAll();
		} else {
			error = payload?.error ?? 'Detach failed';
		}
	}

	async function run() {
		error = '';
		result = null;
		if (!selectedSpuId) {
			error = 'Select an SPU first';
			return;
		}
		if (!isAttached) {
			error = 'Attach a cartridge before running';
			return;
		}
		if (!hasCriteria) {
			error = 'No optical confirmation criteria configured';
			return;
		}

		const readings = parameters.map((p, i) => ({
			readingNumber: i + 1,
			channel: p.channel,
			value: Number(readingValues[p.channel]),
			timestampMs: 0
		}));

		const bad = readings.find((r) => Number.isNaN(r.value));
		if (bad) {
			error = 'Enter a numeric value for every channel';
			return;
		}

		busy = true;
		const { ok, payload } = await postJson('/api/validation/optical-confirmation/result', {
			spuId: selectedSpuId,
			readings
		});
		busy = false;
		if (ok && payload?.success) {
			result = {
				overallPassed: !!payload.overallPassed,
				results: payload.results ?? [],
				sessionId: payload.sessionId
			};
			await invalidateAll();
		} else {
			error = payload?.error ?? 'Run failed';
		}
	}
</script>

<div class="space-y-8">
	<!-- Header -->
	<div class="flex items-start justify-between">
		<div>
			<h1 class="tron-heading text-2xl font-bold">Optical Confirmation</h1>
			<p class="tron-text-muted mt-1">
				Attach a test cartridge to an SPU, capture an optical reading, and record pass/fail.
			</p>
		</div>
		<div class="flex gap-2">
			<a
				href="./optical-confirmation/cartridges"
				class="rounded-lg bg-[var(--color-tron-bg-tertiary)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-cyan)]/20 hover:text-[var(--color-tron-cyan)]"
			>
				Capture cartridges
			</a>
			<a
				href="./optical-confirmation/criteria"
				class="rounded-lg bg-[var(--color-tron-bg-tertiary)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] transition-colors hover:bg-[var(--color-tron-orange)]/20 hover:text-[var(--color-tron-orange)]"
			>
				Criteria
			</a>
		</div>
	</div>

	<!-- Global error -->
	{#if error}
		<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-[var(--color-tron-red)]">
			{error}
		</div>
	{/if}

	<!-- SPU picker -->
	<div class="tron-card p-6">
		<h2 class="tron-heading mb-6 text-lg font-semibold">1. Select SPU</h2>

		{#if data.spus.length === 0}
			<p class="tron-text-muted text-sm">
				No SPUs in an assembling / assembled / validating state are available.
			</p>
		{:else}
			<label for="spuPicker" class="tron-text-muted mb-2 block text-sm font-medium">SPU</label>
			<select
				id="spuPicker"
				bind:value={selectedSpuId}
				onchange={() => {
					result = null;
					error = '';
					selectedBarcode = '';
					cartridgeStatus = null;
				}}
				class="tron-input w-full rounded-lg px-4 py-3"
			>
				<option value="">— Select an SPU —</option>
				{#each data.spus as spu (spu._id)}
					<option value={spu._id}>{spu.udi} ({spu.status})</option>
				{/each}
			</select>

			{#if selectedSpu}
				{@const badge = statusBadge(attachedOc?.status)}
				<div class="mt-4 flex flex-wrap items-center gap-3">
					<span class="tron-text-muted text-sm">Optical confirmation status:</span>
					<span class="rounded-full px-2 py-1 text-xs font-medium {badge.class}">
						{badge.label}
					</span>
					{#if attachedOc?.cartridgeBarcode}
						<span class="tron-text-muted text-sm">
							Cartridge: <span class="tron-heading font-medium">{attachedOc.cartridgeBarcode}</span>
							{#if attachedOc.assay?.skuCode}· {attachedOc.assay.skuCode}{/if}
						</span>
					{/if}
				</div>
			{/if}
		{/if}
	</div>

	<!-- Attach / Detach cartridge -->
	{#if selectedSpu}
		<div class="tron-card p-6">
			<h2 class="tron-heading mb-6 text-lg font-semibold">2. Cartridge</h2>

			{#if isAttached}
				<div
					class="rounded-lg border border-[var(--color-tron-green)]/30 bg-[var(--color-tron-green)]/10 p-4"
				>
					<p class="text-[var(--color-tron-green)]">
						Cartridge <span class="font-medium">{attachedOc?.cartridgeBarcode}</span> is attached.
					</p>
				</div>

				<div class="mt-6 space-y-3">
					<label for="detachReason" class="tron-text-muted block text-sm font-medium">
						Reason (required to detach)
					</label>
					<input
						id="detachReason"
						type="text"
						bind:value={reason}
						placeholder="e.g. wrong cartridge scanned"
						class="tron-input w-full rounded-lg px-4 py-3"
					/>
					<button
						type="button"
						onclick={detach}
						disabled={busy || !reason.trim()}
						class="rounded-lg border border-[var(--color-tron-red)]/30 bg-[var(--color-tron-red)]/10 px-6 py-3 text-sm font-semibold text-[var(--color-tron-red)] transition-all hover:bg-[var(--color-tron-red)]/20 disabled:cursor-not-allowed disabled:opacity-50"
					>
						Detach cartridge
					</button>
				</div>
			{:else}
				<label for="cartridgeScan" class="tron-text-muted mb-2 block text-sm font-medium">
					Scan cartridge barcode
				</label>
				<input
					id="cartridgeScan"
					type="text"
					bind:value={selectedBarcode}
					onblur={checkCartridge}
					placeholder="Scan or type barcode…"
					class="tron-input w-full rounded-lg px-4 py-3 text-lg"
				/>

				{#if cartridgeStatus && !cartridgeStatus.checking}
					{#if cartridgeStatus.exists && cartridgeStatus.available}
						<p class="mt-1 text-xs text-[var(--color-tron-green)]">✓ Available — ready to attach.</p>
					{:else if cartridgeStatus.exists}
						<p class="mt-1 text-xs text-[var(--color-tron-red)]">
							⚠ Already used (type: {cartridgeStatus.cartridgeType}, status: {cartridgeStatus.status}). Pick another cartridge.
						</p>
					{:else}
						<p class="mt-1 text-xs text-[var(--color-tron-red)]">
							⚠ No captured optical-test cartridge with that barcode — capture it first.
						</p>
					{/if}
				{/if}

				{#if data.cartridges.length > 0}
					<label for="cartridgePicker" class="tron-text-muted mt-4 mb-2 block text-sm font-medium">
						…or pick an available one
					</label>
					<select
						id="cartridgePicker"
						bind:value={selectedBarcode}
						onchange={checkCartridge}
						class="tron-input w-full rounded-lg px-4 py-3"
					>
						<option value="">— Select a cartridge —</option>
						{#each data.cartridges as c (c._id)}
							<option value={c.barcode}>
								{c.barcode}{#if c.assay?.skuCode}
									· {c.assay.skuCode}{/if}
							</option>
						{/each}
					</select>
				{:else}
					<p class="tron-text-muted mt-3 text-sm">
						No available optical-test cartridges in inventory — scan one above, or
						<a
							href="./optical-confirmation/cartridges"
							class="text-[var(--color-tron-cyan)] hover:underline">capture one</a
						> first.
					</p>
				{/if}

				<button
					type="button"
					onclick={attach}
					disabled={busy ||
						!selectedBarcode.trim() ||
						(cartridgeStatus?.exists === true && cartridgeStatus?.available === false)}
					class="mt-6 flex w-full items-center justify-center gap-3 rounded-lg bg-[var(--color-tron-cyan)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-cyan)]/90 disabled:cursor-not-allowed disabled:opacity-50"
				>
					Attach cartridge
				</button>
				{#if !selectedBarcode.trim()}
					<p class="tron-text-muted mt-2 text-center text-xs">Scan or select a cartridge barcode to enable.</p>
				{:else if cartridgeStatus?.exists === true && cartridgeStatus?.available === false}
					<p class="tron-text-muted mt-2 text-center text-xs">
						This cartridge is {cartridgeStatus.status} — choose an available one.
					</p>
				{/if}
			{/if}
		</div>
	{/if}

	<!-- Run reading -->
	{#if selectedSpu && isAttached}
		<div class="tron-card p-6">
			<h2 class="tron-heading mb-6 text-lg font-semibold">3. Capture reading</h2>

			{#if !hasCriteria}
				<div class="rounded-lg bg-[var(--color-tron-red)]/10 p-4 text-[var(--color-tron-red)]">
					No optical confirmation criteria are configured. Set criteria on the
					<a href="./optical-confirmation/criteria" class="underline">criteria page</a> before running.
				</div>
			{:else}
				<div class="space-y-4">
					{#each parameters as p (p.channel)}
						<div>
							<label
								for={'reading-' + p.channel}
								class="tron-text-muted mb-2 block text-sm font-medium"
							>
								{p.name} (channel {p.channel}){#if p.unit}
									· {p.unit}{/if}
								{#if p.min != null || p.max != null}
									<span class="tron-text-muted">
										[{p.min ?? '—'}, {p.max ?? '—'}]
									</span>
								{/if}
							</label>
							<input
								id={'reading-' + p.channel}
								type="number"
								step="any"
								bind:value={readingValues[p.channel]}
								class="tron-input w-full rounded-lg px-4 py-3 text-lg"
							/>
						</div>
					{/each}

					<button
						type="button"
						onclick={run}
						disabled={busy}
						class="flex w-full items-center justify-center gap-3 rounded-lg bg-[var(--color-tron-orange)] px-6 py-4 text-lg font-semibold text-[var(--color-tron-bg-primary)] transition-all hover:bg-[var(--color-tron-orange)]/90 disabled:cursor-not-allowed disabled:opacity-50"
					>
						{busy ? 'Submitting…' : 'Submit reading'}
					</button>
				</div>
			{/if}
		</div>
	{/if}

	<!-- Result -->
	{#if result}
		<div class="tron-card p-6">
			<h2 class="tron-heading mb-6 text-lg font-semibold">Result</h2>

			{#if result.overallPassed}
				<div
					class="rounded-lg border border-[var(--color-tron-green)]/30 bg-[var(--color-tron-green)]/10 p-6 text-center"
				>
					<p class="text-3xl font-bold text-[var(--color-tron-green)]">PASS</p>
				</div>
			{:else}
				<div
					class="rounded-lg border border-[var(--color-tron-red)]/30 bg-[var(--color-tron-red)]/10 p-6 text-center"
				>
					<p class="text-3xl font-bold text-[var(--color-tron-red)]">FAIL</p>
				</div>
			{/if}

			<div class="mt-6 overflow-x-auto">
				<table class="w-full text-sm">
					<thead class="bg-[var(--color-tron-bg-secondary)]">
						<tr class="text-left">
							<th class="tron-text-muted p-2">Parameter</th>
							<th class="tron-text-muted p-2">Channel</th>
							<th class="tron-text-muted p-2">Value</th>
							<th class="tron-text-muted p-2">Range</th>
							<th class="tron-text-muted p-2">Result</th>
						</tr>
					</thead>
					<tbody>
						{#each result.results as r (r.channel + r.name)}
							{@const badge = statusBadge(r.passed ? 'passed' : 'failed')}
							<tr class="border-t border-[var(--color-tron-border)]">
								<td class="tron-heading p-2 font-medium">{r.name}</td>
								<td class="tron-text-muted p-2">{r.channel}</td>
								<td class="p-2">{r.value ?? '—'}{#if r.unit}
										{r.unit}{/if}</td>
								<td class="tron-text-muted p-2">[{r.min ?? '—'}, {r.max ?? '—'}]</td>
								<td class="p-2">
									<span class="rounded-full px-2 py-1 text-xs font-medium {badge.class}">
										{badge.label}
									</span>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</div>
