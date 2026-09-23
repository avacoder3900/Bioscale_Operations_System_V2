<script lang="ts">
	/**
	 * Post-Mortem Inspect — inline CV deployment point (POST-MORTEM-INSPECT,
	 * no-state-change variant).
	 *
	 * Runs AFTER a cartridge has been ran. Scan a `completed` cartridge (sticky
	 * context), photograph it (Pi WebRTC station or USB camera), POST /api/cv/capture
	 * at phase 'post_mortem', then poll /api/cv/inspections?imageId= until the deployed
	 * model's verdict lands. The photo is saved to the cartridge's photos[]; the
	 * cartridge status is NOT changed — it stays `completed`. Any model verdict is
	 * advisory only (no scan-gated accept/reject here).
	 * Capture/station plumbing mirrors /reagent-inspect (the proven implementation).
	 */
	import { onMount, onDestroy } from 'svelte';
	import PhotoAnnotatorModal from '$lib/components/PhotoAnnotatorModal.svelte';

	let { data } = $props();

	// Photo currently open in the highlight annotator (null = closed).
	let annotateUrl = $state<string | null>(null);
	let annotateImageId = $state<string | null>(null);

	// A highlight was burned into the stored photo — repoint the feed row and the
	// open modal at the new (boxed) image.
	function applyHighlightSaved(id: string, url: string) {
		feed = feed.map((r) => (r.imageId === id ? { ...r, imageUrl: url } : r));
		annotateUrl = url;
	}

	const PHASE = 'post_mortem';
	// Only ran carts (`completed`) are photographed here; the status is left as-is.
	// 'linked' is allowed so already-linked carts can still be photographed here.
	const ALLOWED_STATUSES = ['completed', 'linked'];

	// ── Sticky cartridge context ────────────────────────────────────────────
	let cartridgeId = $state<string | null>(null);
	let cartridgeStatus = $state<string | null>(null);
	let scannedAt = $state<number | null>(null);

	// Persistent red reject banner — wrong cartridge / wrong status. Cleared
	// on the next successful scan (unlike the transient flash banner).
	let rejectBanner = $state<string | null>(null);

	// Scanner-wedge buffer (hidden autofocused input)
	let scanInput = $state('');
	let scanInputEl: HTMLInputElement | null = null;
	let refocusInterval: ReturnType<typeof setInterval> | null = null;

	// Lock-in-progress guard — a scanner in sensing mode re-fires the same
	// barcode many times per second; gate to a single lookup at a time.
	let locking = $state(false);

	// ── Camera (local USB path) ─────────────────────────────────────────────
	let videoEl: HTMLVideoElement | null = null;
	let stream: MediaStream | null = null;
	let cameras = $state<MediaDeviceInfo[]>([]);
	let selectedCameraId = $state<string | null>(null);
	let cameraError = $state<string | null>(null);

	// ── Remote Pi capture station ───────────────────────────────────────────
	let selectedStationId = $state<string | null>(null);
	let ws: WebSocket | null = null;
	let pc: RTCPeerConnection | null = null;
	// Tracked separately so beforeunload + teardown can release the right
	// station even if selectedStationId has already flipped away.
	let lockedStationId: string | null = null;
	let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	const STATION_HEARTBEAT_MS = 60_000;

	// Persistent "your station went offline" banner (separate from flash).
	let stationDownAt = $state<{ name: string; at: number } | null>(null);

	// ── Transient status banner ─────────────────────────────────────────────
	let banner = $state<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
	let bannerTimer: ReturnType<typeof setTimeout> | null = null;
	function flashBanner(kind: 'ok' | 'err' | 'info', text: string, ms = 3500) {
		if (bannerTimer) clearTimeout(bannerTimer);
		banner = { kind, text };
		bannerTimer = setTimeout(() => { banner = null; }, ms);
	}

	// ── Verdict state (headline banner for the LATEST capture) ──────────────
	type Defect = string | { type?: string; location?: string; severity?: string };
	type Verdict =
		| { state: 'idle' }
		| { state: 'capturing' }
		| { state: 'polling' }
		| { state: 'pass' | 'fail'; confidence: number | null; modelVersion: string | null; defects: Defect[] }
		| { state: 'pending' }   // 30 s elapsed, inspection exists but not terminal
		| { state: 'error'; message: string }
		| { state: 'no_model' }; // captured, nothing deployed → saved without inference
	let verdict = $state<Verdict>({ state: 'idle' });
	// Shadow A/B result — small caption only, never the operator verdict.
	let shadowNote = $state<string | null>(null);
	// Monotonic token so a stale poll loop (operator captured again) can't
	// overwrite the verdict banner of the newer capture.
	let pollSeq = 0;

	function defectText(d: Defect): string {
		if (typeof d === 'string') return d;
		const parts = [d.type, d.location, d.severity].filter(Boolean);
		return parts.length > 0 ? parts.join(' · ') : JSON.stringify(d);
	}

	// ── Session feed (server-loaded 50 + live prepends) ─────────────────────
	type FeedRow = {
		key: string;                       // inspection id (server rows) or imageId (live rows)
		imageId: string | null;
		cartridgeRecordId: string | null;
		imageUrl: string | null;
		result: 'pass' | 'fail' | null;
		confidenceScore: number | null;
		modelVersion: string | null;
		status: string | null;             // 'running'|'completed'|'failed'|'pending'|'none'|…
		isShadow: boolean;
		triggeredAt: string | number | null;
		operator: string | null;
	};
	let feed = $state<FeedRow[]>(
		(data.recentInspections ?? []).map((r: any): FeedRow => ({
			key: r.id,
			imageId: r.imageId ?? null,
			cartridgeRecordId: r.cartridgeRecordId ?? null,
			imageUrl: r.imageUrl ?? null,
			result: r.result ?? null,
			confidenceScore: r.confidenceScore ?? null,
			modelVersion: r.modelVersion ?? null,
			status: r.status ?? null,
			isShadow: r.isShadow === true,
			triggeredAt: r.triggeredAt ?? null,
			operator: r.operator ?? null
		}))
	);

	function patchFeedByImage(imageId: string, patch: Partial<FeedRow>) {
		feed = feed.map((r) => (r.imageId === imageId && !r.isShadow ? { ...r, ...patch } : r));
	}

	// Submission lock so Space-spam doesn't fire multiple POSTs in flight
	let submitting = $state(false);

	// ── Helpers ─────────────────────────────────────────────────────────────
	function lastTwelve(id: string | null): string {
		return id ? id.slice(-12) : '—';
	}
	function pct(c: number | null): string {
		return c == null ? '' : `${Math.round(c * 100)}%`;
	}
	function timeLabel(t: string | number | null): string {
		if (t == null) return '—';
		const d = new Date(t);
		return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString();
	}
	// run-inference writes 'completed'; the schema enum says 'complete'.
	// Accept both so the page works against either vintage of data.
	function isDone(s: string | null | undefined): boolean {
		return s === 'completed' || s === 'complete';
	}

	// ── Scan handling ───────────────────────────────────────────────────────
	async function handleScan(rawCode: string) {
		const code = rawCode.trim();
		if (!code) return;
		if (code === cartridgeId) return; // already locked on this cartridge
		if (locking) return;              // lookup already in flight for this burst
		locking = true;

		try {
			const res = await fetch(`/api/cv/lookup-cartridge?code=${encodeURIComponent(code)}`);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				rejectBanner = body.error || `Cartridge ${code} not found in BIMS`;
				cartridgeId = null;
				cartridgeStatus = null;
				return;
			}
			const info = await res.json();
			const status: string | null = info.status ?? null;
			if (!status || !ALLOWED_STATUSES.includes(status)) {
				rejectBanner = `Cartridge ${info.cartridgeRecordId ?? code} has status "${status ?? 'unknown'}" — post-mortem inspect accepts only: ${ALLOWED_STATUSES.join(', ')}.`;
				cartridgeId = null;
				cartridgeStatus = null;
				return;
			}
			rejectBanner = null;
			cartridgeId = info.cartridgeRecordId;
			cartridgeStatus = status;
			scannedAt = Date.now();
			flashBanner('ok', `Locked on ${cartridgeId} (${status}) — press Space to capture`);
		} catch (e) {
			flashBanner('err', e instanceof Error ? e.message : 'Lookup failed');
		} finally {
			locking = false;
		}
	}

	function clearCartridge() {
		cartridgeId = null;
		cartridgeStatus = null;
		scannedAt = null;
		rejectBanner = null;
		scanInput = '';
		scanInputEl?.focus();
	}

	function onScanKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			const code = scanInput;
			scanInput = '';
			handleScan(code);
		}
	}

	function refocusScanner() {
		// Keep scanner input always focused so wedge keystrokes land in it —
		// but never steal focus from a real control mid-interaction.
		if (scanInputEl && document.activeElement !== scanInputEl) {
			const active = document.activeElement as HTMLElement;
			if (active?.tagName === 'SELECT' || active?.tagName === 'BUTTON' || active?.tagName === 'INPUT') return;
			scanInputEl.focus();
		}
	}

	/**
	 * LIZA tuning — production-validated setup for this hardware, applied on every
	 * camera start. Kept as one constant so the settings panel's Reset restores
	 * exactly what startCamera() applies.
	 */
	const LIZA_TUNING = {
		exposureMode: 'manual',
		exposureCompensation: -5,
		focusMode: 'manual',
		whiteBalanceMode: 'manual',
		colorTemperature: 4000,
		brightness: 128,
		contrast: 128,
		saturation: 128,
		sharpness: 128
	} as const;

	// ── Station capture settings (CvProject.captureSettings) ────────────────
	// The station camera cannot be driven from the browser — see cameraSource.
	// What CAN be changed is the CV project's captureSettings, which the station
	// agent applies through OpenCV (the same knobs as camera_capture.py's tuning
	// panel). These are PERSISTED and shared, and the deployed model was trained
	// against them, so saving is explicit rather than live-applied per slider.

	type CaptureSettingField = {
		key: string;
		label: string;
		min: number;
		max: number;
		step: number;
		hint?: string;
	};

	/** Ranges follow OpenCV's UVC conventions and camera_capture.py's defaults. */
	const CAPTURE_FIELDS: CaptureSettingField[] = [
		{ key: 'exposure', label: 'Exposure', min: -13, max: 0, step: 1, hint: 'OpenCV UVC scale — more negative is a shorter exposure. Default -5.' },
		{ key: 'whiteBalance', label: 'White balance', min: 2000, max: 8000, step: 100, hint: 'Kelvin. Default 4000.' },
		{ key: 'brightness', label: 'Brightness', min: 0, max: 255, step: 1 },
		{ key: 'contrast', label: 'Contrast', min: 0, max: 255, step: 1 },
		{ key: 'gain', label: 'Gain', min: 0, max: 255, step: 1, hint: 'Raises noise as well as signal. Default 0.' },
		{ key: 'sharpness', label: 'Sharpness', min: 0, max: 255, step: 1 },
		{ key: 'claheStrength', label: 'CLAHE strength', min: 0, max: 8, step: 0.1, hint: 'Local contrast in post-processing, not a camera control.' },
		{ key: 'redCorrection', label: 'Red correction', min: 0.5, max: 1.5, step: 0.01 },
		{ key: 'greenCorrection', label: 'Green correction', min: 0.5, max: 1.5, step: 0.01 },
		{ key: 'blueCorrection', label: 'Blue correction', min: 0.5, max: 1.5, step: 0.01 }
	];

	/** Projects deploying at post_mortem that carry capture settings. */
	const tunableProjects = $derived(
		(data.deployedProjects ?? []).filter((p: any) => p && p.captureSettings)
	);
	let stationProjectId = $state<string | null>(null);
	const stationProject = $derived(
		tunableProjects.find((p: any) => p.id === stationProjectId) ?? tunableProjects[0] ?? null
	);

	/** Working copy; only written back to the project on an explicit Save. */
	let stationDraft = $state<Record<string, any>>({});
	let stationDirty = $state(false);
	let stationSaving = $state(false);
	let stationMsg = $state<{ kind: 'ok' | 'err'; text: string } | null>(null);
	let stationLoadedFor: string | null = null;

	$effect(() => {
		const p = stationProject;
		if (!p) return;
		// Re-seed only when the selected project changes, so typing is not clobbered.
		if (stationLoadedFor === p.id) return;
		stationLoadedFor = p.id;
		stationDraft = { ...(p.captureSettings ?? {}) };
		stationDirty = false;
		stationMsg = null;
	});

	function setStationField(key: string, raw: string | number) {
		stationDraft = { ...stationDraft, [key]: Number(raw) };
		stationDirty = true;
		stationMsg = null;
	}

	async function saveStationSettings() {
		const p = stationProject;
		if (!p) return;
		stationSaving = true;
		stationMsg = null;
		try {
			const res = await fetch(`/api/cv/projects/${p.id}`, {
				method: 'PATCH',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ captureSettings: stationDraft })
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body?.error ?? `HTTP ${res.status}`);
			}
			stationDirty = false;
			stationMsg = {
				kind: 'ok',
				text: 'Saved. The station applies these on its next capture — nothing changes the live preview.'
			};
		} catch (e) {
			stationMsg = { kind: 'err', text: e instanceof Error ? e.message : String(e) };
		} finally {
			stationSaving = false;
		}
	}

	// ── Camera settings panel ───────────────────────────────────────────────
	// Driven by what the selected camera actually reports, not a fixed list:
	// MediaStreamTrack.getCapabilities() differs per device and per browser, and
	// the LIZA tuning below applies its values through an `advanced` array, which
	// SILENTLY DROPS anything unsupported. So a hardcoded panel would show
	// controls that quietly do nothing. Here every control is rendered from a
	// reported capability, with that camera's own min/max/step.
	//
	// Session-only: nothing is persisted. The LIZA values are marked
	// production-validated and feed a CV model, so a reload returns to them.

	/** Capability keys worth offering, in the order they are shown. */
	const TUNABLE = [
		'exposureMode', 'exposureTime', 'exposureCompensation', 'iso',
		'focusMode', 'focusDistance',
		'whiteBalanceMode', 'colorTemperature',
		'brightness', 'contrast', 'saturation', 'sharpness',
		'zoom', 'pan', 'tilt', 'torch'
		// frameRate is deliberately absent: its reported min is 0 on many cameras,
		// applying 0 stalls the track, and no later value brings it back. It is a
		// format property rather than an image setting.
	] as const;
	type TunableKey = (typeof TUNABLE)[number];

	const LABELS: Record<string, string> = {
		exposureMode: 'Exposure mode',
		exposureTime: 'Shutter (exposure time)',
		exposureCompensation: 'Exposure compensation',
		iso: 'ISO',
		focusMode: 'Focus mode',
		focusDistance: 'Focus distance',
		whiteBalanceMode: 'White balance mode',
		colorTemperature: 'Colour temperature',
		brightness: 'Brightness',
		contrast: 'Contrast',
		saturation: 'Saturation',
		sharpness: 'Sharpness',
		zoom: 'Zoom',
		pan: 'Pan',
		tilt: 'Tilt',
		torch: 'Torch'
	};

	/** Units/notes shown under a control where the raw number is misleading. */
	const HINTS: Record<string, string> = {
		exposureTime: 'In 100 µs steps — 100 = 10 ms. Needs exposure mode: manual.',
		focusDistance: 'Needs focus mode: manual.',
		colorTemperature: 'Kelvin. Needs white balance mode: manual.',
		iso: 'Many USB webcams do not expose ISO at all.'
	};

	// `stream` is deliberately not $state in this file, so the panel's visibility
	// keys off this flag instead — changing stream's reactivity would ripple
	// through the capture and Pi-station plumbing.
	let cameraLive = $state(false);
	/**
	 * Which path is feeding the preview. It matters: a Pi station's video arrives
	 * as a REMOTE WebRTC track, and getCapabilities()/applyConstraints() only ever
	 * control a local getUserMedia track. The camera is on the Pi, so there is
	 * nothing on this end to configure — the panel has to say so rather than
	 * render blank.
	 */
	let cameraSource = $state<'usb' | 'station' | null>(null);
	let settingsOpen = $state(false);
	let camCaps = $state<Record<string, any>>({});
	let camValues = $state<Record<string, any>>({});
	let camApplyError = $state<string | null>(null);

	/** Numeric range capability, e.g. { min, max, step }. */
	function isRange(c: any): boolean {
		// min === max means the camera reports the property but pins it — a slider
		// there would move and change nothing.
		return (
			c && typeof c === 'object' && !Array.isArray(c) &&
			typeof c.min === 'number' && typeof c.max === 'number' && c.max > c.min
		);
	}
	/** Enumerated capability, e.g. ['none','manual','continuous']. */
	function isEnum(c: any): boolean {
		return Array.isArray(c) && c.length > 1 && typeof c[0] === 'string';
	}
	function isBool(c: any): boolean {
		return Array.isArray(c) && c.some((v) => typeof v === 'boolean');
	}

	/** Which tunables this camera actually reports — the panel is built from this. */
	const supportedKeys = $derived(
		TUNABLE.filter((k) => {
			const c = camCaps[k];
			return isRange(c) || isEnum(c) || isBool(c);
		})
	);

	/**
	 * Everything the camera reported, formatted for display — including the
	 * properties this panel does not offer. Without it, "no adjustable settings"
	 * is indistinguishable from a broken panel, and the whole point here is to
	 * show what a given camera can actually do.
	 */
	const reportedCapabilities = $derived(
		Object.entries(camCaps)
			.filter(([k]) => k !== 'deviceId' && k !== 'groupId')
			.map(([k, v]) => {
				let shape: string;
				if (Array.isArray(v)) shape = v.join(' | ');
				else if (v && typeof v === 'object' && 'min' in v) shape = `${(v as any).min}–${(v as any).max}`;
				else shape = String(v);
				return { key: k, shape, tunable: (supportedKeys as readonly string[]).includes(k) };
			})
			.sort((a, b) => Number(b.tunable) - Number(a.tunable) || a.key.localeCompare(b.key))
	);

	function readCameraCapabilities() {
		camApplyError = null;
		const track = stream?.getVideoTracks?.()[0];
		if (!track) {
			camCaps = {};
			camValues = {};
			return;
		}
		try {
			camCaps = typeof track.getCapabilities === 'function' ? { ...track.getCapabilities() } : {};
			camValues = typeof track.getSettings === 'function' ? { ...track.getSettings() } : {};
		} catch (e) {
			// Firefox has no getCapabilities; the panel then reports nothing tunable
			// rather than pretending otherwise.
			camCaps = {};
			camValues = {};
			camApplyError = e instanceof Error ? e.message : String(e);
		}
	}

	async function applyCameraSetting(key: string, raw: string | number | boolean) {
		const track = stream?.getVideoTracks?.()[0];
		if (!track) return;
		const cap = camCaps[key];
		const value = isRange(cap) ? Number(raw) : raw;
		camApplyError = null;
		try {
			// Not `advanced`: that silently ignores whatever it cannot satisfy, which
			// is exactly the failure mode this panel exists to expose. A bare
			// constraint rejects instead, so a setting that did not take says so.
			await track.applyConstraints({ [key]: value } as MediaTrackConstraints);
			camValues = { ...camValues, ...(track.getSettings?.() ?? {}) };
		} catch (e) {
			camApplyError = `${LABELS[key] ?? key}: ${e instanceof Error ? e.message : String(e)}`;
			// Snap the control back to what the camera is really doing.
			camValues = { ...camValues, ...(track.getSettings?.() ?? {}) };
		}
	}

	/** Back to the production-validated LIZA setup, then re-read what stuck. */
	async function resetCameraTuning() {
		const track = stream?.getVideoTracks?.()[0];
		if (!track) return;
		camApplyError = null;
		try {
			await track.applyConstraints({ advanced: [LIZA_TUNING as MediaTrackConstraintSet] });
		} catch (e) {
			camApplyError = e instanceof Error ? e.message : String(e);
		}
		readCameraCapabilities();
	}

	// ── USB camera ──────────────────────────────────────────────────────────
	async function refreshCameras() {
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			cameras = devices.filter((d) => d.kind === 'videoinput');
			if (!selectedCameraId && cameras.length > 0) selectedCameraId = cameras[0].deviceId;
		} catch (e) {
			cameraError = e instanceof Error ? e.message : String(e);
		}
	}

	async function startCamera() {
		if (stream) stopCamera();
		cameraError = null;
		try {
			const constraints: MediaStreamConstraints = {
				video: selectedCameraId
					? { deviceId: { exact: selectedCameraId }, width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }
					: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
				audio: false
			};
			stream = await navigator.mediaDevices.getUserMedia(constraints);
			cameraLive = true;
			cameraSource = 'usb';

			// LIZA tuning — production-validated setup for this hardware.
			// Unsupported settings are silently skipped by the `advanced` array.
			const track = stream.getVideoTracks()[0];
			if (track) {
				try {
					await track.applyConstraints({
						advanced: [LIZA_TUNING as MediaTrackConstraintSet]
					});
				} catch (e) {
					console.warn('[post-mortem-inspect] LIZA tuning applyConstraints skipped:', e);
				}
			}

			// Populate the settings panel from this camera's real capabilities.
			readCameraCapabilities();

			if (videoEl) {
				videoEl.srcObject = stream;
				await videoEl.play();
			}
			// After permission granted, labels populate.
			await refreshCameras();
		} catch (e) {
			cameraError = e instanceof Error ? e.message : String(e);
			// Try the next camera if available
			if (cameras.length > 1 && selectedCameraId) {
				const idx = cameras.findIndex((c) => c.deviceId === selectedCameraId);
				const next = cameras[(idx + 1) % cameras.length];
				if (next && next.deviceId !== selectedCameraId) {
					selectedCameraId = next.deviceId;
					await startCamera();
				}
			}
		}
	}

	function stopCamera() {
		if (stream) {
			stream.getTracks().forEach((t) => t.stop());
			stream = null;
			cameraLive = false;
			cameraSource = null;
		}
		if (videoEl) videoEl.srcObject = null;
	}

	// ── Pi station (lock → token → WS → WebRTC) ─────────────────────────────
	async function onStationChange() {
		teardownStation();
		stationDownAt = null; // operator acknowledged by changing the dropdown
		if (selectedStationId) {
			cameraError = null;
			await connectToStation(selectedStationId);
		} else {
			await startCamera();
		}
	}

	function teardownStation() {
		if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
		if (pc) { try { pc.close(); } catch { /* */ } pc = null; }
		if (ws) { try { ws.close(); } catch { /* */ } ws = null; }
		if (stream) {
			stream.getTracks().forEach((t) => t.stop());
			stream = null;
			cameraLive = false;
			cameraSource = null;
		}
		if (videoEl) videoEl.srcObject = null;
		if (lockedStationId) {
			const releaseId = lockedStationId;
			lockedStationId = null;
			fetch(`/api/cv/stations/${encodeURIComponent(releaseId)}/lock`, { method: 'DELETE' })
				.catch(() => null);
		}
	}

	async function connectToStation(stationId: string) {
		const station = data.stations.find((s: { _id: string }) => s._id === stationId);
		if (!station) {
			flashBanner('err', `Station ${stationId} not found`);
			selectedStationId = null;
			return;
		}

		// Hard one-operator-per-station lock. 409 means another user holds it.
		try {
			const lockRes = await fetch(`/api/cv/stations/${encodeURIComponent(stationId)}/lock`, { method: 'POST' });
			if (lockRes.status === 409) {
				const body = await lockRes.json().catch(() => ({}));
				const heldBy = body?.heldBy;
				const since = heldBy?.since ? new Date(heldBy.since).toLocaleString() : 'earlier';
				flashBanner('err', `Station already in use by ${heldBy?.username ?? 'another operator'} since ${since}. Pick another station.`);
				selectedStationId = null;
				await startCamera();
				return;
			}
			if (!lockRes.ok) throw new Error(`HTTP ${lockRes.status}`);
			lockedStationId = stationId;
		} catch (e) {
			flashBanner('err', `Failed to claim station lock: ${e instanceof Error ? e.message : e}`);
			selectedStationId = null;
			await startCamera();
			return;
		}

		let token: string;
		try {
			const tokRes = await fetch(`/api/cv/stations/${encodeURIComponent(stationId)}/token`);
			if (!tokRes.ok) throw new Error(`HTTP ${tokRes.status}`);
			const tokBody = await tokRes.json();
			token = tokBody.token;
			if (!token) throw new Error('empty token');
		} catch (e) {
			flashBanner('err', `Failed to fetch station token: ${e instanceof Error ? e.message : e}`);
			selectedStationId = null;
			teardownStation();
			await startCamera();
			return;
		}

		const url = `wss://${station.hostname}/ws?token=${encodeURIComponent(token)}`;
		const sock = new WebSocket(url);
		ws = sock;

		sock.onopen = () => {
			// Heartbeat keeps the BIMS operator-lock alive (5-min server timeout).
			heartbeatInterval = setInterval(() => {
				if (sock.readyState === WebSocket.OPEN) {
					try { sock.send(JSON.stringify({ cmd: 'ping' })); } catch { /* */ }
				}
			}, STATION_HEARTBEAT_MS);
		};

		sock.onerror = () => flashBanner('err', `Station ${station.name}: WebSocket error`);
		sock.onclose = () => {
			if (selectedStationId === stationId) {
				flashBanner('err', `Station ${station.name}: connection closed`);
				stationDownAt = { name: station.name, at: Date.now() };
			}
		};

		sock.onmessage = async (ev) => {
			let msg: any;
			try { msg = JSON.parse(ev.data); } catch { return; }

			if (msg.event === 'hello') {
				try {
					await startWebRtcOffer(sock);
				} catch (e) {
					flashBanner('err', `WebRTC offer failed: ${e instanceof Error ? e.message : e}`);
				}
				return;
			}

			if (msg.event === 'sdp_answer' && pc && msg.sdp) {
				try {
					await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
				} catch (e) {
					flashBanner('err', `setRemoteDescription failed: ${e instanceof Error ? e.message : e}`);
				}
				return;
			}

			if (msg.event === 'ice_candidate' && pc && msg.candidate) {
				try {
					await pc.addIceCandidate(msg.candidate);
				} catch { /* late candidates are okay to drop */ }
				return;
			}

			// Pi scanner forwards each Enter-terminated read — same sticky-lock
			// path as the local wedge.
			if (msg.event === 'scan' && typeof msg.code === 'string') {
				handleScan(msg.code).catch(() => null);
				return;
			}
		};
	}

	async function startWebRtcOffer(sock: WebSocket) {
		const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
		pc = peer;

		// Receive-only — the Pi sends video, we don't send anything back.
		peer.addTransceiver('video', { direction: 'recvonly' });

		peer.ontrack = (event) => {
			const remoteStream = event.streams[0];
			if (!remoteStream) return;
			stream = remoteStream;
			cameraLive = true;
			cameraSource = 'station';
			// Read them anyway: a remote track reports next to nothing, and showing
			// that emptiness honestly is the point.
			readCameraCapabilities();
			if (videoEl) {
				videoEl.srcObject = remoteStream;
				videoEl.play().catch(() => null);
			}
		};

		peer.onicecandidate = (event) => {
			if (event.candidate && sock.readyState === WebSocket.OPEN) {
				sock.send(JSON.stringify({ cmd: 'ice_candidate', candidate: event.candidate.toJSON() }));
			}
		};

		const offer = await peer.createOffer();
		await peer.setLocalDescription(offer);
		if (sock.readyState === WebSocket.OPEN) {
			sock.send(JSON.stringify({ cmd: 'sdp_offer', sdp: offer.sdp }));
		}
	}

	// ── Capture → poll → (advisory) verdict ─────────────────────────────────
	async function capturePhoto() {
		if (submitting) return;
		if (!cartridgeId) {
			flashBanner('err', 'Scan a cartridge first');
			return;
		}
		if (!videoEl || !stream) {
			flashBanner('err', 'Camera not running');
			return;
		}

		submitting = true;
		const mySeq = ++pollSeq;
		verdict = { state: 'capturing' };
		shadowNote = null;
		try {
			const canvas = document.createElement('canvas');
			canvas.width = videoEl.videoWidth;
			canvas.height = videoEl.videoHeight;
			const ctx = canvas.getContext('2d');
			if (!ctx) throw new Error('canvas 2d context unavailable');
			ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

			const blob: Blob = await new Promise((resolve, reject) => {
				canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.92);
			});

			const form = new FormData();
			form.append('file', blob, 'capture.jpg');
			form.append('cartridgeId', cartridgeId);
			form.append('phase', PHASE);

			const res = await fetch('/api/cv/capture', { method: 'POST', body: form });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `HTTP ${res.status}`);
			}
			const result = await res.json();

			// Prepend live row to the session feed; the poll patches it in place.
			const row: FeedRow = {
				key: result.imageId,
				imageId: result.imageId,
				cartridgeRecordId: result.cartridgeRecordId,
				imageUrl: result.imageUrl ?? null,
				result: null,
				confidenceScore: null,
				modelVersion: null,
				status: data.modelDeployed ? 'pending' : 'none',
				isShadow: false,
				triggeredAt: Date.now(),
				operator: data.user.username,
			};
			feed = [row, ...feed];

			if (data.modelDeployed) {
				verdict = { state: 'polling' };
				pollInference(result.imageId, mySeq).catch(() => null);
			} else {
				verdict = { state: 'no_model' };
			}
			// No-state-change: the cartridge stays `completed` after the photo.
			flashBanner('ok', `Captured ${result.cartridgeImageNumber}`, 1800);
		} catch (e) {
			if (pollSeq === mySeq) verdict = { state: 'error', message: e instanceof Error ? e.message : 'Capture failed' };
			flashBanner('err', e instanceof Error ? e.message : 'Capture failed');
		} finally {
			submitting = false;
			// Refocus the scanner input so the next scan still wedges correctly.
			scanInputEl?.focus();
		}
	}

	// Poll /api/cv/inspections every 2 s for up to 30 s. The production
	// (non-shadow) inspection drives the verdict banner; a completed shadow
	// inspection only sets the small caption.
	const POLL_INTERVAL_MS = 2000;
	const MAX_POLL_MS = 30_000;
	async function pollInference(imageId: string, mySeq: number) {
		const startedAt = Date.now();
		let sawAny = false;
		while (Date.now() - startedAt < MAX_POLL_MS) {
			await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
			try {
				const res = await fetch(`/api/cv/inspections?imageId=${encodeURIComponent(imageId)}&limit=10`);
				if (!res.ok) continue;
				const body = await res.json();
				const inspections: any[] = body?.data ?? [];
				if (inspections.length > 0) sawAny = true;

				const shadow = inspections.find((i: any) => i.isShadow === true);
				if (shadow && isDone(shadow.status) && pollSeq === mySeq) {
					shadowNote = `Shadow model v${shadow.modelVersion ?? '?'}: ${String(shadow.result ?? '?').toUpperCase()}${shadow.confidenceScore != null ? ` (${Math.round(shadow.confidenceScore * 100)}%)` : ''}`;
				}

				const prod = inspections.find((i: any) => i.isShadow !== true);
				if (!prod) continue;

				if (isDone(prod.status)) {
					const confidence = typeof prod.confidenceScore === 'number' ? prod.confidenceScore : null;
					if (pollSeq === mySeq) {
						verdict = {
							state: prod.result === 'fail' ? 'fail' : 'pass',
							confidence,
							modelVersion: prod.modelVersion ?? null,
							defects: Array.isArray(prod.defects) ? prod.defects : []
						};
					}
					patchFeedByImage(imageId, {
						result: prod.result ?? null,
						confidenceScore: confidence,
						modelVersion: prod.modelVersion ?? null,
						status: prod.status
					});
					return;
				}
				if (prod.status === 'failed') {
					if (pollSeq === mySeq) {
						verdict = { state: 'error', message: prod.errorMessage ?? 'Inference failed' };
					}
					patchFeedByImage(imageId, { status: 'failed', modelVersion: prod.modelVersion ?? null });
					return;
				}
				// still queued/running — keep polling
			} catch { /* network blip — keep polling */ }
		}
		// Timed out (30 s) — inference pending; the feed row stays 'pending'.
		if (pollSeq === mySeq) verdict = sawAny ? { state: 'pending' } : (data.modelDeployed ? { state: 'pending' } : { state: 'no_model' });
	}

	// ── Keyboard: Space = capture ───────────────────────────────────────────
	function onGlobalKeydown(e: KeyboardEvent) {
		if (e.key !== ' ') return;
		const target = e.target as HTMLElement;
		// Space on a real focused control must scroll-suppress but not trigger
		// the workflow; the hidden scanner-wedge input is the exception.
		if (target !== scanInputEl &&
			(target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
			e.preventDefault();
			return;
		}
		e.preventDefault();
		capturePhoto();
	}

	function onBeforeUnload() {
		if (lockedStationId) {
			// keepalive lets the DELETE finish after the page unloads.
			fetch(`/api/cv/stations/${encodeURIComponent(lockedStationId)}/lock`, {
				method: 'DELETE',
				keepalive: true
			}).catch(() => null);
		}
	}

	onMount(() => {
		(async () => {
			await refreshCameras();
			await startCamera();
			scanInputEl?.focus();
		})();
		refocusInterval = setInterval(refocusScanner, 500);
		if (typeof window !== 'undefined') {
			window.addEventListener('beforeunload', onBeforeUnload);
		}
	});

	onDestroy(() => {
		// Svelte 5 invokes onDestroy during SSR teardown — guard window access.
		if (typeof window !== 'undefined') {
			window.removeEventListener('beforeunload', onBeforeUnload);
		}
		teardownStation();
		stopCamera();
		if (bannerTimer) clearTimeout(bannerTimer);
		if (refocusInterval) clearInterval(refocusInterval);
	});
</script>

<svelte:window onkeydown={onGlobalKeydown} />

<PhotoAnnotatorModal
	url={annotateUrl}
	imageId={annotateImageId}
	onsaved={(u) => applyHighlightSaved(annotateImageId ?? '', u)}
	onclose={() => { annotateUrl = null; annotateImageId = null; }}
/>

<div class="min-h-screen bg-[var(--color-tron-bg-primary)] p-4 sm:p-6">
	<div class="mx-auto max-w-6xl space-y-4">
		<header class="flex items-center justify-between">
			<div>
				<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Post-Mortem Inspect</h1>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">
					Scan each cartridge that has been ran, press Space to photograph it, and the deployed model's PASS/FAIL verdict appears below. The photo is saved to the cartridge — its status stays <span class="font-mono">completed</span> (post-mortem photos don't change cartridge state).
				</p>
			</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">
				Operator: <span class="text-[var(--color-tron-cyan)]">{data.user.username}</span>
			</div>
		</header>

		<!-- Deployment status: yellow notice when nothing is deployed at post_mortem -->
		{#if !data.modelDeployed}
			<div class="rounded border border-[var(--color-tron-yellow,#facc15)] bg-[rgba(250,204,21,0.08)] p-3 text-sm text-[var(--color-tron-yellow,#facc15)]">
				<span class="font-semibold">No model is deployed at the post_mortem phase — captures will save without inference.</span>
				<span class="ml-2 text-[var(--color-tron-text-secondary)]">Promote a model and add "post_mortem" to deployAtPhases under <a href="/cv/projects" class="text-[var(--color-tron-cyan)] hover:underline">/cv/projects</a> → Deployment.</span>
			</div>
		{:else}
			<div class="rounded border border-[var(--color-tron-green,#39ff14)] bg-[rgba(57,255,20,0.05)] p-2 text-xs">
				<span class="text-[var(--color-tron-green,#39ff14)]">✓ Inference active</span>
				<span class="text-[var(--color-tron-text-secondary)]"> at phase </span>
				<span class="font-mono text-[var(--color-tron-cyan)]">post_mortem</span>
				<span class="text-[var(--color-tron-text-secondary)]"> — </span>
				{#each data.deployedProjects as p, i (p.id)}
					{#if i > 0}, {/if}
					<a href={`/cv/projects/${p.id}`} class="text-[var(--color-tron-cyan)] hover:underline">{p.name}</a>
					<span class="font-mono text-[10px] text-[var(--color-tron-text-secondary)]">v{p.version}</span>
				{/each}
			</div>
		{/if}

		<!-- Persistent reject banner: cartridge missing or wrong status -->
		{#if rejectBanner}
			<div class="rounded border border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.1)] p-3 text-sm text-[var(--color-tron-red,#ff3366)]">
				<span class="font-semibold">✕ Rejected:</span> {rejectBanner}
			</div>
		{/if}

		<!-- Transient banner -->
		{#if banner}
			<div class="rounded border p-3 text-sm
				{banner.kind === 'ok' ? 'border-[var(--color-tron-green,#39ff14)] bg-[rgba(57,255,20,0.08)] text-[var(--color-tron-green,#39ff14)]' : ''}
				{banner.kind === 'err' ? 'border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.08)] text-[var(--color-tron-red,#ff3366)]' : ''}
				{banner.kind === 'info' ? 'border-[var(--color-tron-cyan)] bg-[rgba(0,255,255,0.08)] text-[var(--color-tron-cyan)]' : ''}">
				{banner.text}
			</div>
		{/if}

		<!-- Station-down banner — persistent until the dropdown changes -->
		{#if stationDownAt}
			<div class="rounded border border-[var(--color-tron-yellow,#facc15)] bg-[rgba(250,204,21,0.08)] p-3 text-sm text-[var(--color-tron-yellow,#facc15)]">
				<span class="font-semibold">Station {stationDownAt.name} went offline at {new Date(stationDownAt.at).toLocaleTimeString()}.</span>
				<span class="ml-2 text-[var(--color-tron-text-secondary)]">Pick another station from the dropdown, or wait for this one to come back online.</span>
			</div>
		{/if}

		<!-- Context bar: sticky cartridge + station + camera -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<div class="flex flex-wrap items-center gap-4">
				<div class="min-w-[200px] flex-1">
					<div class="text-xs uppercase text-[var(--color-tron-text-secondary)]">Cartridge</div>
					{#if cartridgeId}
						<div class="font-mono text-lg text-[var(--color-tron-green,#39ff14)]">🟢 {cartridgeId}</div>
						<div class="text-xs text-[var(--color-tron-text-secondary)]">
							{cartridgeStatus ?? 'unknown'}{#if scannedAt} · scanned {new Date(scannedAt).toLocaleTimeString()}{/if}
						</div>
						<button
							type="button"
							onclick={clearCartridge}
							class="mt-1 rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[10px] uppercase text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
						>
							Release
						</button>
					{:else}
						<div class="font-mono text-lg text-[var(--color-tron-red,#ff3366)]">⚠ Scan to start</div>
						<div class="text-xs text-[var(--color-tron-text-secondary)]">Accepts: {ALLOWED_STATUSES.join(' · ')}</div>
					{/if}
				</div>
				<div>
					<label for="station-sel" class="block text-xs uppercase text-[var(--color-tron-text-secondary)]">Station</label>
					<select id="station-sel" bind:value={selectedStationId} onchange={() => onStationChange()} class="tron-input">
						<option value={null}>(Local)</option>
						{#each data.stations as s (s._id)}
							{@const badge = s.status === 'online' ? '🟢' : s.status === 'degraded' ? '🟡' : '🔴'}
							{@const heldByOther = s.currentOperator && s.currentOperator._id && s.currentOperator._id !== data.user._id}
							{@const offline = s.status !== 'online' && s.status !== 'degraded'}
							{@const disabled = offline || heldByOther}
							<option value={s._id} {disabled}>
								{badge}
								{s.name}
								{#if offline}(offline){/if}
								{#if heldByOther}(in use by {s.currentOperator.username}){/if}
							</option>
						{/each}
					</select>
				</div>
				<div>
					<label for="cam-sel" class="block text-xs uppercase text-[var(--color-tron-text-secondary)]">Camera</label>
					<select id="cam-sel" bind:value={selectedCameraId} onchange={() => startCamera()} class="tron-input" disabled={!!selectedStationId}>
						{#each cameras as c (c.deviceId)}
							<option value={c.deviceId}>{c.label || `Camera ${c.deviceId.slice(0, 6)}`}</option>
						{/each}
					</select>
				</div>
			</div>
		</div>

		<!-- Video pane -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-black p-2">
			{#if cameraError}
				<div class="flex aspect-video items-center justify-center text-[var(--color-tron-red,#ff3366)]">
					{cameraError}
				</div>
			{:else}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video bind:this={videoEl} class="aspect-video w-full rounded" playsinline autoplay muted></video>
			{/if}
		</div>

		<!-- Action bar -->
		<div class="flex items-center justify-between gap-3">
			<button
				type="button"
				onclick={() => capturePhoto()}
				disabled={submitting || !stream || !cartridgeId}
				class="rounded bg-[var(--color-tron-cyan)] px-6 py-3 text-lg font-bold text-[var(--color-tron-bg-primary)] disabled:opacity-40"
			>
				{submitting ? 'Capturing…' : '📷 Capture (Space)'}
			</button>
			{#if !cartridgeId}
				<div class="text-xs text-[var(--color-tron-text-secondary)]">Scan a cartridge to enable capture</div>
			{/if}
		</div>

		<!-- Camera settings. Built from this camera's reported capabilities, so it
		     shows only controls that actually do something on this hardware. -->
		{#if cameraLive}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
				<button
					type="button"
					onclick={() => (settingsOpen = !settingsOpen)}
					class="flex w-full items-center justify-between px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
				>
					<span>
						Camera settings{cameraSource === 'station'
							? ' — station camera'
							: supportedKeys.length ? ` (${supportedKeys.length} adjustable)` : ''}
					</span>
					<span aria-hidden="true">{settingsOpen ? '▴' : '▾'}</span>
				</button>

				{#if settingsOpen}
					<div class="border-t border-[var(--color-tron-border)] p-4">
						{#if cameraSource === 'station'}
							<div class="rounded border border-[var(--color-tron-yellow,#facc15)] bg-[rgba(250,204,21,0.06)] p-3">
								<p class="text-xs text-[var(--color-tron-text-secondary)]">
									<span class="font-bold text-[var(--color-tron-yellow,#facc15)]">This is a station camera.</span>
									Its video arrives over WebRTC from the Pi, so the camera itself is on the
									station — not on this machine. Browser camera controls only reach a local
									USB camera, so nothing here can change it.
								</p>
								<p class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">
									Station capture settings live on the CV project
									(<span class="font-mono">captureSettings</span>: exposure, white balance,
									brightness, contrast, gain, sharpness), which the station agent applies
									through OpenCV. To tune this camera from the browser instead, plug it
									directly into this machine and pick it under the USB camera above.
								</p>
							</div>
							
							<!-- What CAN be changed for a station: the CV project capture settings the
							     agent applies via OpenCV. Persisted and shared, so Save is explicit. -->
							{#if stationProject}
								<div class="mt-4">
									<div class="flex flex-wrap items-center justify-between gap-2">
										<h4 class="text-sm font-bold text-[var(--color-tron-cyan)]">Station capture settings</h4>
										{#if tunableProjects.length > 1}
											<select
												class="tron-input text-xs"
												value={stationProject.id}
												onchange={(e) => (stationProjectId = e.currentTarget.value)}
											>
												{#each tunableProjects as p (p.id)}<option value={p.id}>{p.name}</option>{/each}
											</select>
										{:else}
											<span class="text-xs text-[var(--color-tron-text-secondary)]">{stationProject.name}</span>
										{/if}
									</div>

									<div class="mt-3 grid gap-4 sm:grid-cols-2">
										{#each CAPTURE_FIELDS as f (f.key)}
											<div>
												<label for="cs-{f.key}" class="block text-xs text-[var(--color-tron-text-secondary)]">{f.label}</label>
												<div class="mt-1 flex items-center gap-2">
													<input
														id="cs-{f.key}"
														type="range"
														class="w-full"
														min={f.min}
														max={f.max}
														step={f.step}
														value={stationDraft[f.key] ?? f.min}
														oninput={(e) => setStationField(f.key, e.currentTarget.value)}
													/>
													<span class="w-14 shrink-0 text-right font-mono text-xs text-[var(--color-tron-cyan)]">
														{stationDraft[f.key] ?? "—"}
													</span>
												</div>
												{#if f.hint}
													<div class="text-[10px] text-[var(--color-tron-text-secondary)]">{f.hint}</div>
												{/if}
											</div>
										{/each}
									</div>

									{#if stationMsg}
										<p class="mt-3 text-xs {stationMsg.kind === 'ok' ? 'text-[var(--color-tron-green,#39ff14)]' : 'text-[var(--color-tron-red,#ff3366)]'}">
											{stationMsg.text}
										</p>
									{/if}

									<div class="mt-3 flex flex-wrap items-center gap-3">
										<button
											type="button"
											onclick={saveStationSettings}
											disabled={!stationDirty || stationSaving}
											class="rounded bg-[var(--color-tron-cyan)] px-3 py-1.5 text-xs font-bold text-[var(--color-tron-bg-primary)] disabled:opacity-40"
										>
											{stationSaving ? 'Saving…' : stationDirty ? 'Save to project' : 'Saved'}
										</button>
										<span class="text-[10px] text-[var(--color-tron-text-secondary)]">
											Persisted on the CV project and shared by everyone using it. The deployed
											model was trained against the current values — changing them changes what
											it sees.
										</span>
									</div>
								</div>
							{/if}
						{:else if supportedKeys.length === 0}
							<p class="text-xs text-[var(--color-tron-text-secondary)]">
								This camera reports no adjustable image settings — only format properties
								like resolution. Built-in laptop webcams are usually like this; the UVC
								inspection cameras expose exposure, focus and white balance. Browsers other
								than Chrome/Edge often report nothing at all.
							</p>
						{:else}
							<div class="grid gap-4 sm:grid-cols-2">
								{#each supportedKeys as key (key)}
									{@const cap = camCaps[key]}
									<div>
										<label for="cam-{key}" class="block text-xs text-[var(--color-tron-text-secondary)]">
											{LABELS[key] ?? key}
										</label>

										{#if isEnum(cap)}
											<select
												id="cam-{key}"
												class="tron-input mt-1 w-full text-sm"
												value={camValues[key] ?? ""}
												onchange={(e) => applyCameraSetting(key, e.currentTarget.value)}
											>
												{#each cap as opt (opt)}<option value={opt}>{opt}</option>{/each}
											</select>
										{:else if isBool(cap)}
											<label class="mt-1 flex items-center gap-2 text-sm">
												<input
													id="cam-{key}"
													type="checkbox"
													checked={!!camValues[key]}
													onchange={(e) => applyCameraSetting(key, e.currentTarget.checked)}
												/>
												<span class="text-[var(--color-tron-text-secondary)]">{camValues[key] ? "on" : "off"}</span>
											</label>
										{:else}
											<div class="mt-1 flex items-center gap-2">
												<input
													id="cam-{key}"
													type="range"
													class="w-full"
													min={cap.min}
													max={cap.max}
													step={cap.step ?? 1}
													value={camValues[key] ?? cap.min}
													oninput={(e) => applyCameraSetting(key, e.currentTarget.value)}
												/>
												<span class="w-16 shrink-0 text-right font-mono text-xs text-[var(--color-tron-cyan)]">
													{camValues[key] ?? "—"}
												</span>
											</div>
											<div class="text-[10px] text-[var(--color-tron-text-secondary)]">
												range {cap.min}–{cap.max}{cap.step ? ` step ${cap.step}` : ""}
											</div>
										{/if}

										{#if HINTS[key]}
											<div class="mt-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">{HINTS[key]}</div>
										{/if}
									</div>
								{/each}
							</div>
						{/if}

						<!-- What the camera reported, adjustable or not. This is the answer to
						     "what can I change on this camera". -->
						{#if reportedCapabilities.length > 0}
							<details class="mt-4">
								<summary class="cursor-pointer text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]">
									What this camera reported ({reportedCapabilities.length})
								</summary>
								<ul class="mt-2 space-y-0.5 font-mono text-[10px]">
									{#each reportedCapabilities as c (c.key)}
										<li class={c.tunable ? "text-[var(--color-tron-cyan)]" : "text-[var(--color-tron-text-secondary)]"}>
											{c.tunable ? '●' : '○'} {c.key}: {c.shape}
										</li>
									{/each}
								</ul>
								<p class="mt-1 text-[10px] text-[var(--color-tron-text-secondary)]">
									● adjustable here · ○ reported but fixed, or a format property
								</p>
							</details>
						{/if}

						{#if camApplyError}
							<p class="mt-3 text-xs text-[var(--color-tron-red,#ff3366)]">
								The camera refused that setting — {camApplyError}
							</p>
						{/if}

						<div class="mt-4 flex items-center gap-3 border-t border-[var(--color-tron-border)] pt-3">
							<button
								type="button"
								onclick={resetCameraTuning}
								class="rounded border border-[var(--color-tron-cyan)] px-3 py-1.5 text-xs text-[var(--color-tron-cyan)] hover:bg-[rgba(0,255,255,0.1)]"
							>
								Reset to validated defaults
							</button>
							<span class="text-[10px] text-[var(--color-tron-text-secondary)]">
								Session only — not saved. Reloading restores the validated setup, which the
								CV model was tuned against.
							</span>
						</div>
					</div>
				{/if}
			</div>
		{/if}

		<!-- Verdict banner — the headline result for the LATEST capture (advisory only) -->
		{#if verdict.state !== 'idle'}
			<div class="rounded-lg border p-4
				{verdict.state === 'pass' ? 'border-[var(--color-tron-green,#39ff14)] bg-[rgba(57,255,20,0.08)]' : ''}
				{verdict.state === 'fail' || verdict.state === 'error' ? 'border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.08)]' : ''}
				{verdict.state === 'pending' ? 'border-[var(--color-tron-yellow,#facc15)] bg-[rgba(250,204,21,0.06)]' : ''}
				{verdict.state === 'polling' || verdict.state === 'capturing' ? 'border-[var(--color-tron-cyan)] bg-[rgba(0,255,255,0.05)]' : ''}
				{verdict.state === 'no_model' ? 'border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]' : ''}">
				{#if verdict.state === 'capturing'}
					<div class="animate-pulse text-lg font-bold text-[var(--color-tron-cyan)]">Uploading capture…</div>
				{:else if verdict.state === 'polling'}
					<div class="animate-pulse text-lg font-bold text-[var(--color-tron-cyan)]">Running inference…</div>
				{:else if verdict.state === 'pass'}
					<div class="flex flex-wrap items-baseline gap-3">
						<span class="text-2xl font-black text-[var(--color-tron-green,#39ff14)]">✓ PASS</span>
						{#if verdict.confidence != null}<span class="font-mono text-sm text-[var(--color-tron-green,#39ff14)]">{pct(verdict.confidence)} confidence</span>{/if}
						{#if verdict.modelVersion}<span class="font-mono text-xs text-[var(--color-tron-text-secondary)]">model v{verdict.modelVersion}</span>{/if}
					</div>
				{:else if verdict.state === 'fail'}
					<div class="flex flex-wrap items-baseline gap-3">
						<span class="text-2xl font-black text-[var(--color-tron-red,#ff3366)]">✕ FAIL</span>
						{#if verdict.confidence != null}<span class="font-mono text-sm text-[var(--color-tron-red,#ff3366)]">{pct(verdict.confidence)} confidence</span>{/if}
						{#if verdict.modelVersion}<span class="font-mono text-xs text-[var(--color-tron-text-secondary)]">model v{verdict.modelVersion}</span>{/if}
					</div>
					{#if verdict.defects.length > 0}
						<ul class="mt-2 list-inside list-disc text-sm text-[var(--color-tron-red,#ff3366)]">
							{#each verdict.defects as d, i (i)}
								<li>{defectText(d)}</li>
							{/each}
						</ul>
					{/if}
				{:else if verdict.state === 'pending'}
					<div class="text-lg font-bold text-[var(--color-tron-yellow,#facc15)]">Inference pending…</div>
					<div class="text-xs text-[var(--color-tron-text-secondary)]">No verdict within 30 s — the capture is saved and the result will land in the feed when the worker finishes.</div>
				{:else if verdict.state === 'error'}
					<div class="text-lg font-bold text-[var(--color-tron-red,#ff3366)]">Inference failed</div>
					<div class="text-xs text-[var(--color-tron-text-secondary)]">{verdict.message}</div>
				{:else if verdict.state === 'no_model'}
					<div class="text-lg font-bold text-[var(--color-tron-text-secondary)]">Captured — saved without inference</div>
					<div class="text-xs text-[var(--color-tron-text-secondary)]">No model is deployed at post_mortem.</div>
				{/if}
				{#if shadowNote}
					<div class="mt-2 text-[11px] text-[var(--color-tron-text-secondary)]">{shadowNote}</div>
				{/if}
			</div>
		{/if}

		<!-- Hidden scanner-wedge input — autofocused; refocuses every 500ms -->
		<input
			bind:this={scanInputEl}
			bind:value={scanInput}
			onkeydown={onScanKeydown}
			type="text"
			autocomplete="off"
			inputmode="none"
			class="sr-only"
			aria-hidden="true"
			tabindex="-1"
		/>

		<!-- Session feed: server-loaded 50 recent post_mortem inspections + live prepends -->
		<div>
			<h3 class="mb-2 text-sm font-semibold uppercase text-[var(--color-tron-text-secondary)]">Recent post_mortem inspections</h3>
			{#if feed.length === 0}
				<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 text-sm text-[var(--color-tron-text-secondary)]">
					No inspections yet — scan a cartridge and capture to start.
				</div>
			{:else}
				<div class="overflow-x-auto rounded-lg border border-[var(--color-tron-border)]">
					<table class="w-full text-left text-sm">
						<thead class="bg-[var(--color-tron-bg-secondary)] text-xs uppercase text-[var(--color-tron-text-secondary)]">
							<tr>
								<th class="px-3 py-2">Photo</th>
								<th class="px-3 py-2">Cartridge</th>
								<th class="px-3 py-2">Verdict</th>
								<th class="px-3 py-2">Confidence</th>
								<th class="px-3 py-2">Model</th>
								<th class="px-3 py-2">Operator</th>
								<th class="px-3 py-2">Time</th>
							</tr>
						</thead>
						<tbody>
							{#each feed as row (row.key)}
								<tr class="border-t border-[var(--color-tron-border)] bg-[var(--color-tron-bg-primary)]">
									<td class="px-3 py-2">
										{#if row.imageUrl}
											<button
												type="button"
												onclick={() => { annotateUrl = row.imageUrl; annotateImageId = row.imageId; }}
												title="Open photo to highlight"
												class="block rounded ring-offset-1 ring-offset-[var(--color-tron-bg-primary)] transition-shadow hover:ring-2 hover:ring-[var(--color-tron-yellow,#facc15)]"
											>
												<img src={row.imageUrl} alt={row.cartridgeRecordId ?? 'capture'} class="h-12 w-12 cursor-pointer rounded object-cover" loading="lazy" />
											</button>
										{:else}
											<div class="flex h-12 w-12 items-center justify-center rounded bg-[var(--color-tron-bg-tertiary)] text-[10px] text-[var(--color-tron-text-secondary)]">—</div>
										{/if}
									</td>
									<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-cyan)]" title={row.cartridgeRecordId ?? ''}>
										{lastTwelve(row.cartridgeRecordId)}
									</td>
									<td class="px-3 py-2">
										{#if isDone(row.status) && row.result === 'pass'}
											<span class="inline-block rounded bg-[var(--color-tron-green,#39ff14)] px-1.5 py-0.5 text-[10px] font-bold text-black">PASS</span>
										{:else if isDone(row.status) && row.result === 'fail'}
											<span class="inline-block rounded bg-[var(--color-tron-red,#ff3366)] px-1.5 py-0.5 text-[10px] font-bold text-white">FAIL</span>
										{:else if row.status === 'failed'}
											<span class="inline-block rounded bg-[var(--color-tron-red,#ff3366)] px-1.5 py-0.5 text-[10px] text-white">ERR</span>
										{:else if row.status === 'none'}
											<span class="inline-block rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">no model</span>
										{:else if row.status === 'pending' || row.status === 'running' || row.status === 'processing'}
											<span class="inline-block animate-pulse rounded bg-[rgba(0,255,255,0.15)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-cyan)]">Inferring…</span>
										{:else}
											<span class="inline-block rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]">{row.status ?? '—'}</span>
										{/if}
										{#if row.isShadow}
											<span class="ml-1 text-[10px] italic text-[var(--color-tron-text-secondary)]">shadow</span>
										{/if}
									</td>
									<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-text-secondary)]">{pct(row.confidenceScore) || '—'}</td>
									<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-text-secondary)]">{row.modelVersion ? `v${row.modelVersion}` : '—'}</td>
									<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{row.operator ?? '—'}</td>
									<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{timeLabel(row.triggeredAt)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	</div>
</div>
