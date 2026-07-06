<script lang="ts">
	// Cartridge Intake — scan/type a barcode, see where it stands, assign it to
	// an inspect step (creates the CartridgeRecord if it doesn't exist), then
	// jump into /capture with the step's phase preselected.
	const INTAKE_STEPS = [
		{ value: 'wax', label: 'Wax inspect', status: 'wax_stored', phase: 'wax_filled' },
		{ value: 'reagent', label: 'Reagent inspect', status: 'sealed', phase: 'reagent_filled' },
		{ value: 'post_mortem', label: 'Post-mortem', status: 'completed', phase: 'post_mortem' }
	] as const;

	type Step = (typeof INTAKE_STEPS)[number]['value'];
	interface IntakeRow {
		cartridgeId: string;
		status: string;
		phase: string;
		created: boolean;
		at: Date;
	}

	let code = $state('');
	let step = $state<Step>('wax');
	let busy = $state(false);
	let error = $state('');
	let lookup = $state<{ found: boolean; cartridgeId: string; status: string | null; photoCount: number } | null>(null);
	let result = $state<IntakeRow | null>(null);
	let history = $state<IntakeRow[]>([]);
	let inputEl = $state<HTMLInputElement | null>(null);

	const selectedStep = $derived(INTAKE_STEPS.find((s) => s.value === step)!);

	async function doLookup() {
		const c = code.trim();
		if (!c || busy) return;
		busy = true;
		error = '';
		result = null;
		try {
			const res = await fetch(`/api/cv/lookup-cartridge?code=${encodeURIComponent(c)}`);
			if (res.ok) {
				const data = await res.json();
				lookup = {
					found: true,
					cartridgeId: data.cartridgeRecordId,
					status: data.status ?? null,
					photoCount: data.photoCount ?? 0
				};
			} else {
				lookup = { found: false, cartridgeId: c, status: null, photoCount: 0 };
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Lookup failed';
			lookup = null;
		} finally {
			busy = false;
		}
	}

	async function assign() {
		if (!lookup || busy) return;
		busy = true;
		error = '';
		try {
			const res = await fetch('/api/cv/cartridge-intake', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cartridgeId: lookup.cartridgeId, inspectStep: step })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				error = body.error || 'Intake failed';
				return;
			}
			const row: IntakeRow = {
				cartridgeId: body.cartridgeId,
				status: body.status,
				phase: body.phase,
				created: body.created,
				at: new Date()
			};
			result = row;
			history = [row, ...history].slice(0, 20);
			lookup = { found: true, cartridgeId: body.cartridgeId, status: body.status, photoCount: lookup.photoCount };
		} catch (e) {
			error = e instanceof Error ? e.message : 'Intake failed';
		} finally {
			busy = false;
		}
	}

	function reset() {
		code = '';
		lookup = null;
		result = null;
		error = '';
		inputEl?.focus();
	}
</script>

<svelte:head>
	<title>Cartridge Intake — Computer Vision</title>
</svelte:head>

