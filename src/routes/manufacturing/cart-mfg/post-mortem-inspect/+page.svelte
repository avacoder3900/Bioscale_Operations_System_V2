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
	 * Capture/station plumbing mirrors /reagent-inspect (the proven implementation),
	 * plus /capture's fast MJPEG view + /snapshot.jpg stills for Pi stations, with
	 * automatic fallback to the WebRTC feed on agents that lack them.
	 */
	import { onMount, onDestroy } from 'svelte';
	import PhotoAnnotatorModal from '$lib/components/PhotoAnnotatorModal.svelte';
	import StationCameraSettings from '$lib/components/capture/StationCameraSettings.svelte';

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
	// Reactive so the Capture button enables when a (fallback) WebRTC stream lands.
	let stream = $state<MediaStream | null>(null);
	let cameras = $state<MediaDeviceInfo[]>([]);
	let selectedCameraId = $state<string | null>(null);
	let cameraError = $state<string | null>(null);

	// ── Station camera parameters ───────────────────────────────────────────
	// Same protocol /capture uses: the agent answers {cmd: 'get_camera_params'}
	// with {event: 'camera_params', params, known, ranges}, and each change goes
	// back as {cmd: 'set_camera_param'}. The camera lives on the Pi, so this is
	// the only route to it — browser constraints reach a local camera only.
	let cameraParams = $state<Record<string, number>>({});
	let cameraParamsKnown = $state<string[]>([]);
	let cameraParamRanges = $state<Record<string, any>>({});
	const cameraParamThrottle: Record<string, ReturnType<typeof setTimeout>> = {};

	function requestCameraParams() {
		try {
			ws?.send(JSON.stringify({ cmd: 'get_camera_params' }));
		} catch {
			// A dead socket is already surfaced by the station banner.
		}
	}

	function setCameraParam(prop: string, value: number) {
		// Optimistic, so the slider tracks the thumb; the agent's reply corrects it
		// to whatever the camera actually accepted.
		cameraParams = { ...cameraParams, [prop]: value };
		if (cameraParamThrottle[prop]) clearTimeout(cameraParamThrottle[prop]);
		cameraParamThrottle[prop] = setTimeout(() => {
			try {
				ws?.send(JSON.stringify({ cmd: 'set_camera_param', prop, value }));
			} catch {
				// As above.
			}
		}, 100);
	}

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

	// ── Fast MJPEG view + clean snapshots, with WebRTC as the safety net ────
	// Same pathway as /capture: the agent's /preview.mjpg is per-frame JPEG (no
	// VP8 motion blockiness, ~35 ms vs ~260 ms lag) and /snapshot.jpg returns a
	// camera frame that never went through the video encoder. Single-encoder
	// rule: the Pi must never run VP8 + JPEG at once (dual encode browned out
	// station 3's PSU), so WebRTC is only negotiated AFTER the MJPEG view has
	// failed — onerror, or no first frame within MJPEG_FIRST_FRAME_MS. Older
	// agents without these endpoints (e.g. station 2) land on WebRTC exactly
	// as before.
	let stationToken = $state<string | null>(null);
	let stationHostname = $state<string | null>(null);
	let mjpegError = $state(false);
	let mjpegImgEl = $state<HTMLImageElement | null>(null);
	let mjpegWatchdog: ReturnType<typeof setTimeout> | null = null;
	const MJPEG_FPS = 15;
	const MJPEG_QUALITY = 80;
	const MJPEG_FIRST_FRAME_MS = 8000;
	const WEBRTC_FALLBACK_WAIT_MS = 10_000;
	const mjpegUrl = $derived(
		stationToken && stationHostname
			? `https://${stationHostname}/preview.mjpg?token=${encodeURIComponent(stationToken)}&fps=${MJPEG_FPS}&q=${MJPEG_QUALITY}`
			: null
	);
	const mjpegShowing = $derived(!!selectedStationId && !mjpegError && !!mjpegUrl);

	function clearMjpegWatchdog() {
		if (mjpegWatchdog) { clearTimeout(mjpegWatchdog); mjpegWatchdog = null; }
	}

	// Drop the MJPEG view for this station and bring the classic WebRTC feed up.
	function fallBackToWebRtc(reason: string) {
		clearMjpegWatchdog();
		if (mjpegError) return;
		mjpegError = true;
		console.warn('[post-mortem-inspect] MJPEG fallback:', reason);
		flashBanner('info', 'Fast preview unavailable on this station — using the standard video feed.', 4000);
		startWebRtcIfNeeded();
	}

	// If the WS isn't open yet, the 'hello' handler starts the offer instead.
	function startWebRtcIfNeeded() {
		if (!pc && ws && ws.readyState === WebSocket.OPEN) {
			startWebRtcOffer(ws).catch((e) =>
				flashBanner('err', `WebRTC offer failed: ${e instanceof Error ? e.message : e}`)
			);
		}
	}

	// Arm the first-frame watchdog whenever a new MJPEG URL starts showing: a
	// stream that neither errors nor paints (stalled proxy, half-open socket)
	// must not leave the operator staring at a blank pane.
	$effect(() => {
		const url = mjpegUrl;
		clearMjpegWatchdog();
		if (!url || mjpegError) return;
		mjpegWatchdog = setTimeout(() => {
			mjpegWatchdog = null;
			if (mjpegUrl === url && !mjpegError && !(mjpegImgEl && mjpegImgEl.naturalWidth > 0)) {
				fallBackToWebRtc(`no frame within ${MJPEG_FIRST_FRAME_MS} ms`);
			}
		}, MJPEG_FIRST_FRAME_MS);
		return clearMjpegWatchdog;
	});

	async function waitForStream(ms: number): Promise<boolean> {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			if (stream && videoEl && videoEl.videoWidth > 0) return true;
			await new Promise((r) => setTimeout(r, 250));
		}
		return false;
	}

	// Snapshot auth. Station JWTs live 5 min, and the agent's 401 carries no
	// CORS header — the browser surfaces it as a network error, not a status —
	// so reactive "retry on 401" can't work. Instead keep a snapshot-only token
	// (separate from stationToken, whose change would restart the MJPEG
	// stream), re-mint it before it ages out, and retry once with a fresh one
	// on any failure.
	let snapshotToken: string | null = null;
	let snapshotTokenAt = 0;
	const SNAPSHOT_TOKEN_MAX_AGE_MS = 4 * 60_000;

	async function mintSnapshotToken(stationId: string): Promise<string | null> {
		try {
			const tokRes = await fetch(`/api/cv/stations/${encodeURIComponent(stationId)}/token`);
			if (!tokRes.ok) return null;
			const fresh = (await tokRes.json())?.token;
			if (!fresh) return null;
			snapshotToken = fresh;
			snapshotTokenAt = Date.now();
			return fresh;
		} catch {
			return null;
		}
	}

	// /snapshot.jpg — a clean camera frame. Returns null on any failure; the
	// caller then falls back to the WebRTC feed.
	async function fetchStationSnapshot(stationId: string): Promise<Blob | null> {
		const hostname = stationHostname;
		if (!hostname) return null;
		const attempt = async (token: string): Promise<Blob | null> => {
			try {
				const res = await fetch(
					`https://${hostname}/snapshot.jpg?token=${encodeURIComponent(token)}&q=92`,
					{ cache: 'no-store' }
				);
				if (!res.ok) {
					console.warn('[post-mortem-inspect] snapshot failed: HTTP', res.status);
					return null;
				}
				const blob = await res.blob();
				return blob.size > 0 ? blob : null;
			} catch (e) {
				console.warn('[post-mortem-inspect] snapshot failed:', e);
				return null;
			}
		};

		const fresh = snapshotToken && Date.now() - snapshotTokenAt < SNAPSHOT_TOKEN_MAX_AGE_MS;
		const token = fresh ? snapshotToken : await mintSnapshotToken(stationId);
		if (!token) return null;
		const blob = await attempt(token);
		if (blob) return blob;
		// One retry with a brand-new token (covers expiry and clock skew).
		const retryToken = await mintSnapshotToken(stationId);
		return retryToken ? attempt(retryToken) : null;
	}

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

			// LIZA tuning — production-validated setup for this hardware.
			// Unsupported settings are silently skipped by the `advanced` array.
			const track = stream.getVideoTracks()[0];
			if (track) {
				try {
					await track.applyConstraints({
						advanced: [
							{
								exposureMode: 'manual',
								exposureCompensation: -5,
								focusMode: 'manual',
								whiteBalanceMode: 'manual',
								colorTemperature: 4000,
								brightness: 128,
								contrast: 128,
								saturation: 128,
								sharpness: 128
							} as MediaTrackConstraintSet
						]
					});
				} catch (e) {
					console.warn('[post-mortem-inspect] LIZA tuning applyConstraints skipped:', e);
				}
			}

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
		clearMjpegWatchdog();
		// Nulling these unmounts the MJPEG <img>, which closes its stream.
		stationToken = null;
		stationHostname = null;
		mjpegError = false;
		snapshotToken = null;
		snapshotTokenAt = 0;
		if (pc) { try { pc.close(); } catch { /* */ } pc = null; }
		if (ws) { try { ws.close(); } catch { /* */ } ws = null; }
		if (stream) {
			stream.getTracks().forEach((t) => t.stop());
			stream = null;
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
			// Starts the MJPEG view; WebRTC waits until it has failed.
			mjpegError = false;
			stationToken = token;
			stationHostname = station.hostname;
			snapshotToken = token;
			snapshotTokenAt = Date.now();
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

			if (msg.event === 'camera_params' && msg.params) {
				cameraParams = msg.params;
				cameraParamsKnown = Array.isArray(msg.known) ? msg.known : Object.keys(msg.params);
				cameraParamRanges = msg.ranges && typeof msg.ranges === 'object' ? msg.ranges : {};
				return;
			}

			if (msg.event === 'camera_param_set' && typeof msg.prop === 'string') {
				cameraParams = { ...cameraParams, [msg.prop]: msg.value };
				return;
			}

			if (msg.event === 'hello') {
				// The agent only volunteers these on request.
				requestCameraParams();
				// Single-encoder: negotiate WebRTC only if the MJPEG view already
				// failed; otherwise fallBackToWebRtc() starts it if/when it does.
				if (mjpegError && !pc) {
					try {
						await startWebRtcOffer(sock);
					} catch (e) {
						flashBanner('err', `WebRTC offer failed: ${e instanceof Error ? e.message : e}`);
					}
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
		// While the MJPEG view is showing there is no WebRTC stream to canvas —
		// the photo comes from the agent's /snapshot.jpg instead.
		if (!mjpegShowing && (!videoEl || !stream)) {
			flashBanner('err', 'Camera not running');
			return;
		}

		submitting = true;
		const mySeq = ++pollSeq;
		verdict = { state: 'capturing' };
		shadowNote = null;
		try {
			let blob: Blob | null = null;

			if (mjpegShowing && selectedStationId) {
				blob = await fetchStationSnapshot(selectedStationId);
				if (!blob) {
					// Snapshot didn't work on this station — switch to the classic
					// feed and take this same photo from it once it's up.
					fallBackToWebRtc('snapshot unavailable');
					if (!(await waitForStream(WEBRTC_FALLBACK_WAIT_MS))) {
						throw new Error('Station photo failed and the standard video feed did not start — try again');
					}
				}
			}

			if (!blob) {
				if (!videoEl || !stream) throw new Error('Camera not running');
				const canvas = document.createElement('canvas');
				canvas.width = videoEl.videoWidth;
				canvas.height = videoEl.videoHeight;
				const ctx = canvas.getContext('2d');
				if (!ctx) throw new Error('canvas 2d context unavailable');
				ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

				blob = await new Promise<Blob>((resolve, reject) => {
					canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/jpeg', 0.92);
				});
			}

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
				<p class="text-xs text-[var(--color-tron-text-secondary)] [@media(pointer:coarse)]:hidden">
					Scan each cartridge that has been ran, press Space to photograph it, and the deployed model's PASS/FAIL verdict appears below. The photo is saved to the cartridge — its status stays <span class="font-mono">completed</span> (post-mortem photos don't change cartridge state).
				</p>
			</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">
				Operator: <span class="text-[var(--color-tron-cyan)]">{data.user.username}</span>
			</div>
		</header>

		<!-- Deployment status: yellow notice when nothing is deployed at post_mortem.
		     Desktop shows it here; touch devices show it below the camera settings. -->
		{#snippet deploymentStatus()}
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
		{/snippet}
		<div class="[@media(pointer:coarse)]:hidden">{@render deploymentStatus()}</div>

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

		<!-- Context bar + video + action bar. On touch devices (tablets) this becomes
		     a grid: a narrow vertical Capture bar (1/16 of the screen width) left of
		     the video, with the context bar spanning below. Desktop keeps DOM order. -->
		<div class="space-y-4 [@media(pointer:coarse)]:grid [@media(pointer:coarse)]:grid-cols-[6.25vw_1fr] [@media(pointer:coarse)]:gap-4 [@media(pointer:coarse)]:space-y-0">
		<!-- Context bar: sticky cartridge + station + camera -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 [@media(pointer:coarse)]:col-span-2 [@media(pointer:coarse)]:row-start-2">
			<div class="flex flex-wrap items-center gap-4">
				<div class="min-w-[200px] flex-1">
					<div class="text-xs uppercase text-[var(--color-tron-text-secondary)]">Cartridge</div>
					{#if cartridgeId}
						<div class="font-mono text-lg text-[var(--color-tron-green,#39ff14)] [@media(pointer:coarse)]:text-xs">🟢 {cartridgeId}</div>
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
				<div class="[@media(pointer:coarse)]:hidden">
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
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-black p-2 [@media(pointer:coarse)]:col-start-2 [@media(pointer:coarse)]:row-start-1">
			{#if cameraError}
				<div class="flex aspect-video items-center justify-center text-[var(--color-tron-red,#ff3366)]">
					{cameraError}
				</div>
			{:else}
				{#if mjpegShowing}
					<!-- Fast MJPEG view. The <video> below stays mounted but hidden;
					     it takes over (WebRTC) if this errors or never paints. -->
					<img
						bind:this={mjpegImgEl}
						src={mjpegUrl}
						alt="Live station preview"
						class="aspect-video w-full rounded object-contain"
						onload={clearMjpegWatchdog}
						onerror={() => fallBackToWebRtc('preview stream error')}
					/>
				{/if}
				<!-- svelte-ignore a11y_media_has_caption -->
				<video bind:this={videoEl} class="aspect-video w-full rounded {mjpegShowing ? 'hidden' : ''}" playsinline autoplay muted></video>
			{/if}
		</div>

		<!-- Action bar. On touch devices (tablets) the button is a full-height
		     vertical bar left of the video showing only the camera emoji (no
		     keyboard, so no "(Space)"), and the scan hint is hidden. -->
		<div class="flex items-center justify-between gap-3 [@media(pointer:coarse)]:col-start-1 [@media(pointer:coarse)]:row-start-1 [@media(pointer:coarse)]:items-stretch">
			<button
				type="button"
				onclick={() => capturePhoto()}
				disabled={submitting || (!stream && !mjpegShowing) || !cartridgeId}
				aria-label="Capture"
				class="rounded bg-[var(--color-tron-cyan)] px-6 py-3 text-lg font-bold text-[var(--color-tron-bg-primary)] disabled:opacity-40 [@media(pointer:coarse)]:w-full [@media(pointer:coarse)]:px-0 [@media(pointer:coarse)]:text-3xl"
			>
				<span class="[@media(pointer:coarse)]:hidden">{submitting ? 'Capturing…' : '📷 Capture (Space)'}</span>
				<span class="hidden [@media(pointer:coarse)]:inline {submitting ? 'animate-pulse' : ''}">📷</span>
			</button>
			{#if !cartridgeId}
				<div class="text-xs text-[var(--color-tron-text-secondary)] [@media(pointer:coarse)]:hidden">Scan a cartridge to enable capture</div>
			{/if}
		</div>
		</div>

		<!-- Station camera tuning. Only for a Pi station: the camera is on the
		     Pi, so this is the only route to it. -->
		{#if selectedStationId}
			<StationCameraSettings
				params={cameraParams}
				ranges={cameraParamRanges}
				known={cameraParamsKnown}
				onSet={setCameraParam}
				onRefresh={requestCameraParams}
			/>
		{/if}
		<div class="hidden [@media(pointer:coarse)]:block">{@render deploymentStatus()}</div>

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
