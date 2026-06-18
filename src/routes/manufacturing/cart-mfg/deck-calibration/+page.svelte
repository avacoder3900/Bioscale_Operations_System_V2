<script lang="ts">
	/**
	 * Deck Calibration Studio (DECK-CALIBRATION-STUDIO).
	 * Graphical deck (every hole at real x/y) + box/click select + jog-to-capture
	 * (maintenance run, mirrors scanner-position teaching) + apply-offset-to-group.
	 */
	import { onDestroy } from 'svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { deserialize } from '$app/forms';
	import { page } from '$app/stores';

	let { data } = $props();

	type Well = { name: string; x: number; y: number; z: number };

	const decks = $derived(data.decks as { loadName: string; namespace: string; version: number }[]);
	const robots = $derived(data.robots as { _id: string; name: string; robotSide: string | null; isActive: boolean }[]);
	const wells = $derived(data.wells as Well[]);
	const dim = $derived(data.dimensions as { x: number; y: number; z: number });
	const editedSet = $derived(new Set(data.editedWells as string[]));
	const wellByName = $derived(new Map(wells.map((w) => [w.name, w] as const)));

	// ── Pickers ───────────────────────────────────────────────────────────────
	let selectedRobotId = $state<string>('');
	$effect(() => {
		if (!selectedRobotId && robots.length) selectedRobotId = robots.find((r) => r.isActive)?._id ?? robots[0]._id;
	});
	const robot = $derived(robots.find((r) => r._id === selectedRobotId) ?? null);

	function pickDeck(loadName: string) {
		const u = new URL($page.url);
		u.searchParams.set('deck', loadName);
		goto(u, { keepFocus: true, noScroll: true });
	}

	// ── Hole role (wax vs reagent) — by deck column parity ───────────────────────
	// Confirmed from the protocols: wax fills EVEN columns (2,4,…,24), reagent fills
	// ODD columns (1,3,…,23). Well name = rowLetter+colNumber, so role = column parity.
	// They need different fill accuracy, so calibration treats them separately.
	type Role = 'wax' | 'reagent';
	function colOf(name: string): number { const m = name.match(/(\d+)$/); return m ? parseInt(m[1], 10) : 0; }
	function roleOf(name: string): Role { return colOf(name) % 2 === 0 ? 'wax' : 'reagent'; }
	let roleFilter = $state<'all' | Role>('all');
	function isActiveRole(name: string): boolean { return roleFilter === 'all' || roleFilter === roleOf(name); }
	const waxCount = $derived(wells.filter((w) => roleOf(w.name) === 'wax').length);
	const reagentCount = $derived(wells.filter((w) => roleOf(w.name) === 'reagent').length);

	// ── Selection ───────────────────────────────────────────────────────────────
	let selection = $state<Set<string>>(new Set());
	const selCount = $derived(selection.size);

	function setRoleFilter(r: 'all' | Role) {
		roleFilter = r;
		// Keep the selection within the active role so an applied offset never
		// touches the other type of hole.
		if (r !== 'all') selection = new Set([...selection].filter(isActiveRole));
	}

	function toggleWell(name: string, additive: boolean) {
		if (!isActiveRole(name)) return; // can't select a filtered-out hole
		const next = new Set(additive ? selection : []);
		if (selection.has(name) && additive) next.delete(name);
		else next.add(name);
		if (!additive && selection.has(name) && selection.size === 1) next.clear();
		selection = next;
	}
	function clearSelection() { selection = new Set(); }

	// ── Canvas geometry (viewBox = deck mm; y flipped to screen) ─────────────────
	let zoom = $state(1); // 1 = fit container width; >1 zooms in (scrolls)
	const wellR = 1.9; // viewBox (mm) radius — ~2× the physical ~0.9mm hole radius so dots stay visible/clickable at fit
	function cy(y: number): number { return dim.y - y; } // flip
	let svgEl = $state<SVGSVGElement | null>(null);

	// Box select
	let boxing = $state(false);
	let boxStart = $state<{ x: number; y: number } | null>(null);
	let boxNow = $state<{ x: number; y: number } | null>(null);

	function toDeck(e: PointerEvent): { x: number; y: number } | null {
		if (!svgEl) return null;
		const pt = svgEl.createSVGPoint();
		pt.x = e.clientX; pt.y = e.clientY;
		const ctm = svgEl.getScreenCTM();
		if (!ctm) return null;
		const loc = pt.matrixTransform(ctm.inverse());
		return { x: loc.x, y: dim.y - loc.y }; // back to deck coords
	}

	function onCanvasPointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		const d = toDeck(e);
		if (!d) return;
		boxing = true;
		boxStart = d;
		boxNow = d;
		(e.target as Element).setPointerCapture?.(e.pointerId);
	}
	function onCanvasPointerMove(e: PointerEvent) {
		if (!boxing) return;
		boxNow = toDeck(e);
	}
	function onCanvasPointerUp(e: PointerEvent) {
		if (!boxing || !boxStart || !boxNow) { boxing = false; return; }
		const x0 = Math.min(boxStart.x, boxNow.x), x1 = Math.max(boxStart.x, boxNow.x);
		const y0 = Math.min(boxStart.y, boxNow.y), y1 = Math.max(boxStart.y, boxNow.y);
		const moved = Math.abs(x1 - x0) > 1 || Math.abs(y1 - y0) > 1;
		if (moved) {
			const hits = wells.filter((w) => isActiveRole(w.name) && w.x >= x0 && w.x <= x1 && w.y >= y0 && w.y <= y1).map((w) => w.name);
			const next = e.shiftKey ? new Set(selection) : new Set<string>();
			for (const h of hits) next.add(h);
			selection = next;
		}
		boxing = false; boxStart = null; boxNow = null;
	}

	const boxRect = $derived.by(() => {
		if (!boxing || !boxStart || !boxNow) return null;
		const x = Math.min(boxStart.x, boxNow.x);
		const y0 = Math.min(boxStart.y, boxNow.y), y1 = Math.max(boxStart.y, boxNow.y);
		const w = Math.abs(boxNow.x - boxStart.x);
		const h = Math.abs(boxNow.y - boxStart.y);
		return { x, y: dim.y - y1, w, h }; // screen-space rect (y flipped)
	});

	// ── Captured / manual offset ─────────────────────────────────────────────────
	let dx = $state(0), dy = $state(0), dz = $state(0);
	let nominal = $state<{ x: number; y: number; z: number } | null>(null);
	let refWell = $state<string | null>(null); // the hole we moved-to for capture

	// ── Messages ─────────────────────────────────────────────────────────────────
	let msg = $state<string | null>(null);
	let errMsg = $state<string | null>(null);
	let busy = $state(false);
	function clearMsg() { msg = null; errMsg = null; }

	async function postAction(action: string, fields: Record<string, string>) {
		clearMsg();
		busy = true;
		try {
			const fd = new FormData();
			for (const [k, v] of Object.entries(fields)) fd.set(k, v);
			const res = await fetch(`?/${action}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
			const result = deserialize(await res.text());
			if (result.type === 'failure') { errMsg = (result.data as any)?.error ?? 'Action failed'; return null; }
			if (result.type === 'error') { errMsg = result.error?.message ?? 'Action failed'; return null; }
			await invalidateAll();
			return (result as any).data ?? {};
		} catch (e) {
			errMsg = e instanceof Error ? e.message : 'Request failed';
			return null;
		} finally {
			busy = false;
		}
	}

	async function applyToSelection() {
		if (selection.size === 0) { errMsg = 'Select at least one hole'; return; }
		if (dx === 0 && dy === 0 && dz === 0) { errMsg = 'Capture or enter a non-zero offset'; return; }
		const r = await postAction('applyBatch', {
			deckLoadName: data.selected,
			wellNames: JSON.stringify([...selection]),
			dx: String(dx), dy: String(dy), dz: String(dz),
			robotId: selectedRobotId || ''
		});
		if (r) { msg = `Applied offset to ${r.applied} hole(s)${r.failed?.length ? ` (${r.failed.length} skipped)` : ''}.`; clearSelection(); }
	}

	let syncWhich = $state<'both' | 'wax' | 'reagent'>('both');
	async function syncToRobot() {
		if (!selectedRobotId) { errMsg = 'Pick a robot'; return; }
		if (!confirm(`Re-upload the ${syncWhich} protocol(s) to ${robot?.name} with the corrected deck?`)) return;
		const r = await postAction('sync', { robotId: selectedRobotId, which: syncWhich });
		if (r) msg = (r.results ?? []).map((x: any) => `${x.processType}: ${x.ok ? '✓' : '✗'} ${x.detail}`).join(' · ');
	}

	// ── Maintenance-run jog (mirror scanner-position teaching) ───────────────────
	let runId = $state<string | null>(null);
	let pipetteId = $state<string | null>(null);
	let pipetteMount = $state<string | null>(null);
	let pipetteName = $state<string | null>(null);
	let stepSize = $state(1);
	let zAxis = $state<'leftZ' | 'rightZ'>('leftZ');
	let liveX = $state<number | null>(null), liveY = $state<number | null>(null), liveZ = $state<number | null>(null);
	let connecting = $state(false);
	// Deck slot the labware sits in (for move-to-hole). Resolved/overridable; OT-2 slots 1-11.
	let deckSlot = $state('1');
	let loadedLabwareId = $state<string | null>(null);

	async function api(path: string, init?: RequestInit): Promise<any> {
		const res = await fetch(path, { ...init, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
		const text = await res.text();
		let body: any = null;
		try { body = text ? JSON.parse(text) : null; } catch { body = text; }
		if (!res.ok) throw new Error((body && body.message) || (typeof body === 'string' ? body : `HTTP ${res.status}`));
		return body;
	}

	async function startMaintenance() {
		if (!selectedRobotId) { errMsg = 'Pick a robot'; return; }
		clearMsg();
		connecting = true;
		try {
			const res = await api(`/api/opentrons-lab/robots/${selectedRobotId}/maintenance`, { method: 'POST', body: JSON.stringify({}) });
			runId = res.runId ?? null;
			pipetteId = res.pipetteId ?? null;
			pipetteMount = res.mount ?? null;
			pipetteName = res.pipetteName ?? null;
			zAxis = pipetteMount === 'right' ? 'rightZ' : 'leftZ';
			loadedLabwareId = null;
			if (!pipetteId) errMsg = 'Maintenance run opened but no pipette loaded — jog/move will fail until a pipette is configured.';
			else msg = `Connected. pipette ${pipetteName} on ${pipetteMount}.`;
		} catch (e) { errMsg = e instanceof Error ? e.message : String(e); } finally { connecting = false; }
	}
	async function stopMaintenance() {
		if (!runId) return;
		busy = true;
		try { await api(`/api/opentrons-lab/robots/${selectedRobotId}/maintenance/${runId}`, { method: 'DELETE' }); }
		catch (e) { errMsg = e instanceof Error ? e.message : String(e); }
		finally { runId = null; pipetteId = null; pipetteMount = null; pipetteName = null; loadedLabwareId = null; liveX = liveY = liveZ = null; busy = false; }
	}
	async function homeRobot() {
		if (!runId) { errMsg = 'Open a maintenance run first'; return; }
		busy = true;
		try { await api(`/api/opentrons-lab/robots/${selectedRobotId}/maintenance/${runId}/home`, { method: 'POST', body: JSON.stringify({}) }); await refreshPosition(); msg = 'Homed.'; }
		catch (e) { errMsg = e instanceof Error ? e.message : String(e); } finally { busy = false; }
	}
	async function jogAxis(axis: 'x' | 'y' | 'leftZ' | 'rightZ', distance: number) {
		if (!runId || !pipetteId) { errMsg = 'Open a maintenance run first'; return; }
		busy = true;
		try { await api(`/api/opentrons-lab/robots/${selectedRobotId}/maintenance/${runId}/jog`, { method: 'POST', body: JSON.stringify({ pipetteId, axis, distance }) }); await refreshPosition(); }
		catch (e) { errMsg = e instanceof Error ? e.message : String(e); } finally { busy = false; }
	}
	async function refreshPosition() {
		if (!runId || !pipetteId) return;
		try {
			const res = await api(`/api/opentrons-lab/robots/${selectedRobotId}/maintenance/${runId}/position`, { method: 'POST', body: JSON.stringify({ pipetteId }) });
			if (res?.position) { liveX = res.position.x; liveY = res.position.y; liveZ = res.position.z; }
		} catch (e) { errMsg = `Position read failed: ${e instanceof Error ? e.message : String(e)}`; }
	}

	// Move to the (single) selected hole's nominal position so the operator can see the error.
	async function moveToSelectedHole() {
		if (!runId || !pipetteId) { errMsg = 'Open a maintenance run first'; return; }
		if (selection.size !== 1) { errMsg = 'Select exactly one reference hole to move to'; return; }
		const name = [...selection][0];
		clearMsg();
		busy = true;
		try {
			// Load the deck labware into the run once (so the robot computes nominal absolute).
			if (!loadedLabwareId) {
				const lw = await api(`/api/opentrons-lab/robots/${selectedRobotId}/maintenance/${runId}/load-labware`, {
					method: 'POST',
					body: JSON.stringify({ namespace: decks.find((d) => d.loadName === data.selected)?.namespace, loadName: data.selected, version: decks.find((d) => d.loadName === data.selected)?.version ?? 1, slot: deckSlot })
				});
				loadedLabwareId = lw?.labwareId ?? null;
				if (!loadedLabwareId) throw new Error('load-labware did not return a labwareId');
			}
			// Safe arc: lift to ~80mm above the highest hole, travel in XY, then descend —
			// so the tip never drags across cartridges between holes.
			const maxWellZ = wells.length ? Math.max(...wells.map((w) => w.z)) : 12;
			const minimumZHeight = Math.round(maxWellZ + 80);
			await api(`/api/opentrons-lab/robots/${selectedRobotId}/maintenance/${runId}/move-to-well`, {
				method: 'POST',
				body: JSON.stringify({ pipetteId, labwareId: loadedLabwareId, wellName: name, minimumZHeight })
			});
			await refreshPosition();
			nominal = liveX !== null ? { x: liveX!, y: liveY!, z: liveZ! } : null;
			refWell = name;
			msg = `At nominal of ${name}. Jog onto the real hole, then Capture.`;
		} catch (e) { errMsg = e instanceof Error ? e.message : String(e); } finally { busy = false; }
	}

	async function captureOffset() {
		if (!nominal) { errMsg = 'Move to a hole first to set the nominal reference'; return; }
		await refreshPosition();
		if (liveX === null || liveY === null || liveZ === null) { errMsg = 'Could not read position'; return; }
		dx = +(liveX - nominal.x).toFixed(3);
		dy = +(liveY - nominal.y).toFixed(3);
		dz = +(liveZ - nominal.z).toFixed(3);
		msg = `Captured offset from ${refWell}: dx=${dx} dy=${dy} dz=${dz}. Select the holes to apply it to.`;
	}

	onDestroy(() => {
		if (runId) {
			try {
				fetch(`/api/opentrons-lab/robots/${selectedRobotId}/maintenance/${runId}`, { method: 'DELETE', credentials: 'same-origin', keepalive: true });
			} catch { /* best-effort */ }
		}
	});

</script>

<div class="mx-auto max-w-[1400px] space-y-4 overflow-x-clip p-4">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Deck Calibration Studio</h1>
			<p class="text-xs" style="color: var(--color-tron-text-secondary)">
				Jog to a hole, capture the real offset, select a group of holes, apply it. Corrections persist in BIMS and reach the robot on Sync.
			</p>
		</div>
		<a href="/manufacturing/cart-mfg/deck-tuner" class="rounded border border-[var(--color-tron-border)] px-3 py-1.5 text-xs hover:border-[var(--color-tron-cyan)]" style="color: var(--color-tron-text)">Text tuner →</a>
	</div>

	<!-- Pickers -->
	<div class="flex flex-wrap items-end gap-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
		<label class="text-xs" style="color: var(--color-tron-text-secondary)">Deck
			<select value={data.selected} onchange={(e) => pickDeck(e.currentTarget.value)} class="mt-1 block rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 font-mono text-xs" style="color: var(--color-tron-text)">
				{#each decks as d (d.loadName)}<option value={d.loadName}>{d.loadName}</option>{/each}
			</select>
		</label>
		<label class="text-xs" style="color: var(--color-tron-text-secondary)">Robot
			<select bind:value={selectedRobotId} class="mt-1 block rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 text-xs" style="color: var(--color-tron-text)">
				{#each robots as r (r._id)}<option value={r._id}>{r.name}{r.isActive ? '' : ' (inactive)'}</option>{/each}
			</select>
		</label>
		<div class="text-xs" style="color: var(--color-tron-text-secondary)">{wells.length} holes · {dim.x}×{dim.y} mm</div>
	</div>

	{#if errMsg}<div class="rounded border border-red-500/40 bg-red-900/20 p-2 text-xs text-red-300">{errMsg}</div>{/if}
	{#if msg}<div class="rounded border border-green-500/30 bg-green-900/15 p-2 text-xs text-green-300">{msg}</div>{/if}

	<div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
		<!-- Canvas -->
		<section class="min-w-0 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
				<div class="flex flex-wrap items-center gap-3">
					<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Deck — {selCount} selected</h2>
					<div class="flex overflow-hidden rounded border border-[var(--color-tron-border)] text-[11px]">
						{#each [['all', 'All'], ['wax', `Wax (${waxCount})`], ['reagent', `Reagent (${reagentCount})`]] as [val, label] (val)}
							<button
								type="button"
								onclick={() => setRoleFilter(val as 'all' | Role)}
								class="px-2.5 py-1 transition-colors {roleFilter === val
									? (val === 'wax' ? 'bg-[rgba(217,160,80,0.25)] text-[#e0b070]' : val === 'reagent' ? 'bg-[rgba(80,170,215,0.25)] text-[#7ec6e6]' : 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]')
									: 'text-[var(--color-tron-text-secondary)] hover:bg-white/5'}"
							>{label}</button>
						{/each}
					</div>
				</div>
				<div class="flex items-center gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
					<label>Zoom <input type="range" min="0.6" max="5" step="0.2" bind:value={zoom} /> {zoom.toFixed(1)}×</label>
					<button type="button" onclick={() => (zoom = 1)} class="rounded border border-[var(--color-tron-border)] px-2 py-1 hover:border-[var(--color-tron-cyan)]" style="color: var(--color-tron-text)">Fit</button>
					<button type="button" onclick={clearSelection} class="rounded border border-[var(--color-tron-border)] px-2 py-1 hover:border-[var(--color-tron-cyan)]" style="color: var(--color-tron-text)">Clear</button>
				</div>
			</div>
			<p class="mb-2 text-[11px]" style="color: var(--color-tron-text-secondary)">Drag a box to select a group (Shift adds). Click a hole to toggle. Wax holes are amber, reagent blue; the toggle restricts which you can select. Edited holes show an amber ring.</p>
			<div class="overflow-auto rounded border border-[var(--color-tron-border)] bg-black/40" style="max-height: 72vh;">
				{#if wells.length}
				<div style={`width:${zoom * 100}%;`}>
					<svg
						bind:this={svgEl}
						width="100%"
						viewBox={`0 0 ${dim.x} ${dim.y}`}
						preserveAspectRatio="xMidYMid meet"
						onpointerdown={onCanvasPointerDown}
						onpointermove={onCanvasPointerMove}
						onpointerup={onCanvasPointerUp}
						style="display:block; height:auto; touch-action:none; cursor: crosshair;"
					>
						{#each wells as w (w.name)}
							{@const sel = selection.has(w.name)}
							{@const edited = editedSet.has(w.name)}
							{@const active = isActiveRole(w.name)}
							{@const role = roleOf(w.name)}
							<circle
								cx={w.x} cy={cy(w.y)} r={wellR}
								fill={!active
									? 'rgba(120,140,160,0.10)'
									: sel
										? 'var(--color-tron-cyan)'
										: refWell === w.name
											? '#f59e0b'
											: role === 'wax'
												? 'rgba(217,160,80,0.6)'
												: 'rgba(80,170,215,0.6)'}
								stroke={edited && active ? '#f59e0b' : sel ? 'var(--color-tron-cyan)' : 'none'}
								stroke-width={edited ? 0.5 : 0.3}
								style={active ? '' : 'pointer-events:none;'}
								onpointerdown={(e) => { e.stopPropagation(); }}
								onclick={(e) => { e.stopPropagation(); toggleWell(w.name, e.shiftKey || e.ctrlKey || e.metaKey); }}
								role="button" tabindex="-1"
							><title>{w.name} ({role}) — x {w.x.toFixed(2)} y {w.y.toFixed(2)} z {w.z.toFixed(2)}{edited ? ' (edited)' : ''}</title></circle>
						{/each}
						{#if boxRect}
							<rect x={boxRect.x} y={boxRect.y} width={boxRect.w} height={boxRect.h} fill="rgba(0,255,255,0.12)" stroke="var(--color-tron-cyan)" stroke-width="0.4" />
						{/if}
					</svg>
				</div>
				{:else}
					<div class="p-6 text-center text-xs" style="color: var(--color-tron-text-secondary)">No wells — pick a deck.</div>
				{/if}
			</div>
		</section>

		<!-- Right column: jog + offset + apply + sync -->
		<div class="min-w-0 space-y-4">
			<!-- Maintenance / Jog -->
			<section class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)]/40 p-3">
				<div class="flex items-center justify-between">
					<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Jog</h2>
					{#if !runId}
						<button type="button" onclick={startMaintenance} disabled={connecting || !selectedRobotId} class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 px-3 py-1.5 text-xs font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25 disabled:opacity-40">{connecting ? 'Opening…' : 'Open run'}</button>
					{:else}
						<div class="flex gap-2">
							<button type="button" onclick={homeRobot} disabled={busy} class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs hover:border-[var(--color-tron-cyan)] disabled:opacity-40" style="color: var(--color-tron-text)">Home</button>
							<button type="button" onclick={stopMaintenance} disabled={busy} class="rounded border border-amber-500/40 bg-amber-900/15 px-2 py-1 text-xs text-amber-300 disabled:opacity-40">Close</button>
						</div>
					{/if}
				</div>
				{#if runId}<p class="mt-1 text-[11px]" style="color: var(--color-tron-text-secondary)">pipette {pipetteName} ({pipetteMount})</p>{/if}

				<div class="mt-2 flex flex-wrap items-center gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
					<label>Step <select bind:value={stepSize} class="rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-0.5 font-mono text-xs" style="color: var(--color-tron-text)">
						<option value={0.1}>0.1</option><option value={1}>1</option><option value={5}>5</option><option value={10}>10</option><option value={25}>25</option>
					</select> mm</label>
					<label>Z <select bind:value={zAxis} class="rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-0.5 font-mono text-xs" style="color: var(--color-tron-text)"><option value="leftZ">leftZ</option><option value="rightZ">rightZ</option></select></label>
					<label>Slot <input bind:value={deckSlot} class="w-10 rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-0.5 font-mono text-xs" style="color: var(--color-tron-text)" /></label>
				</div>

				<div class="mt-2 grid grid-cols-3 gap-1">
					<div></div>
					<button type="button" disabled={!pipetteId || busy} onclick={() => jogAxis('y', stepSize)} class="rounded border border-[var(--color-tron-border)] py-2 text-xs hover:border-[var(--color-tron-cyan)] disabled:opacity-40" style="color: var(--color-tron-text)">Y +</button>
					<div></div>
					<button type="button" disabled={!pipetteId || busy} onclick={() => jogAxis('x', -stepSize)} class="rounded border border-[var(--color-tron-border)] py-2 text-xs hover:border-[var(--color-tron-cyan)] disabled:opacity-40" style="color: var(--color-tron-text)">X −</button>
					<div class="flex items-center justify-center text-[10px]" style="color: var(--color-tron-text-secondary)">XY</div>
					<button type="button" disabled={!pipetteId || busy} onclick={() => jogAxis('x', stepSize)} class="rounded border border-[var(--color-tron-border)] py-2 text-xs hover:border-[var(--color-tron-cyan)] disabled:opacity-40" style="color: var(--color-tron-text)">X +</button>
					<div></div>
					<button type="button" disabled={!pipetteId || busy} onclick={() => jogAxis('y', -stepSize)} class="rounded border border-[var(--color-tron-border)] py-2 text-xs hover:border-[var(--color-tron-cyan)] disabled:opacity-40" style="color: var(--color-tron-text)">Y −</button>
					<div></div>
				</div>
				<div class="mt-1 grid grid-cols-2 gap-1">
					<button type="button" disabled={!pipetteId || busy} onclick={() => jogAxis(zAxis, stepSize)} class="rounded border border-[var(--color-tron-border)] py-2 text-xs hover:border-[var(--color-tron-cyan)] disabled:opacity-40" style="color: var(--color-tron-text)">Z + up</button>
					<button type="button" disabled={!pipetteId || busy} onclick={() => jogAxis(zAxis, -stepSize)} class="rounded border border-[var(--color-tron-border)] py-2 text-xs hover:border-[var(--color-tron-cyan)] disabled:opacity-40" style="color: var(--color-tron-text)">Z − down</button>
				</div>

				<div class="mt-2 flex items-center justify-between rounded border border-[var(--color-tron-border)] bg-black/30 p-2 font-mono text-xs" style="color: var(--color-tron-text)">
					<span>x {liveX !== null ? liveX.toFixed(2) : '—'}</span>
					<span>y {liveY !== null ? liveY.toFixed(2) : '—'}</span>
					<span>z {liveZ !== null ? liveZ.toFixed(2) : '—'}</span>
				</div>

				<div class="mt-2 grid grid-cols-2 gap-2">
					<button type="button" onclick={moveToSelectedHole} disabled={!pipetteId || busy || selCount !== 1} class="rounded border border-[var(--color-tron-cyan)]/40 px-2 py-2 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-40" title="Select exactly one hole">Move to hole</button>
					<button type="button" onclick={captureOffset} disabled={!pipetteId || busy || !nominal} class="rounded border border-green-500/50 bg-green-900/20 px-2 py-2 text-xs font-bold text-green-300 hover:bg-green-900/30 disabled:opacity-40">Capture offset</button>
				</div>
			</section>

			<!-- Offset + Apply -->
			<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
				<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Offset → selection</h2>
				<div class="mt-2 grid grid-cols-3 gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
					<label>dx <input type="number" step="0.01" bind:value={dx} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-1 font-mono" style="color: var(--color-tron-text)" /></label>
					<label>dy <input type="number" step="0.01" bind:value={dy} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-1 font-mono" style="color: var(--color-tron-text)" /></label>
					<label>dz <input type="number" step="0.01" bind:value={dz} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-1 font-mono" style="color: var(--color-tron-text)" /></label>
				</div>
				<button type="button" onclick={applyToSelection} disabled={busy || selCount === 0} class="mt-2 w-full rounded border border-green-500/50 bg-green-900/20 px-3 py-2 text-sm font-bold text-green-300 hover:bg-green-900/30 disabled:opacity-40">
					Apply to {selCount} selected hole{selCount === 1 ? '' : 's'}
				</button>
			</section>

			<!-- Sync -->
			<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
				<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Sync to robot</h2>
				<div class="mt-2 flex items-center gap-2">
					<select bind:value={syncWhich} class="rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 text-xs" style="color: var(--color-tron-text)">
						<option value="both">Wax + Reagent</option><option value="wax">Wax</option><option value="reagent">Reagent</option>
					</select>
					<button type="button" onclick={syncToRobot} disabled={busy || !selectedRobotId} class="flex-1 rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/15 px-3 py-1.5 text-xs font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25 disabled:opacity-40">Re-upload to {robot?.name ?? 'robot'}</button>
				</div>
				<p class="mt-1 text-[10px]" style="color: var(--color-tron-text-secondary)">Re-uploads the protocol so the corrected deck reaches the OT-2. Needs the protocol .py stored in BIMS.</p>
			</section>
		</div>
	</div>

	<!-- History -->
	{#if data.history?.length}
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<h2 class="mb-2 text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Recent edits</h2>
			<div class="overflow-x-auto">
				<table class="w-full text-left text-[11px]">
					<thead style="color: var(--color-tron-text-secondary)"><tr><th class="px-2 py-1">Hole</th><th class="px-2 py-1">Δ (x,y,z)</th><th class="px-2 py-1">After</th><th class="px-2 py-1">By</th><th class="px-2 py-1">When</th></tr></thead>
					<tbody style="color: var(--color-tron-text)">
						{#each data.history as h (h.createdAt + h.wellName)}
							<tr class="border-t border-[var(--color-tron-border)]">
								<td class="px-2 py-1 font-mono">{h.wellName}</td>
								<td class="px-2 py-1 font-mono">{h.delta.x}, {h.delta.y}, {h.delta.z}</td>
								<td class="px-2 py-1 font-mono">{h.after.x.toFixed(2)}, {h.after.y.toFixed(2)}, {h.after.z.toFixed(2)}</td>
								<td class="px-2 py-1">{h.createdBy}</td>
								<td class="px-2 py-1" style="color: var(--color-tron-text-secondary)">{h.createdAt ? new Date(h.createdAt).toLocaleString() : ''}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}
</div>
