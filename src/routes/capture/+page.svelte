<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import jsQR from 'jsqr';

	let { data } = $props();

	// Sticky cartridge context
	let cartridgeId = $state<string | null>(null);
	let cartridgeStatus = $state<string | null>(null);
	let cartridgePhotoCount = $state<number>(0);
	let scannedAt = $state<number | null>(null);

	// Phase selection — server preselects from ?phase= URL param when arriving
	// from a project's "Capture cartridges" deep link, otherwise defaults.
	let phase = $state<string>(data.initialPhase ?? 'wax_filled');

	// Scanner-wedge buffer
	let scanInput = $state('');
	let scanInputEl: HTMLInputElement | null = null;

	// Camera
	let videoEl: HTMLVideoElement | null = null;
	let stream: MediaStream | null = null;
	let cameras = $state<MediaDeviceInfo[]>([]);
	let selectedCameraId = $state<string | null>(null);
	let cameraError = $state<string | null>(null);

	// Remote Pi capture station. null = local USB camera (today's path).
	// A real id swaps the video source to a WebRTC stream from that Pi —
	// see onStationChange() and connectToStation().
	let selectedStationId = $state<string | null>(null);
	let ws: WebSocket | null = null;
	let pc: RTCPeerConnection | null = null;
	// Tracked separately so beforeunload + teardown can release the right
	// station even if selectedStationId has already flipped away.
	let lockedStationId: string | null = null;
	let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	const STATION_HEARTBEAT_MS = 60_000;

	// Status / messaging
	let banner = $state<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
	let bannerTimer: ReturnType<typeof setTimeout> | null = null;
	function flashBanner(kind: 'ok' | 'err' | 'info', text: string, ms = 3500) {
		if (bannerTimer) clearTimeout(bannerTimer);
		banner = { kind, text };
		bannerTimer = setTimeout(() => { banner = null; }, ms);
	}

	// Just-captured strip (newest first, max 10). `inference` is filled in
	// async after capture — runPhaseInference is fire-and-forget on the server,
	// so we poll /api/cv/inspections?imageId=X until status flips.
	type InferenceState =
		| { status: 'pending' | 'running' }
		| { status: 'completed'; result: 'pass' | 'fail'; confidence: number | null }
		| { status: 'failed'; errorMessage?: string }
		| { status: 'none' };
	type Capture = {
		id: string;
		cartridgeImageNumber: string;
		phase: string;
		capturedAt: number;
		url: string | null;
		inference: InferenceState;
	};
	let recentCaptures = $state<Capture[]>([]);

	function patchInference(imageId: string, inf: InferenceState) {
		recentCaptures = recentCaptures.map(c => c.id === imageId ? { ...c, inference: inf } : c);
	}

	// Poll /api/cv/inspections until the (production, non-shadow) inspection for
	// this capture lands in a terminal state. If nothing exists after MAX_POLL_MS
	// we assume no project is deployed at this phase ('none').
	const POLL_INTERVAL_MS = 1500;
	const MAX_POLL_MS = 20000;
	async function pollInference(imageId: string) {
		const startedAt = Date.now();
		let sawAny = false;
		while (Date.now() - startedAt < MAX_POLL_MS) {
			await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
			// Stop if the capture got deleted by a retake.
			if (!recentCaptures.find(c => c.id === imageId)) return;
			try {
				const res = await fetch(`/api/cv/inspections?imageId=${encodeURIComponent(imageId)}&limit=10`);
				if (!res.ok) continue;
				const body = await res.json();
				const inspections: any[] = body?.data ?? [];
				const prod = inspections.find((i: any) => !i.isShadow) ?? inspections[0];
				if (!prod) continue;
				sawAny = true;
				if (prod.status === 'completed') {
					patchInference(imageId, {
						status: 'completed',
						result: prod.result,
						confidence: typeof prod.confidenceScore === 'number' ? prod.confidenceScore : null
					});
					return;
				}
				if (prod.status === 'failed') {
					patchInference(imageId, { status: 'failed', errorMessage: prod.errorMessage });
					return;
				}
				patchInference(imageId, { status: 'running' });
			} catch { /* network blip — keep polling */ }
		}
		patchInference(imageId, sawAny
			? { status: 'failed', errorMessage: 'Inference timed out' }
			: { status: 'none' }
		);
	}

	// Submission lock so Space-spam doesn't fire multiple POSTs in flight
	let submitting = $state(false);

	// 2-photo workflow per cartridge: photo 1 = front, photo 2 = back.
	// After both are taken, the next capture attempt opens the retake dialog.
	type SessionPhoto = { id: string; cartridgeImageNumber: string };
	let sessionPhotos = $state<SessionPhoto[]>([]);
	let showRetakeDialog = $state(false);
	let retakeInProgress = $state(false);
	const PHOTOS_PER_CARTRIDGE = 2;

	let refocusInterval: ReturnType<typeof setInterval> | null = null;

	// Camera-driven auto-scan: jsQR decodes the live video feed every ~2s.
	// New code → handleScan('auto') locks the cartridge + starts a fresh photo session.
	// Same code as currently locked → no-op. The USB handheld scanner still works in parallel.
	// jsQR is the universal path because Chrome's native BarcodeDetector is not exposed on Windows.
	let scanLoopInterval: ReturnType<typeof setInterval> | null = null;
	let scanCanvas: HTMLCanvasElement | null = null;
	let lastAutoScanCode: string | null = null;
	const AUTO_SCAN_INTERVAL_MS = 2000;
	const SCAN_DOWNSAMPLE_WIDTH = 640;  // jsQR scales linearly with pixel count; 640 wide is enough for typical QRs

	async function refreshCameras() {
		try {
			const devices = await navigator.mediaDevices.enumerateDevices();
			cameras = devices.filter(d => d.kind === 'videoinput');
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

			// LIZA tuning panel from camera_capture.py — the production-validated
			// setup for this hardware. Manual exposure / focus / WB are the
			// latency-relevant ones (no auto-adjust pumping between frames).
			// Settings the camera doesn't support are silently skipped by the
			// `advanced` array, so this is safe across different webcams.
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
					console.warn('[capture] LIZA tuning applyConstraints skipped:', e);
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
				const idx = cameras.findIndex(c => c.deviceId === selectedCameraId);
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
			stream.getTracks().forEach(t => t.stop());
			stream = null;
		}
		if (videoEl) videoEl.srcObject = null;
	}

	// Swap the video source when the operator picks a remote Pi station.
	// Drops the local camera, fetches the station token, opens a /ws
	// WebSocket to the Pi, negotiates WebRTC, and attaches the remote
	// MediaStream to videoEl. Going back to "(Local)" tears everything
	// down and restores the USB-camera path verbatim. jsQR auto-scan +
	// capturePhoto both read from `videoEl` and gate on `stream`, so we
	// assign the remote MediaStream into `stream` to keep them working
	// unchanged.
	async function onStationChange() {
		teardownStation();
		if (selectedStationId) {
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
			stream.getTracks().forEach(t => t.stop());
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
			// Heartbeat keeps the BIMS operator-lock alive (5-min server timeout)
			// and lets the Pi notice the operator went away cleanly.
			heartbeatInterval = setInterval(() => {
				if (sock.readyState === WebSocket.OPEN) {
					try { sock.send(JSON.stringify({ cmd: 'ping' })); } catch { /* */ }
				}
			}, STATION_HEARTBEAT_MS);
		};

		sock.onerror = () => flashBanner('err', `Station ${station.name}: WebSocket error`);
		sock.onclose = () => {
			// If the user is still on this station, surface that the link dropped.
			if (selectedStationId === stationId) {
				flashBanner('err', `Station ${station.name}: connection closed`);
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
				} catch { /* best effort — late candidates are okay to drop */ }
				return;
			}

			// Pi scanner forwards each Enter-terminated read as a single event.
			// Funnel into the same handleScan path the local USB scanner uses;
			// 'auto' source debounces same-cartridge re-fires (matches jsQR
			// behavior so a scan that's already locked is a no-op).
			if (msg.event === 'scan' && typeof msg.code === 'string') {
				handleScan(msg.code, 'auto').catch(() => null);
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

	const SCAN_TO_CAPTURE_DELAY_MS = 1000;

	async function handleScan(rawCode: string, source: 'handheld' | 'auto' = 'handheld') {
		const code = rawCode.trim();
		if (!code) return;

		// Same code as currently locked → strict no-op for ANY source.
		// Subsumes the old auto-scan dedupe AND the handheld-retake branch:
		// double-triggering the wedge scanner or leaving a cartridge in frame
		// must never re-capture or pop the retake dialog. Retakes are explicit
		// via the dialog that opens on the 3rd manual capture attempt.
		if (code === cartridgeId) return;

		try {
			const res = await fetch(`/api/cv/lookup-cartridge?code=${encodeURIComponent(code)}`);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				flashBanner('err', body.error || `Cartridge ${code} not found in BIMS`);
				cartridgeId = null;
				cartridgeStatus = null;
				cartridgePhotoCount = 0;
				return;
			}
			const data = await res.json();
			cartridgeId = data.cartridgeRecordId;
			cartridgeStatus = data.status ?? null;
			cartridgePhotoCount = data.photoCount ?? 0;
			scannedAt = Date.now();
			sessionPhotos = [];
			retakeInProgress = false;
			showRetakeDialog = false;
			flashBanner('ok', `Locked on ${cartridgeId} — ${cartridgePhotoCount} prior photos`);

			// Auto-capture photo #1 (front) after a 1s pause so the operator has
			// time to settle the cartridge in frame. Photo #2 (back) stays manual
			// via Space / capture button.
			if (videoEl && stream && cartridgeId) {
				setTimeout(() => { capturePhoto().catch(() => null); }, SCAN_TO_CAPTURE_DELAY_MS);
			}
		} catch (e) {
			flashBanner('err', e instanceof Error ? e.message : 'Lookup failed');
		}
	}

	function snapshotFrame(): Blob | null {
		if (!videoEl || !stream) return null;
		const canvas = document.createElement('canvas');
		canvas.width = videoEl.videoWidth;
		canvas.height = videoEl.videoHeight;
		const ctx = canvas.getContext('2d');
		if (!ctx) return null;
		ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);
		return null; // placeholder; we use toBlob below in capturePhoto
	}

	async function capturePhoto() {
		if (submitting) return;
		if (!cartridgeId) {
			flashBanner('err', 'Scan a cartridge first');
			return;
		}
		if (sessionPhotos.length >= PHOTOS_PER_CARTRIDGE) {
			showRetakeDialog = true;
			return;
		}
		if (!videoEl || !stream) {
			flashBanner('err', 'Camera not running');
			return;
		}

		submitting = true;
		try {
			const canvas = document.createElement('canvas');
			canvas.width = videoEl.videoWidth;
			canvas.height = videoEl.videoHeight;
			const ctx = canvas.getContext('2d');
			if (!ctx) throw new Error('canvas 2d context unavailable');
			ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

			const blob: Blob = await new Promise((resolve, reject) => {
				canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/jpeg', 0.92);
			});

			const form = new FormData();
			form.append('file', blob, `capture.jpg`);
			form.append('cartridgeId', cartridgeId);
			form.append('phase', phase);

			const res = await fetch('/api/cv/capture', { method: 'POST', body: form });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `HTTP ${res.status}`);
			}
			const result = await res.json();

			// Push to recent captures. Inference starts as 'pending'; pollInference
			// runs in the background and patches the entry when the result lands.
			const cap: Capture = {
				id: result.imageId,
				cartridgeImageNumber: result.cartridgeImageNumber,
				phase: result.phase,
				capturedAt: Date.now(),
				url: result.imageUrl,
				inference: { status: 'pending' }
			};
			recentCaptures = [cap, ...recentCaptures].slice(0, 10);
			pollInference(result.imageId).catch(() => null);
			cartridgePhotoCount += 1;
			sessionPhotos = [...sessionPhotos, { id: result.imageId, cartridgeImageNumber: result.cartridgeImageNumber }];
			const retakeComplete = retakeInProgress && sessionPhotos.length >= PHOTOS_PER_CARTRIDGE;
			if (retakeComplete) {
				flashBanner('ok', 'Retake complete — ready for next cartridge', 2400);
				setTimeout(() => clearCartridgeForNext(), 100);
			} else {
				flashBanner('ok', `Captured ${result.cartridgeImageNumber} (${sessionPhotos.length}/${PHOTOS_PER_CARTRIDGE})`, 1800);
			}
		} catch (e) {
			flashBanner('err', e instanceof Error ? e.message : 'Capture failed');
		} finally {
			submitting = false;
			// Refocus the scanner input so the next scan still wedges correctly.
			scanInputEl?.focus();
		}
	}

	async function retakeAll() {
		showRetakeDialog = false;
		const ids = sessionPhotos.map(p => p.id);
		sessionPhotos = [];
		retakeInProgress = true;
		for (const id of ids) {
			try {
				await fetch(`/api/cv/images/${id}`, { method: 'DELETE' });
			} catch { /* best effort */ }
		}
		recentCaptures = recentCaptures.filter(c => !ids.includes(c.id));
		flashBanner('info', 'Retake all — capture 2 new photos');
	}

	async function retakeSecond() {
		showRetakeDialog = false;
		const second = sessionPhotos[1];
		if (!second) return;
		sessionPhotos = [sessionPhotos[0]];
		retakeInProgress = true;
		try {
			await fetch(`/api/cv/images/${second.id}`, { method: 'DELETE' });
		} catch { /* best effort */ }
		recentCaptures = recentCaptures.filter(c => c.id !== second.id);
		flashBanner('info', 'Retake 2nd — capture the back photo');
	}

	function cancelRetake() {
		showRetakeDialog = false;
	}

	function clearCartridgeForNext() {
		cartridgeId = null;
		cartridgeStatus = null;
		cartridgePhotoCount = 0;
		sessionPhotos = [];
		retakeInProgress = false;
		showRetakeDialog = false;
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

	function onGlobalKeydown(e: KeyboardEvent) {
		if (e.key !== ' ') return;
		const target = e.target as HTMLElement;
		// The hidden scanner-wedge input is kept focused by refocusScanner(),
		// so without this exception Space never reaches capturePhoto.
		if (target === scanInputEl) {
			e.preventDefault();
			capturePhoto();
			return;
		}
		if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
		e.preventDefault();
		capturePhoto();
	}

	function refocusScanner() {
		// Keep scanner input always focused so wedge keystrokes land in it.
		if (scanInputEl && document.activeElement !== scanInputEl) {
			// Don't steal focus from the camera selector or phase dropdown.
			const active = document.activeElement as HTMLElement;
			if (active?.tagName === 'SELECT' || active?.tagName === 'BUTTON') return;
			scanInputEl.focus();
		}
	}

	function autoScanTick() {
		if (!videoEl || !stream || submitting || showRetakeDialog) return;
		if (videoEl.videoWidth === 0) return;

		if (!scanCanvas) scanCanvas = document.createElement('canvas');
		const scale = SCAN_DOWNSAMPLE_WIDTH / videoEl.videoWidth;
		scanCanvas.width = SCAN_DOWNSAMPLE_WIDTH;
		scanCanvas.height = Math.round(videoEl.videoHeight * scale);
		const ctx = scanCanvas.getContext('2d', { willReadFrequently: true });
		if (!ctx) return;
		ctx.drawImage(videoEl, 0, 0, scanCanvas.width, scanCanvas.height);
		let imageData: ImageData;
		try {
			imageData = ctx.getImageData(0, 0, scanCanvas.width, scanCanvas.height);
		} catch { return; }

		let result;
		try {
			result = jsQR(imageData.data, imageData.width, imageData.height, { inversionAttempts: 'dontInvert' });
		} catch { return; }

		if (!result?.data) {
			lastAutoScanCode = null;  // Lost sight of code; allow re-trigger next appearance.
			return;
		}
		const code = result.data.trim();
		if (!code) return;
		if (code === lastAutoScanCode) return;     // Same code seen last tick.
		lastAutoScanCode = code;
		if (code === cartridgeId) return;          // Already locked on this cartridge.
		handleScan(code, 'auto').catch(() => null);
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
		scanLoopInterval = setInterval(autoScanTick, AUTO_SCAN_INTERVAL_MS);
		window.addEventListener('beforeunload', onBeforeUnload);
	});

	onDestroy(() => {
		window.removeEventListener('beforeunload', onBeforeUnload);
		teardownStation();
		stopCamera();
		if (bannerTimer) clearTimeout(bannerTimer);
		if (refocusInterval) clearInterval(refocusInterval);
		if (scanLoopInterval) clearInterval(scanLoopInterval);
	});
