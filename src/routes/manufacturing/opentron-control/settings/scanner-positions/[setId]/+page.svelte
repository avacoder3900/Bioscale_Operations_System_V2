<script lang="ts">
	import { onDestroy } from 'svelte';
	import { invalidateAll, goto } from '$app/navigation';
	import { enhance } from '$app/forms';

	let { data, form } = $props();

	type Position = { slotIndex: number; x: number; y: number; z: number; testScanBarcode?: string };
	type SetDoc = {
		_id: string;
		robotId: string;
		title: string;
		positionCount: number;
		positions: Position[];
		isDefault: boolean;
		pipetteMount?: 'left' | 'right';
		pipetteName?: string;
	};
	type Robot = { _id: string; name: string; ip?: string; robotSide?: string; robotModel?: string };

	const set = $derived(data.set as SetDoc);
	const robot = $derived(data.robot as Robot);
	const deviceId = $derived(data.defaultDeviceId as string);

	const positionsBySlot = $derived.by(() => {
		const m = new Map<number, Position>();
		for (const p of set.positions ?? []) m.set(p.slotIndex, p);
		return m;
	});
	const taughtCount = $derived(positionsBySlot.size);

	let selectedSlot = $state<number>(0);
	let stepSize = $state<number>(1); // mm
	let zAxis = $state<'leftZ' | 'rightZ'>(set.pipetteMount === 'right' ? 'rightZ' : 'leftZ');

	// Maintenance run lifecycle
	let runId = $state<string | null>(null);
	let pipetteId = $state<string | null>(null);
	let pipetteMount = $state<string | null>(null);
	let pipetteName = $state<string | null>(null);

	let connecting = $state(false);
	let busy = $state(false);
	let lastError = $state<string | null>(null);
	let lastInfo = $state<string | null>(null);

	// Live position readback
	let liveX = $state<number | null>(null);
	let liveY = $state<number | null>(null);
	let liveZ = $state<number | null>(null);

	// Test scan state
	let testScanInFlight = $state(false);
	let testScanError = $state<string | null>(null);
	let testScanLatest = $state<{ barcode: string; receivedAt: string } | null>(null);
	let pendingTriggerId = $state<string | null>(null);
	let testScanPollTimer: ReturnType<typeof setInterval> | null = null;

	function clearMessages() {
		lastError = null;
		lastInfo = null;
	}

	async function api(path: string, init?: RequestInit): Promise<any> {
		const method = init?.method ?? 'GET';
		let res: Response;
		try {
			res = await fetch(path, {
				...init,
				credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
			});
		} catch (e: any) {
			// Browser-side fetch threw before getting a response (offline, DNS,
			// CORS, server crashed). Include the URL so diagnosis isn't blind.
			throw new Error(`${method} ${path} — network error: ${e?.message ?? 'fetch failed'}`);
		}
		const text = await res.text();
		let body: any = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = text;
		}
		if (!res.ok) {
			const inner =
				(body && typeof body === 'object' && body.message) ||
				body ||
				`HTTP ${res.status}`;
			const innerStr = typeof inner === 'string' ? inner : JSON.stringify(inner);
			throw new Error(`${method} ${path} → HTTP ${res.status}: ${innerStr}`);
		}
		return body;
	}

	async function startMaintenance() {
		clearMessages();
		connecting = true;
		try {
			const body: Record<string, unknown> = {};
			if (set.pipetteMount) body.mount = set.pipetteMount;
			if (set.pipetteName) body.pipetteName = set.pipetteName;
			const res = await api(`/api/opentrons-lab/robots/${robot._id}/maintenance`, {
				method: 'POST',
				body: JSON.stringify(body)
			});
			runId = res.runId ?? null;
			pipetteId = res.pipetteId ?? null;
			pipetteMount = res.mount ?? null;
			pipetteName = res.pipetteName ?? null;
			zAxis = pipetteMount === 'right' ? 'rightZ' : 'leftZ';
			if (!pipetteId) {
				lastError =
					'Maintenance run opened but no pipette could be loaded. Jog/move-to will fail until a pipette is configured on the robot.';
			} else {
				lastInfo = `Connected. runId=${runId}, pipette=${pipetteName} on ${pipetteMount}.`;
			}
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
		} finally {
			connecting = false;
		}
	}

	async function stopMaintenance() {
		if (!runId) return;
		busy = true;
		try {
			await api(`/api/opentrons-lab/robots/${robot._id}/maintenance/${runId}`, { method: 'DELETE' });
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
		} finally {
			runId = null;
			pipetteId = null;
			pipetteMount = null;
			pipetteName = null;
			liveX = null;
			liveY = null;
			liveZ = null;
			busy = false;
		}
	}

	async function homeRobot() {
		if (!runId) {
			lastError = 'Open a maintenance run first';
			return;
		}
		clearMessages();
		busy = true;
		try {
			await api(`/api/opentrons-lab/robots/${robot._id}/maintenance/${runId}/home`, {
				method: 'POST',
				body: JSON.stringify({})
			});
			lastInfo = 'Homed.';
			// Refresh position
			if (pipetteId) await refreshPosition();
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function jogAxis(axis: 'x' | 'y' | 'leftZ' | 'rightZ', distance: number) {
		if (!runId || !pipetteId) {
			lastError = 'Open a maintenance run first';
			return;
		}
		clearMessages();
		busy = true;
		try {
			await api(`/api/opentrons-lab/robots/${robot._id}/maintenance/${runId}/jog`, {
				method: 'POST',
				body: JSON.stringify({ pipetteId, axis, distance })
			});
			await refreshPosition();
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function moveToSavedSlot(slotIndex: number) {
		if (!runId || !pipetteId) {
			lastError = 'Open a maintenance run first';
			return;
		}
		const p = positionsBySlot.get(slotIndex);
		if (!p) {
			lastError = `Slot ${slotIndex + 1} has no saved position yet.`;
			return;
		}
		clearMessages();
		busy = true;
		try {
			await api(`/api/opentrons-lab/robots/${robot._id}/maintenance/${runId}/move-to`, {
				method: 'POST',
				body: JSON.stringify({ pipetteId, x: p.x, y: p.y, z: p.z })
			});
			lastInfo = `Moved to slot ${slotIndex + 1}.`;
			await refreshPosition();
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function refreshPosition() {
		if (!runId || !pipetteId) return;
		try {
			const res = await api(`/api/opentrons-lab/robots/${robot._id}/maintenance/${runId}/position`, {
				method: 'POST',
				body: JSON.stringify({ pipetteId })
			});
			if (res?.position) {
				liveX = res.position.x;
				liveY = res.position.y;
				liveZ = res.position.z;
			}
		} catch (e) {
			lastError = `Position read failed: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	async function fireTestScan() {
		clearMessages();
		testScanError = null;
		testScanInFlight = true;
		testScanLatest = null;
		try {
			const res = await api('/api/scanner/trigger', {
				method: 'POST',
				body: JSON.stringify({ deviceId, source: 'test', contextRef: `teach:${set._id}:${selectedSlot}` })
			});
			pendingTriggerId = res?.triggerId ?? null;
			// Poll events until we see one matching our triggerId
			const started = Date.now();
			if (testScanPollTimer) clearInterval(testScanPollTimer);
			testScanPollTimer = setInterval(async () => {
				if (!pendingTriggerId) return;
				if (Date.now() - started > 15000) {
					if (testScanPollTimer) clearInterval(testScanPollTimer);
					testScanPollTimer = null;
					testScanError = 'Timed out waiting for scanner response (15s)';
					testScanInFlight = false;
					return;
				}
				try {
					const url = new URL('/api/scanner/events', window.location.origin);
					url.searchParams.set('deviceId', deviceId);
					url.searchParams.set('limit', '20');
					const r = await fetch(url, { credentials: 'same-origin' });
					if (!r.ok) return;
					const body = await r.json();
					const evs: any[] = body?.events ?? [];
					const match = evs.find((e) => e?.metadata?.triggerId === pendingTriggerId);
					if (match) {
						if (testScanPollTimer) clearInterval(testScanPollTimer);
						testScanPollTimer = null;
						if (match.eventType === 'scan' && match.barcode) {
							testScanLatest = { barcode: match.barcode, receivedAt: match.receivedAt };
						} else {
							testScanError = match.errorMessage || 'scanner returned error';
						}
						testScanInFlight = false;
						pendingTriggerId = null;
					}
				} catch {
					// ignore poll error, retry
				}
			}, 400);
		} catch (e) {
			testScanError = e instanceof Error ? e.message : String(e);
			testScanInFlight = false;
		}
	}

	async function savePosition() {
		clearMessages();
		// Refresh position right before saving so we record the OT-2's authoritative XYZ.
		if (!runId || !pipetteId) {
			lastError = 'Open a maintenance run first';
			return;
		}
		busy = true;
		try {
			await refreshPosition();
			if (liveX === null || liveY === null || liveZ === null) {
				lastError = 'Could not read position from robot';
				return;
			}
			const body: Record<string, unknown> = { x: liveX, y: liveY, z: liveZ };
			if (testScanLatest?.barcode) body.testScanBarcode = testScanLatest.barcode;
			await api(`/api/scanner-position-sets/${set._id}/positions/${selectedSlot}`, {
				method: 'PUT',
				body: JSON.stringify(body)
			});
			lastInfo = `Saved slot ${selectedSlot + 1}: x=${liveX.toFixed(2)} y=${liveY.toFixed(2)} z=${liveZ.toFixed(2)}`;
			// Auto-advance to next un-taught slot
			const next = findNextUntaughtSlot();
			if (next !== null) selectedSlot = next;
			// Clear test scan so it's fresh for the next slot
			testScanLatest = null;
			await invalidateAll();
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	function findNextUntaughtSlot(): number | null {
		for (let i = selectedSlot + 1; i < set.positionCount; i++) {
			if (!positionsBySlot.has(i)) return i;
		}
		for (let i = 0; i < selectedSlot; i++) {
			if (!positionsBySlot.has(i)) return i;
		}
		return null;
	}

	async function clearSlot(slotIndex: number) {
		if (!confirm(`Clear saved XYZ for slot ${slotIndex + 1}?`)) return;
		try {
			await api(`/api/scanner-position-sets/${set._id}/positions/${slotIndex}`, { method: 'DELETE' });
			await invalidateAll();
			lastInfo = `Cleared slot ${slotIndex + 1}`;
		} catch (e) {
			lastError = e instanceof Error ? e.message : String(e);
		}
	}

	onDestroy(async () => {
		if (testScanPollTimer) clearInterval(testScanPollTimer);
		// Best-effort: close maintenance run on page unload so the robot doesn't
		// stay locked. Browsers may abort the fetch — tradeoff accepted.
		if (runId) {
			try {
				await fetch(`/api/opentrons-lab/robots/${robot._id}/maintenance/${runId}`, {
					method: 'DELETE',
					credentials: 'same-origin',
					keepalive: true
				});
			} catch { /* best-effort */ }
		}
	});

	const slotIndexes = $derived(Array.from({ length: set.positionCount }, (_, i) => i));
</script>

<div class="mx-auto max-w-6xl space-y-6 p-4">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Teach: {set.title}</h1>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				Robot: <span class="font-semibold">{robot.name}</span>
				{robot.ip ? `· ${robot.ip}` : ''} · {set.positionCount} slots · {taughtCount} taught
				{#if set.isDefault}<span class="ml-2 rounded bg-[var(--color-tron-cyan)]/20 px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-[var(--color-tron-cyan)]">default</span>{/if}
			</p>
		</div>
		<a
			href="/manufacturing/opentron-control/settings"
			class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs hover:border-[var(--color-tron-cyan)] transition-colors"
			style="color: var(--color-tron-text)"
		>
			← Back to Settings
		</a>
	</div>

	{#if form?.error}
		<div class="rounded border border-red-500/40 bg-red-900/20 p-2 text-xs text-red-300">{form.error}</div>
	{/if}
	{#if lastError}
		<div class="rounded border border-red-500/40 bg-red-900/20 p-2 text-xs text-red-300">{lastError}</div>
	{/if}
	{#if lastInfo}
		<div class="rounded border border-green-500/30 bg-green-900/15 p-2 text-xs text-green-300">{lastInfo}</div>
	{/if}

	<!-- Connection -->
	<section class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)]/40 p-4">
		<div class="flex flex-wrap items-center justify-between gap-3">
			<div>
				<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Maintenance Run</h2>
				{#if runId}
					<p class="mt-1 text-xs" style="color: var(--color-tron-text)">
						Connected — runId <span class="font-mono">{runId}</span>
						{#if pipetteName}· pipette {pipetteName} ({pipetteMount}){/if}
					</p>
				{:else}
					<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
						Not connected. Click "Open" to start a maintenance run on the robot.
					</p>
				{/if}
			</div>
			<div class="flex gap-2">
				{#if !runId}
					<button
						type="button"
						onclick={startMaintenance}
						disabled={connecting}
						class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 px-4 py-2 text-sm font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25 disabled:opacity-40"
					>
						{connecting ? 'Opening…' : 'Open Maintenance Run'}
					</button>
				{:else}
					<button
						type="button"
						onclick={homeRobot}
						disabled={busy}
						class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm hover:border-[var(--color-tron-cyan)] disabled:opacity-40"
						style="color: var(--color-tron-text)"
					>
						Home
					</button>
					<button
						type="button"
						onclick={stopMaintenance}
						disabled={busy}
						class="rounded border border-amber-500/40 bg-amber-900/15 px-4 py-2 text-sm text-amber-300 hover:bg-amber-900/25 disabled:opacity-40"
					>
						Close Run
					</button>
				{/if}
			</div>
		</div>
	</section>

	<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
		<!-- Slot picker -->
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 lg:col-span-1">
			<div class="mb-2 flex items-center justify-between">
				<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Slot</h2>
				<span class="text-[11px]" style="color: var(--color-tron-text-secondary)">{taughtCount} / {set.positionCount}</span>
			</div>
			<div class="grid grid-cols-6 gap-1.5">
				{#each slotIndexes as i (i)}
					{@const taught = positionsBySlot.has(i)}
					{@const sel = i === selectedSlot}
					<button
						type="button"
						onclick={() => { selectedSlot = i; }}
						class="rounded border px-1 py-2 text-xs transition-colors
							{sel ? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/20' : taught ? 'border-green-500/50 bg-green-900/20' : 'border-[var(--color-tron-border)] bg-black/20'}"
						title={taught ? 'Taught — click to select for re-teach' : 'Empty — click to select'}
					>
						<span class="font-mono {sel ? 'text-[var(--color-tron-cyan)]' : taught ? 'text-green-300' : 'text-[var(--color-tron-text-secondary)]'}">{i + 1}</span>
					</button>
				{/each}
			</div>

			<div class="mt-3 rounded border border-[var(--color-tron-border)] bg-black/30 p-2 text-xs" style="color: var(--color-tron-text)">
				<div class="font-bold" style="color: var(--color-tron-cyan)">Slot {selectedSlot + 1} {positionsBySlot.has(selectedSlot) ? '(taught)' : '(not taught)'}</div>
				{#if positionsBySlot.has(selectedSlot)}
					{@const p = positionsBySlot.get(selectedSlot)}
					<div class="mt-1 grid grid-cols-3 gap-1 font-mono text-[11px]">
						<span>x: {p?.x.toFixed(2)}</span>
						<span>y: {p?.y.toFixed(2)}</span>
						<span>z: {p?.z.toFixed(2)}</span>
					</div>
					{#if p?.testScanBarcode}
						<div class="mt-1 break-all text-[10px]" style="color: var(--color-tron-text-secondary)">last test scan: {p.testScanBarcode}</div>
					{/if}
					<div class="mt-2 flex gap-2">
						<button
							type="button"
							onclick={() => moveToSavedSlot(selectedSlot)}
							disabled={!runId || !pipetteId || busy}
							class="rounded border border-[var(--color-tron-cyan)]/40 px-2 py-1 text-[11px] text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-40"
						>
							Move here
						</button>
						<button
							type="button"
							onclick={() => clearSlot(selectedSlot)}
							class="rounded border border-red-500/30 px-2 py-1 text-[11px] text-red-300 hover:bg-red-900/20"
						>
							Clear
						</button>
					</div>
				{/if}
			</div>
		</section>

		<!-- Jog + scan + save -->
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 lg:col-span-2 space-y-4">
			<div>
				<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Jog</h2>
				<div class="mt-2 flex flex-wrap items-center gap-3">
					<label class="flex items-center gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
						Step size:
						<select
							bind:value={stepSize}
							class="rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1 font-mono text-xs"
							style="color: var(--color-tron-text)"
						>
							<option value={0.1}>0.1 mm</option>
							<option value={1}>1 mm</option>
							<option value={5}>5 mm</option>
							<option value={10}>10 mm</option>
							<option value={25}>25 mm</option>
						</select>
					</label>
					<label class="flex items-center gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
						Z axis:
						<select
							bind:value={zAxis}
							class="rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1 font-mono text-xs"
							style="color: var(--color-tron-text)"
						>
							<option value="leftZ">leftZ</option>
							<option value="rightZ">rightZ</option>
						</select>
					</label>
				</div>
			</div>

			<div class="grid grid-cols-3 gap-2">
				<div></div>
				<button type="button" disabled={!runId || !pipetteId || busy} onclick={() => jogAxis('y', stepSize)}
					class="rounded border border-[var(--color-tron-border)] px-3 py-3 text-sm hover:border-[var(--color-tron-cyan)] disabled:opacity-40"
					style="color: var(--color-tron-text)">Y +</button>
				<div></div>

				<button type="button" disabled={!runId || !pipetteId || busy} onclick={() => jogAxis('x', -stepSize)}
					class="rounded border border-[var(--color-tron-border)] px-3 py-3 text-sm hover:border-[var(--color-tron-cyan)] disabled:opacity-40"
					style="color: var(--color-tron-text)">X −</button>
				<div class="flex items-center justify-center text-[10px]" style="color: var(--color-tron-text-secondary)">deck XY</div>
				<button type="button" disabled={!runId || !pipetteId || busy} onclick={() => jogAxis('x', stepSize)}
					class="rounded border border-[var(--color-tron-border)] px-3 py-3 text-sm hover:border-[var(--color-tron-cyan)] disabled:opacity-40"
					style="color: var(--color-tron-text)">X +</button>

				<div></div>
				<button type="button" disabled={!runId || !pipetteId || busy} onclick={() => jogAxis('y', -stepSize)}
					class="rounded border border-[var(--color-tron-border)] px-3 py-3 text-sm hover:border-[var(--color-tron-cyan)] disabled:opacity-40"
					style="color: var(--color-tron-text)">Y −</button>
				<div></div>
			</div>

			<div class="grid grid-cols-2 gap-2">
				<button type="button" disabled={!runId || !pipetteId || busy} onclick={() => jogAxis(zAxis, stepSize)}
					class="rounded border border-[var(--color-tron-border)] px-3 py-3 text-sm hover:border-[var(--color-tron-cyan)] disabled:opacity-40"
					style="color: var(--color-tron-text)">Z + (up)</button>
				<button type="button" disabled={!runId || !pipetteId || busy} onclick={() => jogAxis(zAxis, -stepSize)}
					class="rounded border border-[var(--color-tron-border)] px-3 py-3 text-sm hover:border-[var(--color-tron-cyan)] disabled:opacity-40"
					style="color: var(--color-tron-text)">Z − (down)</button>
			</div>

			<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-3">
				<div class="flex items-center justify-between">
					<h3 class="text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Live Position</h3>
					<button
						type="button"
						onclick={refreshPosition}
						disabled={!runId || !pipetteId || busy}
						class="text-[11px] underline disabled:opacity-40"
						style="color: var(--color-tron-cyan)"
					>
						Refresh
					</button>
				</div>
				<div class="mt-2 grid grid-cols-3 gap-2 font-mono text-sm">
					<span>x: {liveX !== null ? liveX.toFixed(2) : '—'}</span>
					<span>y: {liveY !== null ? liveY.toFixed(2) : '—'}</span>
					<span>z: {liveZ !== null ? liveZ.toFixed(2) : '—'}</span>
				</div>
			</div>

			<div class="rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/5 p-3">
				<div class="flex items-center justify-between">
					<h3 class="text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Test Scan</h3>
					<button
						type="button"
						onclick={fireTestScan}
						disabled={testScanInFlight}
						class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 px-3 py-1.5 text-xs font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25 disabled:opacity-40"
					>
						{testScanInFlight ? 'Reading…' : 'Test Scan'}
					</button>
				</div>
				{#if testScanLatest}
					<div class="mt-2 break-all rounded bg-black/40 p-2 font-mono text-sm" style="color: var(--color-tron-cyan)">
						{testScanLatest.barcode}
					</div>
				{:else if testScanError}
					<p class="mt-2 text-xs text-red-300">{testScanError}</p>
				{:else}
					<p class="mt-2 text-[11px]" style="color: var(--color-tron-text-secondary)">Fires the gantry-mounted scanner from its current position.</p>
				{/if}
			</div>

			<div class="flex flex-wrap gap-2 pt-2">
				<button
					type="button"
					onclick={savePosition}
					disabled={!runId || !pipetteId || busy}
					class="flex-1 rounded border border-green-500/50 bg-green-900/20 px-4 py-3 text-sm font-bold text-green-300 hover:bg-green-900/30 disabled:opacity-40"
				>
					Save Position for Slot {selectedSlot + 1}
				</button>
				<button
					type="button"
					onclick={() => { selectedSlot = Math.max(0, selectedSlot - 1); }}
					class="rounded border border-[var(--color-tron-border)] px-3 py-3 text-xs"
					style="color: var(--color-tron-text)"
				>
					← Prev
				</button>
				<button
					type="button"
					onclick={() => { selectedSlot = Math.min(set.positionCount - 1, selectedSlot + 1); }}
					class="rounded border border-[var(--color-tron-border)] px-3 py-3 text-xs"
					style="color: var(--color-tron-text)"
				>
					Next →
				</button>
			</div>
		</section>
	</div>

	<!-- Set-level actions -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
		<h2 class="mb-3 text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Set Actions</h2>
		<div class="grid grid-cols-1 gap-3 md:grid-cols-3">
			<form method="POST" action="?/setDefault" use:enhance={() => async ({ update }) => { await update(); await invalidateAll(); }}>
				<button
					type="submit"
					disabled={set.isDefault}
					class="w-full rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10 px-3 py-2 text-sm font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20 disabled:opacity-40"
				>
					{set.isDefault ? 'Already Default' : 'Set as Default for this Robot'}
				</button>
			</form>

			<form method="POST" action="?/rename" use:enhance={() => async ({ update }) => { await update(); await invalidateAll(); }}
				class="flex gap-2">
				<input
					type="text"
					name="title"
					value={set.title}
					required
					class="flex-1 rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 text-sm"
					style="color: var(--color-tron-text)"
				/>
				<button type="submit" class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs hover:border-[var(--color-tron-cyan)]" style="color: var(--color-tron-text)">Rename</button>
			</form>

			<form method="POST" action="?/deleteSet" use:enhance={() => async ({ result, update }) => { if (result.type !== 'redirect') { await update(); await invalidateAll(); } }}>
				<button
					type="submit"
					onclick={(e) => { if (!confirm(`Delete "${set.title}" and all its taught positions?`)) e.preventDefault(); }}
					class="w-full rounded border border-red-500/40 bg-red-900/15 px-3 py-2 text-sm font-medium text-red-300 hover:bg-red-900/25"
				>
					Delete Set
				</button>
			</form>
		</div>
	</section>
</div>
