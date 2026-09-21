<script lang="ts">
	/**
	 * Wax Reject — reject-only visual wax inspection (WAX-SIMPLIFY-2).
	 *
	 * Bucket of visually-rejected wax_filled carts → scan one (sticky context),
	 * press Space to photograph it (Pi WebRTC station or USB camera; POST
	 * /api/cv/capture at phase 'wax_filled' with verdict:'rejected' so the image
	 * is pre-labelled fail for training), optionally pick a reason, then Reject
	 * (Enter) → POST /api/cv/wax-verdict → wax_rejected. Photo is mandatory —
	 * that's the point. Passing inspection is implicit; no button for it.
	 * Capture/station plumbing is copied from /wax-inspect (the proven implementation).
	 */
	import { onMount, onDestroy } from 'svelte';
	import PhotoAnnotatorModal from '$lib/components/PhotoAnnotatorModal.svelte';

	let { data } = $props();

	let annotateUrl = $state<string | null>(null);
	let annotateImageId = $state<string | null>(null);
	function applyHighlightSaved(id: string, url: string) {
		feed = feed.map((r) => (r.imageId === id ? { ...r, imageUrl: url } : r));
		annotateUrl = url;
	}

	const PHASE = 'wax_filled';
	const ALLOWED_STATUSES: string[] = data.allowedStatuses ?? ['wax_filled', 'wax_ready'];
	const REASON_CHIPS = ['underfill', 'overfill', 'bubble', 'smear', 'other'] as const;

	// ── Sticky cartridge context ────────────────────────────────────────────
	let cartridgeId = $state<string | null>(null);
	let cartridgeStatus = $state<string | null>(null);
	let scannedAt = $state<number | null>(null);
	// Photo taken for THIS scan — reject is disabled until it exists.
	let capturedImageId = $state<string | null>(null);
	let capturedImageUrl = $state<string | null>(null);
	let capturedNumber = $state<string | null>(null);
	// Reason (optional): chip + free text.
	let reasonChip = $state<string | null>(null);
	let reasonText = $state('');

	let rejectBanner = $state<string | null>(null);

	let scanInput = $state('');
	let scanInputEl: HTMLInputElement | null = null;
	let refocusInterval: ReturnType<typeof setInterval> | null = null;
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
	let lockedStationId: string | null = null;
	let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	const STATION_HEARTBEAT_MS = 60_000;
	let stationDownAt = $state<{ name: string; at: number } | null>(null);

	// ── Transient status banner ─────────────────────────────────────────────
	let banner = $state<{ kind: 'ok' | 'err' | 'info'; text: string } | null>(null);
	let bannerTimer: ReturnType<typeof setTimeout> | null = null;
	function flashBanner(kind: 'ok' | 'err' | 'info', text: string, ms = 3500) {
		if (bannerTimer) clearTimeout(bannerTimer);
		banner = { kind, text };
		bannerTimer = setTimeout(() => { banner = null; }, ms);
	}

	// ── Session feed (server-loaded 50 + live prepends) ─────────────────────
	type FeedRow = {
		key: string;
		cartridgeId: string;
		imageId: string | null;
		imageUrl: string | null;
		reason: string | null;
		operator: string | null;
		at: string | number | null;
	};
	let feed = $state<FeedRow[]>(
		(data.recentRejects ?? []).map((r: any): FeedRow => ({
			key: `${r.cartridgeId}:${r.at ?? ''}`,
			cartridgeId: r.cartridgeId,
			imageId: r.imageId ?? null,
			imageUrl: r.imageUrl ?? null,
			reason: r.reason ?? null,
			operator: r.operator ?? null,
			at: r.at ?? null
		}))
	);
	let counts = $state({ ...data.counts });

	let submitting = $state(false);
	let rejecting = $state(false);

	function lastTwelve(id: string | null): string {
		return id ? id.slice(-12) : '—';
	}
	function timeLabel(t: string | number | null): string {
		if (t == null) return '—';
		const d = new Date(t);
		return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString();
	}
	function composedReason(): string {
		const parts = [reasonChip, reasonText.trim()].filter(Boolean);
		return parts.join(': ');
	}

	// ── Scan handling ───────────────────────────────────────────────────────
	async function handleScan(rawCode: string) {
		const code = rawCode.trim();
		if (!code) return;
		if (code === cartridgeId) return;
		if (locking) return;
		locking = true;
		try {
			const res = await fetch(`/api/cv/lookup-cartridge?code=${encodeURIComponent(code)}`);
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				rejectBanner = body.error || `Cartridge ${code} not found in BIMS`;
				resetContext(false);
				return;
			}
			const info = await res.json();
			const status: string | null = info.status ?? null;
			if (!status || !ALLOWED_STATUSES.includes(status)) {
				rejectBanner =
					status === 'wax_rejected'
						? `Cartridge ${info.cartridgeRecordId ?? code} is already wax_rejected.`
						: `Cartridge ${info.cartridgeRecordId ?? code} has status "${status ?? 'unknown'}" — Wax Reject accepts only: ${ALLOWED_STATUSES.join(', ')}.`;
				resetContext(false);
				return;
			}
			rejectBanner = null;
			resetContext(false);
			cartridgeId = info.cartridgeRecordId;
			cartridgeStatus = status;
			scannedAt = Date.now();
			flashBanner('ok', `Locked on ${cartridgeId} (${status}) — press Space to photograph`);
		} catch (e) {
			flashBanner('err', e instanceof Error ? e.message : 'Lookup failed');
		} finally {
			locking = false;
		}
	}

	function resetContext(refocus = true) {
		cartridgeId = null;
		cartridgeStatus = null;
		scannedAt = null;
		capturedImageId = null;
		capturedImageUrl = null;
		capturedNumber = null;
		reasonChip = null;
		reasonText = '';
		scanInput = '';
		if (refocus) scanInputEl?.focus();
	}
	function clearCartridge() {
		rejectBanner = null;
		resetContext(true);
	}

	function onScanKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			const code = scanInput;
			scanInput = '';
			if (code.trim()) {
				handleScan(code);
			} else if (cartridgeId && capturedImageId) {
				// Empty Enter on the wedge input = confirm reject for the current scan.
				submitReject();
			}
		}
	}

	function refocusScanner() {
		if (scanInputEl && document.activeElement !== scanInputEl) {
			const active = document.activeElement as HTMLElement;
			if (active?.tagName === 'SELECT' || active?.tagName === 'BUTTON' || active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA') return;
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
			// LIZA tuning — production-validated setup for this hardware; unsupported
			// settings are silently skipped by the `advanced` array.
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
					console.warn('[wax-reject] LIZA tuning applyConstraints skipped:', e);
				}
			}
			if (videoEl) {
				videoEl.srcObject = stream;
				await videoEl.play();
			}
			await refreshCameras();
		} catch (e) {
			cameraError = e instanceof Error ? e.message : String(e);
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
			stream.getTracks().forEach((t) => t.stop());
			stream = null;
		}
		if (videoEl) videoEl.srcObject = null;
		if (lockedStationId) {
			const releaseId = lockedStationId;
			lockedStationId = null;
			fetch(`/api/cv/stations/${encodeURIComponent(releaseId)}/lock`, { method: 'DELETE' }).catch(() => null);
		}
	}

	async function connectToStation(stationId: string) {
		const station = data.stations.find((s: { _id: string }) => s._id === stationId);
		if (!station) {
			flashBanner('err', `Station ${stationId} not found`);
			selectedStationId = null;
			return;
		}
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
				try { await startWebRtcOffer(sock); } catch (e) { flashBanner('err', `WebRTC offer failed: ${e instanceof Error ? e.message : e}`); }
				return;
			}
			if (msg.event === 'sdp_answer' && pc && msg.sdp) {
				try { await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp }); } catch (e) { flashBanner('err', `setRemoteDescription failed: ${e instanceof Error ? e.message : e}`); }
				return;
			}
			if (msg.event === 'ice_candidate' && pc && msg.candidate) {
				try { await pc.addIceCandidate(msg.candidate); } catch { /* late candidates ok to drop */ }
				return;
			}
			if (msg.event === 'scan' && typeof msg.code === 'string') {
				handleScan(msg.code).catch(() => null);
				return;
			}
		};
	}

	async function startWebRtcOffer(sock: WebSocket) {
		const peer = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
		pc = peer;
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

	// ── Capture (photo is the failure record; pre-labelled rejected) ─────────
	async function capturePhoto() {
		if (submitting) return;
		if (!cartridgeId) { flashBanner('err', 'Scan a cartridge first'); return; }
		if (!videoEl || !stream) { flashBanner('err', 'Camera not running'); return; }
		submitting = true;
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
			// A photo on this page MEANS the cart is rejected — pre-label the CvImage
			// so it lands in the training set as a failure without a second call.
			form.append('verdict', 'rejected');
			if (selectedStationId) form.append('stationId', selectedStationId);

			const res = await fetch('/api/cv/capture', { method: 'POST', body: form });
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				throw new Error(body.error || `HTTP ${res.status}`);
			}
			const result = await res.json();
			capturedImageId = result.imageId;
			capturedImageUrl = result.imageUrl ?? null;
			capturedNumber = result.cartridgeImageNumber ?? null;
			flashBanner('ok', `Captured ${result.cartridgeImageNumber} — pick a reason (optional) and press Reject / Enter`, 2500);
		} catch (e) {
			flashBanner('err', e instanceof Error ? e.message : 'Capture failed');
		} finally {
			submitting = false;
			scanInputEl?.focus();
		}
	}

	// ── Reject: wax_filled | wax_ready → wax_rejected (photo mandatory) ─────
	async function submitReject() {
		if (rejecting || !cartridgeId) return;
		if (!capturedImageId) { flashBanner('err', 'Snap a photo first — every reject needs its picture'); return; }
		rejecting = true;
		const id = cartridgeId;
		const reason = composedReason();
		try {
			const res = await fetch('/api/cv/wax-verdict', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ cartridgeId: id, verdict: 'rejected', reason, imageId: capturedImageId, source: 'human' })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok || body.error) {
				flashBanner('err', body.error ?? `Reject failed (HTTP ${res.status})`);
				return;
			}
			feed = [
				{
					key: `${id}:${Date.now()}`,
					cartridgeId: id,
					imageId: capturedImageId,
					imageUrl: capturedImageUrl,
					reason: reason || null,
					operator: data.user.username,
					at: Date.now()
				},
				...feed
			];
			counts = {
				wax_filled: Math.max(0, counts.wax_filled - (body.from === 'wax_filled' ? 1 : 0)),
				wax_rejected_today: counts.wax_rejected_today + 1
			};
			flashBanner('ok', `${id} → wax_rejected`, 2200);
			resetContext(true);
		} catch (e) {
			flashBanner('err', e instanceof Error ? e.message : 'Reject failed');
		} finally {
			rejecting = false;
			scanInputEl?.focus();
		}
	}

	// ── Keyboard: Space = capture, Enter = reject (when a photo exists) ──────
	function onGlobalKeydown(e: KeyboardEvent) {
		const target = e.target as HTMLElement;
		const inControl = target !== scanInputEl &&
			(target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT');
		if (e.key === ' ') {
			if (inControl) return;
			e.preventDefault();
			capturePhoto();
			return;
		}
		if (e.key === 'Enter' && target !== scanInputEl && !inControl) {
			if (cartridgeId && capturedImageId) {
				e.preventDefault();
				submitReject();
			}
		}
	}

	function onBeforeUnload() {
		if (lockedStationId) {
			fetch(`/api/cv/stations/${encodeURIComponent(lockedStationId)}/lock`, { method: 'DELETE', keepalive: true }).catch(() => null);
		}
	}

	onMount(() => {
		(async () => {
			await refreshCameras();
			await startCamera();
			scanInputEl?.focus();
		})();
		refocusInterval = setInterval(refocusScanner, 500);
		if (typeof window !== 'undefined') window.addEventListener('beforeunload', onBeforeUnload);
	});

	onDestroy(() => {
		if (typeof window !== 'undefined') window.removeEventListener('beforeunload', onBeforeUnload);
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
		<header class="flex flex-wrap items-start justify-between gap-3">
			<div>
				<h1 class="text-2xl font-bold text-[var(--color-tron-red,#ff3366)]">Wax Reject</h1>
				<p class="text-xs text-[var(--color-tron-text-secondary)]">
					Visually rejected wax-filled carts come here from the reject bucket. Scan → Space to photograph → Reject (Enter).
					Not being rejected means accepted — there is nothing to do for good carts.
				</p>
			</div>
			<div class="flex gap-4 text-xs text-[var(--color-tron-text-secondary)]">
				<div>wax_filled: <span class="font-mono text-[var(--color-tron-cyan)]">{counts.wax_filled}</span></div>
				<div>rejected today: <span class="font-mono text-[var(--color-tron-red,#ff3366)]">{counts.wax_rejected_today}</span></div>
				<div>Operator: <span class="text-[var(--color-tron-cyan)]">{data.user.username}</span></div>
			</div>
		</header>

		{#if rejectBanner}
			<div class="rounded border border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.1)] p-3 text-sm text-[var(--color-tron-red,#ff3366)]">
				<span class="font-semibold">✕ Can't reject:</span> {rejectBanner}
			</div>
		{/if}

		{#if banner}
			<div class="rounded border p-3 text-sm
				{banner.kind === 'ok' ? 'border-[var(--color-tron-green,#39ff14)] bg-[rgba(57,255,20,0.08)] text-[var(--color-tron-green,#39ff14)]' : ''}
				{banner.kind === 'err' ? 'border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.08)] text-[var(--color-tron-red,#ff3366)]' : ''}
				{banner.kind === 'info' ? 'border-[var(--color-tron-cyan)] bg-[rgba(0,255,255,0.08)] text-[var(--color-tron-cyan)]' : ''}">
				{banner.text}
			</div>
		{/if}

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
							{#if capturedNumber} · 📷 {capturedNumber}{/if}
						</div>
						<button
							type="button"
							onclick={clearCartridge}
							class="mt-1 rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-[10px] uppercase text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)] hover:text-[var(--color-tron-cyan)]"
						>
							Release
						</button>
					{:else}
						<div class="font-mono text-lg text-[var(--color-tron-red,#ff3366)]">⚠ Scan a reject</div>
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

		<!-- Video pane + last capture -->
		<div class="grid gap-3 md:grid-cols-[2fr_1fr]">
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-black p-2">
				{#if cameraError}
					<div class="flex aspect-video items-center justify-center text-[var(--color-tron-red,#ff3366)]">{cameraError}</div>
				{:else}
					<!-- svelte-ignore a11y_media_has_caption -->
					<video bind:this={videoEl} class="aspect-video w-full rounded" playsinline autoplay muted></video>
				{/if}
			</div>
			<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-2">
				<div class="mb-1 text-xs uppercase text-[var(--color-tron-text-secondary)]">Photo for this reject</div>
				{#if capturedImageUrl}
					<img src={capturedImageUrl} alt={cartridgeId ?? 'capture'} class="aspect-video w-full rounded object-cover" />
				{:else}
					<div class="flex aspect-video items-center justify-center rounded border border-dashed border-[var(--color-tron-border)] text-xs text-[var(--color-tron-text-secondary)]">
						{cartridgeId ? 'Press Space to photograph' : 'Scan first'}
					</div>
				{/if}
			</div>
		</div>

		<!-- Reason (optional) -->
		<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-3">
			<div class="mb-2 text-xs uppercase text-[var(--color-tron-text-secondary)]">Reason <span class="normal-case opacity-70">(optional)</span></div>
			<div class="flex flex-wrap items-center gap-2">
				{#each REASON_CHIPS as chip (chip)}
					<button
						type="button"
						onclick={() => { reasonChip = reasonChip === chip ? null : chip; scanInputEl?.focus(); }}
						disabled={!cartridgeId}
						class="rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-40
							{reasonChip === chip
								? 'border-[var(--color-tron-red,#ff3366)] bg-[rgba(255,51,102,0.15)] text-[var(--color-tron-red,#ff3366)]'
								: 'border-[var(--color-tron-border)] text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]'}"
					>{chip}</button>
				{/each}
				<input
					type="text"
					bind:value={reasonText}
					disabled={!cartridgeId}
					placeholder="note…"
					class="tron-input min-w-[200px] flex-1 text-sm"
					onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submitReject(); } }}
				/>
			</div>
		</div>

		<!-- Action bar -->
		<div class="flex flex-wrap items-center gap-3">
			<button
				type="button"
				onclick={() => capturePhoto()}
				disabled={submitting || !stream || !cartridgeId}
				class="rounded bg-[var(--color-tron-cyan)] px-6 py-3 text-lg font-bold text-[var(--color-tron-bg-primary)] disabled:opacity-40"
			>
				{submitting ? 'Capturing…' : capturedImageId ? '📷 Retake (Space)' : '📷 Photograph (Space)'}
			</button>
			<button
				type="button"
				onclick={() => submitReject()}
				disabled={rejecting || !cartridgeId || !capturedImageId}
				title={!capturedImageId ? 'Snap a photo first' : 'Mark wax_rejected'}
				class="rounded bg-red-600 px-6 py-3 text-lg font-bold text-white transition-colors hover:bg-red-500 disabled:opacity-40"
			>
				{rejecting ? 'Rejecting…' : '✗ Reject (Enter)'}
			</button>
			{#if cartridgeId && !capturedImageId}
				<div class="text-xs text-[var(--color-tron-yellow,#facc15)]">Snap a photo first — every reject needs its picture.</div>
			{:else if !cartridgeId}
				<div class="text-xs text-[var(--color-tron-text-secondary)]">Scan a cartridge from the reject bucket to begin</div>
			{/if}
		</div>

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

		<!-- Session feed: last 50 wax_rejected + live prepends -->
		<div>
			<h3 class="mb-2 text-sm font-semibold uppercase text-[var(--color-tron-text-secondary)]">Recent wax rejects</h3>
			{#if feed.length === 0}
				<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-secondary)] p-4 text-sm text-[var(--color-tron-text-secondary)]">
					No rejects yet.
				</div>
			{:else}
				<div class="overflow-x-auto rounded-lg border border-[var(--color-tron-border)]">
					<table class="w-full text-left text-sm">
						<thead class="bg-[var(--color-tron-bg-secondary)] text-xs uppercase text-[var(--color-tron-text-secondary)]">
							<tr>
								<th class="px-3 py-2">Photo</th>
								<th class="px-3 py-2">Cartridge</th>
								<th class="px-3 py-2">Reason</th>
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
												<img src={row.imageUrl} alt={row.cartridgeId} class="h-12 w-12 cursor-pointer rounded object-cover" loading="lazy" />
											</button>
										{:else}
											<div class="flex h-12 w-12 items-center justify-center rounded bg-[var(--color-tron-bg-tertiary)] text-[10px] text-[var(--color-tron-text-secondary)]">—</div>
										{/if}
									</td>
									<td class="px-3 py-2 font-mono text-xs text-[var(--color-tron-cyan)]" title={row.cartridgeId}>
										<a href={`/cartridge-admin/dhr/${encodeURIComponent(row.cartridgeId)}`} class="hover:underline">{lastTwelve(row.cartridgeId)}</a>
									</td>
									<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{row.reason ?? '—'}</td>
									<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{row.operator ?? '—'}</td>
									<td class="px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">{timeLabel(row.at)}</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</div>
	</div>
</div>
