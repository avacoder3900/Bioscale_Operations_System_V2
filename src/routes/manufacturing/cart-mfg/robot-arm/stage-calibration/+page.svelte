<script lang="ts">
	/**
	 * Robot Arm — Stage calibration: the arm line's own calibration studio.
	 *
	 * The arm's OT-2 fills ONE cartridge on an elevated single-cart stage, so
	 * the Deck Calibration Studio (24 slots, Particle-id decks) does not fit.
	 * This page keeps the Studio's essentials — a maintenance run, pick up +
	 * probe a tip on the calibrator, a jog pad with live XYZ, move-to-hole, a
	 * fill-motion preview — and teaches what the stage protocol
	 * (protocols/Wax_Filling_GEN7_ArmStage.py) reads instead of a deck:
	 *
	 *   scan position    no tip on (the sweep runs without one)
	 *   cart location    the rim of the FIRST wax hole, with a PROBED tip on;
	 *                    stored tip-neutral (live − that tip's adjust), the
	 *                    Studio's convention, so every fill adds its own tip's
	 *                    adjust back
	 *   dispense depth   where the tip END sits when wax is dispensed, taught by
	 *                    jogging to it over the first hole (rim − live), NEW for
	 *                    the stage: the hole is 3.75 mm deep and the stage's Z
	 *                    frame is its own
	 *   stage geometry   the cart's rotation on the stage
	 *
	 * LIFT RULE: before EVERY gantry move this page makes — pick up a tip, go
	 * to the calibrator, a hole, the dispense height, drop a tip — the pipette
	 * goes ALL THE WAY UP (lift(): a Z-only home), and the move that follows is
	 * a PLANNED move (forceDirect false), which the OT-2 runs as XY at the top
	 * and then straight down. The arm and its stage stand above anything the
	 * planner knows about, so no arc height or direct move is safe here. The
	 * stage protocol does the same (lift() in Wax_Filling_GEN7_ArmStage.py).
	 *
	 * Every save is a page action; all logic is in $lib/server/arm-wax-fill.
	 */
	import { enhance, deserialize } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { RobotSession, type RobotSessionState } from '$lib/opentrons/direct-client';
	import TransportPill from '$lib/components/opentrons/TransportPill.svelte';
	import type { CalibrationView } from '$lib/server/arm-wax-fill';
	import {
		DISPENSE_DEPTH_DEFAULT_MM,
		DISPENSE_DEPTH_LIMITS,
		STAGE_PREJUMP_MM,
		WAX_HOLE_DEPTH_MM,
		depthFromLive,
		dispenseZ,
		stageTargets,
		type StageHole
	} from '$lib/robot-arm/stage-geometry';

	let { data, form } = $props();

	const WAX_FILL_HREF = '/manufacturing/cart-mfg/robot-arm/wax-fill';
	const robotId = $derived(data.robotId as string | null);
	const studioCalibratorHref = $derived(
		robotId ? `/manufacturing/cart-mfg/deck-calibration?kind=calibrator&robot=${encodeURIComponent(robotId)}` : '/manufacturing/cart-mfg/deck-calibration?kind=calibrator'
	);

	let calibration = $state<CalibrationView | null>(data.calibration);
	$effect(() => {
		calibration = data.calibration;
	});
	const rim = $derived(calibration?.cartLocation ?? null);
	const depthMm = $derived(calibration?.dispenseDepth?.mm ?? null);
	const holes = $derived<StageHole[]>(calibration?.holes ?? stageTargets(0, 0, 0, calibration?.stageRotationDeg ?? 0));
	const holesTaught = $derived(!!calibration?.holes);


	// ── page actions ─────────────────────────────────────────────────────
	async function post(name: string, fields: Record<string, string> = {}): Promise<{ ok: true; data: any } | { ok: false; error: string; status: number }> {
		const fd = new FormData();
		for (const [k, v] of Object.entries(fields)) fd.set(k, v);
		const res = await fetch(`?/${name}`, { method: 'POST', body: fd, headers: { 'x-sveltekit-action': 'true' } });
		const r = deserialize(await res.text());
		if (r.type === 'success') return { ok: true, data: r.data ?? {} };
		if (r.type === 'failure') return { ok: false, error: String((r.data as any)?.error ?? 'Failed'), status: r.status };
		if (r.type === 'error') return { ok: false, error: r.error?.message ?? 'Failed', status: r.status ?? 500 };
		return { ok: false, error: 'Unexpected response', status: 500 };
	}

	// ── robot session + maintenance run (as the scanner / barcode-positions pages) ──
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

	let maintRunId = $state<string | null>(null);
	let pipetteId = $state<string | null>(null);
	let pipetteMount = $state<string | null>(null);
	let pipetteName = $state<string | null>(null);
	let connecting = $state(false);
	let busy = $state(false);
	let errMsg = $state<string | null>(null);
	let msg = $state<string | null>(null);
	let stepSize = $state(1);
	let zAxis = $state<'leftZ' | 'rightZ'>(data.calibration?.pipetteMount === 'right' ? 'rightZ' : 'leftZ');
	let liveX = $state<number | null>(null);
	let liveY = $state<number | null>(null);
	let liveZ = $state<number | null>(null);

	// Tip state. The fill probes every tip and adds its adjust to the taught
	// point, so the cart location is saved tip-neutral with a probed tip on; the
	// scan position is saved with NO tip; the dispense depth needs a tip on
	// (it is about the tip end) but not a probe (Z is not probed).
	let hasTip = $state(false);
	let tipAdjust = $state<{ x: number; y: number } | null>(null);
	let tipWell = $state<string>(data.teach?.nextTipWell ?? 'A1');
	let calibrating = $state(false);

	let testScanInFlight = $state(false);
	let testScanError = $state<string | null>(null);
	let testScanLatest = $state<string | null>(null);

	let selectedHole = $state<string>('X2');
	let motionRunning = $state(false);

	const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
	const dis = $derived(!maintRunId || !pipetteId || busy || data.loopRunning);
	const liveDepth = $derived(rim && liveZ !== null ? depthFromLive(rim.z, liveZ) : null);
	const liveDepthOk = $derived(liveDepth !== null && liveDepth >= DISPENSE_DEPTH_LIMITS.min && liveDepth <= DISPENSE_DEPTH_LIMITS.max);

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

	const mx = (tail: string) => `/api/opentrons-lab/robots/${robotId}/maintenance/${maintRunId}/${tail}`;

	async function openMaintenance() {
		errMsg = null;
		connecting = true;
		try {
			const body: Record<string, unknown> = {};
			if (calibration?.pipetteMount) body.mount = calibration.pipetteMount;
			if (calibration?.pipetteName) body.pipetteName = calibration.pipetteName;
			const res = await api(`/api/opentrons-lab/robots/${robotId}/maintenance`, { method: 'POST', body: JSON.stringify(body) });
			maintRunId = res.runId ?? null;
			pipetteId = res.pipetteId ?? null;
			pipetteMount = res.mount ?? null;
			pipetteName = res.pipetteName ?? null;
			zAxis = pipetteMount === 'right' ? 'rightZ' : 'leftZ';
			msg = pipetteId ? `Connected: pipette ${pipetteName} on ${pipetteMount}.` : 'Maintenance run opened but no pipette could be loaded — jog will fail.';
		} catch (e) {
			errMsg = e instanceof Error ? e.message : String(e);
		} finally {
			connecting = false;
		}
	}

	async function closeMaintenance() {
		if (!maintRunId) return;
		busy = true;
		try {
			if (hasTip && pipetteId) await api(mx('drop-tip'), { method: 'POST', body: JSON.stringify({ pipetteId }) }).catch(() => null);
			await api(`/api/opentrons-lab/robots/${robotId}/maintenance/${maintRunId}`, { method: 'DELETE' });
		} catch (e) {
			errMsg = e instanceof Error ? e.message : String(e);
		} finally {
			maintRunId = pipetteId = pipetteMount = pipetteName = null;
			liveX = liveY = liveZ = null;
			hasTip = false;
			tipAdjust = null;
			busy = false;
		}
	}

	async function refreshPosition() {
		if (!maintRunId || !pipetteId) return;
		const res = await api(mx('position'), { method: 'POST', body: JSON.stringify({ pipetteId }) });
		if (res?.position) {
			liveX = res.position.x;
			liveY = res.position.y;
			liveZ = res.position.z;
		}
	}

	/** Run one gantry action with the panel locked; errors land in the banner. */
	async function act(fn: () => Promise<void>) {
		if (!maintRunId || !pipetteId) {
			errMsg = 'Open a maintenance run first.';
			return;
		}
		if (data.loopRunning) {
			errMsg = 'A wax-fill loop is running on this robot — calibration waits until it ends.';
			return;
		}
		errMsg = null;
		busy = true;
		try {
			await fn();
		} catch (e) {
			errMsg = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	const home = () =>
		act(async () => {
			await api(mx('home'), { method: 'POST', body: JSON.stringify({}) });
			await refreshPosition();
		});
	const jog = (axis: string, distance: number) =>
		act(async () => {
			await api(mx('jog'), { method: 'POST', body: JSON.stringify({ pipetteId, axis, distance }) });
			await refreshPosition();
		});
	/**
	 * ALL THE WAY UP: home only the pipette's Z axis (top of travel). Called
	 * before every move between stations; the planned move after it travels at
	 * the top and comes straight down at its target.
	 */
	async function lift() {
		await api(mx('home'), { method: 'POST', body: JSON.stringify({ axes: [zAxis] }) });
	}
	/**
	 * `lift`: lift first, then a PLANNED move (XY at the top, straight down).
	 * `direct`: a straight line from where the tip is — only for the short
	 * vertical moves over a hole, never for travel.
	 */
	async function moveAbs(p: { x: number; y: number; z: number }, opts: { lift?: boolean; direct?: boolean } = {}) {
		if (opts.lift) await lift();
		await api(mx('move-to'), {
			method: 'POST',
			body: JSON.stringify({ pipetteId, x: p.x, y: p.y, z: p.z, forceDirect: !!opts.direct })
		});
	}

	// ── tip: pick up, probe, drop ───────────────────────────────────────
	async function doPickUpTip(allowRecover = true): Promise<void> {
		await lift(); // the pick-up's own move then travels at the top
		const r = await apiRaw(mx('pick-up-tip'), { method: 'POST', body: JSON.stringify({ pipetteId, tiprackLoadName: data.teach?.tiprackLoadName, slot: '11', tipWell }) });
		if (r.ok) {
			if (r.body?.nextTipWell) tipWell = r.body.nextTipWell;
			hasTip = true;
			tipAdjust = null;
			return;
		}
		if (r.status === 409 && r.body?.code === 'TIP_ALREADY_ATTACHED' && allowRecover) {
			await lift();
			await api(mx('drop-tip'), { method: 'POST', body: JSON.stringify({ pipetteId }) });
			return doPickUpTip(false);
		}
		throw new Error(r.body?.message ?? (typeof r.body === 'string' ? r.body : `pick-up-tip HTTP ${r.status}`));
	}

	/**
	 * Pick up a p20 tip and probe it on the tip calibrator (the Studio's sequence):
	 * lift, travel to the calibrator's approach point at the top of Z, then
	 * /api/scanner/calibrate-tip attached to this maintenance run so the tip stays
	 * on. The adjust it returns is what makes the saved cart location tip-neutral.
	 */
	async function pickUpAndCalibrateTip() {
		const cal = data.teach?.calibrator;
		if (!cal) {
			errMsg = 'No tip-calibrator point is known for this robot — teach it in the Deck Calibration Studio first (link above).';
			return;
		}
		if (pipetteMount !== 'left' && pipetteMount !== 'right') {
			errMsg = 'The maintenance run reported no pipette mount — reopen it.';
			return;
		}
		calibrating = true;
		await act(async () => {
			if (!hasTip) {
				msg = `Picking up a tip (${data.teach?.tiprackLoadName} ${tipWell})…`;
				await doPickUpTip();
			}
			msg = `Lifting all the way up, then moving to the tip calibrator (${cal.x}, ${cal.y}, ${cal.approachZ})…`;
			await moveAbs({ x: cal.x, y: cal.y, z: cal.approachZ }, { lift: true });
			msg = 'Probing the tip on the calibrator (slow limit-switch probe, 1–2 min)…';
			const res = await api('/api/scanner/calibrate-tip', {
				method: 'POST',
				body: JSON.stringify({ robotId, mount: pipetteMount, tipProfile: 'wax', tipWell, runId: maintRunId, pipetteId })
			});
			if (res?.adjust && typeof res.adjust.x === 'number' && typeof res.adjust.y === 'number') {
				tipAdjust = { x: res.adjust.x, y: res.adjust.y };
				msg = `Tip calibrated: adjust x=${tipAdjust.x} y=${tipAdjust.y}. Tip kept on.`;
			} else {
				throw new Error(typeof res?.error === 'string' && res.error ? res.error : 'The probe returned no adjust — nothing taught. Calibrate again before saving the cart location.');
			}
			await refreshPosition();
		});
		calibrating = false;
	}

	const pickUpOnly = () =>
		act(async () => {
			await doPickUpTip();
			msg = `Tip on (${tipWell === 'A1' ? 'rack cursor advanced' : `next ${tipWell}`}) — not probed: fine for the dispense depth, not for the cart location.`;
			await refreshPosition();
		});

	const dropTip = () =>
		act(async () => {
			await lift();
			await api(mx('drop-tip'), { method: 'POST', body: JSON.stringify({ pipetteId }) });
			hasTip = false;
			tipAdjust = null;
			msg = 'Tip dropped in the trash.';
			await refreshPosition();
		});

	// ── the stage: visit holes, preview the fill motion ─────────────────
	const adj = () => ({ x: tipAdjust?.x ?? 0, y: tipAdjust?.y ?? 0 });

	/** 2 mm above a hole's rim — all the way up first, then straight down over it — with this tip's adjust (the fill's frame). */
	const goToHole = (h: StageHole, aboveMm = 2) =>
		act(async () => {
			if (!holesTaught) throw new Error('Teach the cart location first — the holes are laid out from it.');
			if (!hasTip) throw new Error('Pick up a tip first — the holes are taught as the tip end on the rim.');
			const a = adj();
			await moveAbs({ x: h.x + a.x, y: h.y + a.y, z: h.z + aboveMm }, { lift: true });
			selectedHole = h.name;
			msg = `${aboveMm} mm above hole ${h.name} (row ${h.row}, gate ${h.gate})${tipAdjust ? ` with this tip's adjust (${a.x}, ${a.y})` : ' — tip NOT probed, expect it off by this tip\'s bend'}.`;
			await refreshPosition();
		});

	/**
	 * The stage protocol's exact approach at one hole: all the way up, over to
	 * the hole and straight down to the pre-jump height, down to the dispense
	 * height (taught, else the protocol's default hover), dwell, back to the
	 * pre-jump height, all the way up. Dispenses nothing.
	 */
	const fillMotion = (h: StageHole) =>
		act(async () => {
			if (!holesTaught) throw new Error('Teach the cart location first.');
			if (!hasTip) throw new Error('Pick up a tip first — the motion is about the tip end.');
			motionRunning = true;
			try {
				const a = adj();
				const zd = dispenseZ(h.z, depthMm);
				const xy = { x: h.x + a.x, y: h.y + a.y };
				msg = `Fill motion at ${h.name}: all the way up → pre-jump ${STAGE_PREJUMP_MM} mm → dispense ${depthMm === null ? `${Math.abs(DISPENSE_DEPTH_DEFAULT_MM)} mm above (protocol default — depth not taught)` : `${Math.abs(depthMm)} mm ${depthMm >= 0 ? 'below' : 'above'}`} the rim → all the way up…`;
				await moveAbs({ ...xy, z: h.z + STAGE_PREJUMP_MM }, { lift: true });
				await moveAbs({ ...xy, z: zd }, { direct: true });
				await refreshPosition();
				await sleep(1500);
				await moveAbs({ ...xy, z: h.z + STAGE_PREJUMP_MM }, { direct: true });
				await lift();
				selectedHole = h.name;
				msg = `Fill motion at ${h.name} done — tip end paused at z ${zd.toFixed(2)}, pipette back at the top.`;
				await refreshPosition();
			} finally {
				motionRunning = false;
			}
		});

	/** To the dispense height over the first hole (to check or re-teach the depth): all the way up, over, straight down. */
	const goToDispenseHeight = () =>
		act(async () => {
			if (!rim) throw new Error('Teach the cart location first.');
			if (!hasTip) throw new Error('Pick up a tip first.');
			const a = adj();
			await moveAbs({ x: rim.x + a.x, y: rim.y + a.y, z: rim.z + STAGE_PREJUMP_MM }, { lift: true });
			await moveAbs({ x: rim.x + a.x, y: rim.y + a.y, z: dispenseZ(rim.z, depthMm) }, { direct: true });
			msg = depthMm === null ? `At the protocol's default (${Math.abs(DISPENSE_DEPTH_DEFAULT_MM)} mm above the rim) — jog Z and save the depth you want.` : `At the taught dispense height (${Math.abs(depthMm)} mm ${depthMm >= 0 ? 'below' : 'above'} the rim). Jog Z to change it, then save.`;
			await refreshPosition();
		});

	// ── scanner test ─────────────────────────────────────────────────────
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

	// ── saves ────────────────────────────────────────────────────────────
	async function readLive() {
		await refreshPosition();
		if (liveX === null || liveY === null || liveZ === null) throw new Error('Could not read the position from the robot.');
		return { x: liveX, y: liveY, z: liveZ };
	}

	async function applySave(r: Awaited<ReturnType<typeof post>>) {
		if (!r.ok) throw new Error(r.error);
		calibration = r.data.calibration;
		msg = r.data.success;
		await invalidateAll();
	}

	const saveScanPosition = () =>
		act(async () => {
			if (hasTip) throw new Error('Drop the tip before saving the scan position — the scanner sweep runs without one.');
			const p = await readLive();
			await applySave(await post('saveScanPosition', { x: String(p.x), y: String(p.y), z: String(p.z), pipetteMount: pipetteMount ?? '', pipetteName: pipetteName ?? '', ...(testScanLatest ? { testScanBarcode: testScanLatest } : {}) }));
		});

	const saveCartLocation = () =>
		act(async () => {
			if (!hasTip || !tipAdjust) throw new Error('Pick up a tip and calibrate it first — the cart location is saved tip-neutral (live − that tip\'s probe adjust).');
			const p = await readLive();
			await applySave(
				await post('saveCartLocation', {
					x: String(p.x),
					y: String(p.y),
					z: String(p.z),
					pipetteMount: pipetteMount ?? '',
					pipetteName: pipetteName ?? '',
					hasTip: 'true',
					adjustX: String(tipAdjust.x),
					adjustY: String(tipAdjust.y),
					tipWell
				})
			);
		});

	const saveDispenseDepth = () =>
		act(async () => {
			if (!rim) throw new Error('Teach the cart location (the rim) first.');
			if (!hasTip) throw new Error('Pick up a tip first — the depth is where the tip end sits.');
			const p = await readLive();
			await applySave(await post('saveDispenseDepth', { z: String(p.z), hasTip: 'true' }));
		});

	const fmt = (p: { x: number; y: number; z: number } | null) => (p ? `x ${p.x.toFixed(2)} · y ${p.y.toFixed(2)} · z ${p.z.toFixed(2)}` : 'not taught');
	const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '');
	const btn = 'rounded border border-[var(--color-tron-border)] px-3 py-3 text-sm hover:border-[var(--color-tron-cyan)] disabled:opacity-40';
	const small = 'rounded border px-3 py-2 text-xs disabled:opacity-40';
	const primary = `${small} bg-[var(--color-tron-cyan)] border-[var(--color-tron-cyan)] font-semibold text-white hover:bg-[var(--color-tron-cyan)]/80`;
	const plain = `${small} border-[var(--color-tron-border)] hover:border-[var(--color-tron-cyan)]`;
