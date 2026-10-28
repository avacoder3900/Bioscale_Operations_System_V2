<script lang="ts">
	/**
	 * Stage Calibration Studio — the robot-arm line's own calibration studio.
	 *
	 * Organised exactly like the Deck Calibration Studio (deck-calibration/
	 * +page.svelte) — pickers · 2D plane with grid, click / box selection and an
	 * anchor hole · Jog with Move to hole + Capture offset · Tip calibration with
	 * the fixture teach · Offset → selection with Apply / Shift whole grid / Undo
	 * · Tour / Fill motion · Set position → selection · Align selection → anchor ·
	 * Recent edits — but for ONE Gen7 cartridge on an elevated single-cart stage
	 * instead of a 24-slot deck, so:
	 *
	 *   • the "labware" is the cartridge: 12 wax holes laid out rigidly from the
	 *     taught FIRST hole (row 1, gate 4) + the cart's rotation, each with its
	 *     own correction (hole offsets) — what Apply / Set position / Align edit;
	 *   • there is no deck definition and nothing to upload: every value is sent
	 *     to the stage protocol as run-time parameters at each run start;
	 *   • the stage has its own Z frame, so the DISPENSE DEPTH (how far into the
	 *     hole the tip end goes when wax is dispensed) is taught here too.
	 *
	 * Tip frames, as in the Studio: the first hole is taught with a PROBED tip
	 * and stored tip-neutral (live − that tip's calibrator adjust); every move-to
	 * applies the current tip's adjust; the scan position is taught with NO tip.
	 */
	import { onDestroy } from 'svelte';
	import { deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { RobotSession, type RobotSessionState } from '$lib/opentrons/direct-client';
	import TransportPill from '$lib/components/opentrons/TransportPill.svelte';
	import type { CalibrationView } from '$lib/server/arm-wax-fill';
	import {
		DISPENSE_DEPTH_DEFAULT_MM,
		DISPENSE_DEPTH_LIMITS,
		HOLE_OFFSET_LIMIT_MM,
		STAGE_JUMP_LIMITS,
		STAGE_PREJUMP_MM,
		STAGE_ROTATION_DEFAULT_DEG,
		WAX_HOLE_DEPTH_MM,
		WAX_HOLE_DIAMETER_MM,
		depthFromLive,
		dispenseZ,
		stageTargets,
		type StageHole
	} from '$lib/robot-arm/stage-geometry';

	let { data, form } = $props();

	const WAX_FILL_HREF = '/manufacturing/cart-mfg/robot-arm/wax-fill';
	const robotId = $derived(data.robotId as string | null);
	const robotName = $derived((data.robotName as string | null) ?? 'robot');

	// ── the cartridge on the stage ───────────────────────────────────────────
	let calibration = $state<CalibrationView | null>(data.calibration);
	$effect(() => {
		calibration = data.calibration;
	});
	const rim = $derived(calibration?.cartLocation ?? null);
	const taught = $derived(!!calibration?.holes);
	// Untaught: draw the lattice at the origin so the plane still shows the cart's shape.
	const rotation = $derived(calibration?.stageRotationDeg ?? STAGE_ROTATION_DEFAULT_DEG);
	const wells = $derived<StageHole[]>(calibration?.holes ?? stageTargets(0, 0, 0, rotation));
	// Orientation arrows on the plane: the gate direction (gate 4 → 1) and the row
	// direction (row 1 → 3) of the lattice as it sits on the deck at this rotation.
	const gateDir = $derived.by(() => {
		const a = wells[0], b = wells[3];
		return { x: b.rigid.x - a.rigid.x, y: b.rigid.y - a.rigid.y };
	});
	const rowDir = $derived.by(() => {
		const a = wells[0], b = wells[8];
		return { x: b.rigid.x - a.rigid.x, y: b.rigid.y - a.rigid.y };
	});
	const facing = $derived.by(() => {
		const d = gateDir;
		const ax = Math.abs(d.x), ay = Math.abs(d.y);
		if (ay >= ax) return d.y < 0 ? 'gates run toward you (front); gate 4 at the back' : 'gates run away from you (back); gate 4 nearest you';
		return d.x < 0 ? 'gates run right → left; gate 4 on the right' : 'gates run left → right; gate 4 on the left';
	});
	const wellByName = $derived(new Map(wells.map((w) => [w.name, w] as const)));
	const depthMm = $derived(calibration?.dispenseDepth?.mm ?? null);
	const jumpMm = $derived(calibration?.stageJumpHeightMm ?? 60);

	// ── Selection (as the Studio) ────────────────────────────────────────────
	let selection = $state<Set<string>>(new Set());
	const selCount = $derived(selection.size);
	let anchorWell = $state<string | null>(null);
	const anchor = $derived.by(() => {
		if (anchorWell && selection.has(anchorWell)) return anchorWell;
		return wells.find((w) => selection.has(w.name))?.name ?? null;
	});
	let deselectMode = $state(false);
	function toggleWell(name: string, additive: boolean) {
		if (deselectMode) {
			const next = new Set(selection);
			next.delete(name);
			selection = next;
			return;
		}
		const next = new Set(additive ? selection : []);
		if (selection.has(name) && additive) next.delete(name);
		else {
			next.add(name);
			anchorWell = name;
		}
		if (!additive && selection.has(name) && selection.size === 1) next.clear();
		selection = next;
	}
	function clearSelection() {
		selection = new Set();
	}
	function selectAll() {
		selection = new Set(wells.map((w) => w.name));
	}
	function deselectAll() {
		selection = new Set();
		refWell = null;
		nominal = null;
		deselectMode = false;
		boxing = false;
		boxStart = null;
		boxNow = null;
	}
	function onWindowKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') deselectAll();
	}

	// ── Canvas geometry (viewBox = deck mm around the cart; y flipped) ──────
	let zoom = $state(1);
	let showGrid = $state(true);
	let showRigid = $state(true);
	const wellR = WAX_HOLE_DIAMETER_MM / 2; // real bore — the cart is small enough to draw to scale
	const VIEW_PAD = 6;
	const bounds = $derived.by(() => {
		const xs = wells.flatMap((w) => [w.x, w.rigid.x, w.reagent.x]);
		const ys = wells.flatMap((w) => [w.y, w.rigid.y, w.reagent.y]);
		return { x0: Math.min(...xs) - VIEW_PAD, x1: Math.max(...xs) + VIEW_PAD, y0: Math.min(...ys) - VIEW_PAD, y1: Math.max(...ys) + VIEW_PAD };
	});
	function cy(y: number): number {
		return bounds.y1 - y;
	}
	let svgEl = $state<SVGSVGElement | null>(null);
	let boxing = $state(false);
	let boxStart = $state<{ x: number; y: number } | null>(null);
	let boxNow = $state<{ x: number; y: number } | null>(null);
	function toDeck(e: PointerEvent): { x: number; y: number } | null {
		if (!svgEl) return null;
		const pt = svgEl.createSVGPoint();
		pt.x = e.clientX;
		pt.y = e.clientY;
		const ctm = svgEl.getScreenCTM();
		if (!ctm) return null;
		const loc = pt.matrixTransform(ctm.inverse());
		return { x: loc.x, y: bounds.y1 - loc.y };
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
	let hover = $state<{ x: number; y: number } | null>(null);
	const hoverNearest = $derived.by(() => {
		if (!hover || !wells.length) return null;
		let best: StageHole | null = null,
			bestD = Infinity;
		for (const w of wells) {
			const ddx = w.x - hover.x,
				ddy = w.y - hover.y,
				d = ddx * ddx + ddy * ddy;
			if (d < bestD) {
				bestD = d;
				best = w;
			}
		}
		return best ? { well: best, dist: Math.sqrt(bestD) } : null;
	});
	function onCanvasPointerMove(e: PointerEvent) {
		hover = toDeck(e);
		if (boxing) boxNow = hover;
	}
	function onCanvasPointerUp(e: PointerEvent) {
		if (!boxing || !boxStart || !boxNow) {
			boxing = false;
			return;
		}
		const x0 = Math.min(boxStart.x, boxNow.x),
			x1 = Math.max(boxStart.x, boxNow.x);
		const y0 = Math.min(boxStart.y, boxNow.y),
			y1 = Math.max(boxStart.y, boxNow.y);
		const moved = Math.abs(x1 - x0) > 0.5 || Math.abs(y1 - y0) > 0.5;
		if (moved) {
			const hits = wells.filter((w) => w.x >= x0 && w.x <= x1 && w.y >= y0 && w.y <= y1).map((w) => w.name);
			if (deselectMode) {
				const next = new Set(selection);
				for (const h of hits) next.delete(h);
				selection = next;
			} else {
				const next = e.shiftKey ? new Set(selection) : new Set<string>();
				for (const h of hits) next.add(h);
				selection = next;
			}
		}
		boxing = false;
		boxStart = null;
		boxNow = null;
	}
	const boxRect = $derived.by(() => {
		if (!boxing || !boxStart || !boxNow) return null;
		const x = Math.min(boxStart.x, boxNow.x);
		const yTop = Math.max(boxStart.y, boxNow.y);
		return { x, y: cy(yTop), w: Math.abs(boxNow.x - boxStart.x), h: Math.abs(boxNow.y - boxStart.y) };
	});

	// ── Captured / manual offset, set-position, undo (as the Studio) ─────────
	let dx = $state(0),
		dy = $state(0),
		dz = $state(0);
	let setX = $state(0),
		setY = $state(0),
		setZ = $state(0);
	$effect(() => {
		if (anchor) {
			const w = wellByName.get(anchor);
			if (w) {
				setX = +w.x.toFixed(3);
				setY = +w.y.toFixed(3);
				setZ = +w.z.toFixed(3);
			}
		}
	});
	type Vec3 = { x: number; y: number; z: number };
	type Edit = { wellName: string; delta: Vec3 };
	let undoStack = $state<{ edits: Edit[]; label: string }[]>([]);
	// nominal carries the tip state it was read in (the critical point drops by the
	// tip length when a tip goes on), so a capture across a tip change is refused.
	let nominal = $state<{ x: number; y: number; z: number; hasTip: boolean } | null>(null);
	let refWell = $state<string | null>(null);
	const APPROACH_Z_MM = 2; // "Move to hole" parks the tip end this far above the rim

	// ── Messages / actions ───────────────────────────────────────────────────
	let msg = $state<string | null>(null);
	let errMsg = $state<string | null>(null);
	let busy = $state(false);
	function clearMsg() {
		msg = null;
		errMsg = null;
	}
	async function postAction(action: string, fields: Record<string, string>) {
		clearMsg();
		busy = true;
		try {
			const fd = new FormData();
			for (const [k, v] of Object.entries(fields)) fd.set(k, v);
			const res = await fetch(`?/${action}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
			const result = deserialize(await res.text());
			if (result.type === 'failure') {
				errMsg = (result.data as any)?.error ?? 'Action failed';
				return null;
			}
			if (result.type === 'error') {
				errMsg = result.error?.message ?? 'Action failed';
				return null;
			}
			const out = (result as any).data ?? {};
			if (out.calibration) calibration = out.calibration;
			await invalidateAll();
			return out;
		} catch (e) {
			errMsg = e instanceof Error ? e.message : 'Request failed';
			return null;
		} finally {
			busy = false;
		}
	}

	// Core apply: each hole by its own delta (the server translates the whole cart
	// when every hole gets the same delta). Recorded for undo unless this IS an undo.
	async function applyEdits(edits: Edit[], label: string, record = true) {
		const r = await postAction('applyPerWell', {
			edits: JSON.stringify(edits.map((e) => ({ wellName: e.wellName, dx: e.delta.x, dy: e.delta.y, dz: e.delta.z }))),
			label
		});
		if (r && record) undoStack = [...undoStack, { edits, label }];
		return r;
	}
	function applyMsg(verb: string, r: any): string {
		const rej = r.failed?.length ? ` ⚠ ${r.failed.length} skipped (${r.failed.map((f: any) => `${f.wellName}: ${f.reason}`).join('; ')}).` : '';
		const how = r.mode === 'translate' ? ' (whole cart moved — the first hole was re-taught)' : '';
		return `${verb} to ${r.applied} hole(s)${how} — saved to BIMS.${rej} Live for "Move to hole" now; the next fill reads it at start.`;
	}
	async function applyToSelection() {
		if (selection.size === 0) {
			errMsg = 'Select at least one hole';
			return;
		}
		if (dx === 0 && dy === 0 && dz === 0) {
			errMsg = 'Capture or enter a non-zero offset';
			return;
		}
		const r = await applyEdits([...selection].map((wellName) => ({ wellName, delta: { x: dx, y: dy, z: dz } })), `offset (${dx}, ${dy}, ${dz})`);
		if (r) {
			msg = applyMsg('Applied', r);
			clearSelection();
		}
	}
	async function applyGlobalShift() {
		if (dx === 0 && dy === 0 && dz === 0) {
			errMsg = 'Capture (or type) a non-zero offset first';
			return;
		}
		if (!confirm(`Shift the whole cart (all 12 holes) by dx=${dx} dy=${dy} dz=${dz}? This moves the taught first hole; per-hole corrections stay.`)) return;
		const r = await applyEdits(wells.map((w) => ({ wellName: w.name, delta: { x: dx, y: dy, z: dz } })), `shift whole cart (${dx}, ${dy}, ${dz})`);
		if (r) {
			msg = applyMsg('Whole cart shifted', r);
			clearSelection();
		}
	}
	async function applyAbsolute() {
		if (selection.size === 0) {
			errMsg = 'Select one or more holes — the typed position sets the anchor; the group moves with it';
			return;
		}
		const a = anchor ? wellByName.get(anchor) : null;
		if (!a) {
			errMsg = 'Anchor hole not found';
			return;
		}
		const d = { x: +(setX - a.x).toFixed(3), y: +(setY - a.y).toFixed(3), z: +(setZ - a.z).toFixed(3) };
		if (d.x === 0 && d.y === 0 && d.z === 0) {
			errMsg = 'Position equals current — nothing to change';
			return;
		}
		const names = [...selection];
		const r = await applyEdits(
			names.map((wellName) => ({ wellName, delta: d })),
			`set ${anchor} → (${setX}, ${setY}, ${setZ})${names.length > 1 ? ` + ${names.length - 1} more` : ''}`
		);
		if (r) msg = names.length === 1 ? `Set ${anchor} to (${setX}, ${setY}, ${setZ}) — saved to BIMS.` : applyMsg(`Set anchor ${anchor} → (${setX}, ${setY}, ${setZ}); moved`, r);
	}
	// Align: every other selected hole snaps back onto the rigid lattice, carrying
	// the anchor's correction — the stage's "clean grid ruled by the anchor".
	async function alignSelectionToAnchor() {
		if (selection.size < 2) {
			errMsg = 'Select the holes to align — at least 2, anchor included';
			return;
		}
		const a = anchor ? wellByName.get(anchor) : null;
		if (!a) {
			errMsg = 'Click the trusted (jog-verified) hole last — it becomes the anchor';
			return;
		}
		const edits: Edit[] = [];
		let already = 0;
		for (const name of selection) {
			if (name === a.name) continue;
			const w = wellByName.get(name);
			if (!w) continue;
			const d = { x: +(a.offset.dx - w.offset.dx).toFixed(3), y: +(a.offset.dy - w.offset.dy).toFixed(3), z: 0 };
			if (d.x === 0 && d.y === 0) {
				already++;
				continue;
			}
			edits.push({ wellName: name, delta: d });
		}
		if (!edits.length) {
			msg = `Nothing to move — the selection already sits on the lattice ruled by ${a.name}.`;
			return;
		}
		if (!confirm(`Align ${edits.length} hole(s) to anchor ${a.name}?\nEach snaps onto the cartridge's rigid 6 × 9 mm lattice carrying ${a.name}'s correction (${a.offset.dx}, ${a.offset.dy}). Z is untouched.${already ? `\n(${already} already aligned.)` : ''}\nUndo reverts the whole alignment.`)) return;
		const r = await applyEdits(edits, `align ${edits.length} to ${a.name}`);
		if (r) {
			msg = applyMsg(`Aligned to ${a.name}`, r);
			clearSelection();
		}
	}
	async function undoLast() {
		const last = undoStack[undoStack.length - 1];
		if (!last) {
			errMsg = 'Nothing to undo';
			return;
		}
		const r = await applyEdits(
			last.edits.map((e) => ({ wellName: e.wellName, delta: { x: -e.delta.x, y: -e.delta.y, z: -e.delta.z } })),
			'',
			false
		);
		if (r) {
			undoStack = undoStack.slice(0, -1);
			msg = `Undid ${last.label} on ${r.applied} hole(s).`;
		}
	}

	// ── Robot session + maintenance run ──────────────────────────────────────
	let robotSession: RobotSession | null = null;
	let robotConn = $state<RobotSessionState | null>(null);
	$effect(() => {
		const id = robotId;
		if (!id) return;
		const s = new RobotSession(id);
		robotSession = s;
		s.subscribe((st) => (robotConn = st));
		void s.open();
		return () => {
			s.close();
			robotSession = null;
		};
	});
	let runId = $state<string | null>(null);
	let pipetteId = $state<string | null>(null);
	let pipetteMount = $state<string | null>(null);
	let pipetteName = $state<string | null>(null);
	// The stage protocol fills with the p20 on the RIGHT mount, so the studio probes with that pipette.
	let desiredMount = $state<'left' | 'right'>(data.calibration?.pipetteMount === 'left' ? 'left' : 'right');
	// The run loaded something other than a p20 (a p300 on the other mount, say). A 20 µL tip
	// pressed by it looks picked up but the robot refuses to model it (KeyError PipetteTipType.t20),
	// and every probe / teach after that would be in the wrong tip frame — so tip work is blocked.
	const wrongPipette = $derived(!!pipetteName && !/^p20/i.test(pipetteName));
	let connecting = $state(false);
	let stepSize = $state(1);
	let zAxis = $state<'leftZ' | 'rightZ'>(data.calibration?.pipetteMount === 'right' ? 'rightZ' : 'leftZ');
	let liveX = $state<number | null>(null);
	let liveY = $state<number | null>(null);
	let liveZ = $state<number | null>(null);
	const locked = $derived(!!data.loopRunning);
	// Arc height for travel over the raised stage (the planner only knows the labware on the deck).
	const TEACH_ARC_Z = 120;

	async function apiRaw(path: string, init?: RequestInit): Promise<{ status: number; ok: boolean; body: any }> {
		const doFetch = robotSession ? robotSession.fetchRoute.bind(robotSession) : fetch;
		const res = await doFetch(path, { ...init, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
		const text = await res.text();
		let body: any = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = text;
		}
		return { status: res.status, ok: res.ok, body };
	}
	async function api(path: string, init?: RequestInit): Promise<any> {
		const { status, ok, body } = await apiRaw(path, init);
		if (!ok) throw new Error(`${init?.method ?? 'GET'} ${path} → HTTP ${status}: ${body?.message ?? (typeof body === 'string' ? body : JSON.stringify(body))}`);
		return body;
	}
	const mx = (tail: string) => `/api/opentrons-lab/robots/${robotId}/maintenance/${runId}/${tail}`;

	async function startMaintenance() {
		clearMsg();
		connecting = true;
		try {
			const res = await api(`/api/opentrons-lab/robots/${robotId}/maintenance`, { method: 'POST', body: JSON.stringify({ mount: desiredMount }) });
			runId = res.runId ?? null;
			pipetteId = res.pipetteId ?? null;
			pipetteMount = res.mount ?? null;
			pipetteName = res.pipetteName ?? null;
			zAxis = pipetteMount === 'right' ? 'rightZ' : 'leftZ';
			msg = pipetteId ? `Run open: ${pipetteName} on ${pipetteMount}.` : 'Run opened but no pipette could be loaded — jog will fail.';
			if (pipetteId && pipetteName && !/^p20/i.test(pipetteName)) {
				msg = `Run open: ${pipetteName} on ${pipetteMount} — not a p20. The 20 µL wax tips only model on a p20 (anything else answers KeyError PipetteTipType.t20 and the robot never sees the tip). If the p20 is on the other mount, close the run and open it there; the fill follows the mount the stage is taught with.`;
			}
		} catch (e) {
			errMsg = e instanceof Error ? e.message : String(e);
		} finally {
			connecting = false;
		}
	}
	async function stopMaintenance() {
		if (!runId) return;
		busy = true;
		try {
			if (hasTip && pipetteId) await api(mx('drop-tip'), { method: 'POST', body: JSON.stringify({ pipetteId }) }).catch(() => null);
			await api(`/api/opentrons-lab/robots/${robotId}/maintenance/${runId}`, { method: 'DELETE' });
		} catch (e) {
			errMsg = e instanceof Error ? e.message : String(e);
		} finally {
			runId = pipetteId = pipetteMount = pipetteName = null;
			liveX = liveY = liveZ = null;
			hasTip = false;
			tipAdjust = null;
			nominal = null;
			refWell = null;
			busy = false;
		}
	}
	onDestroy(() => {
		if (runId) {
			try {
				fetch(`/api/opentrons-lab/robots/${robotId}/maintenance/${runId}`, { method: 'DELETE', credentials: 'same-origin', keepalive: true });
			} catch {
				/* best-effort */
			}
		}
	});
	async function refreshPosition() {
		if (!runId || !pipetteId) return;
		try {
			const res = await api(mx('position'), { method: 'POST', body: JSON.stringify({ pipetteId }) });
			if (res?.position) {
				liveX = res.position.x;
				liveY = res.position.y;
				liveZ = res.position.z;
			}
		} catch (e) {
			errMsg = `Position read failed: ${e instanceof Error ? e.message : String(e)}`;
		}
	}
	async function act(fn: () => Promise<void>) {
		if (!runId || !pipetteId) {
			errMsg = 'Open a maintenance run first';
			return;
		}
		if (locked) {
			errMsg = 'A wax-fill loop is running on this robot — calibration waits until it ends.';
			return;
		}
		clearMsg();
		busy = true;
		try {
			await fn();
		} catch (e) {
			errMsg = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}
	const homeRobot = () =>
		act(async () => {
			await api(mx('home'), { method: 'POST', body: JSON.stringify({}) });
			await refreshPosition();
		});
	const jogAxis = (axis: string, distance: number) =>
		act(async () => {
			await api(mx('jog'), { method: 'POST', body: JSON.stringify({ pipetteId, axis, distance }) });
			await refreshPosition();
		});
	async function moveAbs(p: { x: number; y: number; z: number }, o: { arc?: boolean; direct?: boolean; speed?: number } = {}) {
		await api(mx('move-to'), {
			method: 'POST',
			body: JSON.stringify({
				pipetteId,
				x: p.x,
				y: p.y,
				z: p.z,
				...(o.speed ? { speed: o.speed } : {}),
				...(o.arc ? { minimumZHeight: TEACH_ARC_Z, forceDirect: false } : {}),
				...(o.direct ? { forceDirect: true } : {})
			})
		});
	}
	const adj = () => ({ x: tipAdjust?.x ?? 0, y: tipAdjust?.y ?? 0 });

	/** To a hole's tip-neutral rim + this tip's adjust, APPROACH_Z_MM above it, via a high arc (the fill's frame). */
	async function moveToWellSafe(name: string) {
		if (!taught) throw new Error('Teach the first hole first — the holes are laid out from it.');
		const w = wellByName.get(name);
		if (!w) throw new Error(`Unknown hole ${name}`);
		const a = adj();
		await moveAbs({ x: w.x + a.x, y: w.y + a.y, z: w.z + APPROACH_Z_MM }, { arc: true });
	}
	const moveToSelectedHole = () =>
		act(async () => {
			if (selection.size !== 1) throw new Error('Select exactly one reference hole to move to');
			const name = [...selection][0];
			await moveToWellSafe(name);
			await refreshPosition();
			nominal = liveX !== null ? { x: liveX!, y: liveY!, z: liveZ!, hasTip } : null;
			refWell = name;
			msg = `At nominal of ${name}${hasTip ? (tipAdjust ? ' (tip on, probed)' : ' (tip on, NOT probed — capture will carry this tip\'s bend)') : ' (no tip)'}. Jog onto the real hole, then Capture.`;
		});
	const captureOffset = () =>
		act(async () => {
			if (!nominal) throw new Error('Move to a hole first to set the nominal reference');
			if (nominal.hasTip !== hasTip) {
				const was = nominal.hasTip ? 'tip was on' : 'no tip';
				nominal = null;
				refWell = null;
				throw new Error(`Tip state changed since "Move to hole" (${was}, now ${hasTip ? 'tip on' : 'no tip'}). Move to the hole again so nominal + capture share one frame, then Capture.`);
			}
			await refreshPosition();
			if (liveX === null || liveY === null || liveZ === null) throw new Error('Could not read position');
			dx = +(liveX - nominal.x).toFixed(3);
			dy = +(liveY - nominal.y).toFixed(3);
			// Nominal was parked APPROACH_Z_MM above the rim: add it back so dz is the true rim delta.
			dz = +(liveZ - nominal.z + APPROACH_Z_MM).toFixed(3);
			msg = `Captured offset from ${refWell}: dx=${dx} dy=${dy} dz=${dz}. Select the holes to apply it to.`;
		});

	// ── Tour / Fill motion (as the Studio; the stage protocol's heights) ───────
	let touring = $state(false);
	let tourIndex = $state(0);
	let tourWells = $state<string[]>([]);
	let tourPlaying = $state(false);
	function fillOrder(names: string[]): string[] {
		return names.slice().sort((a, b) => (wellByName.get(a)?.index ?? 0) - (wellByName.get(b)?.index ?? 0));
	}
	async function tourGoTo(i: number) {
		if (i < 0 || i >= tourWells.length) return;
		await act(async () => {
			const name = tourWells[i];
			await moveToWellSafe(name);
			tourIndex = i;
			selection = new Set([name]);
			refWell = name;
			msg = `Tour: ${i + 1}/${tourWells.length} — ${name}`;
		});
	}
	async function startTour() {
		if (!runId || !pipetteId) {
			errMsg = 'Open a maintenance run first';
			return;
		}
		tourWells = fillOrder(wells.map((w) => w.name));
		touring = true;
		await tourGoTo(0);
	}
	async function tourNext() {
		if (tourIndex < tourWells.length - 1) await tourGoTo(tourIndex + 1);
	}
	async function tourPrev() {
		if (tourIndex > 0) await tourGoTo(tourIndex - 1);
	}
	function tourStop() {
		touring = false;
		tourPlaying = false;
	}
	async function tourPlay() {
		tourPlaying = true;
		while (tourPlaying && tourIndex < tourWells.length - 1) {
			await tourGoTo(tourIndex + 1);
			if (!tourPlaying || errMsg) break;
			await new Promise((r) => setTimeout(r, 500));
		}
		tourPlaying = false;
	}
	let fillMatchProtocol = $state(true);
	let fillSpeed = $state(20);
	let fillDwellMs = $state(1000);
	let fillMotionRunning = $state(false);
	let fillPaused = $state(false);
	let fillStop = false;
	async function fillWaitIfPaused() {
		while (fillPaused && !fillStop) await new Promise((r) => setTimeout(r, 150));
	}
	async function fillMoveAbs(name: string, aboveRimMm: number, o: { forceDirect: boolean; arc?: boolean }) {
		const w = wellByName.get(name);
		if (!w) throw new Error(`Unknown hole ${name}`);
		const a = adj();
		await moveAbs({ x: w.x + a.x, y: w.y + a.y, z: w.z + aboveRimMm }, { arc: !!o.arc, direct: o.forceDirect, ...(fillMatchProtocol ? {} : { speed: fillSpeed }) });
	}
	async function runFillMotion() {
		if (!runId || !pipetteId) {
			errMsg = 'Open a maintenance run first';
			return;
		}
		if (!taught) {
			errMsg = 'Teach the first hole first';
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
		const dispenseAbove = -(depthMm ?? DISPENSE_DEPTH_DEFAULT_MM);
		try {
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
				await fillMoveAbs(name, jumpMm, { forceDirect: false, arc: true }); // travel height
				await fillMoveAbs(name, STAGE_PREJUMP_MM, { forceDirect: true }); // pre-jump
				await fillWaitIfPaused();
				if (fillStop) break;
				await fillMoveAbs(name, dispenseAbove, { forceDirect: true }); // dispense height
				await refreshPosition();
				await new Promise((r) => setTimeout(r, Math.max(0, fillDwellMs)));
				await fillWaitIfPaused();
				if (fillStop) break;
				await fillMoveAbs(name, STAGE_PREJUMP_MM, { forceDirect: true }); // retract
				await fillMoveAbs(name, jumpMm, { forceDirect: true }); // back to travel height
			}
			if (!fillStop) msg = `Fill motion complete — ${chosen.length} hole(s)${depthMm === null ? ' at the protocol\'s default depth (teach the dispense depth below)' : ''}`;
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

	// ── Tip: pick up, probe on the calibrator, swap, drop; fixture teach ─────
	let hasTip = $state(false);
	let tipAdjust = $state<{ x: number; y: number } | null>(null);
	let calibrating = $state(false);
	let tipWell = $state<string>(data.teach?.nextTipWell ?? 'A1');
	const tiprack = $derived(data.teach?.tiprackLoadName ?? 'cosmasanddamian_96_tiprack_20ul');
	const CAL_Z_MIN = 5,
		CAL_Z_MAX = 200;
	const CAL_AT_TOLERANCE_MM = 3;
	let calX = $state(data.teach?.calibrator?.x ?? 125.181);
	let calY = $state(data.teach?.calibrator?.y ?? 173.247);
	let calZ = $state(data.teach?.calibrator?.approachZ ?? 38.5);
	let probeZ = $state(data.teach?.calibrator?.probeZ ?? 34.491);
	let maxAdjust = $state<number | ''>(data.teach?.calibrator?.maxTipAdjust ?? '');
	$effect(() => {
		const c = data.teach?.calibrator;
		if (c) {
			calX = c.x;
			calY = c.y;
			calZ = c.approachZ;
			probeZ = c.probeZ;
			maxAdjust = c.maxTipAdjust ?? '';
		}
	});
	function atCalibratorNow(): boolean {
		return liveX !== null && liveY !== null && Math.hypot(liveX - calX, liveY - calY) <= CAL_AT_TOLERANCE_MM;
	}
	function checkedZ(v: number, label: string): number | null {
		if (!Number.isFinite(v) || v < CAL_Z_MIN || v > CAL_Z_MAX) {
			errMsg = `${label} must be a number between ${CAL_Z_MIN} and ${CAL_Z_MAX} mm (got ${Number.isFinite(v) ? v : 'blank'})`;
			return null;
		}
		return v;
	}
	async function doDropTip(): Promise<boolean> {
		const r = await apiRaw(mx('drop-tip'), { method: 'POST', body: JSON.stringify({ pipetteId }) });
		if (!r.ok) throw new Error(r.body?.message || `HTTP ${r.status}`);
		return !!r.body?.dropped;
	}
	async function doPickUp(allowRecover: boolean) {
		const r = await apiRaw(mx('pick-up-tip'), { method: 'POST', body: JSON.stringify({ pipetteId, tiprackLoadName: tiprack, slot: '11', tipWell }) });
		if (r.ok) {
			if (r.body?.nextTipWell) tipWell = r.body.nextTipWell;
			return;
		}
		if (r.status === 409 && r.body?.code === 'TIP_ALREADY_ATTACHED' && allowRecover) {
			msg = 'The run still had a tip modelled — dropping it in the trash first…';
			await doDropTip();
			return doPickUp(false);
		}
		throw new Error(r.body?.message || (typeof r.body === 'string' ? r.body : `HTTP ${r.status}`));
	}
	async function doPickUpTip(): Promise<void> {
		await doPickUp(true);
		hasTip = true;
		tipAdjust = null;
		nominal = null;
		refWell = null;
		await refreshPosition();
	}
	async function doGoToCalibrator(z: number): Promise<void> {
		await moveAbs({ x: calX, y: calY, z }, { arc: true });
		await refreshPosition();
	}
	async function calibrateTip() {
		const approachZNow = checkedZ(calZ, 'Approach Z');
		if (approachZNow === null) return;
		const probeZNow = checkedZ(probeZ, 'Probe Z');
		if (probeZNow === null) return;
		if (pipetteMount !== 'left' && pipetteMount !== 'right') {
			errMsg = 'The run reported no pipette mount — reopen it.';
			return;
		}
		calibrating = true;
		await act(async () => {
			let pickedUpNow = false;
			if (!hasTip) {
				msg = `Picking up a p20 tip (${tiprack} ${tipWell})…`;
				await doPickUpTip();
				pickedUpNow = true;
			}
			await refreshPosition();
			if (!pickedUpNow && atCalibratorNow()) msg = 'Already on the calibrator — probing from the jogged position…';
			else {
				msg = `Moving to the tip calibrator (${calX}, ${calY}, ${approachZNow})…`;
				await doGoToCalibrator(approachZNow);
			}
			msg = 'Calibrating tip on the fixture… (slow limit-switch probe; the tip stays on)';
			const res = await api('/api/scanner/calibrate-tip', {
				method: 'POST',
				body: JSON.stringify({ robotId, mount: pipetteMount, tipProfile: 'wax', tipWell, runId, pipetteId, calibrator: { x: calX, y: calY, z: probeZNow } })
			});
			if (res?.adjust && typeof res.adjust.x === 'number') {
				tipAdjust = { x: res.adjust.x, y: res.adjust.y };
				nominal = null;
				refWell = null;
				await refreshPosition();
				msg = `Tip calibrated: adjust x=${tipAdjust.x} y=${tipAdjust.y}. Tip kept on; applied to every move-to. Move to a hole to set a fresh nominal.`;
			} else {
				throw new Error((typeof res?.error === 'string' && res.error) || 'Calibration returned no adjust');
			}
		});
		calibrating = false;
	}
	const pickUpTipAction = () =>
		act(async () => {
			await doPickUpTip();
			msg = `Tip on (no probe) — next fresh ${tipWell}. Enough for Fill motion / depth; Calibrate tip before teaching the first hole.`;
		});
	const swapTipAction = () =>
		act(async () => {
			const dropped = await doDropTip();
			hasTip = false;
			tipAdjust = null;
			nominal = null;
			refWell = null;
			await doPickUpTip();
			msg = `${dropped ? 'Dropped the old tip and picked' : 'Picked'} a fresh tip — Calibrate tip again before capturing.`;
		});
	const dropTipAction = () =>
		act(async () => {
			await doDropTip();
			hasTip = false;
			tipAdjust = null;
			nominal = null;
			refWell = null;
			msg = 'Tip dropped in the trash.';
			await refreshPosition();
		});
	const goToCalibrator = () =>
		act(async () => {
			const z = checkedZ(calZ, 'Approach Z');
			if (z === null) throw new Error(errMsg ?? 'Approach Z');
			await doGoToCalibrator(z);
			msg = `At the tip-calibrator approach point (${calX}, ${calY}, ${z}). Jog to fine-tune.`;
		});
	function captureCalibratorFromLive() {
		if (liveX === null || liveY === null || liveZ === null) {
			errMsg = 'No live position — open a run and move/jog first';
			return;
		}
		calX = +liveX.toFixed(3);
		calY = +liveY.toFixed(3);
		calZ = +liveZ.toFixed(3);
		msg = `Calibrator fields set from live (${calX}, ${calY}, ${calZ}). Click Save to persist.`;
	}
	async function saveCalibratorPosition() {
		if (checkedZ(calZ, 'Approach Z') === null || checkedZ(probeZ, 'Probe Z') === null) return;
		const r = await postAction('saveCalibrator', { x: String(calX), y: String(calY), z: String(calZ), zCalWax: String(probeZ), maxTipAdjust: maxAdjust === '' ? '' : String(maxAdjust) });
		if (r) msg = r.success;
	}

	// ── The stage's own teach points ─────────────────────────────────────────
	let testScanInFlight = $state(false);
	let testScanError = $state<string | null>(null);
	let testScanLatest = $state<string | null>(null);
	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	async function fireTestScan() {
		testScanError = null;
		testScanLatest = null;
		testScanInFlight = true;
		try {
			const res = await api('/api/scanner/trigger', { method: 'POST', body: JSON.stringify({ deviceId: data.scannerDeviceId, source: 'test', contextRef: 'arm-stage-calibration' }) });
			const triggerId = res?.triggerId;
			const started = Date.now();
			while (Date.now() - started < 15000) {
				await sleep(400);
				const url = new URL('/api/scanner/events', window.location.origin);
				url.searchParams.set('deviceId', data.scannerDeviceId);
				url.searchParams.set('limit', '20');
				const r = await fetch(url, { credentials: 'same-origin' });
				if (!r.ok) continue;
				const evs: any[] = (await r.json())?.events ?? [];
				const match = evs.find((e) => e?.metadata?.triggerId === triggerId);
				if (match) {
					if (match.eventType === 'scan' && match.barcode) testScanLatest = match.barcode;
					else testScanError = match.errorMessage || 'scanner returned error';
					return;
				}
			}
			testScanError = 'Timed out waiting for the scanner (15 s).';
		} catch (e) {
			testScanError = e instanceof Error ? e.message : String(e);
		} finally {
			testScanInFlight = false;
		}
	}
	async function readLive() {
		await refreshPosition();
		if (liveX === null || liveY === null || liveZ === null) throw new Error('Could not read the position from the robot.');
		return { x: liveX, y: liveY, z: liveZ };
	}
	const saveScanPosition = () =>
		act(async () => {
			if (hasTip) throw new Error('Drop the tip before saving the scan position — the scanner sweep runs without one.');
			const p = await readLive();
			const r = await postAction('saveScanPosition', { x: String(p.x), y: String(p.y), z: String(p.z), pipetteMount: pipetteMount ?? '', pipetteName: pipetteName ?? '', ...(testScanLatest ? { testScanBarcode: testScanLatest } : {}) });
			if (r) msg = r.success;
		});
	const saveFirstHole = () =>
		act(async () => {
			if (!hasTip || !tipAdjust) throw new Error('Calibrate the tip first — the first hole is saved tip-neutral (live − that tip\'s probe adjust).');
			const p = await readLive();
			const r = await postAction('saveCartLocation', {
				x: String(p.x),
				y: String(p.y),
				z: String(p.z),
				pipetteMount: pipetteMount ?? '',
				pipetteName: pipetteName ?? '',
				hasTip: 'true',
				adjustX: String(tipAdjust.x),
				adjustY: String(tipAdjust.y),
				tipWell
			});
			if (r) {
				msg = r.success;
				nominal = null;
				refWell = null;
			}
		});
	const goToDispenseHeight = () =>
		act(async () => {
			if (!rim) throw new Error('Teach the first hole first.');
			if (!hasTip) throw new Error('Pick up a tip first — the depth is about the tip end.');
			const a = adj();
			await moveAbs({ x: rim.x + a.x, y: rim.y + a.y, z: rim.z + STAGE_PREJUMP_MM }, { arc: true });
			await moveAbs({ x: rim.x + a.x, y: rim.y + a.y, z: dispenseZ(rim.z, depthMm) }, { direct: true });
			msg = depthMm === null ? `At the protocol's default (${Math.abs(DISPENSE_DEPTH_DEFAULT_MM)} mm above the rim) — jog Z to where the wax should land, then save.` : `At the taught dispense height (${Math.abs(depthMm)} mm ${depthMm >= 0 ? 'below' : 'above'} the rim). Jog Z to change it, then save.`;
			await refreshPosition();
		});
	const liveDepth = $derived(rim && liveZ !== null ? depthFromLive(rim.z, liveZ) : null);
	const liveDepthOk = $derived(liveDepth !== null && liveDepth >= DISPENSE_DEPTH_LIMITS.min && liveDepth <= DISPENSE_DEPTH_LIMITS.max);
	const saveDispenseDepth = () =>
		act(async () => {
			if (!rim) throw new Error('Teach the first hole first.');
			if (!hasTip) throw new Error('Pick up a tip first.');
			const p = await readLive();
			const r = await postAction('saveDispenseDepth', { z: String(p.z), hasTip: 'true' });
			if (r) msg = r.success;
		});
	let rotationDeg = $state<number>(data.calibration?.stageRotationDeg ?? STAGE_ROTATION_DEFAULT_DEG);
	let jumpHeightMm = $state<number>(data.calibration?.stageJumpHeightMm ?? 60);
	$effect(() => {
		rotationDeg = data.calibration?.stageRotationDeg ?? STAGE_ROTATION_DEFAULT_DEG;
		jumpHeightMm = data.calibration?.stageJumpHeightMm ?? 60;
	});
	async function saveGeometry() {
		const r = await postAction('saveStageGeometry', { rotationDeg: String(rotationDeg), jumpHeightMm: String(jumpHeightMm) });
		if (r) msg = r.success;
	}
	/** Turn the whole cart a quarter turn about the taught first hole and save — the plane redraws from the result. */
	async function rotateCart(deltaDeg: number) {
		const next = (((rotation + deltaDeg) % 360) + 360) % 360;
		rotationDeg = next;
		const r = await postAction('saveStageGeometry', { rotationDeg: String(next), jumpHeightMm: String(jumpHeightMm) });
		if (r) msg = `Cart rotated to ${next}° about the first hole — ${facing}. All 12 holes follow; per-hole corrections are kept.`;
	}

	const fmt3 = (n: number) => n.toFixed(2);
	const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '');
	const pad = 'rounded border border-[var(--color-tron-border)] py-2 text-xs hover:border-[var(--color-tron-cyan)] disabled:opacity-40';
</script>

<svelte:window onkeydown={onWindowKeydown} />

<div class="mx-auto max-w-[1400px] space-y-4 overflow-x-clip">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<h1 class="text-2xl font-bold" style="color: var(--color-tron-cyan)">Stage Calibration Studio</h1>
			<p class="text-xs" style="color: var(--color-tron-text-secondary)">
				The robot arm's single-cart stage. Teach the first wax hole, jog to a hole, capture the real offset, select holes, apply it. Corrections persist in BIMS and the stage protocol reads them at every run start — nothing to upload.
			</p>
		</div>
		<a href={WAX_FILL_HREF} class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1.5 text-xs font-medium text-[var(--color-tron-cyan)] transition-colors hover:bg-[var(--color-tron-cyan)]/20">Wax fill tab →</a>
	</div>

	<!-- Pickers -->
	<div class="flex flex-wrap items-end gap-4 rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
		<div class="text-xs" style="color: var(--color-tron-text-secondary)">Labware
			<div class="mt-1 flex overflow-hidden rounded border border-[var(--color-tron-border)] text-[11px]">
				<span class="bg-[var(--color-tron-cyan)]/20 px-2.5 py-1.5 text-[var(--color-tron-cyan)]" title="One Gen7 cartridge on the arm's elevated stage">Cartridge on stage</span>
				<span class="px-2.5 py-1.5" title="Tube rack · slot 10 — the fill reads its labware definition as on a deck robot">Tube rack 10</span>
				<span class="px-2.5 py-1.5" title="Tip rack · slot 11">Tip rack 11</span>
			</div>
		</div>
		<div class="text-xs" style="color: var(--color-tron-text-secondary)">Robot
			<div class="mt-1 rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 text-xs" style="color: var(--color-tron-text)">{robotName}<span class="ml-1 opacity-60">· the OT-2 the arm feeds</span></div>
			{#if robotId}<span class="mt-1 block"><TransportPill state={robotConn} onRetry={() => void robotSession?.retryDirect()} /></span>{/if}
		</div>
		<div class="text-xs" style="color: var(--color-tron-text-secondary)">Pipette mount
			<div class="mt-1 flex overflow-hidden rounded border border-[var(--color-tron-border)] text-[11px]">
				{#each [['left', 'Left'], ['right', 'Right']] as [m, lbl] (m)}
					<button type="button" disabled={!!runId} onclick={() => { desiredMount = m as 'left' | 'right'; zAxis = m === 'right' ? 'rightZ' : 'leftZ'; }}
						class="px-2.5 py-1.5 transition-colors disabled:opacity-50 {desiredMount === m ? 'bg-[var(--color-tron-cyan)]/20 text-[var(--color-tron-cyan)]' : 'text-[var(--color-tron-text-secondary)] hover:bg-white/5'}"
						title={runId ? 'Close the run to switch mounts' : `Open the run on the ${lbl.toLowerCase()} mount — the fill uses the mount the stage is taught with`}>{lbl}</button>
				{/each}
			</div>
			{#if runId}<div class="mt-0.5 text-[10px]">close run to switch</div>{/if}
		</div>
		<div class="text-xs" style="color: var(--color-tron-text-secondary)">
			12 wax holes · 6 × 9 mm lattice · rotation {rotation}° ({facing}) ·
			{#if taught}first hole <span class="font-mono">({fmt3(rim!.x)}, {fmt3(rim!.y)}, {fmt3(rim!.z)})</span>{:else}<span class="text-amber-300">first hole not taught</span>{/if}
		</div>
		{#if locked}<div class="text-xs text-amber-300">A wax-fill loop is running on this robot — motion is locked until it ends.</div>{/if}
	</div>

	{#if !robotId}
		<div class="rounded border border-amber-500/40 bg-amber-900/15 p-3 text-xs text-amber-200">No OT-2 is chosen for the arm yet — pick it in <a href={WAX_FILL_HREF} class="underline">Wax fill → Setup</a>, then come back here.</div>
	{/if}
	{#if form?.error}<div class="rounded border border-red-500/40 bg-red-900/20 p-2 text-xs text-red-300">{form.error}</div>{/if}
	{#if errMsg}<div class="rounded border border-red-500/40 bg-red-900/20 p-2 text-xs text-red-300">{errMsg}</div>{/if}
	{#if msg}<div class="rounded border border-green-500/30 bg-green-900/15 p-2 text-xs text-green-300">{msg}</div>{/if}

	<div class="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
		<!-- Canvas -->
		<section class="flex min-w-0 flex-col rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<div class="mb-2 flex flex-wrap items-center justify-between gap-2">
				<div class="flex flex-wrap items-center gap-3">
					<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Cartridge — {selCount} selected</h2>
					<span class="font-mono text-[11px]" style="color: var(--color-tron-cyan)" title="Cursor position in deck mm; z is the nearest hole's rim">
						{#if hover}x {hover.x.toFixed(2)}  y {hover.y.toFixed(2)}{#if hoverNearest}  ·  {hoverNearest.well.name} z {hoverNearest.well.z.toFixed(2)} ({hoverNearest.dist.toFixed(1)}mm){/if}{:else}<span style="color: var(--color-tron-text-secondary)">hover the cart for coords</span>{/if}
					</span>
				</div>
				<div class="flex flex-wrap items-center gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
					<label>Zoom <input type="range" min="0.6" max="4" step="0.2" bind:value={zoom} /> {zoom.toFixed(1)}×</label>
					<button type="button" onclick={() => (zoom = 1)} class="rounded border border-[var(--color-tron-border)] px-2 py-1 hover:border-[var(--color-tron-cyan)]" style="color: var(--color-tron-text)">Fit</button>
					<span class="ml-2 inline-flex overflow-hidden rounded border border-[var(--color-tron-cyan)]/50" title="Turn the whole cart a quarter turn about the taught first hole and save it (the stage protocol reads the rotation at run start)">
						<button type="button" onclick={() => void rotateCart(-90)} disabled={busy || locked} class="px-2 py-1 text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-40">⟲ Rotate cart</button>
						<span class="border-x border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-2 py-1 font-mono text-[var(--color-tron-cyan)]">{rotation}°</span>
						<button type="button" onclick={() => void rotateCart(90)} disabled={busy || locked} class="px-2 py-1 text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-40">Rotate cart ⟳</button>
					</span>
					<button type="button" onclick={() => (showGrid = !showGrid)} class="rounded border px-2 py-1 {showGrid ? 'border-[var(--color-tron-cyan)]/60 text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)]'}" style={showGrid ? '' : 'color: var(--color-tron-text)'} title="Reference grid (0.25mm fine · 1mm · 10mm bold)">Grid{showGrid ? ' ✓' : ''}</button>
					<button type="button" onclick={() => (showRigid = !showRigid)} class="rounded border px-2 py-1 {showRigid ? 'border-[var(--color-tron-cyan)]/60 text-[var(--color-tron-cyan)]' : 'border-[var(--color-tron-border)]'}" style={showRigid ? '' : 'color: var(--color-tron-text)'} title="Show where the rigid lattice puts each corrected hole">Lattice{showRigid ? ' ✓' : ''}</button>
					<button type="button" onclick={selectAll} class="rounded border border-[var(--color-tron-border)] px-2 py-1 hover:border-[var(--color-tron-cyan)]" style="color: var(--color-tron-text)">Select all</button>
					<button type="button" onclick={() => (deselectMode = !deselectMode)} class="rounded border px-2 py-1 {deselectMode ? 'border-amber-500/60 bg-amber-900/20 text-amber-300' : 'border-[var(--color-tron-border)] hover:border-[var(--color-tron-cyan)]'}" style={deselectMode ? '' : 'color: var(--color-tron-text)'} title="When on, box-drag/click removes holes from the selection">Deselect{deselectMode ? ' ✓' : ''}</button>
					<button type="button" onclick={deselectAll} title="Deselect everything (or press Esc anywhere)" class="rounded border border-[var(--color-tron-border)] px-2 py-1 hover:border-[var(--color-tron-cyan)]" style="color: var(--color-tron-text)">Clear (Esc)</button>
				</div>
			</div>
			<p class="mb-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
				Drag a box to select a group (Shift adds). Click a hole to toggle; the last clicked is the anchor. Wax holes are amber (the first, taught hole is ringed); the blue dots are the paired reagent holes, drawn for orientation only. Deck mm, to scale. Esc clears everything.
				{#if !taught}<span class="text-amber-300"> The cart is drawn at the origin until the first hole is taught (Stage → First hole).</span>{/if}
			</p>
			<div class="flex-1 overflow-auto rounded border border-[var(--color-tron-border)] bg-black/40" style="max-height: 85vh; display: flex; align-items: safe center; justify-content: safe center;">
				<div style={`width:${zoom * 100}%; flex: 0 0 auto;`}>
					<svg
						bind:this={svgEl}
						width="100%"
						viewBox={`${bounds.x0} 0 ${bounds.x1 - bounds.x0} ${bounds.y1 - bounds.y0}`}
						preserveAspectRatio="xMidYMid meet"
						onpointerdown={onCanvasPointerDown}
						onpointermove={onCanvasPointerMove}
						onpointerup={onCanvasPointerUp}
						onpointerleave={() => (hover = null)}
						style="display:block; height:auto; touch-action:none; cursor: crosshair;"
					>
						<defs>
							<pattern id="sgrid-025mm" x={bounds.x0} y="0" width="0.25" height="0.25" patternUnits="userSpaceOnUse">
								<path d="M 0.25 0 L 0 0 0 0.25" fill="none" stroke="rgba(130,180,220,0.22)" stroke-width="0.02" />
							</pattern>
							<pattern id="sgrid-1mm" x={bounds.x0} y="0" width="1" height="1" patternUnits="userSpaceOnUse">
								<rect width="1" height="1" fill="url(#sgrid-025mm)" />
								<path d="M 1 0 L 0 0 0 1" fill="none" stroke="rgba(130,180,220,0.40)" stroke-width="0.05" />
							</pattern>
							<pattern id="sgrid-10mm" x={bounds.x0} y="0" width="10" height="10" patternUnits="userSpaceOnUse">
								<rect width="10" height="10" fill="url(#sgrid-1mm)" />
								<path d="M 10 0 L 0 0 0 10" fill="none" stroke="rgba(130,180,220,0.55)" stroke-width="0.1" />
							</pattern>
						</defs>
						{#if showGrid}
							<rect x={bounds.x0} y="0" width={bounds.x1 - bounds.x0} height={bounds.y1 - bounds.y0} fill="url(#sgrid-10mm)" />
						{/if}
						<!-- Which way is which: the OT-2's front (low y, toward the operator) is the bottom of the plane. -->
						<text x={(bounds.x0 + bounds.x1) / 2} y={bounds.y1 - bounds.y0 - 0.8} font-size="1.3" text-anchor="middle" fill="rgba(200,220,240,0.55)" style="pointer-events:none; user-select:none;">▼ front · toward you (−y)</text>
						<text x={(bounds.x0 + bounds.x1) / 2} y="1.6" font-size="1.3" text-anchor="middle" fill="rgba(200,220,240,0.55)" style="pointer-events:none; user-select:none;">back of the OT-2 (+y)</text>
						<!-- Gate and row directions of the lattice at this rotation. -->
						<defs>
							<marker id="sarrow" viewBox="0 0 4 4" refX="3.5" refY="2" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0 L4,2 L0,4 z" fill="rgba(0,255,255,0.7)" /></marker>
						</defs>
						<line x1={wells[0].rigid.x} y1={cy(wells[0].rigid.y)} x2={wells[0].rigid.x + gateDir.x * 1.25} y2={cy(wells[0].rigid.y + gateDir.y * 1.25)} stroke="rgba(0,255,255,0.45)" stroke-width="0.12" marker-end="url(#sarrow)" style="pointer-events:none;" />
						<text x={wells[0].rigid.x + gateDir.x * 1.35} y={cy(wells[0].rigid.y + gateDir.y * 1.35)} font-size="1.1" text-anchor="middle" fill="rgba(0,255,255,0.7)" style="pointer-events:none; user-select:none;">gates 4→1</text>
						<line x1={wells[0].rigid.x} y1={cy(wells[0].rigid.y)} x2={wells[0].rigid.x + rowDir.x * 1.25} y2={cy(wells[0].rigid.y + rowDir.y * 1.25)} stroke="rgba(0,255,255,0.45)" stroke-width="0.12" marker-end="url(#sarrow)" style="pointer-events:none;" />
						<text x={wells[0].rigid.x + rowDir.x * 1.35} y={cy(wells[0].rigid.y + rowDir.y * 1.35)} font-size="1.1" text-anchor="middle" fill="rgba(0,255,255,0.7)" style="pointer-events:none; user-select:none;">rows 1→3</text>
						<!-- reagent holes: orientation only -->
						{#each wells as w (`rg-${w.name}`)}
							<circle cx={w.reagent.x} cy={cy(w.reagent.y)} r={wellR * 0.8} fill="rgba(80,170,215,0.35)" style="pointer-events:none;" />
						{/each}
						<!-- rigid lattice position of a corrected hole -->
						{#if showRigid}
							{#each wells as w (`rigid-${w.name}`)}
								{#if w.offset.dx !== 0 || w.offset.dy !== 0}
									<circle cx={w.rigid.x} cy={cy(w.rigid.y)} r={wellR} fill="none" stroke="rgba(217,160,80,0.45)" stroke-width="0.12" stroke-dasharray="0.3 0.2" style="pointer-events:none;" />
									<line x1={w.rigid.x} y1={cy(w.rigid.y)} x2={w.x} y2={cy(w.y)} stroke="rgba(217,160,80,0.6)" stroke-width="0.1" style="pointer-events:none;" />
								{/if}
							{/each}
						{/if}
						{#each wells as w (w.name)}
							{@const sel = selection.has(w.name)}
							<circle
								cx={w.x} cy={cy(w.y)} r={wellR}
								fill={sel ? 'var(--color-tron-cyan)' : refWell === w.name ? '#f59e0b' : 'rgba(217,160,80,0.65)'}
								stroke={w.index === 0 ? 'var(--color-tron-cyan)' : sel ? 'var(--color-tron-cyan)' : 'none'}
								stroke-width={w.index === 0 ? 0.25 : 0.15}
								onpointerdown={(e) => { e.stopPropagation(); }}
								onclick={(e) => { e.stopPropagation(); toggleWell(w.name, e.shiftKey || e.ctrlKey || e.metaKey); }}
								role="button" tabindex="-1"
							><title>{w.name} (row {w.row}, gate {w.gate}{w.index === 0 ? ', first/taught' : ''}) — x {w.x.toFixed(2)} y {w.y.toFixed(2)} z {w.z.toFixed(2)}{w.offset.dx || w.offset.dy || w.offset.dz ? ` · correction ${w.offset.dx}, ${w.offset.dy}, ${w.offset.dz}` : ''}</title></circle>
							<text x={w.x} y={cy(w.y) - wellR - 0.4} font-size="1.1" text-anchor="middle" fill="rgba(200,220,240,0.7)" style="pointer-events:none; user-select:none;">{w.name}</text>
						{/each}
						{#if boxRect}
							<rect x={boxRect.x} y={boxRect.y} width={boxRect.w} height={boxRect.h} fill="rgba(0,255,255,0.12)" stroke="var(--color-tron-cyan)" stroke-width="0.15" />
						{/if}
					</svg>
				</div>
			</div>
		</section>

		<!-- Right column: jog + tip + offset + protocol -->
		<div class="min-w-0 space-y-4">
			<section class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)]/40 p-3">
				<div class="flex items-center justify-between">
					<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Jog</h2>
					{#if !runId}
						<button type="button" onclick={startMaintenance} disabled={connecting || !robotId || locked} class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 px-3 py-1.5 text-xs font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25 disabled:opacity-40">{connecting ? 'Opening…' : 'Open run'}</button>
					{:else}
						<div class="flex gap-2">
							<button type="button" onclick={homeRobot} disabled={busy} class="rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs hover:border-[var(--color-tron-cyan)] disabled:opacity-40" style="color: var(--color-tron-text)">Home</button>
							<button type="button" onclick={stopMaintenance} disabled={busy} class="rounded border border-amber-500/40 bg-amber-900/15 px-2 py-1 text-xs text-amber-300 disabled:opacity-40">Close</button>
						</div>
					{/if}
				</div>
				{#if runId}<p class="mt-1 text-[11px] {wrongPipette ? 'text-amber-300' : ''}" style={wrongPipette ? '' : 'color: var(--color-tron-text-secondary)'}>pipette {pipetteName} ({pipetteMount}){wrongPipette ? ' — not a p20; 20 µL tips will not model on it' : ''}</p>{/if}
				<div class="mt-2 flex flex-wrap items-center gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
					<label>Step <select bind:value={stepSize} class="rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-0.5 font-mono text-xs" style="color: var(--color-tron-text)">
						<option value={0.1}>0.1</option><option value={0.5}>0.5</option><option value={1}>1</option><option value={5}>5</option><option value={10}>10</option><option value={25}>25</option>
					</select> mm</label>
					<label>Z <select bind:value={zAxis} class="rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-0.5 font-mono text-xs" style="color: var(--color-tron-text)"><option value="leftZ">leftZ</option><option value="rightZ">rightZ</option></select></label>
				</div>
				<div class="mt-2 grid grid-cols-3 gap-1">
					<div></div>
					<button type="button" disabled={!pipetteId || busy} onclick={() => jogAxis('y', stepSize)} class={pad} style="color: var(--color-tron-text)">Y +</button>
					<div></div>
					<button type="button" disabled={!pipetteId || busy} onclick={() => jogAxis('x', -stepSize)} class={pad} style="color: var(--color-tron-text)">X −</button>
					<div class="flex items-center justify-center text-[10px]" style="color: var(--color-tron-text-secondary)">XY</div>
					<button type="button" disabled={!pipetteId || busy} onclick={() => jogAxis('x', stepSize)} class={pad} style="color: var(--color-tron-text)">X +</button>
					<div></div>
					<button type="button" disabled={!pipetteId || busy} onclick={() => jogAxis('y', -stepSize)} class={pad} style="color: var(--color-tron-text)">Y −</button>
					<div></div>
				</div>
				<div class="mt-1 grid grid-cols-2 gap-1">
					<button type="button" disabled={!pipetteId || busy} onclick={() => jogAxis(zAxis, stepSize)} class={pad} style="color: var(--color-tron-text)">Z + up</button>
					<button type="button" disabled={!pipetteId || busy} onclick={() => jogAxis(zAxis, -stepSize)} class={pad} style="color: var(--color-tron-text)">Z − down</button>
				</div>
				<div class="mt-2 flex items-center justify-between rounded border border-[var(--color-tron-border)] bg-black/30 p-2 font-mono text-xs" style="color: var(--color-tron-text)">
					<span>x {liveX !== null ? liveX.toFixed(2) : '—'}</span>
					<span>y {liveY !== null ? liveY.toFixed(2) : '—'}</span>
					<span>z {liveZ !== null ? liveZ.toFixed(2) : '—'}</span>
				</div>
				{#if rim && liveZ !== null}
					<p class="mt-1 text-[10px]" style="color: var(--color-tron-text-secondary)">tip end {Math.abs(liveDepth ?? 0).toFixed(2)} mm {(liveDepth ?? 0) >= 0 ? 'below' : 'above'} the taught rim</p>
				{/if}
				<div class="mt-2 grid grid-cols-2 gap-2">
					<button type="button" onclick={moveToSelectedHole} disabled={!pipetteId || busy || selCount !== 1 || !taught} class="rounded border border-[var(--color-tron-cyan)]/40 px-2 py-2 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-40" title="Select exactly one hole — parks the tip 2 mm above its rim, this tip's adjust applied">Move to hole</button>
					<button type="button" onclick={captureOffset} disabled={!pipetteId || busy || !nominal} class="rounded border border-green-500/50 bg-green-900/20 px-2 py-2 text-xs font-bold text-green-300 hover:bg-green-900/30 disabled:opacity-40">Capture offset</button>
				</div>

				<!-- Tip -->
				<div class="mt-3 rounded border border-[var(--color-tron-border)] bg-black/20 p-2">
					<div class="mb-1 flex items-center justify-between text-[11px]" style="color: var(--color-tron-text-secondary)">
						<span class="font-bold uppercase tracking-wider">Tip</span>
						<span>{hasTip ? '🟢 tip on' : 'no tip'} · p20 rack{tipAdjust ? ` · zeroed (${tipAdjust.x}, ${tipAdjust.y})` : ''}</span>
					</div>
					<div class="mb-2 flex items-center gap-2 text-[10px]" style="color: var(--color-tron-text-secondary)">
						<span>Pick from</span>
						<input type="text" bind:value={tipWell} disabled={busy} class="w-12 rounded border border-[var(--color-tron-border)] bg-black/40 px-1 py-0.5 text-center font-mono text-[11px]" style="color: var(--color-tron-text)" title="Rack position of the next fresh tip (column-major). Overtype if the rack was reloaded." />
						{#if data.teach?.nextTipWell}<span title="Where the robot's tip tracker / Studio cursor says the next fresh tip is">next fresh: <span class="font-mono">{data.teach.nextTipWell}</span> · {data.teach.nextTipSource}</span>{/if}
						<button type="button" onclick={() => (tipWell = 'A1')} disabled={busy} class="rounded border border-[var(--color-tron-border)] px-1.5 py-0.5 hover:border-[var(--color-tron-cyan)]/60" title="Rack was refilled — start from A1 again">Refilled → A1</button>
					</div>
					{#if !data.teach?.calibrator || data.teach.calibrator.source === 'default'}
						<p class="mb-1 rounded border border-amber-400/40 bg-amber-900/15 px-1.5 py-1 text-[10px] leading-tight text-amber-200">No calibrator point is taught for {robotName} — the probe would drive to the protocol's default. Teach it in the <strong>Tip calibrator</strong> panel below first.</p>
					{/if}
					<button type="button" onclick={calibrateTip} disabled={busy || calibrating || !pipetteId} class="w-full rounded border border-purple-400/50 bg-purple-900/20 px-2 py-2 text-xs font-bold text-purple-200 hover:bg-purple-900/30 disabled:opacity-40" title="Picks up a p20 tip, travels to the tip calibrator, then runs the slow limit-switch probe. Keeps the tip on for tuning.">
						{calibrating ? 'Calibrating tip…' : hasTip ? 'Calibrate tip (probe, keeps tip)' : 'Calibrate tip (picks up a p20 tip first)'}
					</button>
					{#if !calibrating}
						<p class="mt-1 text-[10px] leading-tight" style="color: var(--color-tron-text-secondary)">
							{#if !hasTip}Picks up <span class="font-mono">{tiprack} {tipWell}</span> from slot 11, moves to ({calX}, {calY}, {calZ}), then probes at z {probeZ}.
							{:else if atCalibratorNow()}Probes from the current jogged position — already within {CAL_AT_TOLERANCE_MM} mm of the calibrator, so it will not travel.
							{:else}Moves to ({calX}, {calY}, {calZ}), then probes at z {probeZ}.{/if}
						</p>
					{/if}
					<button type="button" onclick={swapTipAction} disabled={!pipetteId || busy} class="mt-1 w-full rounded border border-amber-400/50 bg-amber-900/15 px-2 py-1.5 text-[11px] font-semibold text-amber-200 hover:bg-amber-900/25 disabled:opacity-40" title="Drops the current tip in the trash, then picks the next fresh one from slot 11. Clears the probe adjust — Calibrate tip again before capturing.">Swap tip — drop it, take a fresh one from the rack</button>
					<button type="button" onclick={pickUpTipAction} disabled={!pipetteId || busy} class="mt-1 w-full rounded border border-[var(--color-tron-cyan)]/40 px-2 py-1.5 text-[11px] text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-40" title="Just picks up a tip from slot 11 — no travel to the calibrator, no probe.">{hasTip ? 'Pick up tip (another one)' : 'Pick up tip (no probe)'}</button>
					<button type="button" onclick={dropTipAction} disabled={!pipetteId || busy || !hasTip} class="mt-1 w-full rounded border border-[var(--color-tron-border)] px-2 py-1.5 text-[11px] hover:border-amber-400/60 disabled:opacity-40" style="color: var(--color-tron-text-secondary)">Drop tip (for the scan position)</button>
					{#if tipAdjust}
						<button type="button" onclick={() => (tipAdjust = null)} class="mt-1 w-full rounded border border-[var(--color-tron-border)] px-2 py-1 text-[10px] hover:border-amber-400/60" style="color: var(--color-tron-text-secondary)">Clear tip adjust</button>
					{/if}
				</div>

				<!-- Offset → selection -->
				<div class="mt-3 rounded border border-[var(--color-tron-border)] bg-black/20 p-2">
					<div class="mb-1 text-[11px] font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Offset → selection</div>
					<div class="mt-2 grid grid-cols-3 gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
						<label>dx <input type="number" step="0.01" bind:value={dx} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-1 font-mono" style="color: var(--color-tron-text)" /></label>
						<label>dy <input type="number" step="0.01" bind:value={dy} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-1 font-mono" style="color: var(--color-tron-text)" /></label>
						<label>dz <input type="number" step="0.01" bind:value={dz} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-1 font-mono" style="color: var(--color-tron-text)" /></label>
					</div>
					<button type="button" onclick={applyToSelection} disabled={busy || selCount === 0 || !taught} class="mt-2 w-full rounded border border-green-500/50 bg-green-900/20 px-3 py-2 text-sm font-bold text-green-300 hover:bg-green-900/30 disabled:opacity-40">Apply to {selCount} selected hole{selCount === 1 ? '' : 's'}</button>
					<button type="button" onclick={applyGlobalShift} disabled={busy || !taught} class="mt-2 w-full rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-2 text-xs font-semibold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/20 disabled:opacity-40">⤧ Shift whole cart by this offset</button>
					<p class="mt-1 text-[10px]" style="color: var(--color-tron-text-secondary)">Anchor: jog to one hole → Capture → <strong>Shift whole cart</strong> moves the taught first hole (all 12 follow). Apply to a subset writes per-hole corrections (±{HOLE_OFFSET_LIMIT_MM} mm max).</p>
					<button type="button" onclick={undoLast} disabled={busy || undoStack.length === 0} class="mt-2 w-full rounded border border-amber-500/50 bg-amber-900/15 px-3 py-2 text-xs font-semibold text-amber-300 hover:bg-amber-900/25 disabled:opacity-40" title="Revert the last applied shift (offset, whole cart, set-position or align)">↶ Undo last {undoStack.length ? `(${undoStack.length})` : ''}</button>
				</div>
			</section>

			<!-- Tip calibrator: the fixture point the probe uses — taught here, robot-keyed (the arm's OT-2 has no deck). -->
			<section class="rounded-lg border border-purple-400/40 bg-[var(--color-tron-surface)] p-3">
				<div class="flex items-center justify-between">
					<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Tip calibrator</h2>
					<span class="text-[10px] {data.teach?.calibrator?.source === 'default' ? 'text-amber-300' : ''}" style={data.teach?.calibrator?.source === 'default' ? '' : 'color: var(--color-tron-text-secondary)'}>
						{#if !data.teach?.calibrator || data.teach.calibrator.source === 'default'}not taught — protocol defaults{:else}{data.teach.calibrator.source}{data.teach.calibrator.taughtAt ? ` · ${when(data.teach.calibrator.taughtAt)}` : ''}{data.teach.calibrator.taughtBy ? ` · ${data.teach.calibrator.taughtBy}` : ''}{/if}
					</span>
				</div>
				<p class="mt-1 text-[10px] leading-tight" style="color: var(--color-tron-text-secondary)">
					The limit-switch fixture every tip is probed on. Its point is this robot's own (the arm's OT-2 has no deck) and becomes the fill's cal_x / cal_y / z_cal.
					Teach it: <strong>Open run</strong> → <strong>Pick up tip (no probe)</strong> → <strong>Go to calibrator</strong> → jog the tip onto the fixture → <strong>From live</strong> → <strong>Save</strong>. Then <strong>Calibrate tip</strong> to confirm the probe reads.
				</p>
				<div class="mt-2 grid grid-cols-3 gap-1 text-[10px]" style="color: var(--color-tron-text-secondary)">
					<label>calX <input type="number" step="0.1" bind:value={calX} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-0.5 font-mono" style="color: var(--color-tron-text)" /></label>
					<label>calY <input type="number" step="0.1" bind:value={calY} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-0.5 font-mono" style="color: var(--color-tron-text)" /></label>
					<label title="Pre-probe travel height: where the tip parks before the probe runs. Never the touch-off depth.">Approach Z <input type="number" step="0.1" min={CAL_Z_MIN} max={CAL_Z_MAX} bind:value={calZ} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-0.5 font-mono" style="color: var(--color-tron-text)" /></label>
				</div>
				<div class="mt-2 grid grid-cols-2 gap-2 rounded border border-purple-400/30 bg-purple-900/10 p-1.5 text-[10px]" style="color: var(--color-tron-text-secondary)">
					<label class="block" title="Touch-off depth the limit-switch probe descends to — production z_cal for this robot">Probe Z — p20 · wax (zCalWax)
						<input type="number" step="0.1" min={CAL_Z_MIN} max={CAL_Z_MAX} bind:value={probeZ} class="mt-0.5 w-full rounded border border-purple-400/40 bg-black/30 px-1 py-0.5 font-mono" style="color: var(--color-tron-text)" />
					</label>
					<label class="block" title="Largest probe adjust the fill accepts before it stops (raw, carries this fixture's baseline). Blank = the protocol's 4.0">Max tip adjust (mm)
						<input type="number" step="0.1" min="0.3" max="12" bind:value={maxAdjust} class="mt-0.5 w-full rounded border border-purple-400/40 bg-black/30 px-1 py-0.5 font-mono" style="color: var(--color-tron-text)" />
					</label>
				</div>
				<p class="mt-1 text-[10px] leading-tight" style="color: var(--color-tron-text-secondary)">Approach Z is travel-only — "Calibrate tip" and "Go to calibrator" park there; the probe descends to Probe Z under its own protection. "Calibrate tip" uses what is typed here immediately; Save writes it to production.</p>
				<button type="button" onclick={goToCalibrator} disabled={!pipetteId || busy} class="mt-2 w-full rounded border border-[var(--color-tron-cyan)]/40 px-2 py-1.5 text-[11px] text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-40" title="Park at the approach point so you can jog onto the fixture — no probe">Go to calibrator (park, no probe)</button>
				<div class="mt-1 grid grid-cols-2 gap-2">
					<button type="button" onclick={captureCalibratorFromLive} disabled={busy || liveX === null} class="rounded border border-[var(--color-tron-border)] px-2 py-1.5 text-[11px] hover:border-[var(--color-tron-cyan)] disabled:opacity-40" style="color: var(--color-tron-text)" title="Copy the live jogged position into the calX / calY / Approach Z fields">From live ↧</button>
					<button type="button" onclick={saveCalibratorPosition} disabled={busy || !robotId} class="rounded border border-green-500/40 bg-green-900/15 px-2 py-1.5 text-[11px] font-semibold text-green-300 hover:bg-green-900/25 disabled:opacity-40">Save → {robotName}</button>
				</div>
			</section>

			<!-- Protocol on robot (the Studio's "Sync" — nothing to upload here) -->
			<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
				<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Protocol on robot</h2>
				<div class="mt-2 space-y-1 text-[11px]">
					{#if !data.protocol}
						<p class="text-amber-300">No wax-filling protocol on {robotName} — upload <span class="font-mono">protocols/Wax_Filling_GEN7_ArmStage.py</span> on <a href="/opentrons" class="underline">/opentrons</a> and deploy it to this robot.</p>
					{:else if !data.protocol.declaresCartLocation}
						<p class="text-amber-300"><span class="font-mono">{data.protocol.protocolName}</span> is the carriage protocol — it reads no stage calibration. Upload Wax_Filling_GEN7_ArmStage.py to this robot.</p>
					{:else}
						<p style="color: var(--color-tron-text)">✓ <span class="font-mono">{data.protocol.protocolName}</span> reads the first hole, rotation, travel height and dispense depth.</p>
						<p class={data.teach?.protocolDeclaresHoleOffsets ? '' : 'text-amber-300'} style={data.teach?.protocolDeclaresHoleOffsets ? 'color: var(--color-tron-text)' : ''}>
							{data.teach?.protocolDeclaresHoleOffsets ? '✓ reads the per-hole corrections (hole_01…12).' : '○ this upload predates per-hole corrections — re-upload the stage .py to this robot for Apply / Align to reach the fill.'}
						</p>
					{/if}
					<p style="color: var(--color-tron-text-secondary)">Nothing to sync: every value on this page is sent to the robot as run-time parameters at each run start.</p>
				</div>
				<button type="button" onclick={() => void invalidateAll()} class="mt-2 w-full rounded border border-[var(--color-tron-border)] px-2 py-1.5 text-[11px] hover:border-[var(--color-tron-cyan)]" style="color: var(--color-tron-text)">Re-check</button>
			</section>
		</div>
	</div>

	<!-- Under-canvas tools: they act on the CURRENT SELECTION -->
	<div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Tour / Fill motion</h2>
			{#if touring}
				<div class="mb-1 text-center text-[11px]" style="color: var(--color-tron-cyan)">{tourIndex + 1} / {tourWells.length} — {tourWells[tourIndex]}</div>
				<div class="grid grid-cols-4 gap-1">
					<button type="button" onclick={tourPrev} disabled={busy || tourIndex === 0} class={pad} style="color: var(--color-tron-text)">‹ Prev</button>
					<button type="button" onclick={tourNext} disabled={busy || tourIndex >= tourWells.length - 1} class={pad} style="color: var(--color-tron-text)">Next ›</button>
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
					<button type="button" onclick={startTour} disabled={!pipetteId || busy || !taught} class="rounded border border-[var(--color-tron-cyan)]/40 px-2 py-2 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-40" title="Drive through all 12 holes in fill order">Run through all holes</button>
					<button type="button" onclick={runFillMotion} disabled={!pipetteId || busy || selCount === 0 || !taught} class="rounded border border-[var(--color-tron-cyan)]/40 px-2 py-2 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-40" title="The stage protocol's exact approach at the selected hole(s): travel height → pre-jump → dispense depth → dwell → retract">▶ Fill motion ({selCount} selected)</button>
				</div>
				<div class="mt-2 flex flex-wrap items-center gap-2 text-[11px]" style="color: var(--color-tron-text-secondary)">
					<span class="opacity-70">Fill:</span>
					<label class="flex items-center gap-1"><input type="checkbox" bind:checked={fillMatchProtocol} /> Protocol speed</label>
					{#if !fillMatchProtocol}<label>Cap <input type="number" min="1" max="400" step="1" bind:value={fillSpeed} class="w-14 rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-0.5 font-mono" style="color: var(--color-tron-text)" /> mm/s</label>{/if}
					<label>Dwell <input type="number" min="0" max="5000" step="50" bind:value={fillDwellMs} class="w-16 rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-0.5 font-mono" style="color: var(--color-tron-text)" /> ms</label>
				</div>
				<p class="mt-1 text-[10px]" style="color: var(--color-tron-text-secondary)"><strong>Fill motion</strong> mimics the stage fill at each selected hole ({jumpMm} mm travel → {STAGE_PREJUMP_MM} mm pre-jump → {depthMm === null ? `${Math.abs(DISPENSE_DEPTH_DEFAULT_MM)} mm above the rim (protocol default — depth not taught)` : `${Math.abs(depthMm)} mm ${depthMm >= 0 ? 'below' : 'above'} the rim`} → {fillDwellMs} ms dwell → retract), in fill order.{hasTip ? '' : ' Pick up a tip first to match the real fill height.'}</p>
			{/if}
		</section>

		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Set position → selection</h2>
			<p class="mt-1 text-[10px]" style="color: var(--color-tron-text-secondary)">Type an EXACT x/y/z (deck mm, tip-neutral) for the <strong>anchor</strong> hole — not a change. With several holes selected, the whole group translates by the same delta. Prefilled with the anchor's current coords.</p>
			<div class="mt-1 text-[10px] font-mono" style="color: var(--color-tron-text-secondary)">{anchor ? `Anchor: ${anchor}${selCount > 1 ? ` (+${selCount - 1} more move with it)` : ''}` : 'Select one or more holes'}</div>
			<div class="mt-2 grid grid-cols-3 gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
				<label>x <input type="number" step="0.01" bind:value={setX} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-1 font-mono" style="color: var(--color-tron-text)" /></label>
				<label>y <input type="number" step="0.01" bind:value={setY} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-1 font-mono" style="color: var(--color-tron-text)" /></label>
				<label>z <input type="number" step="0.01" bind:value={setZ} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-1 font-mono" style="color: var(--color-tron-text)" /></label>
			</div>
			<button type="button" onclick={applyAbsolute} disabled={busy || selCount === 0 || !taught} class="mt-2 w-full rounded border border-green-500/50 bg-green-900/20 px-3 py-2 text-sm font-bold text-green-300 hover:bg-green-900/30 disabled:opacity-40">
				{selCount === 0 ? 'Select one or more holes' : selCount === 1 ? `Set ${anchor} to this position` : `Move ${selCount} holes (anchor ${anchor})`}
			</button>
		</section>

		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Align selection → anchor hole</h2>
			<p class="mt-1 text-[10px]" style="color: var(--color-tron-text-secondary)">Fixes holes that drifted relative to each other. Jog-verify ONE good hole, select the group (box-drag), click the good hole <strong>last</strong> so it's the anchor. Every other selected hole snaps onto the cartridge's rigid 6 × 9 mm lattice carrying the anchor's correction. Z untouched.</p>
			<div class="mt-1 text-[10px] font-mono" style="color: var(--color-tron-text-secondary)">{anchor && selCount >= 2 ? `Anchor: ${anchor} (correction ${wellByName.get(anchor)?.offset.dx ?? 0}, ${wellByName.get(anchor)?.offset.dy ?? 0}) — ${selCount - 1} other hole(s) selected` : 'Select the holes, click the trusted hole last'}</div>
			<button type="button" onclick={alignSelectionToAnchor} disabled={busy || selCount < 2 || !taught} class="mt-2 w-full rounded border border-cyan-500/50 bg-cyan-900/20 px-3 py-2 text-sm font-bold text-cyan-300 hover:bg-cyan-900/30 disabled:opacity-40">
				{selCount < 2 ? 'Select the holes + an anchor hole' : `⌗ Align ${selCount - 1} hole(s) to ${anchor}`}
			</button>
		</section>
	</div>

	<!-- The stage's own teach points: what a deck definition would otherwise carry -->
	<div class="grid grid-cols-1 gap-4 lg:grid-cols-4">
		<section class="rounded-lg border {taught ? 'border-[var(--color-tron-border)]' : 'border-amber-500/40'} bg-[var(--color-tron-surface)] p-3 space-y-2">
			<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Stage · first hole</h2>
			<div class="font-mono text-xs" style="color: var(--color-tron-cyan)">{rim ? `x ${fmt3(rim.x)} · y ${fmt3(rim.y)} · z ${fmt3(rim.z)}` : 'not taught'}</div>
			<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">
				The rim of the cart's first wax hole (row 1, gate 4 — X2). Calibrate a tip, jog the <strong>tip end</strong> onto that rim, save: stored tip-neutral (live − this tip's adjust); the other 11 follow from it. Re-teaching it keeps the per-hole corrections.
				{#if rim?.taughtAt}Taught {when(rim.taughtAt)}{rim.taughtBy ? ` by ${rim.taughtBy}` : ''}.{/if}
				{#if rim?.tipAdjust}Probe at teach <span class="font-mono">{rim.tipAdjust.x}, {rim.tipAdjust.y}</span>.{:else if rim}<span class="text-amber-300"> Taught without a probed tip — teach again.</span>{/if}
			</p>
			<button type="button" onclick={saveFirstHole} disabled={!pipetteId || busy || !hasTip || !tipAdjust || locked} class="w-full rounded border border-green-500/50 bg-green-900/20 px-3 py-2 text-xs font-bold text-green-300 hover:bg-green-900/30 disabled:opacity-40" title={!hasTip || !tipAdjust ? 'Calibrate the tip first — the point is saved tip-neutral' : ''}>Save here as first hole</button>
		</section>

		<section class="rounded-lg border {depthMm === null ? 'border-amber-500/40' : 'border-[var(--color-tron-border)]'} bg-[var(--color-tron-surface)] p-3 space-y-2">
			<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Stage · dispense depth</h2>
			<div class="font-mono text-xs" style="color: var(--color-tron-cyan)">{#if depthMm !== null}{Math.abs(depthMm)} mm {depthMm >= 0 ? 'below' : 'above'} the rim{#if rim} · tip end z {dispenseZ(rim.z, depthMm).toFixed(2)}{/if}{:else}not taught — protocol would hover {Math.abs(DISPENSE_DEPTH_DEFAULT_MM)} mm above{/if}</div>
			<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">How far into the first wax hole the <strong>tip end</strong> goes when wax is dispensed (dispense_depth). "Go to dispense height" parks it at the current value; jog Z to where the wax should land, save. Allowed {DISPENSE_DEPTH_LIMITS.min} (hover) to {DISPENSE_DEPTH_LIMITS.max} mm into the {WAX_HOLE_DEPTH_MM} mm hole.{#if calibration?.dispenseDepth?.taughtAt} Taught {when(calibration.dispenseDepth.taughtAt)}.{/if}</p>
			{#if rim && liveZ !== null}<p class="text-[11px] {liveDepthOk ? 'text-green-300' : 'text-amber-300'}">Tip end now {Math.abs(liveDepth ?? 0).toFixed(2)} mm {(liveDepth ?? 0) >= 0 ? 'below' : 'above'} the rim{liveDepthOk ? '' : ' — outside the allowed range'}.</p>{/if}
			<div class="grid grid-cols-2 gap-2">
				<button type="button" onclick={goToDispenseHeight} disabled={!pipetteId || busy || !hasTip || !rim} class={pad} style="color: var(--color-tron-text)">Go to dispense height</button>
				<button type="button" onclick={saveDispenseDepth} disabled={!pipetteId || busy || !hasTip || !rim || !liveDepthOk || locked} class="rounded border border-green-500/50 bg-green-900/20 py-2 text-xs font-bold text-green-300 hover:bg-green-900/30 disabled:opacity-40">Save depth here</button>
			</div>
		</section>

		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 space-y-2">
			<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Stage · geometry</h2>
			<div class="grid grid-cols-2 gap-2 text-xs" style="color: var(--color-tron-text-secondary)">
				<label>Cart rotation (°) <input type="number" step="0.5" min="-360" max="360" bind:value={rotationDeg} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-1 font-mono" style="color: var(--color-tron-text)" /></label>
				<label>Travel height (mm) <input type="number" step="1" min={STAGE_JUMP_LIMITS.min} max={STAGE_JUMP_LIMITS.max} bind:value={jumpHeightMm} class="mt-0.5 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-1 py-1 font-mono" style="color: var(--color-tron-text)" /></label>
			</div>
			<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">Rotation: counter-clockwise from above, about the first hole, vs a carriage slot. <strong>90° = this stage</strong>: the cart turned a quarter turn so the gates run toward you (gate 4 at the back, gate 1 nearest you) and the rows run left → right. 270° (or −90°) = the same quarter turn the other way; 0° = as on a carriage. The plane's arrows show the result; save to redraw. Travel height: the clearance the tip arrives at and leaves the cart at; lower it if the stage is tall.</p>
			<div class="grid grid-cols-3 gap-2">
				<button type="button" onclick={() => void rotateCart(-90)} disabled={busy || locked} class="rounded border border-[var(--color-tron-cyan)]/50 px-2 py-2 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-40" title="Quarter turn counter-clockwise, saved immediately">⟲ 90°</button>
				<button type="button" onclick={saveGeometry} disabled={busy || locked} class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 px-3 py-2 text-xs font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25 disabled:opacity-40">Save geometry</button>
				<button type="button" onclick={() => void rotateCart(90)} disabled={busy || locked} class="rounded border border-[var(--color-tron-cyan)]/50 px-2 py-2 text-xs text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10 disabled:opacity-40" title="Quarter turn clockwise, saved immediately">90° ⟳</button>
			</div>
		</section>

		<section class="rounded-lg border {calibration?.scanPosition ? 'border-[var(--color-tron-border)]' : 'border-amber-500/40'} bg-[var(--color-tron-surface)] p-3 space-y-2">
			<div class="flex items-center justify-between">
				<h2 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Stage · scan position</h2>
				<button type="button" onclick={fireTestScan} disabled={testScanInFlight || !runId} class="rounded border border-[var(--color-tron-cyan)] px-2 py-1 text-[11px] font-bold text-[var(--color-tron-cyan)] disabled:opacity-40">{testScanInFlight ? 'Reading…' : 'Test scan'}</button>
			</div>
			<div class="font-mono text-xs" style="color: var(--color-tron-cyan)">{calibration?.scanPosition ? `x ${fmt3(calibration.scanPosition.x)} · y ${fmt3(calibration.scanPosition.y)} · z ${fmt3(calibration.scanPosition.z)}` : 'not taught'}</div>
			<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">Where the gantry scanner reads the cart the arm placed. Jog with <strong>no tip on</strong> (the sweep runs without one), fire a test scan, save.{#if calibration?.scanPosition?.testScanBarcode} Test read <span class="font-mono">{calibration.scanPosition.testScanBarcode}</span>.{/if}</p>
			{#if testScanLatest}<div class="break-all rounded bg-black/40 p-2 font-mono text-xs" style="color: var(--color-tron-cyan)">{testScanLatest}</div>{:else if testScanError}<p class="text-[11px] text-red-300">{testScanError}</p>{/if}
			<div class="grid grid-cols-2 gap-2">
				<button type="button" onclick={() => void act(async () => { await moveAbs(calibration!.scanPosition!, { arc: true }); msg = 'At the scan position.'; await refreshPosition(); })} disabled={!pipetteId || busy || !calibration?.scanPosition} class={pad} style="color: var(--color-tron-text)">Move to</button>
				<button type="button" onclick={saveScanPosition} disabled={!pipetteId || busy || hasTip || locked} class="rounded border border-green-500/50 bg-green-900/20 py-2 text-xs font-bold text-green-300 hover:bg-green-900/30 disabled:opacity-40" title={hasTip ? 'Drop the tip first — the sweep runs without one' : ''}>Save here (no tip)</button>
			</div>
		</section>
	</div>

	<!-- History -->
	{#if calibration?.edits?.length}
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<h2 class="mb-2 text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Recent edits</h2>
			<div class="overflow-x-auto">
				<table class="w-full text-left text-[11px]">
					<thead style="color: var(--color-tron-text-secondary)"><tr><th class="px-2 py-1">Hole</th><th class="px-2 py-1">Δ (x,y,z)</th><th class="px-2 py-1">After</th><th class="px-2 py-1">What</th><th class="px-2 py-1">By</th><th class="px-2 py-1">When</th></tr></thead>
					<tbody style="color: var(--color-tron-text)">
						{#each calibration.edits as h (h._id)}
							<tr class="border-t border-[var(--color-tron-border)]">
								<td class="px-2 py-1 font-mono">{h.wellName}</td>
								<td class="px-2 py-1 font-mono">{h.delta.x}, {h.delta.y}, {h.delta.z}</td>
								<td class="px-2 py-1 font-mono">{h.after.x.toFixed(2)}, {h.after.y.toFixed(2)}, {h.after.z.toFixed(2)}</td>
								<td class="px-2 py-1" style="color: var(--color-tron-text-secondary)">{h.label ?? ''}</td>
								<td class="px-2 py-1">{h.by ?? ''}</td>
								<td class="px-2 py-1" style="color: var(--color-tron-text-secondary)">{when(h.at)}</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		</section>
	{/if}
</div>
