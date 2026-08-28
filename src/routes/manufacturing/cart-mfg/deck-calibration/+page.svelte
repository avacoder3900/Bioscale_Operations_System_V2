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

	type LwOpt = { loadName: string; namespace: string; version: number };
	const decks = $derived(data.decks as LwOpt[]);
	const tubeRacks = $derived((data.tubeRacks ?? []) as LwOpt[]);
	const tipRacks = $derived((data.tipRacks ?? []) as LwOpt[]);
	const kind = $derived(data.kind as 'deck' | 'tube' | 'tip' | 'calibrator');
	const labwareOptions = $derived(kind === 'tube' ? tubeRacks : kind === 'tip' ? tipRacks : decks);
	const robots = $derived(data.robots as { _id: string; name: string; robotSide: string | null; isActive: boolean }[]);
	const wells = $derived(data.wells as Well[]);
	const dim = $derived(data.dimensions as { x: number; y: number; z: number });
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
	function pickKind(k: 'deck' | 'tube' | 'tip' | 'calibrator') {
		const u = new URL($page.url);
		u.searchParams.set('kind', k);
		u.searchParams.delete('deck'); // default to first option of the new kind
		goto(u, { keepFocus: true, noScroll: true });
	}

	// Switching labware (kind/selection) invalidates the canvas selection and the
	// deck loaded into the run (it's a different labware now). Also resync the deck
	// slot to the kind's default and drop the wax/reagent filter (only decks have it).
	let lastSelectedKey = '';
	$effect(() => {
		const key = `${data.kind}:${data.selected}`;
		if (key !== lastSelectedKey) {
			lastSelectedKey = key;
			selection = new Set();
			loadedLabwareId = null;
			deckDirty = false;
			deckSlot = data.slot;
			if (data.kind !== 'deck') roleFilter = 'all';
		}
	});

	// Per-robot calibration state (PRD 2/5): the selected robot's saved global
	// offset + tip-calibrator fixture. Prefill the calibrator point when the robot
	// changes so "Go to calibrator" starts from its last-saved position.
	const currentCalibrator = $derived((data.calibrators as any[]).find((c) => c.robotId === selectedRobotId) ?? null);
	let lastCalRobot = '';
	$effect(() => {
		if (selectedRobotId && selectedRobotId !== lastCalRobot) {
			lastCalRobot = selectedRobotId;
			const cal = (data.calibrators as any[]).find((c) => c.robotId === selectedRobotId);
			if (cal?.position) { calX = cal.position.x; calY = cal.position.y; calZ = cal.position.z; }
			// Probe Z lives in its OWN fixture fields (zCalWax / zCalReagent), never in
			// position.z. Seeding only position.z is exactly why this page LOOKED like it
			// round-tripped a calibration Z while the probe never read the number back.
			// Seed both so the field shows the depth this robot would actually probe at,
			// falling back to the .py defaults when nothing has ever been taught.
			calZWax = typeof cal?.zCalWax === 'number' ? cal.zCalWax : PROBE_Z_DEFAULT.wax;
			calZReagent = typeof cal?.zCalReagent === 'number' ? cal.zCalReagent : PROBE_Z_DEFAULT.reagent;
		}
	});

	// ── Hole role (wax vs reagent) — by deck column parity ───────────────────────
	// Confirmed from the protocols: wax fills EVEN columns (2,4,…,24), reagent fills
	// ODD columns (1,3,…,23). Well name = rowLetter+colNumber, so role = column parity.
	// They need different fill accuracy, so calibration treats them separately.
	type Role = 'wax' | 'reagent';
	function colOf(name: string): number { const m = name.match(/(\d+)$/); return m ? parseInt(m[1], 10) : 0; }
	function rowOf(name: string): string { const m = name.match(/^([A-Za-z]+)/); return m ? m[1] : ''; }
	function roleOf(name: string): Role { return colOf(name) % 2 === 0 ? 'wax' : 'reagent'; }
	let roleFilter = $state<'all' | Role>('all');
	function isActiveRole(name: string): boolean { return roleFilter === 'all' || roleFilter === roleOf(name); }
	const waxCount = $derived(wells.filter((w) => roleOf(w.name) === 'wax').length);
	const reagentCount = $derived(wells.filter((w) => roleOf(w.name) === 'reagent').length);

	// ── Selection ───────────────────────────────────────────────────────────────
	let selection = $state<Set<string>>(new Set());
	const selCount = $derived(selection.size);

	// Anchor for "Set position → selection": the typed x/y/z is the anchor's new
	// position; the whole selection translates by the same delta (preserves the
	// holes' relative geometry). Prefer the most-recently-clicked hole while it
	// stays selected; otherwise fall back to the first selected hole in deck order
	// so the anchor is always defined when anything is selected.
	let anchorWell = $state<string | null>(null);
	const anchor = $derived.by(() => {
		if (anchorWell && selection.has(anchorWell)) return anchorWell;
		return wells.find((w) => selection.has(w.name))?.name ?? null;
	});

	function setRoleFilter(r: 'all' | Role) {
		roleFilter = r;
		// Keep the selection within the active role so an applied offset never
		// touches the other type of hole.
		if (r !== 'all') selection = new Set([...selection].filter(isActiveRole));
	}

	// Deselect mode: when on, box-drag and clicks REMOVE holes from the selection.
	let deselectMode = $state(false);

	function toggleWell(name: string, additive: boolean) {
		if (deselectMode) { const next = new Set(selection); next.delete(name); selection = next; return; }
		if (!isActiveRole(name)) return; // can't select a filtered-out hole
		const next = new Set(additive ? selection : []);
		if (selection.has(name) && additive) next.delete(name);
		else { next.add(name); anchorWell = name; } // a newly clicked hole becomes the anchor
		if (!additive && selection.has(name) && selection.size === 1) next.clear();
		selection = next;
	}
	function clearSelection() { selection = new Set(); }

	// ESC = wipe EVERYTHING selected/highlighted, no matter what: the well
	// selection, the reference-hole highlight, an in-progress box drag, and
	// deselect mode. Works anywhere on the page (handy mid-jog).
	function deselectAll() {
		selection = new Set();
		refWell = null;
		nominal = null;
		deselectMode = false;
		boxing = false; boxStart = null; boxNow = null;
	}
	function onWindowKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') deselectAll();
	}

	// ── Canvas geometry (viewBox = deck mm; y flipped to screen) ─────────────────
	let zoom = $state(1); // 1 = fit container width; >1 zooms in (scrolls)
	let showGrid = $state(true); // light 1mm reference grid (10mm major lines) behind the holes
	const wellR = 1.9; // viewBox (mm) radius — ~2× the physical ~0.9mm hole radius so dots stay visible/clickable at fit
	// Padding (mm) around the deck in the viewBox so edge rows (front row sits at
	// y≈0 → the very bottom after the y-flip) aren't clipped at the canvas edge.
	const VIEW_PAD = 24;
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
	// Live cursor coords (deck mm) for the hover readout + nearest hole (for z,
	// which is only defined per-hole on a deck).
	let hover = $state<{ x: number; y: number } | null>(null);
	const hoverNearest = $derived.by(() => {
		if (!hover || !wells.length) return null;
		let best: Well | null = null, bestD = Infinity;
		for (const w of wells) {
			const ddx = w.x - hover.x, ddy = w.y - hover.y, d = ddx * ddx + ddy * ddy;
			if (d < bestD) { bestD = d; best = w; }
		}
		return best ? { well: best, dist: Math.sqrt(bestD) } : null;
	});

	function onCanvasPointerMove(e: PointerEvent) {
		hover = toDeck(e);
		if (boxing) boxNow = hover;
	}
	function onCanvasPointerUp(e: PointerEvent) {
		if (!boxing || !boxStart || !boxNow) { boxing = false; return; }
		const x0 = Math.min(boxStart.x, boxNow.x), x1 = Math.max(boxStart.x, boxNow.x);
		const y0 = Math.min(boxStart.y, boxNow.y), y1 = Math.max(boxStart.y, boxNow.y);
		const moved = Math.abs(x1 - x0) > 1 || Math.abs(y1 - y0) > 1;
		if (moved) {
			const hits = wells.filter((w) => isActiveRole(w.name) && w.x >= x0 && w.x <= x1 && w.y >= y0 && w.y <= y1).map((w) => w.name);
			if (deselectMode) {
				// Deselect mode: a box REMOVES the boxed holes from the selection.
				const next = new Set(selection);
				for (const h of hits) next.delete(h);
				selection = next;
			} else {
				const next = e.shiftKey ? new Set(selection) : new Set<string>();
				for (const h of hits) next.add(h);
				selection = next;
			}
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

	// Set-absolute-position (vs offset): type an exact x/y/z for the anchor hole;
	// the whole selection translates by the same delta. Prefilled from the anchor's
	// current coords whenever the anchor changes.
	let setX = $state(0), setY = $state(0), setZ = $state(0);
	$effect(() => {
		if (anchor) {
			const w = wellByName.get(anchor);
			if (w) { setX = +w.x.toFixed(3); setY = +w.y.toFixed(3); setZ = +w.z.toFixed(3); }
		}
	});

	// Session undo stack of applied shifts (offset / global / set-position). Each
	// entry is the wells + the delta that was applied, so undo = apply the inverse.
	type Vec3 = { x: number; y: number; z: number };
	// A uniform entry carries one delta for all wells; an align entry carries a
	// per-well edit list (each hole moved by its own amount) — undo inverts each.
	let undoStack = $state<{ wellNames: string[]; delta: Vec3; label: string; edits?: { wellName: string; delta: Vec3 }[] }[]>([]);
	// nominal carries the tip-state it was measured in. The OT-2 position readback
	// (savePosition) is the pipette CRITICAL POINT, which drops by the tip length
	// (~50mm) the moment a tip is picked up. dz = live − nominal is only a true
	// GANTRY displacement if both reads share one tip state; otherwise the tip
	// length leaks into the captured delta and corrupts the deck geometry. So we
	// stamp the tip state and refuse a capture across a tip change.
	let nominal = $state<{ x: number; y: number; z: number; hasTip: boolean } | null>(null);
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

	// Core apply: one delta → many wells (Mongo via applyBatch). Records the op on
	// the undo stack unless this IS an undo. Returns the action result (or null).
	async function applyDelta(wellNames: string[], d: Vec3, label: string, record = true) {
		const r = await postAction('applyBatch', {
			deckLoadName: data.selected,
			wellNames: JSON.stringify(wellNames),
			dx: String(d.x), dy: String(d.y), dz: String(d.z),
			robotId: selectedRobotId || ''
		});
		if (r && record) undoStack = [...undoStack, { wellNames, delta: d, label }];
		return r;
	}

	// Per-well apply: each hole moves by ITS OWN delta (one Mongo write via
	// applyPerWell). Records an align-style undo entry unless this IS an undo.
	async function applyPerWellEdits(edits: { wellName: string; delta: Vec3 }[], label: string, record = true) {
		const r = await postAction('applyPerWell', {
			deckLoadName: data.selected,
			edits: JSON.stringify(edits.map((e) => ({ wellName: e.wellName, dx: e.delta.x, dy: e.delta.y, dz: e.delta.z }))),
			robotId: selectedRobotId || ''
		});
		if (r && record) undoStack = [...undoStack, { wellNames: edits.map((e) => e.wellName), delta: { x: 0, y: 0, z: 0 }, label, edits }];
		return r;
	}

	// ── Align selection to the anchor hole (straighten every line) ───────────────
	// The anchor is the jog-verified, trusted hole. Every OTHER selected hole of the
	// SAME role snaps onto a clean grid ruled by the anchor's row + column:
	//   new x = x of the hole at (anchor's row, this hole's column)  → every column
	//           line becomes perfectly straight, spaced per the anchor's row;
	//   new y = y of the hole at (this hole's row, anchor's column)  → every row
	//           becomes level, spaced per the anchor's column.
	// Z is never touched. Opposite-role holes are skipped — wax and reagent rows are
	// deliberately staggered (~one row pitch), so their Y must come from a ruler
	// column of their own role; re-run with an anchor of the other type.
	async function alignSelectionToAnchor() {
		if (selection.size < 2) { errMsg = 'Select the cartridge (or group) to align — at least 2 holes, anchor included'; return; }
		const aName = anchor;
		const a = aName ? wellByName.get(aName) : null;
		if (!aName || !a) { errMsg = 'Click the trusted (jog-verified) hole last — it becomes the anchor'; return; }
		const aRow = rowOf(aName), aCol = colOf(aName), aRole = roleOf(aName);

		const edits: { wellName: string; delta: Vec3 }[] = [];
		let skippedRole = 0, skippedNoRuler = 0, alreadyAligned = 0;
		for (const name of selection) {
			if (name === aName) continue;
			if (roleOf(name) !== aRole) { skippedRole++; continue; }
			const w = wellByName.get(name);
			if (!w) continue;
			const xRuler = wellByName.get(`${aRow}${colOf(name)}`);   // anchor's row, this column
			const yRuler = wellByName.get(`${rowOf(name)}${aCol}`);   // this row, anchor's column
			if (!xRuler || !yRuler) { skippedNoRuler++; continue; }
			const d = { x: +(xRuler.x - w.x).toFixed(3), y: +(yRuler.y - w.y).toFixed(3), z: 0 };
			if (d.x === 0 && d.y === 0) { alreadyAligned++; continue; }
			edits.push({ wellName: name, delta: d });
		}

		const skips = [
			skippedRole ? `${skippedRole} ${aRole === 'wax' ? 'reagent' : 'wax'} hole(s) skipped (align them with a ${aRole === 'wax' ? 'reagent' : 'wax'} anchor)` : '',
			alreadyAligned ? `${alreadyAligned} already aligned` : ''
		].filter(Boolean).join('; ');
		if (edits.length === 0) {
			msg = `Nothing to move — ${skips || 'selection is already aligned to ' + aName}.`;
			return;
		}
		if (!confirm(
			`Align ${edits.length} ${aRole} hole(s) to anchor ${aName}?\n` +
			`Each hole snaps onto the grid ruled by ${aName}'s row + line (X from row ${aRow}, Y from line ${aCol}). ` +
			`Z is untouched.${skips ? `\n(${skips}.)` : ''}\nUndo reverts the whole alignment.`
		)) return;
		const r = await applyPerWellEdits(edits, `align ${edits.length} to ${aName}`);
		if (r) {
			msg = applyMsg(`Aligned to ${aName}`, r) + (skips ? ` (${skips}.)` : '');
			if (skippedNoRuler) msg += ` ⚠ ${skippedNoRuler} skipped (ruler hole missing).`;
			clearSelection();
			if (runId && !slotOrigin) deckDirty = true;
		}
	}

	async function applyToSelection() {
		if (selection.size === 0) { errMsg = 'Select at least one hole'; return; }
		if (dx === 0 && dy === 0 && dz === 0) { errMsg = 'Capture or enter a non-zero offset'; return; }
		const r = await applyDelta([...selection], { x: dx, y: dy, z: dz }, `offset (${dx}, ${dy}, ${dz})`);
		if (r) {
			msg = applyMsg('Applied', r);
			clearSelection();
			if (runId && !slotOrigin) deckDirty = true;
		}
	}

	// Set the selection to an EXACT position: the typed x/y/z is the ANCHOR hole's
	// new position; the whole selection translates by that delta (single hole =
	// just that hole). Computes the delta vs the anchor's current coords, then
	// applies via the same engine so history/bounds/undo work.
	async function applyAbsolute() {
		if (selection.size === 0) { errMsg = 'Select one or more holes — the typed position sets the anchor; the group moves with it'; return; }
		const aName = anchor;
		const a = aName ? wellByName.get(aName) : null;
		if (!a) { errMsg = 'Anchor hole not found'; return; }
		const d = { x: +(setX - a.x).toFixed(3), y: +(setY - a.y).toFixed(3), z: +(setZ - a.z).toFixed(3) };
		if (d.x === 0 && d.y === 0 && d.z === 0) { errMsg = 'Position equals current — nothing to change'; return; }
		const names = [...selection];
		const r = await applyDelta(names, d, `set ${aName} → (${setX}, ${setY}, ${setZ})${names.length > 1 ? ` + ${names.length - 1} more` : ''}`);
		if (r) {
			msg = names.length === 1
				? `Set ${aName} to (${setX}, ${setY}, ${setZ}) — saved to BIMS.${runId && !slotOrigin ? ' Reload deck to verify.' : ''}`
				: applyMsg(`Set anchor ${aName} → (${setX}, ${setY}, ${setZ}); moved`, r);
			if (runId && !slotOrigin) deckDirty = true;
		}
	}

	// Undo the last applied shift (offset / global / set-position) by applying its
	// inverse delta. LIFO across the session; not recorded as a new undo entry.
	async function undoLast() {
		const last = undoStack[undoStack.length - 1];
		if (!last) { errMsg = 'Nothing to undo'; return; }
		const r = last.edits
			? await applyPerWellEdits(
				last.edits.map((e) => ({ wellName: e.wellName, delta: { x: -e.delta.x, y: -e.delta.y, z: -e.delta.z } })),
				'', false)
			: await applyDelta(last.wellNames, { x: -last.delta.x, y: -last.delta.y, z: -last.delta.z }, '', false);
		if (r) {
			undoStack = undoStack.slice(0, -1);
			msg = `Undid ${last.label} on ${r.applied} hole(s).`;
			if (runId && !slotOrigin) deckDirty = true;
		}
	}

	// Build the post-apply message: report count, any skipped wells, and whether the
	// open run already reflects it (absolute moves) or needs a reload. Position is no
	// longer restricted, so `failed` now only ever means "well not found".
	function applyMsg(verb: string, r: any): string {
		const liveNote = runId
			? slotOrigin
				? ' Live in this run — “Move to hole” reflects it now.'
				: ' Move to a hole once to enable live updates (or Reload deck).'
			: '';
		const rej = r.failed?.length
			? ` ⚠ ${r.failed.length} skipped (${r.failed.map((f: any) => `${f.wellName}: ${f.reason}`).join('; ')}).`
			: '';
		return `${verb} to ${r.applied} hole(s) — saved to BIMS.${rej}${liveNote} Re-upload (Sync) for real fills.`;
	}

	// Select every hole of the active role (handy for a global grid shift).
	function selectAllActive() {
		selection = new Set(wells.filter((w) => isActiveRole(w.name)).map((w) => w.name));
	}

	// Global grid shift: anchor on one jogged point, apply that offset to the WHOLE
	// grid (active role) as a rigid translation. Use when the entire deck is off.
	async function applyGlobalShift() {
		if (dx === 0 && dy === 0 && dz === 0) { errMsg = 'Capture (or type) a non-zero offset first'; return; }
		const names = wells.filter((w) => isActiveRole(w.name)).map((w) => w.name);
		if (names.length === 0) { errMsg = 'No holes to shift'; return; }
		const label = roleFilter === 'all' ? 'the entire deck' : `all ${roleFilter} holes`;
		if (!confirm(`Shift ${names.length} holes (${label}) by dx=${dx} dy=${dy} dz=${dz}? This translates the whole grid.`)) return;
		const r = await applyDelta(names, { x: dx, y: dy, z: dz }, `global shift (${dx}, ${dy}, ${dz})`);
		if (r) {
			msg = applyMsg('Global shift applied', r);
			clearSelection();
			if (runId && !slotOrigin) deckDirty = true;
		}
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
	// Which pipette to dial in with. Chosen before opening the run; locked while open.
	let desiredMount = $state<'left' | 'right'>('left');
	let liveX = $state<number | null>(null), liveY = $state<number | null>(null), liveZ = $state<number | null>(null);
	let connecting = $state(false);
	// Deck slot the labware sits in (for move-to-hole). Resolved/overridable; OT-2 slots 1-11.
	let deckSlot = $state('1');
	let loadedLabwareId = $state<string | null>(null);
	// #6 — apply edits to the OPEN run without closing it. The OT-2 binds a labware's
	// geometry at loadLabware time, so moveToWell uses the coords AS LOADED; later
	// Mongo edits don't reach the live run (the old "Reload deck" close/reopen dance).
	// Fix: derive the slot's deck origin ONCE (first moveToWell, vs the coords
	// snapshotted at load), then move via absolute moveToCoordinates built from the
	// LIVE (edited) Mongo coords. moveToCoordinates places the critical point at an
	// absolute deck point (robot handles tip length), so it's tip-independent and
	// reflects edits instantly — no run close needed.
	let slotOrigin = $state<{ x: number; y: number; z: number } | null>(null);
	let loadedWells = $state<Map<string, { x: number; y: number; z: number }> | null>(null);
	const APPROACH_Z_MM = 2; // critical point parks this far above the well top

	// Deck floor for the tip, derived from the deck's OWN dimensions (data.dimensions
	// ← definition.dimensions in the labware JSON), never from its holes. The frame's
	// origin is the deck's bottom face; holes are locations INSIDE it, so a crept or
	// mistyped hole must not be allowed to define how low the tip may go.
	//
	// Upward is deliberately unbounded — raising a hole is the whole point of the new
	// cartridge deck. Downward is not: below the deck bottom there is no hole to
	// dispense into, only the slot. Server-side apply-edit.ts enforces the same floor
	// on the SAVED coordinate; this is the same rule on the COMMANDED one, because a
	// move reads live coords and an out-of-range value must never reach the gantry.
	const DECK_FLOOR_Z = 0;
	// True after an offset is applied while a run is open: the run still holds the
	// pre-edit deck, so "Move to hole" would use stale coords until the deck is reloaded.
	let deckDirty = $state(false);

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
			const res = await api(`/api/opentrons-lab/robots/${selectedRobotId}/maintenance`, { method: 'POST', body: JSON.stringify({ mount: desiredMount }) });
			runId = res.runId ?? null;
			pipetteId = res.pipetteId ?? null;
			pipetteMount = res.mount ?? null;
			pipetteName = res.pipetteName ?? null;
			zAxis = pipetteMount === 'right' ? 'rightZ' : 'leftZ';
			loadedLabwareId = null;
			deckDirty = false; // fresh run loads the current deck from Mongo
			hasTip = false;
			// A fresh run knows nothing from the previous session, so every piece of
			// frame state must die with it. tipAdjust especially: stopMaintenance()
			// clears it, but a session killed EXTERNALLY (e.g. a fill run stealing the
			// run engine) never runs that path — reconnecting then silently folded the
			// dead session's adjust into every Move-to-hole, which is exactly what made
			// a "raw" verification look perfect on 2026-07-29 (B14) and led to a wrong
			// whole-deck re-shift. Same reset list as stopMaintenance's finally.
			tipAdjust = null;
			nominal = null;
			refWell = null;
			slotOrigin = null;
			loadedWells = null;
			liveX = liveY = liveZ = null;
			if (!pipetteId) errMsg = 'Maintenance run opened but no pipette loaded — jog/move will fail until a pipette is configured.';
			else msg = `Connected. pipette ${pipetteName} on ${pipetteMount}. If a tip is still on the pipette from an earlier session, remove it by hand before moving — a fresh session assumes a bare nozzle.`;
		} catch (e) { errMsg = e instanceof Error ? e.message : String(e); } finally { connecting = false; }
	}

	// Reopen the run so it re-registers the corrected deck from Mongo — the only
	// reliable way to make "Move to hole" reflect offsets applied since opening.
	async function reloadDeckIntoRun() {
		if (!runId) { errMsg = 'No run open'; return; }
		clearMsg();
		msg = 'Reloading corrected deck into the run…';
		await stopMaintenance();
		await startMaintenance();
		if (!errMsg) msg = 'Reloaded — the run now uses your corrected deck. Move to a hole to verify.';
	}
	async function stopMaintenance() {
		if (!runId) return;
		busy = true;
		try { await api(`/api/opentrons-lab/robots/${selectedRobotId}/maintenance/${runId}`, { method: 'DELETE' }); }
		catch (e) { errMsg = e instanceof Error ? e.message : String(e); }
		// Closing the run drops the tip and clears the session → reset ALL tip/frame
		// state so a stale tipAdjust or nominal can't leak into the next session.
		finally { runId = null; pipetteId = null; pipetteMount = null; pipetteName = null; loadedLabwareId = null; liveX = liveY = liveZ = null; hasTip = false; tipAdjust = null; nominal = null; refWell = null; slotOrigin = null; loadedWells = null; busy = false; }
	}
	async function homeRobot() {
		if (!runId) { errMsg = 'Open a maintenance run first'; return; }
		clearMsg();
		busy = true;
		msg = 'Homing all axes… (~30s, the gantry re-finds its endstops)';
		try {
			// Empty body = home ALL axes — re-references position after the arm is
			// knocked off track. Server allows up to 120s; client waits ~70s.
			await api(`/api/opentrons-lab/robots/${selectedRobotId}/maintenance/${runId}/home`, { method: 'POST', body: JSON.stringify({}) });
			// Position reference changed — the prior move-to-hole nominal is now stale.
			nominal = null; refWell = null;
			await refreshPosition();
			msg = 'Homed — positions re-referenced. Move to a hole again to recalibrate.';
		} catch (e) {
			errMsg = `Home failed: ${e instanceof Error ? e.message : String(e)}`;
		} finally { busy = false; }
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
	// Load the deck labware into the run once (so the robot computes well positions).
	async function ensureDeckLoaded(): Promise<string> {
		if (loadedLabwareId) return loadedLabwareId;
		const d = labwareOptions.find((x) => x.loadName === data.selected);
		const lw = await api(`/api/opentrons-lab/robots/${selectedRobotId}/maintenance/${runId}/load-labware`, {
			method: 'POST',
			body: JSON.stringify({ namespace: d?.namespace, loadName: data.selected, version: d?.version ?? 1, slot: deckSlot })
		});
		loadedLabwareId = lw?.labwareId ?? null;
		if (!loadedLabwareId) throw new Error('load-labware did not return a labwareId');
		// Snapshot the coords the run was loaded with (so we can derive the slot origin
		// even after subsequent edits change the live Mongo coords). Re-derive origin.
		loadedWells = new Map(wells.map((w) => [w.name, { x: w.x, y: w.y, z: w.z }]));
		slotOrigin = null;
		return loadedLabwareId;
	}
	// Safe-arc lift height (critical-point deck Z) for moves between holes.
	// Based on the labware's OWN physical height (dimensions.z) + clearance — NOT
	// max(well.z), which a corrupted/edited well could inflate without bound (that
	// drove the "Arc out of bounds in Z" error: a deck whose wells had crept to 82mm
	// produced safeArcZ 162 → +tip ≈ 211mm, past the gantry limit). Clamped to a
	// machine-real ceiling: the OT-2 left p300 rejects gantry Z beyond ~170mm, and a
	// tip adds ~50mm, so the critical point must stay below ~115mm. (Verify per robot.)
	const ARC_CLEARANCE_MM = 80;
	const ARC_CEILING_MM = 115;
	const safeArcZ = $derived(Math.min(Math.round((dim.z || 12.7) + ARC_CLEARANCE_MM), ARC_CEILING_MM));

	// Safe arc: lift to safeArcZ, travel in XY, descend. Never drags the tip.
	// Once the slot origin is known we move by ABSOLUTE coordinates from the live
	// (edited) Mongo coords, so applied edits take effect with no run close (#6).
	// The first move of a session uses moveToWell (the run's loaded def) and derives
	// the origin from the load-time snapshot.
	async function moveToWellSafe(name: string): Promise<void> {
		const lid = await ensureDeckLoaded();
		const ax = tipAdjust?.x ?? 0, ay = tipAdjust?.y ?? 0;

		if (slotOrigin) {
			// Absolute move from LIVE coords → reflects edits instantly, tip-independent.
			const w = wellByName.get(name);
			if (!w) throw new Error(`Unknown well ${name}`);
			// Reject, never clamp — same rule as the calibrator Z fields. A clamp would
			// quietly send the tip to a depth the operator never asked for.
			// Check the STORED hole Z, not the derived target: well.z is the hole's
			// BOTTOM in the labware frame (verified on DECK001 — z 3.5-8.8mm with
			// depth 3.75 on a 12.7mm block, so z + depth lands just under the deck
			// top). z < 0 therefore means the hole bottom is below the deck's bottom
			// face — the tip would be in the slot, not in a hole. Testing the target
			// instead would let the +2mm approach clearance mask a hole sitting up to
			// 2mm below the deck. Same rule, same number as apply-edit.ts server-side.
			if (!Number.isFinite(w.z) || w.z < DECK_FLOOR_Z) {
				throw new Error(
					`Well ${name} sits at z ${w.z}mm, below the ${dim.z || 12.7}mm deck's floor ` +
						`(${DECK_FLOOR_Z}mm) — the tip would be driven into the slot, not into a hole. ` +
						`Raising a hole is unrestricted; fix this hole's Z before moving.`
				);
			}
			await api(`/api/opentrons-lab/robots/${selectedRobotId}/maintenance/${runId}/move-to`, {
				method: 'POST',
				body: JSON.stringify({
					pipetteId,
					x: slotOrigin.x + w.x + ax,
					y: slotOrigin.y + w.y + ay,
					z: slotOrigin.z + w.z + APPROACH_Z_MM,
					minimumZHeight: safeArcZ,
					forceDirect: false
				})
			});
			return;
		}

		// First move: use moveToWell (uses the run's loaded def), then derive the slot
		// origin from the load-time snapshot so every later move can go absolute.
		// Fold the tip-cal adjust into the well offset (one fluid move to well+adjust,
		// matching the protocol's well.top().move(adjust)).
		await api(`/api/opentrons-lab/robots/${selectedRobotId}/maintenance/${runId}/move-to-well`, {
			method: 'POST',
			body: JSON.stringify({
				pipetteId, labwareId: lid, wellName: name, minimumZHeight: safeArcZ,
				xOffsetMm: ax, yOffsetMm: ay
			})
		});
		await refreshPosition();
		const loaded = loadedWells?.get(name);
		if (loaded && liveX !== null && liveY !== null && liveZ !== null) {
			// liveZ is the critical point parked at (well top + APPROACH_Z); the robot
			// already accounted for tip length, so the derived origin is tip-independent.
			slotOrigin = {
				x: liveX - loaded.x - ax,
				y: liveY - loaded.y - ay,
				z: liveZ - loaded.z - APPROACH_Z_MM
			};
		}
	}

	async function moveToSelectedHole() {
		if (!runId || !pipetteId) { errMsg = 'Open a maintenance run first'; return; }
		if (selection.size !== 1) { errMsg = 'Select exactly one reference hole to move to'; return; }
		const name = [...selection][0];
		clearMsg();
		busy = true;
		try {
			await moveToWellSafe(name);
			await refreshPosition();
			nominal = liveX !== null ? { x: liveX!, y: liveY!, z: liveZ!, hasTip } : null;
			refWell = name;
			msg = `At nominal of ${name}${hasTip ? ' (tip on)' : ' (no tip)'}. Jog onto the real hole, then Capture.`;
		} catch (e) { errMsg = e instanceof Error ? e.message : String(e); } finally { busy = false; }
	}

	// ── Tour: drive the pipette through every active-role hole, like a fill run, ──
	// so you can watch which positions are hitting. Stepped or auto-played.
	let touring = $state(false);
	let tourIndex = $state(0);
	let tourWells = $state<string[]>([]);
	let tourPlaying = $state(false);

	function orderedActiveWells(): string[] {
		// Column-major sweep (left→right, then by y) so travel between holes is short.
		return wells
			.filter((w) => isActiveRole(w.name))
			.slice()
			.sort((a, b) => colOf(a.name) - colOf(b.name) || a.y - b.y)
			.map((w) => w.name);
	}
	async function tourGoTo(i: number) {
		if (i < 0 || i >= tourWells.length) return;
		busy = true; clearMsg();
		try {
			const name = tourWells[i];
			await moveToWellSafe(name);
			tourIndex = i;
			selection = new Set([name]);
			refWell = name;
			msg = `Tour ${roleFilter === 'all' ? 'holes' : roleFilter}: ${i + 1}/${tourWells.length} — ${name}`;
		} catch (e) { errMsg = e instanceof Error ? e.message : String(e); tourPlaying = false; }
		finally { busy = false; }
	}
	async function startTour() {
		if (!runId || !pipetteId) { errMsg = 'Open a maintenance run first'; return; }
		const list = orderedActiveWells();
		if (!list.length) { errMsg = 'No holes for the active role'; return; }
		tourWells = list; touring = true;
		await tourGoTo(0);
	}
	async function tourNext() { if (tourIndex < tourWells.length - 1) await tourGoTo(tourIndex + 1); }
	async function tourPrev() { if (tourIndex > 0) await tourGoTo(tourIndex - 1); }
	function tourStop() { touring = false; tourPlaying = false; }
	async function tourPlay() {
		tourPlaying = true;
		while (tourPlaying && tourIndex < tourWells.length - 1) {
			await tourGoTo(tourIndex + 1);
			if (!tourPlaying) break;
			await new Promise((r) => setTimeout(r, 500));
		}
		tourPlaying = false;
	}

	// ── Fill motion: replay the REAL fill motion on just the selected hole(s) ──
	// Mirrors Reagent_Filling_GEN7 (run_calibration_check / dispense_reagent), which
	// at every hole does: jump 60mm above the well top → descend to +2mm (the dispense
	// position, = well.top(-3)+5) → dwell → retract to +5mm. We drive that motion at the
	// fill travel speed (default 20 mm/s = the protocol's speed=20 moves). Runs ONLY the
	// holes you selected, in fill order, starting from your first selected hole — so you
	// can pick any hole(s) as the start point, not just the whole-deck Tour.
	const FILL_JUMP_MM = 60; // protocol jump_height: travel height above the well top
	const FILL_DISPENSE_MM = 2; // protocol dispense pos: well.top(-3)+5 = 2mm above top
	const FILL_RETRACT_MM = 5; // protocol well_prejump_height
	// The reagent fill's dispense loop (dispense_reagent) uses plain move_to with NO
	// speed arg → the gantry runs at the pipette's DEFAULT (full) speed. So "match the
	// protocol" = don't cap the speed at all. The earlier 20 mm/s was the tip-calibrator
	// limit-switch probe, which is deliberately slow — not the fill.
	let fillMatchProtocol = $state(true); // default: move at the protocol's own (full) speed
	let fillSpeed = $state(20); // mm/s cap, applied ONLY when match-protocol is off (watch slowly)
	let fillDwellMs = $state(250); // dwell at the dispense position (protocol delays 0.25s)
	let fillMotionRunning = $state(false);
	let fillPaused = $state(false); // pause takes effect between moves (mid-move can't interrupt)
	let fillStop = false;

	// Block between moves while paused (until resumed or stopped). Mid-move can't be
	// interrupted — the OT-2 finishes the current move — so pause lands at a safe point.
	async function fillWaitIfPaused() {
		while (fillPaused && !fillStop) await new Promise((r) => setTimeout(r, 150));
	}

	// Holes in the order the fill visits them (column-major, then y) — matches Tour.
	function fillOrder(names: string[]): string[] {
		return names
			.slice()
			.sort((a, b) => colOf(a) - colOf(b) || (wellByName.get(a)?.y ?? 0) - (wellByName.get(b)?.y ?? 0));
	}

	// Absolute move to `aboveTopMm` over a hole's top, at fill speed, from LIVE (edited)
	// Mongo coords via slotOrigin — so the motion reflects the current calibration and is
	// tip-independent (the robot places the critical point at the target).
	async function fillMoveAbs(name: string, aboveTopMm: number, o: { forceDirect: boolean; arc?: boolean }) {
		const w = wellByName.get(name);
		if (!w || !slotOrigin) throw new Error('Deck origin not established yet');
		const ax = tipAdjust?.x ?? 0,
			ay = tipAdjust?.y ?? 0;
		const zAbs = slotOrigin.z + w.z + aboveTopMm;
		await api(`/api/opentrons-lab/robots/${selectedRobotId}/maintenance/${runId}/move-to`, {
			method: 'POST',
			body: JSON.stringify({
				pipetteId,
				x: slotOrigin.x + w.x + ax,
				y: slotOrigin.y + w.y + ay,
				z: zAbs,
				// Match the protocol: its dispense-loop moves run at the default (full) speed,
				// so only cap when the operator turns match-protocol off to watch slowly.
				...(fillMatchProtocol ? {} : { speed: fillSpeed }),
				// Between holes, lift to the jump height (arc) so the tip never drags.
				...(o.arc ? { minimumZHeight: zAbs } : {}),
				forceDirect: o.forceDirect
			})
		});
	}

	async function runFillMotion() {
		if (!runId || !pipetteId) {
			errMsg = 'Open a maintenance run first';
			return;
		}
		const chosen = fillOrder([...selection].filter((n) => wellByName.has(n)));
		if (!chosen.length) {
			errMsg = 'Select the hole(s) you want to run the fill motion on';
			return;
		}
		clearMsg();
		fillMotionRunning = true;
		fillStop = false;
		fillPaused = false;
		busy = true;
		try {
			// Establish the slot origin (first move uses the safe arc via moveToWellSafe).
			if (!slotOrigin) await moveToWellSafe(chosen[0]);
			for (let i = 0; i < chosen.length; i++) {
				await fillWaitIfPaused();
				if (fillStop) {
					msg = `Fill motion stopped — ${i}/${chosen.length} done`;
					break;
				}
				const name = chosen[i];
				selection = new Set([name]);
				refWell = name;
				msg = `Fill motion ${i + 1}/${chosen.length} — ${name}${fillMatchProtocol ? ' (protocol speed)' : ` @ ${fillSpeed} mm/s`}`;
				await fillMoveAbs(name, FILL_JUMP_MM, { forceDirect: false, arc: true }); // 1) travel above hole
				await fillWaitIfPaused();
				if (fillStop) break;
				await fillMoveAbs(name, FILL_DISPENSE_MM, { forceDirect: true }); // 2) descend to dispense pos
				await refreshPosition();
				await new Promise((r) => setTimeout(r, Math.max(0, fillDwellMs))); // 3) dwell (visual check)
				await fillWaitIfPaused();
				if (fillStop) break;
				await fillMoveAbs(name, FILL_RETRACT_MM, { forceDirect: true }); // 4) retract to prejump
			}
			if (!fillStop) msg = `Fill motion complete — ${chosen.length} hole(s)${fillMatchProtocol ? ' at protocol speed' : ` at ${fillSpeed} mm/s`}`;
		} catch (e) {
			errMsg = e instanceof Error ? e.message : String(e);
		} finally {
			fillMotionRunning = false;
			fillPaused = false;
			busy = false;
			await refreshPosition();
		}
	}
	function pauseFillMotion() {
		fillPaused = true;
		msg = 'Fill motion paused — Resume to continue, or Stop to end.';
	}
	function resumeFillMotion() {
		fillPaused = false;
	}
	function stopFillMotion() {
		fillStop = true;
		fillPaused = false;
	}

	// ── Tip pickup + go to tip calibrator (matches the real fill workflow) ──
	// Tiprack + calibrator point come from the protocols (wax: p20 right + the
	// limit-switch calibrator at 125.181,173.247,z34.491; reagent: p300 left).
	// TWO different Z heights live on one fixture, and they are deliberately TWO
	// controls (PRD CALIB-4 section 5, decision 1). calZ is the APPROACH point --
	// where the tip parks BEFORE the probe, and the only Z that "Go to calibrator"
	// may ever command. The probe Zs below are the touch-off depths the limit-switch
	// routine descends to under its own protection. If a probe Z drove the free jog
	// move-to, the pipette would descend to touch-off depth with nothing protecting
	// it -- that is the crash case, so the two never share a control.
	let calX = $state(125.181), calY = $state(173.247), calZ = $state(34.491);
	// "Is the tip already on the fixture?" — the one-click Calibrate sequence asks this
	// before it decides to travel. In ATTACHED mode the daemon probes from the pipette's
	// CURRENT position (ot2-bridge.py execute_calibrate_tip), so a tip the operator has
	// jogged onto the calibrator IS the point being taught. Re-driving to the stored
	// calX/calY would silently throw that jog away, so within tolerance we leave it be.
	const CAL_AT_TOLERANCE_MM = 3;
	function atCalibratorNow(): boolean {
		return liveX !== null && liveY !== null
			&& Math.hypot(liveX - calX, liveY - calY) <= CAL_AT_TOLERANCE_MM;
	}
	// Both probe Zs are held at once so flipping the tip type swaps which one is
	// shown without discarding the other one's unsaved edit. Defaults mirror
	// TIP_PROFILE[*].defaultZ in $lib/server/services/deck-calibration/tip-calibrator.ts
	// (wax/p20 34.491, reagent/p300 40.8) -- that file is the source of truth.
	const PROBE_Z_DEFAULT: Record<'wax' | 'reagent', number> = { wax: 34.491, reagent: 40.8 };
	let calZWax = $state(PROBE_Z_DEFAULT.wax); // -> fixture.zCalWax, p20 / wax-filling
	let calZReagent = $state(PROBE_Z_DEFAULT.reagent); // -> fixture.zCalReagent, p300 / reagent-filling
	// CAL_Z_LIMITS per PRD section 4.4, re-declared here as literals rather than
	// imported: tip-calibrator.ts sits under $lib/server and SvelteKit hard-blocks
	// value imports from server code into a component. Keep in sync with the export
	// there, which stays the source of truth.
	const CAL_Z_MIN = 5, CAL_Z_MAX = 200;
	let tipWell = $state('A1');
	let hasTip = $state(false);
	// Which tip is on the mount is an OPERATOR CHOICE, never inferred. The
	// pipettes are not fixed to mounts on this fleet, so deriving the tiprack
	// (or the calibration Z) from desiredMount loaded the wrong definition and
	// probed at the wrong depth. Starts null so nothing can proceed on a guess.
	let tipProfile = $state<'wax' | 'reagent' | null>(null);
	const tiprackForProfile = $derived(
		tipProfile === 'wax'
			? 'cosmasanddamian_96_tiprack_20ul'
			: tipProfile === 'reagent'
				? 'cosmas_and_damian_biotix_96_200ul_tiprack'
				: null
	);

	// Which stored field the Probe Z control is editing right now. Keyed off the
	// explicit tip profile, never the mount -- getting that wrong is the 6.309 mm
	// error. Null until a tip type is picked, and a null key means Save sends NO
	// probe Z at all: an absent key is "leave it alone", which is far safer than
	// guessing which fill process the operator meant.
	const probeZKey = $derived(
		tipProfile === 'wax' ? 'zCalWax' : tipProfile === 'reagent' ? 'zCalReagent' : null
	);
	const probeZ = $derived(tipProfile === 'reagent' ? calZReagent : calZWax);
	function setProbeZ(v: number) {
		if (tipProfile === 'reagent') calZReagent = v;
		else calZWax = v;
	}
	// Reject, never clamp (PRD section 5, decision 4): a clamp silently moves the
	// pipette somewhere the operator did not ask for. Failure here is asymmetric --
	// too low crashes into the fixture, too high reads nothing -- so a bad number is
	// refused at the form rather than discovered at the robot.
	function checkedZ(v: number, label: string): number | null {
		if (!Number.isFinite(v) || v < CAL_Z_MIN || v > CAL_Z_MAX) {
			errMsg = `${label} must be a number between ${CAL_Z_MIN} and ${CAL_Z_MAX} mm (got ${Number.isFinite(v) ? v : 'blank'})`;
			return null;
		}
		return v;
	}

	// ── PRD 4: robot-side tip calibration (limit-switch probe via the bridge). ──
	// The returned adjust{x,y} is the per-tip bend correction; we apply it to every
	// move-to during tuning so captured geometry is tip-zeroed (no double-count).
	let tipAdjust = $state<{ x: number; y: number } | null>(null);
	let calibrating = $state(false);
	// ONE CLICK = the whole setup. Picking up a tip and travelling to the fixture are
	// mandatory, never-varying prerequisites of the probe, and skipping the travel used
	// to fail deep in the robot ("limit switch not reached within 5mm") because the
	// daemon probes wherever the tip happens to be. So this does both, driven by the
	// tip profile — which calibration is being done — rather than nagging the operator.
	async function calibrateTip() {
		if (!runId || !pipetteId) { errMsg = 'Open a run first'; return; }
		if (!tipProfile) { errMsg = 'Pick the tip type first (p20/wax or p300/reagent) — the probe depth depends on it and is never guessed'; return; }
		// Try-before-commit means the probe runs at whatever is in the fields RIGHT
		// NOW, saved or not. That makes this form the last line of defence before the
		// gantry moves, so both heights are range-checked here.
		const approachZNow = checkedZ(calZ, 'Approach Z');
		if (approachZNow === null) return;
		const probeZNow = checkedZ(probeZ, 'Probe Z');
		if (probeZNow === null) return;
		const tipLabel = tipProfile === 'reagent' ? 'p300' : 'p20';
		// busy for the WHOLE sequence, not just the probe: this now commands gantry
		// motion, so the jog pad and the other motion buttons stay locked out.
		clearMsg(); busy = true; calibrating = true;
		try {
			// Step 1 — a tip of the type this calibration is for. tiprackForProfile is
			// derived from tipProfile, never from the mount.
			let pickedUpNow = false;
			if (!hasTip) {
				msg = `Picking up a ${tipLabel} tip (${tiprackForProfile} ${tipWell})…`;
				await doPickUpTip();
				pickedUpNow = true;
				// Live XY is the tiprack in slot 11 now, not the fixture — re-read it so
				// the position readout is honest. Not load-bearing: pickedUpNow already
				// forces the travel below, because refreshPosition swallows its own
				// errors and a stale liveX/liveY must never be allowed to skip a move.
				await refreshPosition();
			}
			// Step 2 — travel, unless the operator already jogged onto the fixture.
			if (!pickedUpNow && atCalibratorNow()) {
				msg = 'Already on the calibrator — probing from the jogged position…';
			} else {
				msg = `Moving to the tip calibrator (${calX}, ${calY}, ${approachZNow})…`;
				await doGoToCalibrator(approachZNow);
			}
			// Step 3 — the probe itself.
			msg = 'Calibrating tip on the fixture… (slow limit-switch probe; the tip stays on for tuning)';
			// Probe inside THIS run so the tip + session survive for deck tuning.
			// tipProfile — NOT the mount — decides the probe Z and the tiprack.
			// `calibrator` is the UN-SAVED override (PRD section 4.3):
			// applyCalibratorOverride lays it over the stored fixture axis by axis, so the
			// probe happens at the live field values without writing a thing to Mongo.
			// Its z is the PROBE Z -- the touch-off depth -- never the approach height.
			const res = await api('/api/scanner/calibrate-tip', { method: 'POST', body: JSON.stringify({ robotId: selectedRobotId, mount: desiredMount, tipProfile, tipWell, runId, pipetteId, calibrator: { x: calX, y: calY, z: probeZNow } }) });
			if (res?.adjust && typeof res.adjust.x === 'number') {
				tipAdjust = { x: res.adjust.x, y: res.adjust.y };
				// The probe moved the gantry and changed the applied adjust → any prior
				// nominal is stale. Re-Move to the hole before capturing.
				nominal = null; refWell = null;
				await refreshPosition();
				msg = `Tip calibrated: adjust x=${tipAdjust.x} y=${tipAdjust.y}. Tip kept on; applied to every move-to while tuning. Move to a hole to set a fresh nominal.`;
			} else { errMsg = 'Calibration returned no adjust'; }
		} catch (e) { errMsg = e instanceof Error ? e.message : String(e); } finally { busy = false; calibrating = false; }
	}

	// doPickUpTip is a STEP of calibrateTip's sequence rather than a button handler:
	// it throws and touches no busy/msg state, which is what lets it compose. (The
	// standalone "Pick up tip" button was removed when the panel was condensed.)

	// Load the tiprack + pick up a tip. If slot 11 already holds a DIFFERENT rack
	// (e.g. the reagent rack loaded earlier this run to calibrate it, then a wax tip
	// pickup needs the 20µL rack in the same slot), the endpoint returns 409
	// SLOT_OCCUPIED — the slot can't be freed in place (no gripper), so reopen the run
	// (fresh empty deck) once and retry. allowRecover guards against an infinite loop.
	//
	// MERGE NOTE (2026-08-21): this recovery is master's and is kept. One-click
	// Calibrate tip makes it MORE reachable, not less — an operator can now switch
	// tip type and re-run without ever thinking about what is in slot 11. The rack
	// comes from tiprackForProfile (the operator's explicit choice), not master's
	// tiprackForMount, which inferred it from the mount.
	async function doPickUp(allowRecover: boolean) {
		const res = await fetch(
			`/api/opentrons-lab/robots/${selectedRobotId}/maintenance/${runId}/pick-up-tip`,
			{
				method: 'POST',
				credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ pipetteId, tiprackLoadName: tiprackForProfile, slot: '11', tipWell })
			}
		);
		if (res.ok) return;
		const body = await res.json().catch(() => ({}) as any);
		if (res.status === 409 && body?.code === 'SLOT_OCCUPIED' && allowRecover) {
			msg = 'Slot 11 had another rack loaded — reopening the run to free it…';
			await stopMaintenance();
			await startMaintenance();
			// Both of those clear `busy` in their own finally blocks, but the calibrate
			// sequence still owns the gantry — take the lock back before carrying on.
			busy = true;
			if (!runId || !pipetteId) throw new Error('Could not reopen the maintenance run to free slot 11');
			return doPickUp(false);
		}
		throw new Error(body?.message || (typeof body === 'string' ? body : `HTTP ${res.status}`));
	}

	/** Pick up a tip of the current profile. Throws on failure. */
	async function doPickUpTip(): Promise<void> {
		if (!tiprackForProfile) throw new Error('Pick the tip type first (p20/wax or p300/reagent) — it is not inferred from the mount');
		await doPickUp(true);
		hasTip = true;
		// Tip state just changed → any nominal taken without the tip is now a
		// different frame. Force a fresh Move-to-hole before the next capture.
		nominal = null; refWell = null;
	}

	/** Safe arc to the calibrator APPROACH point (lift, travel, descend). Caller range-checks z. Throws. */
	async function doGoToCalibrator(z: number): Promise<void> {
		await api(`/api/opentrons-lab/robots/${selectedRobotId}/maintenance/${runId}/move-to`, {
			method: 'POST',
			body: JSON.stringify({ pipetteId, x: calX, y: calY, z, minimumZHeight: safeArcZ, forceDirect: false })
		});
		await refreshPosition();
	}

	// Standalone "Pick up tip": a tip WITHOUT the 1-2 minute probe. Restored after the
	// panel was condensed, because two flows on this page want a tip on its own and
	// neither wants a calibration: Fill motion only matches the real fill height with
	// a tip on, and "Move to hole" -> Capture offset must be taught in the same tip
	// frame it will run in. Going through "Calibrate tip" for those means waiting out
	// a probe nobody asked for. Guards are calibrateTip's step 1 exactly — tip type is
	// never inferred from the mount, because probe depth differs by 6.309 mm.
	async function pickUpTipAction() {
		if (!runId || !pipetteId) { errMsg = 'Open a maintenance run first'; return; }
		if (!tiprackForProfile) { errMsg = 'Pick the tip type first (p20/wax or p300/reagent) — it is not inferred from the mount'; return; }
		clearMsg(); busy = true;
		msg = 'Loading tiprack & picking up a tip…';
		try {
			await doPickUpTip();
			msg = `Picked up a tip (${tiprackForProfile} ${tipWell}). No calibration run — use "Calibrate tip" for that, or move to a hole.`;
		} catch (e) { errMsg = e instanceof Error ? e.message : String(e); } finally { busy = false; }
	}

	// Park at the fixture without probing — the first step of the teach loop
	// (park → jog → From live ↧ → Save). Lives in the teach disclosure.
	async function goToCalibrator() {
		if (!runId || !pipetteId) { errMsg = 'Open a maintenance run first'; return; }
		// APPROACH Z only, deliberately. This is a free jog with no probe routine
		// underneath it, so handing it the touch-off depth would drive the tip into
		// the fixture unprotected.
		const approachZNow = checkedZ(calZ, 'Approach Z');
		if (approachZNow === null) return;
		clearMsg(); busy = true;
		try {
			await doGoToCalibrator(approachZNow);
			msg = `At the tip-calibrator approach point (${calX}, ${calY}, ${approachZNow}). Jog to fine-tune.`;
		} catch (e) { errMsg = e instanceof Error ? e.message : String(e); } finally { busy = false; }
	}

	async function captureOffset() {
		if (!nominal) { errMsg = 'Move to a hole first to set the nominal reference'; return; }
		// Tip-state must match the nominal's, or the ~50mm tip length leaks into dz.
		if (nominal.hasTip !== hasTip) {
			errMsg = `Tip state changed since "Move to hole" (${nominal.hasTip ? 'tip was on' : 'no tip'}, now ${hasTip ? 'tip on' : 'no tip'}). Move to the hole again so nominal + capture share one frame, then Capture.`;
			nominal = null; refWell = null;
			return;
		}
		await refreshPosition();
		if (liveX === null || liveY === null || liveZ === null) { errMsg = 'Could not read position'; return; }
		dx = +(liveX - nominal.x).toFixed(3);
		dy = +(liveY - nominal.y).toFixed(3);
		dz = +(liveZ - nominal.z).toFixed(3);
		msg = `Captured offset from ${refWell}: dx=${dx} dy=${dy} dz=${dz}. Select the holes to apply it to.`;
	}

	// ── PRD 2: save the tip-calibrator fixture position for the selected robot. ──
	// Saves EXACTLY the X/Y/Z fields — type them directly, or click "From live" to
	// fill them from the jogged position first. (Previously it silently used the
	// live position whenever a run was open, ignoring typed edits.)
	async function saveCalibratorPosition() {
		if (!selectedRobotId) { errMsg = 'Pick a robot'; return; }
		if (checkedZ(calZ, 'Approach Z') === null) return;
		// Save is the ONLY write path to production: these numbers become that robot's
		// z_cal runtime parameter in real wax/reagent runs. Send exactly ONE probe-Z
		// key, chosen by the active tip profile -- omitting the other key means "leave
		// it alone", so a wax session can never quietly rewrite the reagent depth.
		const fields: Record<string, string> = {
			robotId: selectedRobotId,
			x: String(calX), y: String(calY), z: String(calZ),
			source: 'manual'
		};
		if (probeZKey) {
			const z = checkedZ(probeZ, 'Probe Z');
			if (z === null) return;
			fields[probeZKey] = String(z);
		}
		// Read the inherit flag BEFORE saving: postAction invalidates and re-loads, and
		// once this robot has its own row the fork it just performed is invisible.
		const forkedFromGlobal = !!currentCalibrator?.inheritedFromGlobal;
		const r = await postAction('saveCalibrator', fields);
		if (r)
			msg =
				`Saved tip-calibrator for ${robot?.name}: approach (${calX}, ${calY}, ${calZ})` +
				(probeZKey ? ` and probe Z ${probeZ} -> ${probeZKey}.` : ' (probe Z untouched - no tip type picked).') +
				(forkedFromGlobal ? ` This robot now has its own fixture and no longer follows 'global'.` : '');
	}
	// Fill the calibrator X/Y/Z fields from the live jogged position (jog onto the
	// calibrator → click this → Save).
	// APPROACH point only: the live reading is where the tip is parked, not the
	// depth the probe found, so it must never be copied into a Probe Z field.
	function captureCalibratorFromLive() {
		if (liveX === null || liveY === null || liveZ === null) { errMsg = 'No live position — open a run and move/jog first'; return; }
		calX = +liveX.toFixed(3); calY = +liveY.toFixed(3); calZ = +liveZ.toFixed(3);
		msg = `Calibrator fields set from live (${calX}, ${calY}, ${calZ}). Click Save to persist.`;
	}

	// ── PRD 5: save the robot's GLOBAL deck offset. The captured dx/dy/dz (the
	// error of THIS robot vs the reference deck) is the global correction applied
	// to all labware at fill time. One robot is the reference (offset 0,0,0).

	onDestroy(() => {
		if (runId) {
			try {
				fetch(`/api/opentrons-lab/robots/${selectedRobotId}/maintenance/${runId}`, { method: 'DELETE', credentials: 'same-origin', keepalive: true });
			} catch { /* best-effort */ }
		}
	});