</script>

<div class="space-y-4">
	<div class="flex flex-wrap items-start justify-between gap-3">
		<div>
			<h2 class="text-lg font-bold" style="color: var(--color-tron-cyan)">Stage calibration{#if data.robotName} · {data.robotName}{/if}</h2>
			<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
				The arm's OT-2 fills one cart on an elevated stage, not a 24-slot deck. Taught here, per robot: the <span class="font-semibold">scan position</span> (no tip),
				the <span class="font-semibold">cart location</span> — the rim of the cart's first wax hole, with a probed tip, saved tip-neutral — the
				<span class="font-semibold">dispense depth</span> the tip end goes to in that hole, and the cart's <span class="font-semibold">rotation</span> and
				<span class="font-semibold">travel height</span>. The <a href={WAX_FILL_HREF} class="underline" style="color: var(--color-tron-cyan)">Wax fill</a> tab runs on these.
			</p>
		</div>
		<div class="flex flex-wrap items-center gap-2">
			{#if robotId}<TransportPill state={robotConn} onRetry={() => void robotSession?.retryDirect()} />{/if}
			<a href={studioCalibratorHref} class="{plain} py-1" style="color: var(--color-tron-text)" title="This robot's tip-calibrator point (approach XY, probe Z) — taught in the Deck Calibration Studio; the probe here and the stage protocol both use it">Tip calibrator (Studio)</a>
			<a href={WAX_FILL_HREF} class="{plain} py-1" style="color: var(--color-tron-text)">Wax fill</a>
		</div>
	</div>

	{#if form?.error}<div class="rounded border border-red-500/40 bg-red-900/20 p-2 text-xs text-red-300">{form.error}</div>{/if}
	{#if form?.success}<div class="rounded border border-green-500/30 bg-green-900/15 p-2 text-xs text-green-300">{form.success}</div>{/if}

	{#if !robotId}
		<section class="rounded-lg border border-amber-500/40 bg-amber-900/15 p-4 text-xs text-amber-200">
			No OT-2 is chosen for the arm yet — pick it in <a href={WAX_FILL_HREF} class="underline">Wax fill → Setup</a>, then come back here.
		</section>
	{:else}
		<!-- ── Checklist ─────────────────────────────────────────────────── -->
		<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4">
			<h3 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">What the stage protocol needs</h3>
			<ul class="mt-2 grid grid-cols-1 gap-2 text-xs md:grid-cols-2">
				{#each data.checklist as c (c.key)}
					<li class="flex gap-2 rounded border p-2 {c.ok ? 'border-green-500/30 bg-green-900/10' : 'border-amber-500/40 bg-amber-900/10'}">
						<span class="mt-0.5 text-sm leading-none {c.ok ? 'text-green-300' : 'text-amber-300'}">{c.ok ? '✓' : '○'}</span>
						<span>
							<span class="font-semibold" style="color: var(--color-tron-text)">{c.label}</span>
							<span class="block text-[11px]" style="color: var(--color-tron-text-secondary)">{c.detail}</span>
						</span>
					</li>
				{/each}
			</ul>
			{#if data.loopRunning}
				<p class="mt-2 text-[11px] text-amber-300">A wax-fill loop is running on this robot — motion here is locked until it ends.</p>
			{/if}
		</section>

		<!-- ── Maintenance run + tip ─────────────────────────────────────── -->
		<section class="rounded-lg border border-[var(--color-tron-cyan)]/30 bg-[var(--color-tron-surface)]/40 p-4 space-y-3">
			{#if errMsg}<div class="rounded border border-red-500/40 bg-red-900/20 p-2 text-xs text-red-300">{errMsg}</div>{/if}
			{#if msg}<div class="rounded border border-green-500/30 bg-green-900/15 p-2 text-xs text-green-300">{msg}</div>{/if}

			<div class="flex flex-wrap items-center justify-between gap-3">
				<div class="text-xs" style="color: var(--color-tron-text-secondary)">
					{#if maintRunId}
						Maintenance run <span class="font-mono">{maintRunId}</span>{#if pipetteName} · {pipetteName} ({pipetteMount}){/if}
						· <span class={hasTip ? 'text-green-300' : ''}>{hasTip ? (tipAdjust ? `tip on, probed (${tipAdjust.x}, ${tipAdjust.y})` : 'tip on, NOT probed') : 'no tip'}</span>
					{:else}No maintenance run open — open one to jog, pick up a tip and teach.{/if}
				</div>
				<div class="flex flex-wrap gap-2">
					{#if !maintRunId}
						<button type="button" onclick={openMaintenance} disabled={connecting || data.loopRunning}
							class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 px-4 py-2 text-sm font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25 disabled:opacity-40">
							{connecting ? 'Opening…' : 'Open maintenance run'}
						</button>
					{:else}
						<button type="button" onclick={() => void pickUpAndCalibrateTip()} disabled={dis || calibrating || !data.teach?.calibrator}
							class="rounded border border-purple-400/50 bg-purple-900/20 px-3 py-2 text-xs font-bold text-purple-200 hover:bg-purple-900/30 disabled:opacity-40"
							title="Lifts all the way up, picks up a p20 tip from slot 11, lifts again, travels to the tip calibrator and runs the slow limit-switch probe. Keeps the tip on.">
							{calibrating ? 'Calibrating…' : hasTip ? 'Re-probe this tip' : `Pick up tip (${tipWell}) + calibrate`}
						</button>
						<button type="button" onclick={() => void pickUpOnly()} disabled={dis || hasTip} class={plain} style="color: var(--color-tron-text)" title="Just a tip, no probe — enough for the dispense depth and the fill motion, not for the cart location">Pick up tip (no probe)</button>
						<button type="button" onclick={() => void dropTip()} disabled={dis || !hasTip} class="{small} border-amber-500/40 bg-amber-900/15 text-amber-300 hover:bg-amber-900/25">Drop tip</button>
						<button type="button" onclick={home} disabled={dis} class={plain} style="color: var(--color-tron-text)">Home</button>
						<button type="button" onclick={closeMaintenance} disabled={busy} class="{small} border-amber-500/40 bg-amber-900/15 text-amber-300 hover:bg-amber-900/25">Close run</button>
					{/if}
				</div>
			</div>
			{#if data.teach?.calibrator}
				<p class="text-[10px]" style="color: var(--color-tron-text-secondary)">
					Calibrator ({data.teach.calibrator.source}): x {data.teach.calibrator.x} · y {data.teach.calibrator.y} · approach z {data.teach.calibrator.approachZ} · probe z {data.teach.calibrator.probeZ}.
					Tips: {data.teach.tiprackLoadName} in slot 11, next {tipWell}.
				</p>
			{:else}
				<p class="text-[10px] text-amber-300">No tip-calibrator point for this robot — teach it in the Deck Calibration Studio before probing a tip here.</p>
			{/if}

			<div class="grid grid-cols-1 gap-4 lg:grid-cols-5">
				<!-- jog pad + live position -->
				<div class="space-y-3 lg:col-span-2">
					<div class="flex flex-wrap items-center gap-3 text-xs" style="color: var(--color-tron-text-secondary)">
						<label class="flex items-center gap-2">Step
							<select bind:value={stepSize} class="rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1 font-mono" style="color: var(--color-tron-text)">
								<option value={0.1}>0.1 mm</option><option value={0.5}>0.5 mm</option><option value={1}>1 mm</option><option value={5}>5 mm</option><option value={10}>10 mm</option><option value={25}>25 mm</option>
							</select>
						</label>
						<label class="flex items-center gap-2">Z axis
							<select bind:value={zAxis} class="rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1 font-mono" style="color: var(--color-tron-text)">
								<option value="leftZ">leftZ</option><option value="rightZ">rightZ</option>
							</select>
						</label>
					</div>
					<div class="grid grid-cols-3 gap-2">
						<div></div>
						<button type="button" disabled={dis} onclick={() => jog('y', stepSize)} class={btn} style="color: var(--color-tron-text)">Y +</button>
						<div></div>
						<button type="button" disabled={dis} onclick={() => jog('x', -stepSize)} class={btn} style="color: var(--color-tron-text)">X −</button>
						<div class="flex items-center justify-center text-[10px]" style="color: var(--color-tron-text-secondary)">deck XY</div>
						<button type="button" disabled={dis} onclick={() => jog('x', stepSize)} class={btn} style="color: var(--color-tron-text)">X +</button>
						<div></div>
						<button type="button" disabled={dis} onclick={() => jog('y', -stepSize)} class={btn} style="color: var(--color-tron-text)">Y −</button>
						<div></div>
					</div>
					<div class="grid grid-cols-2 gap-2">
						<button type="button" disabled={dis} onclick={() => jog(zAxis, stepSize)} class={btn} style="color: var(--color-tron-text)">Z + (up)</button>
						<button type="button" disabled={dis} onclick={() => jog(zAxis, -stepSize)} class={btn} style="color: var(--color-tron-text)">Z − (down)</button>
					</div>
					<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-3">
						<div class="flex items-center justify-between">
							<span class="text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Live position</span>
							<button type="button" onclick={() => void act(refreshPosition)} disabled={dis} class="text-[11px] underline disabled:opacity-40" style="color: var(--color-tron-cyan)">Refresh</button>
						</div>
						<div class="mt-2 grid grid-cols-3 gap-2 font-mono text-sm" style="color: var(--color-tron-text)">
							<span>x: {liveX !== null ? liveX.toFixed(2) : '—'}</span><span>y: {liveY !== null ? liveY.toFixed(2) : '—'}</span><span>z: {liveZ !== null ? liveZ.toFixed(2) : '—'}</span>
						</div>
						{#if rim && liveZ !== null}
							<p class="mt-1 text-[11px]" style="color: var(--color-tron-text-secondary)">
								Tip end is <span class="font-mono {liveDepthOk ? '' : 'text-amber-300'}">{Math.abs(liveDepth ?? 0).toFixed(2)} mm {(liveDepth ?? 0) >= 0 ? 'below' : 'above'}</span> the taught rim (z {rim.z.toFixed(2)}).
							</p>
						{/if}
					</div>
				</div>

				<!-- the stage: 12 holes -->
				<div class="space-y-2 lg:col-span-3">
					<div class="flex items-center justify-between">
						<span class="text-xs font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">The cart on the stage</span>
						<span class="text-[10px]" style="color: var(--color-tron-text-secondary)">
							{holesTaught ? `12 wax holes from the taught first hole · rotation ${calibration?.stageRotationDeg ?? 0}° · 6 mm per gate, 9 mm per row` : 'Holes appear once the cart location is taught'}
						</span>
					</div>
					<div class="rounded border border-[var(--color-tron-border)] bg-black/30 p-3">
						<div class="mb-1 grid grid-cols-[2.5rem_repeat(4,minmax(0,1fr))] gap-1 text-[10px] text-center" style="color: var(--color-tron-text-secondary)">
							<span></span><span>gate 4</span><span>gate 3</span><span>gate 2</span><span>gate 1</span>
						</div>
						{#each [1, 2, 3] as row (row)}
							<div class="grid grid-cols-[2.5rem_repeat(4,minmax(0,1fr))] gap-1 mb-1">
								<span class="flex items-center justify-center text-[10px]" style="color: var(--color-tron-text-secondary)">row {row}</span>
								{#each holes.filter((h) => h.row === row) as h (h.name)}
									<button type="button" onclick={() => void goToHole(h)} disabled={dis || !holesTaught || !hasTip}
										title={holesTaught ? `Move 2 mm above ${h.name}: x ${h.x} · y ${h.y} · z ${h.z}` : 'Teach the cart location first'}
										class="rounded border px-1 py-2 text-center text-[11px] disabled:opacity-40 {h.index === 0 ? 'border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15' : selectedHole === h.name ? 'border-green-500/50 bg-green-900/15' : 'border-[var(--color-tron-border)] hover:border-[var(--color-tron-cyan)]'}"
										style="color: var(--color-tron-text)">
										<span class="font-semibold">{h.name}</span>{#if h.index === 0}<span class="block text-[9px]" style="color: var(--color-tron-cyan)">first · taught</span>{:else if holesTaught}<span class="block font-mono text-[9px]" style="color: var(--color-tron-text-secondary)">{h.x.toFixed(1)}, {h.y.toFixed(1)}</span>{/if}
									</button>
								{/each}
							</div>
						{/each}
						<p class="mt-1 text-[10px]" style="color: var(--color-tron-text-secondary)">Click a hole to move 2 mm above its rim (tip on; this tip's probe adjust applied, as the fill does). The first hole is the taught one; the rest follow from the cartridge's pitch and the rotation below.</p>
					</div>
					<div class="flex flex-wrap items-center gap-2">
						<label class="flex items-center gap-2 text-xs" style="color: var(--color-tron-text-secondary)">Fill motion at
							<select bind:value={selectedHole} class="rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1 font-mono" style="color: var(--color-tron-text)">
								{#each holes as h (h.name)}<option value={h.name}>{h.name}</option>{/each}
							</select>
						</label>
						<button type="button" onclick={() => { const h = holes.find((x) => x.name === selectedHole); if (h) void fillMotion(h); }} disabled={dis || !holesTaught || !hasTip || motionRunning}
							class="{small} border-[var(--color-tron-cyan)] text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/10"
							title="The stage protocol's exact approach at this hole — all the way up, pre-jump, dispense height, dwell, pre-jump, all the way up — without dispensing">
							{motionRunning ? 'Running…' : 'Run fill motion'}
						</button>
						<span class="text-[10px]" style="color: var(--color-tron-text-secondary)">
							all the way up → {STAGE_PREJUMP_MM} mm → {depthMm === null ? `${Math.abs(DISPENSE_DEPTH_DEFAULT_MM)} mm above the rim (default, depth not taught)` : `${Math.abs(depthMm)} mm ${depthMm >= 0 ? 'below' : 'above'} the rim`} → pause → {STAGE_PREJUMP_MM} mm → all the way up
						</span>
					</div>
				</div>
			</div>
		</section>

		<!-- ── The four taught things ─────────────────────────────────────── -->
		<div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
			<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-2">
				<div class="flex items-center justify-between">
					<h3 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">1 · Scan position</h3>
					<button type="button" onclick={fireTestScan} disabled={testScanInFlight || !maintRunId}
						class="rounded border border-[var(--color-tron-cyan)] px-2 py-1 text-[11px] font-bold text-[var(--color-tron-cyan)] disabled:opacity-40">{testScanInFlight ? 'Reading…' : 'Test scan'}</button>
				</div>
				<div class="font-mono text-xs" style="color: var(--color-tron-cyan)">{fmt(calibration?.scanPosition ?? null)}</div>
				<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">
					Where the gantry scanner reads the cart the arm placed. Jog with <span class="font-semibold">no tip on</span> (the sweep runs without one), fire a test scan, save.
					{#if calibration?.scanPosition?.taughtAt}Taught {when(calibration.scanPosition.taughtAt)}{calibration.scanPosition.taughtBy ? ` by ${calibration.scanPosition.taughtBy}` : ''}.{/if}
					{#if calibration?.scanPosition?.testScanBarcode}Test read: <span class="font-mono">{calibration.scanPosition.testScanBarcode}</span>.{/if}
				</p>
				{#if testScanLatest}<div class="break-all rounded bg-black/40 p-2 font-mono text-xs" style="color: var(--color-tron-cyan)">{testScanLatest}</div>
				{:else if testScanError}<p class="text-[11px] text-red-300">{testScanError}</p>{/if}
				<div class="flex gap-2">
					<button type="button" onclick={() => void saveScanPosition()} disabled={dis || hasTip} class="{primary} flex-1" title={hasTip ? 'Drop the tip first — the sweep runs without one' : ''}>Save here as scan position</button>
					{#if calibration?.scanPosition}
						<button type="button" onclick={() => void act(async () => { await moveAbs(calibration!.scanPosition!, { lift: true }); msg = 'At the scan position.'; await refreshPosition(); })} disabled={dis} class={plain} style="color: var(--color-tron-text)">Move to</button>
					{/if}
				</div>
			</section>

			<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-2">
				<div class="flex items-center justify-between">
					<h3 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">2 · Cart location</h3>
					<span class="font-mono text-[10px] {hasTip && tipAdjust ? 'text-green-300' : ''}" style={hasTip && tipAdjust ? '' : 'color: var(--color-tron-text-secondary)'}>{hasTip ? (tipAdjust ? `probed ${tipAdjust.x}, ${tipAdjust.y}` : 'tip on · not probed') : 'no tip'}</span>
				</div>
				<div class="font-mono text-xs" style="color: var(--color-tron-cyan)">{fmt(rim)}</div>
				<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">
					The rim of the cart's <span class="font-semibold">first wax hole</span> (row 1, gate 4 — the hole a full deck calls X2). Pick up + calibrate a tip, jog the
					<span class="font-semibold">tip end</span> onto that rim, save. Stored tip-neutral (live − this tip's adjust); sent as arm_cart_x/y/z.
					{#if rim?.taughtAt}Taught {when(rim.taughtAt)}{rim.taughtBy ? ` by ${rim.taughtBy}` : ''}.{/if}
					{#if rim?.tipAdjust}Probe at teach <span class="font-mono">{rim.tipAdjust.x}, {rim.tipAdjust.y}</span>{rim.tipWell ? ` (tip ${rim.tipWell})` : ''}.{:else if rim}<span class="text-amber-300"> Taught without a probed tip — teach again.</span>{/if}
				</p>
				<div class="flex gap-2">
					<button type="button" onclick={() => void saveCartLocation()} disabled={dis || !hasTip || !tipAdjust} class="{primary} flex-1" title={!hasTip || !tipAdjust ? 'Pick up and calibrate a tip first — the point is saved tip-neutral' : ''}>Save here as cart location</button>
					{#if holesTaught}
						<button type="button" onclick={() => void goToHole(holes[0])} disabled={dis || !hasTip} class={plain} style="color: var(--color-tron-text)" title="2 mm above the taught rim, this tip's adjust applied">Move to</button>
					{/if}
				</div>
			</section>

			<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-2">
				<h3 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">3 · Dispense depth</h3>
				<div class="font-mono text-xs" style="color: var(--color-tron-cyan)">
					{#if depthMm !== null}{Math.abs(depthMm)} mm {depthMm >= 0 ? 'below' : 'above'} the rim{#if rim} · tip end at z {dispenseZ(rim.z, depthMm).toFixed(2)}{/if}{:else}not taught — the protocol would hover {Math.abs(DISPENSE_DEPTH_DEFAULT_MM)} mm above the rim{/if}
				</div>
				<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">
					How far into the first wax hole the <span class="font-semibold">tip end</span> goes when wax is dispensed (the protocol's dispense_depth). With a tip on, "Go to dispense height" puts it
					at the current value over the first hole; jog Z to where the wax should land, save. Allowed {DISPENSE_DEPTH_LIMITS.min} (hover {Math.abs(DISPENSE_DEPTH_LIMITS.min)} mm above)
					to {DISPENSE_DEPTH_LIMITS.max} mm into the {WAX_HOLE_DEPTH_MM} mm-deep hole — deeper snaps tips. Measured from the taught rim, so re-teach it if the rim moves.
					{#if calibration?.dispenseDepth?.taughtAt}Taught {when(calibration.dispenseDepth.taughtAt)}{calibration.dispenseDepth.taughtBy ? ` by ${calibration.dispenseDepth.taughtBy}` : ''}.{/if}
				</p>
				{#if rim && liveZ !== null}
					<p class="text-[11px] {liveDepthOk ? 'text-green-300' : 'text-amber-300'}">Tip end now: {Math.abs(liveDepth ?? 0).toFixed(2)} mm {(liveDepth ?? 0) >= 0 ? 'below' : 'above'} the rim{liveDepthOk ? '' : ' — outside the allowed range'}.</p>
				{/if}
				<div class="flex gap-2">
					<button type="button" onclick={() => void saveDispenseDepth()} disabled={dis || !hasTip || !rim || !liveDepthOk} class="{primary} flex-1" title={!rim ? 'Teach the cart location first' : !hasTip ? 'Pick up a tip first' : !liveDepthOk ? 'Jog within the allowed range' : ''}>Save dispense depth here</button>
					<button type="button" onclick={() => void goToDispenseHeight()} disabled={dis || !hasTip || !rim} class={plain} style="color: var(--color-tron-text)">Go to dispense height</button>
				</div>
			</section>

			<section class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-2">
				<h3 class="text-sm font-bold uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">4 · Stage geometry</h3>
				<form method="POST" action="?/saveStageGeometry" use:enhance class="space-y-3 text-xs">
					<div class="grid grid-cols-2 gap-3">
						<label class="block">
							<span style="color: var(--color-tron-text-secondary)">Cart rotation on the stage (°)</span>
							<input name="rotationDeg" type="number" step="0.5" min="-360" max="360" value={calibration?.stageRotationDeg ?? 0}
								class="mt-1 w-full rounded border border-[var(--color-tron-border)] bg-black/30 px-2 py-1.5 font-mono" style="color: var(--color-tron-text)" />
						</label>
						<div class="block text-[11px]" style="color: var(--color-tron-text-secondary)">
							<span class="block">Travel height</span>
							<span class="mt-1 block">None to set: the pipette goes <span class="font-semibold">all the way up</span> (top of Z) before every move between the tip rack, the calibrator, the tube and the cart — here and in the fill.</span>
						</div>
					</div>
					<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">
						Rotation: counter-clockwise from above, about the first hole. 0 = as in a carriage slot (gates toward −x, rows toward −y); 180 = the cart turned end for end.
						Check it by clicking holes on the map.
					</p>
					<div class="flex justify-end">
						<button type="submit" disabled={data.loopRunning} class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)]/15 px-4 py-1.5 text-xs font-bold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25 disabled:opacity-40">Save geometry</button>
					</div>
				</form>
			</section>
		</div>
	{/if}
</div>