<div class="mx-auto max-w-3xl space-y-6">
	<header>
		<h2 class="tron-heading text-2xl font-bold text-[var(--color-tron-cyan)]">Cartridge Intake</h2>
		<p class="mt-1 text-sm text-[var(--color-tron-text-secondary)]">
			Scan or type a cartridge barcode, assign it to an inspect step — the cartridge document is
			created if it doesn't exist, and its status is set so that step's scan-gated flow accepts it.
		</p>
	</header>

	<!-- Scan / lookup -->
	<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
		<label for="intake-code" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Barcode</label>
		<div class="flex flex-wrap items-center gap-2">
			<!-- svelte-ignore a11y_autofocus -->
			<input
				id="intake-code"
				bind:this={inputEl}
				bind:value={code}
				onkeydown={(e) => e.key === 'Enter' && doLookup()}
				autofocus
				autocomplete="off"
				placeholder="Scan with the wedge scanner or type, then Enter"
				class="tron-input min-w-64 flex-1 font-mono"
			/>
			<button
				type="button"
				onclick={doLookup}
				disabled={busy || !code.trim()}
				class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-medium text-[var(--color-tron-bg-primary)] disabled:opacity-40"
			>
				{busy ? '…' : 'Look up'}
			</button>
			{#if lookup || result}
				<button type="button" onclick={reset} class="rounded px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">next cartridge</button>
			{/if}
		</div>
	</div>

	{#if error}
		<div class="rounded border border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.08)] p-3 text-sm text-[var(--color-tron-red,#ff3366)]">{error}</div>
	{/if}

	<!-- Lookup result + step assignment -->
	{#if lookup}
		<div class="rounded-lg border {lookup.found ? 'border-[var(--color-tron-border)]' : 'border-[var(--color-tron-yellow,#facc15)]'} bg-[var(--color-tron-bg-secondary)] p-4">
			<div class="flex flex-wrap items-center gap-3">
				<span class="font-mono text-lg {lookup.found ? 'text-[var(--color-tron-green,#39ff14)]' : 'text-[var(--color-tron-yellow,#facc15)]'}">{lookup.cartridgeId}</span>
				{#if lookup.found}
					<span class="rounded bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-xs">status: {lookup.status ?? 'unknown'}</span>
					<span class="text-xs text-[var(--color-tron-text-secondary)]">{lookup.photoCount} photos</span>
				{:else}
					<span class="rounded bg-[rgba(250,204,21,0.15)] px-2 py-0.5 text-xs text-[var(--color-tron-yellow,#facc15)]">not in BIMS — will be created</span>
				{/if}
			</div>

			<div class="mt-4 flex flex-wrap items-end gap-3">
				<div>
					<label for="intake-step" class="mb-1 block text-xs uppercase text-[var(--color-tron-text-secondary)]">Inspect step</label>
					<select id="intake-step" bind:value={step} class="tron-input">
						{#each INTAKE_STEPS as s (s.value)}
							<option value={s.value}>{s.label} (→ {s.status})</option>
						{/each}
					</select>
				</div>
				<button
					type="button"
					onclick={assign}
					disabled={busy}
					class="rounded bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-[var(--color-tron-bg-primary)] disabled:opacity-40"
				>
					{busy ? 'Assigning…' : lookup.found ? `Assign to ${selectedStep.label}` : `Create & assign to ${selectedStep.label}`}
				</button>
			</div>
			<p class="mt-2 text-[11px] text-[var(--color-tron-text-secondary)]">
				Sets status → <span class="font-mono">{selectedStep.status}</span>; photos for this step are captured at phase
				<span class="font-mono">{selectedStep.phase}</span>.
			</p>
		</div>
	{/if}

	<!-- Success -->
	{#if result}
		<div class="rounded-lg border border-[var(--color-tron-green,#39ff14)] bg-[rgba(57,255,20,0.06)] p-4">
			<div class="text-sm text-[var(--color-tron-green,#39ff14)]">
				<span class="font-mono font-semibold">{result.cartridgeId}</span>
				{result.created ? 'created' : 'assigned'} → <span class="font-mono">{result.status}</span>
			</div>
			<div class="mt-3 flex flex-wrap gap-2">
				<a
					href={`/capture?phase=${encodeURIComponent(result.phase)}`}
					class="rounded bg-[var(--color-tron-green,#39ff14)] px-4 py-2 text-sm font-semibold text-black"
				>
					Take photos → ({result.phase})
				</a>
				<button type="button" onclick={reset} class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]">
					Scan next cartridge
				</button>
			</div>
		</div>
	{/if}

	<!-- Session history -->
	{#if history.length > 0}
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<h3 class="mb-2 text-xs uppercase text-[var(--color-tron-text-secondary)]">This session</h3>
			<table class="w-full text-left text-xs">
				<thead class="text-[var(--color-tron-text-secondary)]">
					<tr><th class="py-1 pr-3">Cartridge</th><th class="py-1 pr-3">Action</th><th class="py-1 pr-3">Status</th><th class="py-1">When</th></tr>
				</thead>
				<tbody>
					{#each history as h (h.cartridgeId + h.at.getTime())}
						<tr class="border-t border-[var(--color-tron-border)]">
							<td class="py-1 pr-3 font-mono">{h.cartridgeId}</td>
							<td class="py-1 pr-3">{h.created ? 'created' : 'assigned'}</td>
							<td class="py-1 pr-3 font-mono">{h.status}</td>
							<td class="py-1 text-[var(--color-tron-text-secondary)]">{h.at.toLocaleTimeString()}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{/if}
</div>