</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="mx-auto max-w-[1400px] space-y-4 overflow-x-clip p-4">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Deck Calibration Studio</h1>
			<p class="text-xs" style="color: var(--color-tron-text-secondary)">
				Jog to a hole, capture the real offset, select a group of holes, apply it. Corrections persist in BIMS and reach the robot on Sync.
			</p>
		</div>
		<!-- Text tuner (deck-tuner, CALIB-1) deleted 2026-08-28: superseded by this
		     Studio since June; no recorded usage. -->
		<a href="/manufacturing/cart-mfg/deck-calibration/barcode-positions"
			class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1.5 text-xs font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20 transition-colors">
			Teach barcode positions →
		</a>
	</div>

	<!-- Pickers -->
	<div class="flex flex-wrap items-end gap-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
		<div class="text-xs" style="color: var(--color-tron-text-secondary)">Labware
			<div class="mt-1 flex overflow-hidden rounded border border-[var(--color-tron-border)] text-[11px]">
				{#each [['deck', 'Deck', '1'], ['tube', 'Tube rack', '10'], ['tip', 'Tip rack', '11'], ['calibrator', 'Calibrator', '—']] as [k, lbl, sl] (k)}
					<button
						type="button"
						onclick={() => pickKind(k as 'deck' | 'tube' | 'tip' | 'calibrator')}
						class="px-2.5 py-1.5 transition-colors {kind === k ? 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)] hover:bg-white/5'}"
						title={sl === '—' ? 'Tip-calibrator fixture' : `Slot ${sl}`}
					>{lbl}</button>
				{/each}
			</div>
		</div>
		{#if kind !== 'calibrator'}
			<label class="text-xs" style="color: var(--color-tron-text-secondary)">{kind === 'tube' ? 'Tube rack' : kind === 'tip' ? 'Tip rack' : 'Deck'}
				<select value={data.selected} onchange={(e) => pickDeck(e.currentTarget.value)} class="mt-1 block rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 font-mono text-xs" style="color: var(--color-tron-text)">
					{#each labwareOptions as d (d.loadName)}<option value={d.loadName}>{d.loadName}</option>{/each}
				</select>
			</label>
		{/if}
		<label class="text-xs" style="color: var(--color-tron-text-secondary)">Robot
			<select bind:value={selectedRobotId} class="mt-1 block rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 text-xs" style="color: var(--color-tron-text)">
				{#each robots as r (r._id)}<option value={r._id}>{r.name}{r.isActive ? '' : ' (inactive)'}</option>{/each}
			</select>
		</label>
		{#if kind === 'calibrator'}
			<div class="text-xs" style="color: var(--color-tron-text-secondary)">Tip-calibrator fixture · slot-free</div>
		{:else}
			<div class="text-xs" style="color: var(--color-tron-text-secondary)">{wells.length} holes · {dim.x}×{dim.y} mm · slot {data.slot}</div>
		{/if}
	</div>

	{#if errMsg}<div class="rounded border border-red-500/40 bg-red-900/20 p-2 text-xs text-red-300">{errMsg}</div>{/if}
	{#if msg}<div class="rounded border border-green-500/30 bg-green-900/15 p-2 text-xs text-green-300">{msg}</div>{/if}

	<div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
		<!-- Canvas -->
		<section class="flex min-w-0 flex-col rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
				<div class="flex flex-wrap items-center gap-3">
					<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">{kind === 'deck' ? 'Deck' : kind === 'tube' ? 'Tube rack' : 'Tip rack'} — {selCount} selected</h2>
					{#if kind === 'deck'}
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
					{/if}
					<span class="font-mono text-[11px]" style="color: var(--color-tron-cyan)" title="Cursor position in deck mm; z is the nearest hole's calibrated height">
						{#if hover}x {hover.x.toFixed(2)}  y {hover.y.toFixed(2)}{#if hoverNearest}  ·  {hoverNearest.well.name} z {hoverNearest.well.z.toFixed(2)} ({hoverNearest.dist.toFixed(1)}mm){/if}{:else}<span style="color: var(--color-tron-text-secondary)">hover deck for coords</span>{/if}
					</span>
				</div>
				<div class="flex items-center gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
					<label>Zoom <input type="range" min="0.6" max="5" step="0.2" bind:value={zoom} /> {zoom.toFixed(1)}×</label>
					<button type="button" onclick={() => (zoom = 1)} class="rounded border border-[var(--color-tron-border)] px-2 py-1 hover:border-[var(--color-tron-cyan)]" style="color: var(--color-tron-text)">Fit</button>
					<button type="button" onclick={() => (showGrid = !showGrid)} class="rounded border px-2 py-1 {showGrid ? 'border-[var(--color-tron-cyan)]/60 text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)]'}" style={showGrid ? '' : 'color: var(--color-tron-text)'} title="Toggle the reference grid (0.25mm fine · 1mm · 10mm bold)">Grid{showGrid ? ' ✓' : ''}</button>
					<button type="button" onclick={selectAllActive} class="rounded border border-[var(--color-tron-border)] px-2 py-1 hover:border-[var(--color-tron-cyan)]" style="color: var(--color-tron-text)">Select all{roleFilter !== 'all' ? ` ${roleFilter}` : ''}</button>
					<button type="button" onclick={() => (deselectMode = !deselectMode)} class="rounded border px-2 py-1 {deselectMode ? 'border-amber-500/60 bg-amber-900/20 text-amber-300' : 'border-[var(--color-tron-border)] hover:border-[var(--color-tron-cyan)]'}" style={deselectMode ? '' : 'color: var(--color-tron-text)'} title="When on, box-drag/click removes holes from the selection">Deselect{deselectMode ? ' ✓' : ''}</button>
					<button type="button" onclick={deselectAll} title="Deselect everything (or press Esc anywhere)" class="rounded border border-[var(--color-tron-border)] px-2 py-1 hover:border-[var(--color-tron-cyan)]" style="color: var(--color-tron-text)">Clear (Esc)</button>
				</div>
			</div>
			<p class="mb-2 text-[11px]" style="color: var(--color-tron-text-secondary)">Drag a box to select a group (Shift adds). Click a hole to toggle. Wax holes are amber, reagent blue; the toggle restricts which you can select. Esc clears everything.</p>
			<!-- The canvas box grows to fill the section (2026-08-28) so the deck no
			     longer leaves dead space when the right rail is taller, and the
			     graphic sits centred in whatever room it has. `safe center` keeps
			     the top-left reachable if a zoomed deck overflows the box. -->
			<div class="flex-1 overflow-auto rounded border border-[var(--color-tron-border)] bg-black/40" style="max-height: 85vh; display: flex; align-items: safe center; justify-content: safe center;">
				{#if wells.length}
				<div style={`width:${zoom * 100}%; flex: 0 0 auto;`}>
					<svg
						bind:this={svgEl}
						width="100%"
						viewBox={`${-VIEW_PAD} ${-VIEW_PAD} ${dim.x + 2 * VIEW_PAD} ${dim.y + 2 * VIEW_PAD}`}
						preserveAspectRatio="xMidYMid meet"
						onpointerdown={onCanvasPointerDown}
						onpointermove={onCanvasPointerMove}
						onpointerup={onCanvasPointerUp}
						onpointerleave={() => (hover = null)}
						style="display:block; height:auto; touch-action:none; cursor: crosshair;"
					>
						<!-- Reference grid drawn behind the holes: 0.25mm fine, 1mm medium, 10mm
						     bold (nested SVG patterns — tiled, so cheap regardless of deck size). -->
						<defs>
							<pattern id="grid-025mm" width="0.25" height="0.25" patternUnits="userSpaceOnUse">
								<path d="M 0.25 0 L 0 0 0 0.25" fill="none" stroke="rgba(130,180,220,0.22)" stroke-width="0.02" />
							</pattern>
							<pattern id="grid-1mm" width="1" height="1" patternUnits="userSpaceOnUse">
								<rect width="1" height="1" fill="url(#grid-025mm)" />
								<path d="M 1 0 L 0 0 0 1" fill="none" stroke="rgba(130,180,220,0.40)" stroke-width="0.05" />
							</pattern>
							<pattern id="grid-10mm" width="10" height="10" patternUnits="userSpaceOnUse">
								<rect width="10" height="10" fill="url(#grid-1mm)" />
								<path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(130,180,220,0.55)" stroke-width="0.1" />
							</pattern>
						</defs>
						{#if showGrid}
							<rect x={-VIEW_PAD} y={-VIEW_PAD} width={dim.x + 2 * VIEW_PAD} height={dim.y + 2 * VIEW_PAD} fill="url(#grid-10mm)" />
						{/if}
						{#each wells as w (w.name)}
							{@const sel = selection.has(w.name)}
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
								stroke={sel ? 'var(--color-tron-cyan)' : 'none'}
								stroke-width="0.3"
								style={active ? '' : 'pointer-events:none;'}
								onpointerdown={(e) => { e.stopPropagation(); }}
								onclick={(e) => { e.stopPropagation(); toggleWell(w.name, e.shiftKey || e.ctrlKey || e.metaKey); }}
								role="button" tabindex="-1"
							><title>{w.name} ({role}) — x {w.x.toFixed(2)} y {w.y.toFixed(2)} z {w.z.toFixed(2)}</title></circle>
						{/each}
						{#if boxRect}
							<rect x={boxRect.x} y={boxRect.y} width={boxRect.w} height={boxRect.h} fill="rgba(0,255,255,0.12)" stroke="var(--color-tron-cyan)" stroke-width="0.4" />
						{/if}
					</svg>
				</div>
				{:else if kind === 'calibrator'}
					<div class="space-y-2 p-6 text-center text-xs" style="color: var(--color-tron-text-secondary)">
						<p>The tip calibrator is a fixed limit-switch fixture, not labware — there's no grid to teach.</p>
						<p>Open a run, pick up a tip, jog onto the calibrator, then <strong>Save calibrator position</strong> in the Tip panel. It saves per robot ({robot?.name ?? 'robot'}).</p>
						<p class="font-mono">{robot?.name ?? 'robot'}: {currentCalibrator ? `(${currentCalibrator.position.x}, ${currentCalibrator.position.y}, ${currentCalibrator.position.z})` : 'none saved'}</p>
					</div>
				{:else}
					<div class="p-6 text-center text-xs" style="color: var(--color-tron-text-secondary)">No wells — pick {kind === 'tube' ? 'a tube rack' : kind === 'tip' ? 'a tip rack' : 'a deck'}.</div>
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

				{#if runId && deckDirty}
					<div class="mt-2 flex items-center justify-between gap-2 rounded border border-amber-500/40 bg-amber-900/15 p-2 text-[11px] text-amber-200">
						<span>Deck edits aren't in the run's loaded copy yet — Move to hole will use the old positions.</span>
						<button type="button" onclick={reloadDeckIntoRun} disabled={busy || connecting} class="shrink-0 rounded border border-amber-400/60 bg-amber-900/30 px-2 py-1 font-bold text-amber-100 disabled:opacity-40">Reload deck</button>
					</div>
				{/if}

				<div class="mt-2 flex items-center gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
					<span>Pipette</span>
					<div class="flex overflow-hidden rounded border border-[var(--color-tron-border)]">
						{#each [['left', 'Left'], ['right', 'Right']] as [m, lbl] (m)}
							<button
								type="button"
								disabled={!!runId}
								onclick={() => { desiredMount = m as 'left' | 'right'; zAxis = m === 'right' ? 'rightZ' : 'leftZ'; }}
								class="px-2.5 py-1 transition-colors disabled:opacity-50 {desiredMount === m ? 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]' : 'hover:bg-white/5'}"
							>{lbl}</button>
						{/each}
					</div>
					{#if runId}<span class="text-[10px]">close run to switch</span>{/if}
				</div>

				<div class="mt-2 flex flex-wrap items-center gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
					<label>Step <select bind:value={stepSize} class="rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-0.5 font-mono text-xs" style="color: var(--color-tron-text)">
						<option value={0.1}>0.1</option><option value={0.5}>0.5</option><option value={1}>1</option><option value={5}>5</option><option value={10}>10</option><option value={25}>25</option>
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

				<!-- Tip calibration: tip type → one button. Teach controls behind a disclosure. -->
				<div class="mt-3 rounded border border-[var(--color-tron-border)] bg-black/20 p-2">
					<div class="mb-1 flex items-center justify-between text-[11px]" style="color: var(--color-tron-text-secondary)">
						<span class="font-bold uppercase tracking-wider">Tip</span>
						<span>{hasTip ? '🟢 tip on' : 'no tip'} · {tipProfile ? (tipProfile === 'wax' ? 'p20 rack' : 'p300 rack') : 'tip type not set'}{tipAdjust ? ` · zeroed (${tipAdjust.x}, ${tipAdjust.y})` : ''}</span>
					</div>
					<!--
						Tip type is chosen explicitly. It sets BOTH the tiprack definition and
						the calibration probe Z, neither of which can be read off the mount —
						the pipettes are not fixed to mounts on this fleet.
					-->
					<div class="mb-2">
						<div class="mb-1 text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Tip type on {desiredMount}</div>
						<div class="grid grid-cols-2 gap-2">
							{#each [['wax', 'p20 · wax'], ['reagent', 'p300 · reagent']] as [p, lbl] (p)}
								<button
									type="button"
									onclick={() => (tipProfile = p as 'wax' | 'reagent')}
									disabled={busy || hasTip}
									title={hasTip ? 'Drop the tip before changing tip type' : 'Sets the tiprack and the calibration probe Z'}
									class="rounded border px-2 py-1.5 text-[11px] transition-colors disabled:opacity-40 {tipProfile === p ? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)] hover:border-[var(--color-tron-cyan)]/60'}"
									style={tipProfile === p ? '' : 'color: var(--color-tron-text-secondary)'}>{lbl}</button>
							{/each}
						</div>
						{#if !tipProfile}
							<p class="mt-1 text-[10px] text-amber-300/90">Pick the tip type — probe depth differs by 6.309 mm and is never guessed.</p>
						{/if}
					</div>
					<!--
						ONE BUTTON is the whole everyday flow: pick up a tip of the SELECTED tip
						type, travel to the calibrator, then probe. Still hard-gated on tip type —
						the probe depth is never guessed — but no longer on hasTip, because picking
						the tip up is now a step of the sequence rather than a prerequisite.
						The plain "Pick up tip" below it is the same step WITHOUT the probe, for the
						flows that need a tip but no calibration (Fill motion, Move to hole →
						Capture). "Go to calibrator" stays in the teach disclosure, where it parks
						at the fixture to jog WITHOUT firing the 1-2 min probe.
					-->
					<button type="button" onclick={calibrateTip} disabled={busy || calibrating || !pipetteId || !tipProfile} class="mt-2 w-full rounded border border-purple-400/50 bg-purple-900/20 px-2 py-2 text-xs font-bold text-purple-200 hover:bg-purple-900/30 disabled:opacity-40" title="Picks up a tip of the selected type, travels to the tip calibrator, then runs the slow limit-switch probe. Keeps the tip on for deck tuning.">
						{calibrating
							? 'Calibrating tip…'
							: !tipProfile
								? 'Calibrate tip — pick a tip type first'
								: hasTip
									? 'Calibrate tip (probe, keeps tip)'
									: `Calibrate tip (picks up a ${tipProfile === 'reagent' ? 'p300' : 'p20'} tip first)`}
					</button>
					{#if tipProfile && !calibrating}
						<!-- Nothing about the auto-motion is hidden: say what the click will do. -->
						<p class="mt-1 text-[10px] leading-tight" style="color: var(--color-tron-text-secondary)">
							{#if !hasTip}
								Picks up <span class="font-mono">{tiprackForProfile} {tipWell}</span> from slot 11, moves to ({calX}, {calY}, {calZ}), then probes.
							{:else if atCalibratorNow()}
								Probes from the current jogged position &mdash; already within {CAL_AT_TOLERANCE_MM} mm of the calibrator, so it will not travel.
							{:else}
								Moves to ({calX}, {calY}, {calZ}), then probes.
							{/if}
						</p>
					{/if}
					<!--
						Secondary on purpose: thin, outlined, below the primary. It is a tip and
						nothing else — no travel, no probe. Guarded on tip type for the same reason
						"Calibrate tip" is (the rack, hence the tip length, follows the operator's
						explicit choice), but deliberately NOT on hasTip: that flag is this page's
						belief, and an operator recovering from a dropped or broken tip has to be
						able to pick another one up without reopening the run.
					-->
					<button type="button" onclick={pickUpTipAction} disabled={!pipetteId || busy || !tipProfile} class="mt-1 w-full rounded border border-[var(--color-tron-cyan)]/40 px-2 py-1.5 text-[11px] text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-40" title="Just picks up a tip of the selected type from slot 11 — no travel to the calibrator, no probe.">
						{hasTip ? 'Pick up tip (another one)' : 'Pick up tip (no probe)'}
					</button>
					{#if currentCalibrator?.inheritedFromGlobal}
						<!-- Provenance of the point the button above will probe at. Conditional and
						     rare, so it stays in the main view rather than hiding in the disclosure. -->
						<p class="mt-1 rounded border border-amber-400/40 bg-amber-900/15 px-1.5 py-1 text-[10px] leading-tight text-amber-200">
							{robot?.name ?? 'This robot'} has no fixture of its own and is using the shared <span class="font-mono">global</span> one. The first Save forks it off permanently &mdash; later edits to <span class="font-mono">global</span> will stop reaching it.
						</p>
					{/if}
					{#if tipAdjust}
						<button type="button" onclick={() => (tipAdjust = null)} class="mt-1 w-full rounded border border-[var(--color-tron-border)] px-2 py-1 text-[10px] hover:border-amber-400/60" style="color: var(--color-tron-text-secondary)">Clear tip adjust</button>
					{/if}

					<!--
						Teaching the fixture point is the rare path; probing at it is the daily one.
						So the coordinates, the two Z controls and the save/park buttons live behind
						a disclosure, closed by default. Nothing is hidden that the click depends on
						silently — the hint under the button always names the point it will drive to.
					-->
					<details class="mt-2 rounded border border-[var(--color-tron-border)] bg-black/20">
						<summary class="cursor-pointer select-none px-2 py-1 text-[10px] uppercase tracking-wider hover:text-[var(--color-tron-cyan)]" style="color: var(--color-tron-text-secondary)">Fixture point (teach)</summary>
						<div class="border-t border-[var(--color-tron-border)] p-2">
							<!--
								TWO Z heights on one fixture, and deliberately TWO controls (PRD CALIB-4
								section 5, decision 1). Approach Z is travel-only; Probe Z is the touch-off
								depth the limit-switch routine owns. Merging them would let a plain jog
								descend to touch-off depth with no probe protecting the tip.
							-->
							<div class="grid grid-cols-3 gap-1 text-[10px]" style="color: var(--color-tron-text-secondary)">
								<label>calX <input type="number" step="0.1" bind:value={calX} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-0.5 font-mono" style="color: var(--color-tron-text)" /></label>
								<label>calY <input type="number" step="0.1" bind:value={calY} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-0.5 font-mono" style="color: var(--color-tron-text)" /></label>
								<label title="Pre-probe travel height: where the tip parks before the probe runs. Never the touch-off depth.">Approach Z <input type="number" step="0.1" min={CAL_Z_MIN} max={CAL_Z_MAX} bind:value={calZ} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-0.5 font-mono" style="color: var(--color-tron-text)" /></label>
							</div>
							<p class="mt-1 text-[10px] leading-tight" style="color: var(--color-tron-text-secondary)">
								Approach Z is the pre-probe travel height only &mdash; both "Calibrate tip" and "Go to calibrator" park there. The probe never reads it.
							</p>

							<!-- Probe Z: the real touch-off depth, and the number production z_cal reads. -->
							<div class="mt-2 rounded border border-purple-400/30 bg-purple-900/10 p-1.5">
								<label class="block text-[10px]" style="color: var(--color-tron-text-secondary)">
									Probe Z &mdash; {tipProfile === 'reagent'
										? 'p300 · reagent-filling (zCalReagent)'
										: tipProfile === 'wax'
											? 'p20 · wax-filling (zCalWax)'
											: 'pick a tip type above'}
									<input
										type="number"
										step="0.1"
										min={CAL_Z_MIN}
										max={CAL_Z_MAX}
										disabled={!tipProfile}
										value={Number.isFinite(probeZ) ? probeZ : ''}
										oninput={(e) => setProbeZ(e.currentTarget.valueAsNumber)}
										class="mt-0.5 w-full rounded border border-purple-400/40 bg-black/30 px-1 py-0.5 font-mono disabled:opacity-40"
										style="color: var(--color-tron-text)" />
								</label>
								<p class="mt-1 text-[10px] leading-tight" style="color: var(--color-tron-text-secondary)">
									Touch-off depth the limit-switch probe descends to. "Calibrate tip" uses whatever is typed here immediately &mdash; no save needed &mdash; and Save writes it to production z_cal for this robot. Switching tip type swaps this field; the other process keeps its own value.
								</p>
							</div>
							<!--
								Park at the fixture WITHOUT probing. This is the teach loop's first step
								(park → jog → From live ↧ → Save); "Calibrate tip" would also travel here
								but then spend 1-2 minutes probing, which is not what teaching wants.
							-->
							<button type="button" onclick={goToCalibrator} disabled={!pipetteId || busy} class="mt-2 w-full rounded border border-[var(--color-tron-cyan)]/40 px-2 py-1.5 text-[11px] text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-40" title="Park at the approach point so you can jog onto the fixture — no probe">Go to calibrator (park, no probe)</button>
							<div class="mt-1 grid grid-cols-2 gap-2">
								<button type="button" onclick={captureCalibratorFromLive} disabled={busy || liveX === null} class="rounded border border-[var(--color-tron-border)] px-2 py-1.5 text-[11px] hover:border-[var(--color-tron-cyan)] disabled:opacity-40" style="color: var(--color-tron-text)" title="Copy the live jogged position into the X/Y/Z fields">From live ↧</button>
								<button type="button" onclick={saveCalibratorPosition} disabled={busy || !selectedRobotId} class="rounded border border-green-500/40 bg-green-900/15 px-2 py-1.5 text-[11px] font-semibold text-green-300 hover:bg-green-900/25 disabled:opacity-40">Save → {robot?.name ?? 'robot'}</button>
							</div>
						</div>
					</details>
				</div>

				<!-- Offset → selection lives in the rail (2026-08-28 swap): it is the
				     everyday capture→apply control and belongs beside Jog/Capture. -->
				<div class="mt-3 rounded border border-[var(--color-tron-border)] bg-black/20 p-2">
					<div class="mb-1 text-[11px] font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Offset → selection</div>
					<div class="mt-2 grid grid-cols-3 gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
						<label>dx <input type="number" step="0.01" bind:value={dx} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-1 font-mono" style="color: var(--color-tron-text)" /></label>
						<label>dy <input type="number" step="0.01" bind:value={dy} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-1 font-mono" style="color: var(--color-tron-text)" /></label>
						<label>dz <input type="number" step="0.01" bind:value={dz} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-1 font-mono" style="color: var(--color-tron-text)" /></label>
					</div>
					<button type="button" onclick={applyToSelection} disabled={busy || selCount === 0} class="mt-2 w-full rounded border border-green-500/50 bg-green-900/20 px-3 py-2 text-sm font-bold text-green-300 hover:bg-green-900/30 disabled:opacity-40">
						Apply to {selCount} selected hole{selCount === 1 ? '' : 's'}
					</button>
					<button type="button" onclick={applyGlobalShift} disabled={busy} class="mt-2 w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-2 text-xs font-semibold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20 disabled:opacity-40">
						⤧ Shift whole grid by this offset {roleFilter !== 'all' ? `(${roleFilter} only)` : ''}
					</button>
					<p class="mt-1 text-[10px]" style="color: var(--color-tron-text-secondary)">Anchor: jog to one hole (e.g. a corner) → Capture → <strong>Shift whole grid</strong> translates every hole of the active role by that offset.</p>
					<button type="button" onclick={undoLast} disabled={busy || undoStack.length === 0} class="mt-2 w-full rounded border border-amber-500/50 bg-amber-900/15 px-3 py-2 text-xs font-semibold text-amber-300 hover:bg-amber-900/25 disabled:opacity-40" title="Revert the last applied shift (offset, global, or set-position)">
						↶ Undo last {undoStack.length ? `(${undoStack.length})` : ''}
					</button>
				</div>
			</section>

			<!-- Offset + Apply -->
			<!-- Robot global offset panel DELETED 2026-08-28. The offset layer was
			     retired on 08-19 (calibration-rtps forces 0,0,0 and saveRobotOffset
			     refuses non-zero), so the panel could only ever write zeros while
			     advertising a deck-swapping workflow that does not work. Deck
			     geometry + the per-tip probe are the whole positional model. -->
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

	<!-- Hole-edit tools. Moved out of the right rail (2026-08-28) into a 3-up row
	     under the canvas: they were stacking into the tall empty gap beside the
	     deck graphic, and they all act on the CURRENT SELECTION, so they belong
	     with the grid rather than with the jog controls. -->
	<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
	<!-- Tour / Fill motion moved into the under-canvas row (2026-08-28 swap):
	     it drives the whole selection/deck and needs the width. -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
		<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Tour / Fill motion</h2>
		{#if touring}
			<div class="mb-1 text-center text-[11px]" style="color: var(--color-tron-cyan)">{tourIndex + 1} / {tourWells.length} — {tourWells[tourIndex]}</div>
			<div class="grid grid-cols-4 gap-1">
				<button type="button" onclick={tourPrev} disabled={busy || tourIndex === 0} class="rounded border border-[var(--color-tron-border)] py-1.5 text-xs hover:border-[var(--color-tron-cyan)] disabled:opacity-40" style="color: var(--color-tron-text)">‹ Prev</button>
				<button type="button" onclick={tourNext} disabled={busy || tourIndex >= tourWells.length - 1} class="rounded border border-[var(--color-tron-border)] py-1.5 text-xs hover:border-[var(--color-tron-cyan)] disabled:opacity-40" style="color: var(--color-tron-text)">Next ›</button>
				{#if tourPlaying}
					<button type="button" onclick={() => (tourPlaying = false)} class="rounded border border-amber-500/40 bg-amber-900/15 py-1.5 text-xs text-amber-300">Pause</button>
				{:else}
					<button type="button" onclick={tourPlay} disabled={busy || tourIndex >= tourWells.length - 1} class="rounded border border-[var(--color-tron-cyan)]/40 py-1.5 text-xs text-[var(--color-tron-cyan)] disabled:opacity-40">Play</button>
				{/if}
				<button type="button" onclick={tourStop} class="rounded border border-red-500/40 bg-red-900/15 py-1.5 text-xs text-red-300">Stop</button>
			</div>
		{:else if fillMotionRunning}
			{#if fillPaused}<div class="mb-1 text-center text-[11px] text-amber-300">Paused</div>{/if}
			<div class="grid grid-cols-2 gap-1">
				{#if fillPaused}
					<button type="button" onclick={resumeFillMotion} class="rounded border border-[var(--color-tron-cyan)]/40 py-2 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10">▶ Resume</button>
				{:else}
					<button type="button" onclick={pauseFillMotion} class="rounded border border-amber-500/40 bg-amber-900/15 py-2 text-xs text-amber-300">❚❚ Pause</button>
				{/if}
				<button type="button" onclick={stopFillMotion} class="rounded border border-red-500/40 bg-red-900/15 py-2 text-xs text-red-300">■ Stop</button>
			</div>
		{:else}
			<div class="grid grid-cols-2 gap-1">
				<button type="button" onclick={startTour} disabled={!pipetteId || busy} class="rounded border border-[var(--color-tron-cyan)]/40 px-2 py-2 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-40" title="Drive through every hole in order (whole deck)">
					Run through all {roleFilter === 'all' ? 'holes' : `${roleFilter} holes`}
				</button>
				<button type="button" onclick={runFillMotion} disabled={!pipetteId || busy || selCount === 0} class="rounded border border-[var(--color-tron-cyan)]/40 px-2 py-2 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-40" title="Drive the exact fill motion (jump 60mm → dispense +2mm → dwell → retract +5mm) at fill speed, for the selected hole(s) only">
					▶ Fill motion ({selCount} selected)
				</button>
			</div>
			<div class="mt-2 flex flex-wrap items-center gap-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
				<span class="opacity-70">Fill:</span>
				<label class="flex items-center gap-1"><input type="checkbox" bind:checked={fillMatchProtocol} /> Protocol speed</label>
				{#if !fillMatchProtocol}
					<label>Cap <input type="number" min="1" max="400" step="1" bind:value={fillSpeed} class="w-14 rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-0.5 font-mono" style="color: var(--color-tron-text)" /> mm/s</label>
				{/if}
				<label>Dwell <input type="number" min="0" max="5000" step="50" bind:value={fillDwellMs} class="w-16 rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-0.5 font-mono" style="color: var(--color-tron-text)" /> ms</label>
			</div>
			<p class="mt-1 text-[10px]" style="color: var(--color-tron-text-secondary)"><strong>Fill motion</strong> mimics a real fill at each selected hole (60mm jump → 2mm-above-top dispense → {fillDwellMs}ms dwell → 5mm retract){fillMatchProtocol ? ' at the protocol’s own full speed' : ` capped to ${fillSpeed} mm/s`}, in fill order — pick any hole(s) as the start.{hasTip ? '' : ' Pick up a tip first to match the real fill height.'}</p>
		{/if}
	</section>

	<!-- Set absolute position (selection, anchor-translate) -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
		<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Set position → selection</h2>
		<p class="mt-1 text-[10px]" style="color: var(--color-tron-text-secondary)">Type an EXACT x/y/z (deck mm) for the <strong>anchor</strong> hole — not a change. With several holes selected, the whole group translates by the same delta (relative spacing preserved). Prefilled with the anchor's current coords; edit and apply.</p>
		<div class="mt-1 text-[10px] font-mono" style="color: var(--color-tron-text-secondary)">
			{anchor ? `Anchor: ${anchor}${selCount > 1 ? ` (+${selCount - 1} more move with it)` : ''}` : 'Select one or more holes'}
		</div>
		<div class="mt-2 grid grid-cols-3 gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
			<label>x <input type="number" step="0.01" bind:value={setX} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-1 font-mono" style="color: var(--color-tron-text)" /></label>
			<label>y <input type="number" step="0.01" bind:value={setY} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-1 font-mono" style="color: var(--color-tron-text)" /></label>
			<label>z <input type="number" step="0.01" bind:value={setZ} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-1 font-mono" style="color: var(--color-tron-text)" /></label>
		</div>
		<button type="button" onclick={applyAbsolute} disabled={busy || selCount === 0} class="mt-2 w-full rounded border border-green-500/50 bg-green-900/20 px-3 py-2 text-sm font-bold text-green-300 hover:bg-green-900/30 disabled:opacity-40" title="Select one or more holes; the typed position sets the anchor and the group moves with it">
			{selCount === 0 ? 'Select one or more holes' : selCount === 1 ? `Set ${anchor} to this position` : `Move ${selCount} holes (anchor ${anchor})`}
		</button>
	</section>

	<!-- Align selection to the anchor hole (straighten every line) -->
	<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
		<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Align selection → anchor hole</h2>
		<p class="mt-1 text-[10px]" style="color: var(--color-tron-text-secondary)">Fixes lines that are shifted relative to each other within a cartridge. Jog-verify ONE good hole, select the whole cartridge (box-drag), and click the good hole <strong>last</strong> so it's the anchor. Every selected {anchor ? roleOf(anchor) : ''} hole snaps onto a clean grid ruled by the anchor's row and line: X from the anchor's row, Y from the anchor's line. Z untouched. {anchor ? `${roleOf(anchor) === 'wax' ? 'Reagent' : 'Wax'} holes are staggered by design — align them separately with a ${roleOf(anchor) === 'wax' ? 'reagent' : 'wax'} anchor.` : ''}</p>
		<div class="mt-1 text-[10px] font-mono" style="color: var(--color-tron-text-secondary)">
			{anchor && selCount >= 2 ? `Anchor: ${anchor} (${roleOf(anchor)}) — ${selCount - 1} other hole(s) selected` : 'Select the cartridge, click the trusted hole last'}
		</div>
		<button type="button" onclick={alignSelectionToAnchor} disabled={busy || selCount < 2} class="mt-2 w-full rounded border border-cyan-500/50 bg-cyan-900/20 px-3 py-2 text-sm font-bold text-cyan-300 hover:bg-cyan-900/30 disabled:opacity-40" title="Straighten every line in the selection to the anchor hole's row + line (same hole type only; Z untouched)">
			{selCount < 2 ? 'Select the cartridge + an anchor hole' : `⌗ Align ${selCount - 1} hole(s) to ${anchor}`}
		</button>
	</section>
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