</script>

<svelte:window onkeydown={onGlobalKeydown} />

<div class="min-h-screen bg-[var(--color-tron-bg-primary)] p-4 sm:p-6">
	<div class="mx-auto max-w-6xl space-y-4">
		<header class="flex items-center justify-between">
			<div>
				<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Capture Station</h1>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">
					Hold a cartridge in front of the camera (auto-scans every 2s) or use the USB scanner. Front photo captures 1s after a new scan; press Space for the back photo. Re-scanning the same cartridge does nothing — show a different cartridge to advance.
				</p>
			</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">
				Operator: <span class="text-[var(--color-tron-cyan)]">{data.user.username}</span>
			</div>
		</header>

		<!-- Project context banner — only when arrived from /cv/projects/[id] -->
		{#if data.projectContext}
			{@const pc = data.projectContext}
			{@const willRun = !!pc.activeModelVersion && pc.deployAtPhases.includes(phase)}
			<div class="rounded-lg border p-3 text-sm
				{willRun
					? 'border-[var(--color-tron-green,#39ff14)] bg-[rgba(57,255,20,0.05)]'
					: 'border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.05)]'}">
				<div class="flex flex-wrap items-center gap-x-2 gap-y-1">
					<span class="text-[var(--color-tron-text-secondary)]">Capturing for project:</span>
					<a href={`/cv/projects/${pc.id}`} class="font-semibold text-[var(--color-tron-cyan)] hover:underline">{pc.name}</a>
					{#if !pc.activeModelVersion}
						<span class="text-[var(--color-tron-red,#ff3366)]">— no active model on this project. Train + promote one under the project's Deployment tab before inference will run.</span>
					{:else if !pc.deployAtPhases.includes(phase)}
						<span class="text-[var(--color-tron-red,#ff3366)]">
							— this project deploys at {pc.deployAtPhases.length > 0 ? pc.deployAtPhases.join(', ') : '(no phases)'}, not "{phase}". Change the phase below OR add "{phase}" to deployAtPhases on the project.
						</span>
					{:else}
						<span class="text-[var(--color-tron-green,#39ff14)]">— ✓ inference will run (model v{pc.activeModelVersion}) for captures at "{phase}".</span>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Banner -->
		{#if banner}
			<div class="rounded border p-3 text-sm
				{banner.kind === 'ok' ? 'border-[var(--color-tron-green,#39ff14)] bg-[rgba(57,255,20,0.08)] text-[var(--color-tron-green,#39ff14)]' : ''}
				{banner.kind === 'err' ? 'border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.08)] text-[var(--color-tron-red,#ff3366)]' : ''}
				{banner.kind === 'info' ? 'border-[var(--color-tron-cyan)] bg-[rgba(0,255,255,0.08)] text-[var(--color-tron-cyan)]' : ''}">
				{banner.text}
			</div>
		{/if}

		<!-- Context bar -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<div class="flex flex-wrap items-center gap-4">
				<div class="flex-1 min-w-[200px]">
					<div class="text-xs uppercase text-[var(--color-tron-text-secondary)]">Cartridge</div>
					{#if cartridgeId}
						<div class="font-mono text-lg text-[var(--color-tron-green,#39ff14)]">🟢 {cartridgeId}</div>
						<div class="text-xs text-[var(--color-tron-text-secondary)]">
							{cartridgeStatus ?? 'unknown'} · {cartridgePhotoCount} prior photo{cartridgePhotoCount === 1 ? '' : 's'}
						</div>
					{:else}
						<div class="font-mono text-lg text-[var(--color-tron-red,#ff3366)]">⚠ Scan to start</div>
					{/if}
				</div>
				<div>
					<label for="phase-sel" class="block text-xs uppercase text-[var(--color-tron-text-secondary)]">Phase</label>
					<select id="phase-sel" bind:value={phase} class="tron-input">
						{#each data.phases as p (p)}
							<option value={p}>{p}</option>
						{/each}
					</select>
				</div>
				<div>
					<label for="station-sel" class="block text-xs uppercase text-[var(--color-tron-text-secondary)]">Station</label>
					<select id="station-sel" bind:value={selectedStationId} onchange={() => onStationChange()} class="tron-input">
						<option value={null}>(Local)</option>
						{#each data.stations as s (s._id)}
							<option value={s._id}>{s.name}</option>
						{/each}
					</select>
				</div>
				<div>
					<label for="cam-sel" class="block text-xs uppercase text-[var(--color-tron-text-secondary)]">Camera</label>
					<select id="cam-sel" bind:value={selectedCameraId} onchange={() => startCamera()} class="tron-input">
						{#each cameras as c (c.deviceId)}
							<option value={c.deviceId}>{c.label || `Camera ${c.deviceId.slice(0, 6)}`}</option>
						{/each}
					</select>
				</div>
			</div>
		</div>

		<!-- Camera -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-black p-2">
			{#if cameraError}
				<div class="aspect-video flex items-center justify-center text-[var(--color-tron-red,#ff3366)]">
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
				onclick={capturePhoto}
				disabled={submitting || !cartridgeId || !stream}
				class="rounded bg-[var(--color-tron-cyan)] px-6 py-3 text-lg font-bold text-[var(--color-tron-bg-primary)] disabled:opacity-40"
			>
				{submitting ? 'Capturing…' : sessionPhotos.length >= PHOTOS_PER_CARTRIDGE ? '↺ Retake (Space)' : `📷 Capture ${sessionPhotos.length + 1} of ${PHOTOS_PER_CARTRIDGE} (Space)`}
			</button>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">
				This session: {recentCaptures.length} photo{recentCaptures.length === 1 ? '' : 's'}
			</div>
		</div>

		<!-- Retake dialog — opens when operator presses Space after the 2nd photo -->
		{#if showRetakeDialog}
			<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true">
				<div class="w-full max-w-md rounded-lg border border-[var(--color-tron-cyan)] bg-[var(--color-tron-bg-secondary)] p-6 space-y-4">
					<h2 class="text-lg font-bold text-[var(--color-tron-cyan)]">Retake photos?</h2>
					<p class="text-sm text-[var(--color-tron-text-secondary)]">
						This cartridge already has its {PHOTOS_PER_CARTRIDGE} photos. Choose what to retake — the replaced photo(s) will be deleted.
					</p>
					<div class="grid gap-2">
						<button
							type="button"
							onclick={retakeAll}
							class="rounded border border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.08)] px-4 py-3 text-left text-sm text-[var(--color-tron-red,#ff3366)] hover:bg-[rgba(255,51,102,0.15)]"
						>
							<div class="font-bold">↺ Retake both</div>
							<div class="text-xs opacity-80">Deletes both photos. Capture 2 new ones.</div>
						</button>
						<button
							type="button"
							onclick={retakeSecond}
							class="rounded border border-[var(--color-tron-cyan)] bg-[rgba(0,255,255,0.08)] px-4 py-3 text-left text-sm text-[var(--color-tron-cyan)] hover:bg-[rgba(0,255,255,0.15)]"
						>
							<div class="font-bold">↺ Retake only the back (2nd photo)</div>
							<div class="text-xs opacity-80">Deletes the 2nd photo. Capture one new one.</div>
						</button>
						<button
							type="button"
							onclick={cancelRetake}
							class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm text-[var(--color-tron-text-secondary)] hover:bg-[var(--color-tron-bg-primary)]"
						>
							Cancel
						</button>
					</div>
				</div>
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

		<!-- Recent captures strip -->
		{#if recentCaptures.length > 0}
			<div>
				<h3 class="mb-2 text-sm font-semibold text-[var(--color-tron-text-secondary)] uppercase">Just captured</h3>
				<div class="flex gap-2 overflow-x-auto">
					{#each recentCaptures as cap (cap.id)}
						<div class="shrink-0 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-2 text-xs">
							{#if cap.url}
								<img src={cap.url} alt={cap.cartridgeImageNumber} class="h-32 w-32 rounded object-cover" />
							{/if}
							<div class="mt-1 font-mono text-[var(--color-tron-cyan)] truncate w-32">{cap.cartridgeImageNumber}</div>
							<div class="text-[var(--color-tron-text-secondary)] truncate w-32">{cap.phase}</div>
							<div class="mt-1 w-32">
								{#if cap.inference.status === 'pending' || cap.inference.status === 'running'}
									<span class="inline-block animate-pulse rounded bg-[rgba(0,255,255,0.15)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-cyan)]">Inferring…</span>
								{:else if cap.inference.status === 'completed' && cap.inference.result === 'pass'}
									<span class="inline-block rounded bg-[var(--color-tron-green,#39ff14)] px-1.5 py-0.5 text-[10px] font-bold text-black">
										PASS{cap.inference.confidence != null ? ' ' + Math.round(cap.inference.confidence * 100) + '%' : ''}
									</span>
								{:else if cap.inference.status === 'completed' && cap.inference.result === 'fail'}
									<span class="inline-block rounded bg-[var(--color-tron-red,#ff3366)] px-1.5 py-0.5 text-[10px] font-bold text-white">
										FAIL{cap.inference.confidence != null ? ' ' + Math.round(cap.inference.confidence * 100) + '%' : ''}
									</span>
								{:else if cap.inference.status === 'failed'}
									<span class="inline-block rounded bg-[var(--color-tron-red,#ff3366)] px-1.5 py-0.5 text-[10px] text-white" title={cap.inference.errorMessage ?? ''}>ERR</span>
								{:else}
									<span class="inline-block rounded bg-[var(--color-tron-bg-tertiary)] px-1.5 py-0.5 text-[10px] text-[var(--color-tron-text-secondary)]" title="No project is deployed at this phase — set one up under /cv/projects/[id] Deployment.">no model</span>
								{/if}
							</div>
						</div>
					{/each}
				</div>
			</div>
		{/if}
	</div>
</div>
