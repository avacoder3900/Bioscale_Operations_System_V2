<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { invalidateAll } from '$app/navigation';
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

	// Which projects (active model + this phase in deployAtPhases) will run
	// inference for captures at the current phase. Updates reactively when
	// the operator changes the phase dropdown.
	type DeployedProject = { id: string; name: string; version: string };
	let deployedHere = $derived<DeployedProject[]>(data.deploymentsByPhase?.[phase] ?? []);

	// Every station that currently holds an operator lock — held by anyone,
	// including us. Drives the always-visible "Station locks" panel below the
	// picker so an operator can boot a ghost lock off (a browser tab that died
	// without firing beforeunload pins the station as "in use" forever and
	// disables its dropdown option) or clear their own stale lock. Every
	// force-release is audited server-side.
	let occupiedStations = $derived(
		(data.stations ?? []).filter((s: any) => s.currentOperator?._id)
	);

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

	// Story E2: persistent banner shown when the operator's currently-selected
	// station goes offline. flashBanner above is transient (3.5 s) and not
	// the right fit for "the station you're using just died — pick another."
	let stationDownAt = $state<{ name: string; at: number } | null>(null);

	// Remote-camera tuning panel — only meaningful when a Pi station is the
	// active video source. cameraParams is populated by the WS handler for
	// {event: 'camera_params'} which the agent sends after we POST a
	// {cmd: 'get_camera_params'}; slider changes get throttled per-prop and
	// fire {cmd: 'set_camera_param', prop, value} back.
	let cameraParams = $state<Record<string, number>>({});
	let cameraParamsKnown = $state<string[]>([]);
	// Real per-control ranges from the agent (V4L2 where available, advisory
	// fallback otherwise). Drives slider min/max/step so the thumb can actually
	// reach the camera's true limits. source: 'v4l2' = camera's real range,
	// 'fallback' = our guess.
	type CamRange = { min: number; max: number; step?: number; default?: number; source?: string };
	let cameraParamRanges = $state<Record<string, CamRange>>({});
	let cameraParamsExpanded = $state(false);
	const cameraParamThrottle: Record<string, ReturnType<typeof setTimeout>> = {};
	const CAMERA_PARAM_THROTTLE_MS = 100;
	const CAMERA_PARAM_LABELS: Record<string, { label: string; min: number; max: number; step?: number }> = {
		brightness: { label: 'Brightness', min: 0, max: 255 },
		contrast: { label: 'Contrast', min: 0, max: 255 },
		saturation: { label: 'Saturation', min: 0, max: 255 },
		hue: { label: 'Hue', min: -180, max: 180 },
		gain: { label: 'Gain', min: 0, max: 255 },
		exposure: { label: 'Exposure', min: -13, max: 0 },
		auto_exposure: { label: 'Auto Exposure (1=manual, 3=auto)', min: 1, max: 3, step: 1 },
		autofocus: { label: 'Autofocus', min: 0, max: 1, step: 1 },
		focus: { label: 'Focus', min: 0, max: 255 },
		auto_wb: { label: 'Auto WB', min: 0, max: 1, step: 1 },
		wb_temperature: { label: 'WB Temperature (K)', min: 2800, max: 6500 },
		sharpness: { label: 'Sharpness', min: 0, max: 255 },
		gamma: { label: 'Gamma', min: 1, max: 500 }
	};

	function setCameraParam(prop: string, value: number) {
		if (!ws || ws.readyState !== WebSocket.OPEN) return;
		// Optimistic local update so the slider feels responsive; the WS
		// response will overwrite with the actual value the camera accepted.
		cameraParams = { ...cameraParams, [prop]: value };
		if (cameraParamThrottle[prop]) clearTimeout(cameraParamThrottle[prop]);
		cameraParamThrottle[prop] = setTimeout(() => {
			try {
				ws?.send(JSON.stringify({ cmd: 'set_camera_param', prop, value }));
			} catch {
				/* socket may have closed mid-throttle; next slider event will retry */
			}
			delete cameraParamThrottle[prop];
		}, CAMERA_PARAM_THROTTLE_MS);
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

	// Lock-in-progress guard. A scanner in sensing mode re-fires the same
	// barcode many times per second; because cartridgeId isn't set until the
	// async lookup resolves, a burst of re-reads would each kick off a
	// duplicate /api/cv/lookup-cartridge call before the first returns. This
	// gates handleScan to a single lookup at a time — "scan once, lock once."
	let locking = $state(false);

	// 2-photo workflow per cartridge: photo 1 = front, photo 2 = back.
	// After both are taken, the next capture attempt opens the retake dialog.
	type SessionPhoto = { id: string; cartridgeImageNumber: string };
	let sessionPhotos = $state<SessionPhoto[]>([]);
	let showRetakeDialog = $state(false);
	let retakeInProgress = $state(false);
	const PHOTOS_PER_CARTRIDGE = 2;

	// Remote scan-then-capture (Pi station only). Space sends {cmd:'trigger_scan'}
	// to the agent, which forwards the next physical read tagged triggered=true;
	// the WS handler then locks the cartridge AND auto-fires the photo. This flag
	// gates the handler + the Space key so one press maps to exactly one
	// scan→capture, and the timer recovers if no barcode is ever read.
	let awaitingTriggeredScan = $state(false);
	let triggerScanTimer: ReturnType<typeof setTimeout> | null = null;
	const TRIGGER_SCAN_TIMEOUT_MS = 6000;

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
		// Story E2: clear any stale station-down banner now that the operator
		// has acknowledged it by changing the dropdown.
		stationDownAt = null;
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
			stream.getTracks().forEach(t => t.stop());
			stream = null;
		}
		if (videoEl) videoEl.srcObject = null;
		// Clear the remote-camera tuning panel; new station's WS will
		// repopulate from its own camera. Cancel any throttled sends so a
		// stale prop write doesn't hit the next station.
		cameraParams = {};
		cameraParamsKnown = [];
		cameraParamRanges = {};
		for (const t of Object.values(cameraParamThrottle)) clearTimeout(t);
		for (const k of Object.keys(cameraParamThrottle)) delete cameraParamThrottle[k];
		// Drop any in-flight scan trigger — it belonged to the old station.
		awaitingTriggeredScan = false;
		if (triggerScanTimer) { clearTimeout(triggerScanTimer); triggerScanTimer = null; }
		if (lockedStationId) {
			const releaseId = lockedStationId;
			lockedStationId = null;
			fetch(`/api/cv/stations/${encodeURIComponent(releaseId)}/lock`, { method: 'DELETE' })
				.catch(() => null);
		}
	}

	// Boot a ghost operator off a station. ?force=true clears the lock no matter
	// who holds it; the server audits every force-release. After release we
	// re-run the page load so the dropdown option flips back to selectable and
	// the station returns to "waiting for an operator".
	async function resetStation(stationId: string, name: string, holder: string) {
		if (
			!confirm(
				`Reset "${name}"? This boots ${holder} off and returns the station to "waiting for an operator". Only do this if no one is actually using it.`
			)
		)
			return;
		try {
			const res = await fetch(
				`/api/cv/stations/${encodeURIComponent(stationId)}/lock?force=true`,
				{ method: 'DELETE' }
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			await invalidateAll();
			flashBanner('ok', `Station "${name}" released — now waiting for an operator.`);
		} catch (e) {
			flashBanner('err', `Failed to reset station: ${e instanceof Error ? e.message : e}`);
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
			// Story E2: also raise the persistent "station down" banner so the
			// operator knows they need to pick another rather than wondering
			// why captures stopped working.
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
				// Request current camera params so the settings panel can
				// populate slider defaults from what the camera actually
				// reports rather than from the LABELS map mins.
				try { sock.send(JSON.stringify({ cmd: 'get_camera_params' })); } catch { /* */ }
				return;
			}

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
			// Two paths:
			//  • triggered (operator pressed Space → {cmd:'trigger_scan'}): lock
			//    the cartridge AND auto-capture the photo. msg.triggered comes
			//    from the agent; awaitingTriggeredScan is the local fallback for
			//    agents that predate trigger tagging.
			//  • untriggered (a direct pull of the scanner's own trigger): plain
			//    cartridge lock via the same 'auto' path the local wedge uses.
			if (msg.event === 'scan' && typeof msg.code === 'string') {
				if (awaitingTriggeredScan || msg.triggered) {
					triggeredScanCapture(msg.code).catch(() => null);
				} else {
					handleScan(msg.code, 'auto').catch(() => null);
				}
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

	// Returns the locked cartridge id when a cartridge is (or stays) locked and
	// ready to photograph, or null when nothing should be captured (empty code,
	// lookup failure, or a different scan rejected mid-session by lock-until-done).
	// triggeredScanCapture relies on this to decide whether to auto-fire the photo.
	async function handleScan(rawCode: string, source: 'handheld' | 'auto' | 'triggered' = 'handheld'): Promise<string | null> {
		const code = rawCode.trim();
		if (!code) return null;

		// Same code as currently locked → no-op for any source. (Was previously
		// limited to 'auto'; handheld re-scans used to silently re-lock + reset
		// the session. With lock-until-done that's the wrong default — the
		// only legitimate re-trigger of the same code is "operator wants the
		// retake dialog," which they reach via Capture-after-2-photos instead.)
		// We still return the locked id so a triggered re-scan can capture.
		if (code === cartridgeId) return cartridgeId;

		// Lock-until-done guard: a cartridge is locked AND the 2-photo session
		// is still in progress → ignore any DIFFERENT scan code. Stops wedge
		// re-reads and jsQR sightings of other cartridges from stomping on the
		// in-flight workflow. Operator must finish photos OR click "Release"
		// (clearCartridgeForNext) before a new cartridge can lock.
		if (cartridgeId && sessionPhotos.length < PHOTOS_PER_CARTRIDGE) {
			if (source !== 'auto') {
				// Intentional trigger pull / Space-press — operator deserves feedback.
				flashBanner('info', `Still on ${cartridgeId} (${sessionPhotos.length}/${PHOTOS_PER_CARTRIDGE} photos). Finish or click "Release lock" to scan a new cartridge.`, 2800);
			}
			// jsQR / Pi-scanner 'auto' sources are silently ignored — they fire
			// continuously, so toasts would spam.
			return null;
		}

		// A lookup is already in flight from an earlier read in this sensing-mode
		// burst — cartridgeId hasn't been set yet, so the guards above can't catch
		// it. Drop the duplicate; the first lookup will do the lock.
		if (locking) return null;
		locking = true;

		try {
			const res = await fetch(`/api/cv/lookup-cartridge?code=${encodeURIComponent(code)}`);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				flashBanner('err', body.error || `Cartridge ${code} not found in BIMS`);
				cartridgeId = null;
				cartridgeStatus = null;
				cartridgePhotoCount = 0;
				return null;
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
			return cartridgeId;
		} catch (e) {
			flashBanner('err', e instanceof Error ? e.message : 'Lookup failed');
			return null;
		} finally {
			locking = false;
		}
	}

	function isStationLive(): boolean {
		return !!selectedStationId && !!ws && ws.readyState === WebSocket.OPEN;
	}

	// Space on a live Pi station. Decides between "scan first, then capture" and
	// "just capture the next photo":
	//  • No cartridge locked (or the previous session is finished) → trigger a
	//    fresh scan; the WS handler auto-captures once it locks.
	//  • Mid-session (front already shot, back pending) → capture directly. The
	//    cartridge identity is already established, and the barcode is usually
	//    hidden on the back, so forcing a re-scan would just stall.
	//  • Both photos done → open the retake dialog (same as local).
	function onStationSpace() {
		if (submitting || awaitingTriggeredScan) return;
		// Already locked — either a sensing/auto read picked the cartridge up
		// before Space, or it's mid-session. The scan half of "scan → photo"
		// already happened, so just capture; after both photos Space reaches the
		// retake dialog (same as local).
		if (cartridgeId) {
			if (sessionPhotos.length >= PHOTOS_PER_CARTRIDGE) showRetakeDialog = true;
			else capturePhoto();
			return;
		}
		// Nothing locked yet → arm a scan; the WS handler auto-captures once a
		// barcode locks the cartridge.
		requestTriggeredScan();
	}

	function requestTriggeredScan() {
		if (!isStationLive()) {
			flashBanner('err', 'Station not connected — pick a station or wait for it to reconnect.');
			return;
		}
		try {
			ws!.send(JSON.stringify({ cmd: 'trigger_scan' }));
		} catch {
			flashBanner('err', 'Failed to reach station — try again.');
			return;
		}
		awaitingTriggeredScan = true;
		flashBanner('info', 'Scanning… present the cartridge barcode', TRIGGER_SCAN_TIMEOUT_MS);
		if (triggerScanTimer) clearTimeout(triggerScanTimer);
		triggerScanTimer = setTimeout(() => {
			if (awaitingTriggeredScan) {
				awaitingTriggeredScan = false;
				flashBanner('err', 'No barcode scanned — press Space to try again.');
			}
		}, TRIGGER_SCAN_TIMEOUT_MS);
	}

	// A triggered scan landed: lock the cartridge, then auto-fire the photo.
	async function triggeredScanCapture(code: string) {
		awaitingTriggeredScan = false;
		if (triggerScanTimer) { clearTimeout(triggerScanTimer); triggerScanTimer = null; }
		const locked = await handleScan(code, 'triggered');
		if (!locked) return; // lookup failed, or a different cartridge was rejected mid-session
		await capturePhoto();
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
		// Space on a real focused control (camera-settings slider, a <select>)
		// must scroll-suppress but not trigger the workflow. The hidden
		// scanner-wedge input — kept focused by refocusScanner() — is the
		// exception: it stands in for "the page" so our keys still fire.
		if (target !== scanInputEl &&
			(target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')) {
			e.preventDefault();
			return;
		}
		e.preventDefault();
		// On a Pi station, Space scans first then auto-captures; locally it just
		// captures the cartridge that's already wedge-scanned.
		if (selectedStationId) onStationSpace();
		else capturePhoto();
	}

	function refocusScanner() {
		// Keep scanner input always focused so wedge keystrokes land in it.
		if (scanInputEl && document.activeElement !== scanInputEl) {
			// Don't steal focus from the camera selector, phase dropdown, or any
			// other focused input (e.g. the camera-settings sliders). Stealing
			// focus back to the hidden scanner input mid-interaction yanks the
			// slider thumb and scrolls the page to the refocused element —
			// "the screen moves on its own." scanInputEl is itself an INPUT, but
			// the activeElement !== scanInputEl guard above already excludes it.
			const active = document.activeElement as HTMLElement;
			if (active?.tagName === 'SELECT' || active?.tagName === 'BUTTON' || active?.tagName === 'INPUT') return;
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
		// Continuous jsQR auto-scan disabled per operator request — the 2 s
		// camera-driven scan loop was overriding workflows when the wedge
		// scanner was in continuous mode (double reads, ambient triggers).
		// Single-scan flow now: every lock is an explicit wedge trigger pull
		// (or a Pi-station scan event, which is already one-shot per Enter).
		// autoScanTick + scanCanvas + lastAutoScanCode are kept but unwired;
		// flip this back on with `setInterval(autoScanTick, …)` if you want
		// continuous behavior again.
		if (typeof window !== 'undefined') {
			window.addEventListener('beforeunload', onBeforeUnload);
		}
	});

	onDestroy(() => {
		// Svelte 5 invokes onDestroy during SSR teardown (#close_render), so
		// guard the window access — server has no window object.
		if (typeof window !== 'undefined') {
			window.removeEventListener('beforeunload', onBeforeUnload);
		}
		teardownStation();
		stopCamera();
		if (bannerTimer) clearTimeout(bannerTimer);
		if (refocusInterval) clearInterval(refocusInterval);
		if (scanLoopInterval) clearInterval(scanLoopInterval);
		if (triggerScanTimer) clearTimeout(triggerScanTimer);
	});
</script>

<svelte:window onkeydown={onGlobalKeydown} />

<div class="min-h-screen bg-[var(--color-tron-bg-primary)] p-4 sm:p-6">
	<div class="mx-auto max-w-6xl space-y-4">
		<header class="flex items-center justify-between">
			<div>
				<h1 class="text-2xl font-bold text-[var(--color-tron-cyan)]">Capture Station</h1>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">
					Pull the USB scanner trigger to lock a cartridge. Press Space (×2) for front + back photos. While locked, other scans are ignored — finish both photos or click "Release lock" to switch cartridges.
				</p>
				{#if selectedStationId}
					<p class="text-xs text-[var(--color-tron-cyan)]">
						Pi station: press Space to scan the barcode — the front photo is taken automatically once it locks. Press Space again for the back.
					</p>
				{/if}
			</div>
			<div class="text-xs text-[var(--color-tron-text-secondary)]">
				Operator: <span class="text-[var(--color-tron-cyan)]">{data.user.username}</span>
			</div>
		</header>

		<!-- Always-on phase inference indicator. Tells the operator BEFORE they
		     capture whether anything will run inference. Updates reactively as
		     the operator changes the phase dropdown via $derived deployedHere. -->
		<div class="rounded border p-2 text-xs
			{deployedHere.length > 0
				? 'border-[var(--color-tron-green,#39ff14)] bg-[rgba(57,255,20,0.05)]'
				: 'border-[var(--color-tron-text-secondary)] bg-[var(--color-tron-bg-secondary)]'}">
			{#if deployedHere.length > 0}
				<span class="text-[var(--color-tron-green,#39ff14)]">✓ Inference active</span>
				<span class="text-[var(--color-tron-text-secondary)]"> at phase</span>
				<span class="font-mono text-[var(--color-tron-cyan)]">{phase}</span>
				<span class="text-[var(--color-tron-text-secondary)]"> — </span>
				{#each deployedHere as d, i (d.id)}
					{#if i > 0}, {/if}
					<a href={`/cv/projects/${d.id}`} class="text-[var(--color-tron-cyan)] hover:underline">{d.name}</a>
					<span class="font-mono text-[10px] text-[var(--color-tron-text-secondary)]">v{d.version}</span>
				{/each}
			{:else}
				<span class="text-[var(--color-tron-text-secondary)]">No project deploys at phase</span>
				<span class="font-mono text-[var(--color-tron-cyan)]">{phase}</span>
				<span class="text-[var(--color-tron-text-secondary)]"> — captures will save but no PASS/FAIL inference will run. Wire one up under <a href="/cv/projects" class="text-[var(--color-tron-cyan)] hover:underline">/cv/projects</a> → Deployment tab.</span>
			{/if}
		</div>

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

		<!-- Station-down banner (story E2). Persistent — only cleared when the
		     operator changes the station dropdown. Different from the transient
		     `banner` above because the operator needs time to read and act. -->
		{#if stationDownAt}
			<div class="rounded border border-[var(--color-tron-yellow,#facc15)] bg-[rgba(250,204,21,0.08)] p-3 text-sm text-[var(--color-tron-yellow,#facc15)]">
				<span class="font-semibold">Station {stationDownAt.name} went offline at {new Date(stationDownAt.at).toLocaleTimeString()}.</span>
				<span class="ml-2 text-[var(--color-tron-text-secondary)]">Pick another station from the dropdown above, or wait for this one to come back online.</span>
			</div>
		{/if}

		<!-- Context bar -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4">
			<div class="flex flex-wrap items-center gap-4">
				<div class="flex-1 min-w-[200px]">
					<div class="text-xs uppercase text-[var(--color-tron-text-secondary)]">Cartridge</div>
					{#if cartridgeId}
						<div class="flex items-center gap-2">
							<span class="font-mono text-lg text-[var(--color-tron-green,#39ff14)]">🟢 {cartridgeId}</span>
							{#if sessionPhotos.length < PHOTOS_PER_CARTRIDGE}
								<span class="rounded bg-[rgba(255,215,0,0.15)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-tron-yellow,#ffd700)]" title="Other scans are ignored until you take {PHOTOS_PER_CARTRIDGE} photos or click Release.">🔒 LOCKED</span>
							{/if}
						</div>
						<div class="text-xs text-[var(--color-tron-text-secondary)]">
							{cartridgeStatus ?? 'unknown'} · {cartridgePhotoCount} prior · session {sessionPhotos.length}/{PHOTOS_PER_CARTRIDGE}
						</div>
						<button
							type="button"
							onclick={clearCartridgeForNext}
							class="mt-1 rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[10px] uppercase text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
							title="Release the lock so you can scan a different cartridge before finishing this one"
						>
							Release lock
						</button>
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
							{@const badge = s.status === 'online' ? '🟢' : s.status === 'degraded' ? '🟡' : '🔴'}
							{@const heldByOther = s.currentOperator && s.currentOperator._id && s.currentOperator._id !== data.user._id}
							{@const offline = s.status !== 'online' && s.status !== 'degraded'}
							{@const disabled = offline || heldByOther}
							<option value={s._id} disabled={disabled}>
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
					<select id="cam-sel" bind:value={selectedCameraId} onchange={() => startCamera()} class="tron-input">
						{#each cameras as c (c.deviceId)}
							<option value={c.deviceId}>{c.label || `Camera ${c.deviceId.slice(0, 6)}`}</option>
						{/each}
					</select>
				</div>
			</div>
		</div>

		<!-- Station-lock manager. Every station currently holding an operator lock
		     is listed here with a Reset (force-release) button so a ghost lock — a
		     dead browser tab that pins a station as "in use" forever and disables
		     its dropdown option — can be cleared back to idle. Visible to any
		     operator; every reset is audited server-side. -->
		{#if occupiedStations.length > 0}
			<div class="rounded-lg border border-[var(--color-tron-yellow,#facc15)] bg-[rgba(250,204,21,0.06)] p-3">
				<p class="text-xs font-semibold uppercase text-[var(--color-tron-yellow,#facc15)]">
					Station locks — Reset to boot an operator off
				</p>
				<ul class="mt-2 space-y-1">
					{#each occupiedStations as s (s._id)}
						{@const isSelf = s.currentOperator._id === data.user._id}
						<li class="flex items-center justify-between gap-3 text-sm">
							<span class="text-[var(--color-tron-text-secondary)]">
								<span class="text-[var(--color-tron-cyan)]">{s.name}</span>
								— {s.currentOperator.username}{#if isSelf} (you){/if}{#if s.currentOperator.since} since {new Date(s.currentOperator.since).toLocaleString()}{/if}
							</span>
							<button
								type="button"
								onclick={() => resetStation(s._id, s.name, s.currentOperator.username)}
								title="Force-release this station back to idle. Use only when no one is actually on it."
								class="shrink-0 rounded border border-[var(--color-tron-red,#ff3366)] px-2 py-0.5 text-xs text-[var(--color-tron-red,#ff3366)] hover:bg-[rgba(255,51,102,0.08)]"
							>
								Reset
							</button>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

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

		<!-- Remote camera tuning (Pi station only). Collapsible to keep the
		     main capture flow uncluttered; expand when an operator needs to
		     dial in exposure / focus / white balance for the room. -->
		{#if selectedStationId && cameraParamsKnown.length > 0}
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)]">
				<button
					type="button"
					onclick={() => (cameraParamsExpanded = !cameraParamsExpanded)}
					class="flex w-full items-center justify-between rounded-t-lg px-4 py-2 text-left text-sm font-medium text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-bg-tertiary)]"
				>
					<span>🎛 Camera settings (Pi station)</span>
					<svg
						class="h-4 w-4 transition-transform {cameraParamsExpanded ? 'rotate-180' : ''}"
						fill="none"
						viewBox="0 0 24 24"
						stroke="currentColor"
					>
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
					</svg>
				</button>
				{#if cameraParamsExpanded}
					<div class="grid gap-3 border-t border-[var(--color-tron-border)] p-4 sm:grid-cols-2">
						{#each cameraParamsKnown as prop (prop)}
							{@const cfg = CAMERA_PARAM_LABELS[prop]}
							{@const r = cameraParamRanges[prop]}
							{@const lo = r?.min ?? cfg?.min ?? 0}
							{@const hi = r?.max ?? cfg?.max ?? 255}
							{@const step = r?.step ?? cfg?.step ?? 1}
							{@const label = cfg?.label ?? prop}
							<div>
								<div class="flex items-baseline justify-between gap-2">
									<label for={`cp-${prop}`} class="text-xs text-[var(--color-tron-text-secondary)]">
										{label}
									</label>
									<span class="font-mono text-xs text-[var(--color-tron-cyan)]">
										{cameraParams[prop] ?? '?'}
									</span>
								</div>
								<input
									id={`cp-${prop}`}
									type="range"
									min={lo}
									max={hi}
									{step}
									value={cameraParams[prop] ?? lo}
									oninput={(e) => setCameraParam(prop, Number((e.currentTarget as HTMLInputElement).value))}
									class="w-full"
								/>
								<!-- Real editable bounds so the operator can see what's adjustable.
								     "camera" = true V4L2 range, "default" = advisory fallback. -->
								<div class="flex justify-between text-[10px] text-[var(--color-tron-text-secondary)]">
									<span class="font-mono">{lo}</span>
									<span>{r ? (r.source === 'v4l2' ? 'camera range' : 'default range') : 'default range'}</span>
									<span class="font-mono">{hi}</span>
								</div>
							</div>
						{/each}
					</div>
				{/if}
			</div>
		{/if}

		<!-- Action bar -->
		<div class="flex items-center justify-between gap-3">
			<button
				type="button"
				onclick={() => (selectedStationId ? onStationSpace() : capturePhoto())}
				disabled={submitting || awaitingTriggeredScan || !stream || (!selectedStationId && !cartridgeId)}
				class="rounded bg-[var(--color-tron-cyan)] px-6 py-3 text-lg font-bold text-[var(--color-tron-bg-primary)] disabled:opacity-40"
			>
				{submitting
					? 'Capturing…'
					: awaitingTriggeredScan
						? 'Scanning…'
						: sessionPhotos.length >= PHOTOS_PER_CARTRIDGE
							? '↺ Retake (Space)'
							: selectedStationId && !cartridgeId
								? '⎵ Scan + Capture (Space)'
								: `📷 Capture ${sessionPhotos.length + 1} of ${PHOTOS_PER_CARTRIDGE} (Space)`}
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
