<script lang="ts">
	import { enhance } from '$app/forms';
	import { goto } from '$app/navigation';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import bwipjs from 'bwip-js/browser';
	import {
		ZT230_2X_075_DEFAULTS,
		buildAlignmentZpl,
		buildCartridgeLabelsZpl,
		computeGeometry,
		type ZebraLabelConfig
	} from '$lib/zebra/cartridge-label-zpl';
	import {
		defaultPrinter,
		describeDevice,
		detectAgent,
		listPrinters,
		queryHostStatus,
		sendZpl,
		type BrowserPrintDevice
	} from '$lib/zebra/browser-print';
	import type { ActionData, PageData } from './$types';

	interface Props {
		data: PageData;
		form: ActionData;
	}
	let { data, form }: Props = $props();

	// ── Printer / agent ──────────────────────────────────────────────────
	let agentReachable = $state<boolean | null>(null);
	let agentError = $state<string | null>(null);
	let printers = $state<BrowserPrintDevice[]>([]);
	let selectedUid = $state<string>('');
	let refreshingPrinters = $state(false);
	let printerStatus = $state<string | null>(null);
	const PRINTER_KEY = 'zebraPrinter.uid';

	const selectedPrinter = $derived(printers.find((p) => p.uid === selectedUid) ?? null);

	async function refreshPrinters() {
		refreshingPrinters = true;
		agentError = null;
		try {
			const st = await detectAgent(true);
			agentReachable = st.reachable;
			if (!st.reachable) {
				agentError = st.error ?? 'Browser Print agent not reachable';
				printers = [];
				return;
			}
			printers = await listPrinters();
			const saved = typeof localStorage !== 'undefined' ? localStorage.getItem(PRINTER_KEY) : null;
			if (saved && printers.some((p) => p.uid === saved)) {
				selectedUid = saved;
			} else if (!printers.some((p) => p.uid === selectedUid)) {
				const def = await defaultPrinter();
				selectedUid = def && printers.some((p) => p.uid === def.uid) ? def.uid : (printers[0]?.uid ?? '');
			}
		} catch (e) {
			agentReachable = false;
			agentError = e instanceof Error ? e.message : String(e);
			printers = [];
		} finally {
			refreshingPrinters = false;
		}
	}

	$effect(() => {
		if (typeof localStorage === 'undefined' || !selectedUid) return;
		localStorage.setItem(PRINTER_KEY, selectedUid);
	});

	async function checkPrinterStatus() {
		if (!selectedPrinter) return;
		printerStatus = 'Querying…';
		const s = await queryHostStatus(selectedPrinter);
		if (!s) {
			printerStatus = 'No status reply (agent/printer did not answer ~HS)';
			return;
		}
		const flags = [
			s.paperOut ? 'PAPER OUT' : null,
			s.headOpen ? 'HEAD OPEN' : null,
			s.paused ? 'PAUSED' : null
		].filter(Boolean);
		printerStatus = flags.length ? `⚠ ${flags.join(' · ')}` : `✓ Ready${s.labelsRemainingInBatch ? ` (${s.labelsRemainingInBatch} labels still queued)` : ''}`;
	}

	onMount(() => {
		void refreshPrinters();
	});

	// ── Calibration (per browser, like the Avery page) ───────────────────
	const CALIB_KEY = 'zebraLabelCalib.v1';
	function loadCalib(): Partial<ZebraLabelConfig> | null {
		if (typeof localStorage === 'undefined') return null;
		try {
			return JSON.parse(localStorage.getItem(CALIB_KEY) || 'null');
		} catch {
			return null;
		}
	}
	const _saved = loadCalib();
	let dpi = $state(_saved?.dpi ?? ZT230_2X_075_DEFAULTS.dpi);
	let columnGapIn = $state(_saved?.columnGapIn ?? ZT230_2X_075_DEFAULTS.columnGapIn);
	let offsetX = $state(_saved?.offsetX ?? ZT230_2X_075_DEFAULTS.offsetX);
	let offsetY = $state(_saved?.offsetY ?? ZT230_2X_075_DEFAULTS.offsetY);
	let darkness = $state<number | ''>(_saved?.darkness ?? '');
	let printSpeedIps = $state<number | ''>(_saved?.printSpeedIps ?? '');
	let qrMagnification = $state(_saved?.qrMagnification ?? ZT230_2X_075_DEFAULTS.qrMagnification);
	let abcMarks = $state(_saved?.abcMarks ?? ZT230_2X_075_DEFAULTS.abcMarks);
	let humanReadable = $state(_saved?.humanReadable ?? ZT230_2X_075_DEFAULTS.humanReadable);

	const cfg = $derived<ZebraLabelConfig>({
		...ZT230_2X_075_DEFAULTS,
		dpi: Number(dpi) || 203,
		columnGapIn: Number(columnGapIn) || 0,
		offsetX: Math.round(Number(offsetX) || 0),
		offsetY: Math.round(Number(offsetY) || 0),
		darkness: darkness === '' ? undefined : Number(darkness),
		printSpeedIps: printSpeedIps === '' ? undefined : Number(printSpeedIps),
		qrMagnification: Math.max(1, Math.min(10, Math.round(Number(qrMagnification) || 3))),
		abcMarks,
		humanReadable
	});
	const geometry = $derived(computeGeometry(cfg));

	$effect(() => {
		if (typeof localStorage === 'undefined') return;
		localStorage.setItem(CALIB_KEY, JSON.stringify(cfg));
	});
	function resetCalib() {
		dpi = ZT230_2X_075_DEFAULTS.dpi;
		columnGapIn = ZT230_2X_075_DEFAULTS.columnGapIn;
		offsetX = 0;
		offsetY = 0;
		darkness = '';
		printSpeedIps = '';
		qrMagnification = ZT230_2X_075_DEFAULTS.qrMagnification;
		abcMarks = true;
		humanReadable = true;
	}

	// ── Mint / preview expiry (same contract as the Avery page) ──────────
	let count = $state(20);
	let submitting = $state(false);
	let nowMs = $state(Date.now());
	const hasBatch = $derived(!!(form && 'success' in form && form.success && form.barcodes?.length));
	const expiresAtMs = $derived(hasBatch ? ((form as any).expiresAtMs ?? null) : null);
	const msLeft = $derived(expiresAtMs === null ? null : expiresAtMs - nowMs);
	let serverExpired = $state(false);
	const previewExpired = $derived(serverExpired || (msLeft !== null && msLeft <= 0));
	$effect(() => {
		serverExpired = false;
		if (expiresAtMs === null) return;
		nowMs = Date.now();
		const id = setInterval(() => (nowMs = Date.now()), 1000);
		const resync = () => (nowMs = Date.now());
		document.addEventListener('visibilitychange', resync);
		window.addEventListener('pageshow', resync);
		return () => {
			clearInterval(id);
			document.removeEventListener('visibilitychange', resync);
			window.removeEventListener('pageshow', resync);
		};
	});
	const countdownLabel = $derived.by(() => {
		if (msLeft === null || msLeft <= 0) return '';
		const total = Math.ceil(msLeft / 1000);
		return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
	});
	const barcodes = $derived<string[]>(hasBatch ? (form as any).barcodes : []);
	const spotCheck = $derived(hasBatch ? (form as any).spotCheck : null);

	// ── Sending ──────────────────────────────────────────────────────────
	let sending = $state(false);
	let sendError = $state<string | null>(null);
	let sentAtMs = $state<number | null>(null);
	let showConfirm = $state(false);
	let confirming = $state(false);
	let addError = $state<string | null>(null);
	let testMsg = $state<string | null>(null);

	const job = $derived.by(() => {
		if (!barcodes.length) return null;
		try {
			return buildCartridgeLabelsZpl(barcodes, cfg);
		} catch (e) {
			return { error: e instanceof Error ? e.message : String(e) } as const;
		}
	});

	async function sendBatch() {
		if (sending || !job || 'error' in job) return;
		if (previewExpired) {
			sendError = 'This batch expired before it was sent. Generate a fresh batch — nothing was printed or counted.';
			return;
		}
		if (!selectedPrinter) {
			sendError = 'Pick a printer first.';
			return;
		}
		sending = true;
		sendError = null;
		try {
			await sendZpl(selectedPrinter, job.zpl);
			sentAtMs = Date.now();
			showConfirm = true;
		} catch (e) {
			sendError = e instanceof Error ? e.message : String(e);
		} finally {
			sending = false;
		}
	}

	async function printAlignment() {
		if (!selectedPrinter) {
			testMsg = 'Pick a printer first.';
			return;
		}
		testMsg = 'Sending…';
		try {
			await sendZpl(selectedPrinter, buildAlignmentZpl(cfg).zpl);
			testMsg = '✓ Alignment row sent. The border should sit exactly on the die-cut edge of both labels; nudge X/Y and repeat.';
		} catch (e) {
			testMsg = `✗ ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	function downloadZpl() {
		if (!job || 'error' in job || !hasBatch) return;
		const blob = new Blob([job.zpl], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `cartridge-labels-${(form as any).batchId}.zpl`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 5000);
	}

	async function discardAndReset() {
		showConfirm = false;
		await goto($page.url.pathname, { invalidateAll: true, replaceState: true });
	}

	// ── On-screen preview of the first row, drawn from the SAME geometry ──
	const PREVIEW_SCALE = 2;
	let previewCanvas = $state<HTMLCanvasElement | null>(null);
	$effect(() => {
		const canvas = previewCanvas;
		if (!canvas) return;
		const g = geometry;
		const c = cfg;
		const codes = barcodes.length ? barcodes.slice(0, c.columns) : Array.from({ length: c.columns }, () => '00000000-0000-4000-8000-000000000000');
		const pitch = g.labelW + g.gap;
		const W = (c.columns * pitch - g.gap + Math.max(0, c.offsetX)) * PREVIEW_SCALE;
		const H = (g.labelH + Math.max(0, c.offsetY)) * PREVIEW_SCALE;
		canvas.width = W;
		canvas.height = H;
		const ctx = canvas.getContext('2d');
		if (!ctx) return;
		ctx.fillStyle = '#e5e7eb'; // liner
		ctx.fillRect(0, 0, W, H);
		const S = PREVIEW_SCALE;
		for (let col = 0; col < c.columns; col++) {
			const lx = col * pitch * S;
			ctx.fillStyle = '#ffffff';
			ctx.fillRect(lx, 0, g.labelW * S, g.labelH * S); // die-cut label
			const ox = lx + c.offsetX * S;
			const oy = c.offsetY * S;
			ctx.fillStyle = '#000';
			ctx.textBaseline = 'top';
			if (c.abcMarks) {
				ctx.font = `bold ${g.abcFont * S}px courier, monospace`;
				ctx.textAlign = 'left';
				for (let i = 0; i < 3; i++) ctx.fillText('ABC'[i], ox + (g.abcLeft + i * g.abcSpacing) * S, oy + g.abcTop * S);
			}
			try {
				const qc = document.createElement('canvas');
				bwipjs.toCanvas(qc, { bcid: 'qrcode', text: codes[col], scale: 4, eclevel: c.qrEcc } as any);
				ctx.drawImage(qc, ox + g.qrLeft * S, oy + g.qrTop * S, g.qrSize * S, g.qrSize * S);
			} catch { /* preview only */ }
			if (g.textLines > 0) {
				const code = codes[col];
				const half = Math.ceil(code.length / 2);
				ctx.font = `${g.textFont * S}px courier, monospace`;
				ctx.textAlign = 'center';
				const lineH = Math.round(g.textFont * 1.1) * S;
				ctx.fillText(code.slice(0, half), ox + (g.labelW / 2) * S, oy + g.textTop * S);
				ctx.fillText(code.slice(half), ox + (g.labelW / 2) * S, oy + g.textTop * S + lineH);
			}
		}
	});

	const oddCount = $derived(count % data.columns !== 0);
</script>

<div class="space-y-5 p-4">
	<div>
		<h1 class="text-xl font-semibold" style="color: var(--color-tron-cyan)">Print Cartridge Barcodes — Zebra ZT230</h1>
		<p class="mt-1 text-xs" style="color: var(--color-tron-text-secondary)">
			Roll labels, {data.columns}-across ¾&quot; squares. Same UUID barcodes and inventory accounting as the
			<a href="/manufacturing/print-barcodes" class="underline" style="color: var(--color-tron-cyan)">Avery sheet page</a>;
			the job is pushed to the printer through Zebra Browser Print on this PC (USB or LAN/WiFi).
		</p>
	</div>

	<!-- Printer -->
	<div class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3 space-y-2 text-sm">
		<div class="flex flex-wrap items-center gap-3">
			<span style="color: var(--color-tron-text)">Browser Print agent:</span>
			{#if agentReachable === null}
				<span style="color: var(--color-tron-text-secondary)">detecting…</span>
			{:else if agentReachable}
				<span class="text-emerald-400">● connected</span>
			{:else}
				<span class="text-red-400">● not reachable</span>
			{/if}
			<button type="button" onclick={refreshPrinters} disabled={refreshingPrinters}
				class="rounded border border-[var(--color-tron-border)] px-2 py-0.5 text-xs hover:border-[var(--color-tron-text-secondary)] disabled:opacity-50"
				style="color: var(--color-tron-text-secondary)">{refreshingPrinters ? 'Refreshing…' : 'Refresh'}</button>
		</div>
		{#if agentReachable === false}
			<div class="rounded border border-amber-500/50 bg-amber-900/20 p-2 text-xs text-amber-200">
				Install <strong>Zebra Browser Print</strong> on this PC and make sure it is running (tray icon). Add the ZT230 in the
				agent (USB, or its IP for WiFi/Ethernet). On first use the agent asks you to <em>Accept</em> this site — click it, then Refresh.
				{#if agentError}<div class="mt-1 font-mono opacity-70">{agentError}</div>{/if}
			</div>
		{:else if agentReachable && printers.length === 0}
			<div class="text-xs text-amber-200">Agent is running but sees no printers. Add the ZT230 in the Browser Print settings, then Refresh.</div>
		{/if}
		{#if printers.length > 0}
			<div class="flex flex-wrap items-center gap-3">
				<label class="block">
					<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Printer</span>
					<select bind:value={selectedUid}
						class="mt-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm"
						style="color: var(--color-tron-text)">
						{#each printers as p (p.uid)}
							<option value={p.uid}>{describeDevice(p)}</option>
						{/each}
					</select>
				</label>
				<button type="button" onclick={checkPrinterStatus} disabled={!selectedPrinter}
					class="mt-4 rounded border border-[var(--color-tron-border)] px-2 py-1 text-xs hover:border-[var(--color-tron-text-secondary)] disabled:opacity-50"
					style="color: var(--color-tron-text-secondary)">Check status</button>
				{#if printerStatus}<span class="mt-4 text-xs font-mono" style="color: var(--color-tron-text)">{printerStatus}</span>{/if}
			</div>
		{/if}
		<div class="text-[11px]" style="color: var(--color-tron-text-secondary)">
			Labels (PT-CT-106) on hand: <strong class="font-mono" style="color: var(--color-tron-cyan)">{data.labelsOnHand}</strong>
		</div>
	</div>

	<!-- Calibration -->
	<details class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
		<summary class="cursor-pointer text-sm font-medium" style="color: var(--color-tron-text)">Label layout &amp; printer calibration</summary>
		<div class="mt-3 space-y-3">
			<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">
				Every element is placed at absolute dot coordinates, so once X/Y are dialled in the design lands in the same spot on every label.
				Use <em>Print alignment row</em> (mints nothing) until the border sits on the die-cut edge. Settings are saved in this browser only
				and recorded with each confirmed batch.
			</p>
			<div class="grid gap-3 sm:grid-cols-4">
				<label class="block"><span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Printer dpi</span>
					<select bind:value={dpi} class="mt-1 w-28 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm font-mono" style="color: var(--color-tron-text)">
						<option value={203}>203</option><option value={300}>300</option>
					</select></label>
				<label class="block"><span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Gap between columns (in)</span>
					<input type="number" step="0.005" min="0" max="0.5" bind:value={columnGapIn} class="mt-1 w-28 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm font-mono" style="color: var(--color-tron-text)" /></label>
				<label class="block"><span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">X offset (dots, + = right)</span>
					<input type="number" step="1" bind:value={offsetX} class="mt-1 w-28 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm font-mono" style="color: var(--color-tron-text)" /></label>
				<label class="block"><span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Y offset (dots, + = down)</span>
					<input type="number" step="1" bind:value={offsetY} class="mt-1 w-28 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm font-mono" style="color: var(--color-tron-text)" /></label>
				<label class="block"><span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">QR module size (dots)</span>
					<input type="number" step="1" min="1" max="10" bind:value={qrMagnification} class="mt-1 w-28 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm font-mono" style="color: var(--color-tron-text)" /></label>
				<label class="block"><span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Darkness 0–30 (blank = printer)</span>
					<input type="number" step="1" min="0" max="30" bind:value={darkness} class="mt-1 w-28 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm font-mono" style="color: var(--color-tron-text)" /></label>
				<label class="block"><span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Speed ips 2–6 (blank = printer)</span>
					<input type="number" step="1" min="2" max="14" bind:value={printSpeedIps} class="mt-1 w-28 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm font-mono" style="color: var(--color-tron-text)" /></label>
				<div class="flex flex-col gap-1 pt-4 text-xs" style="color: var(--color-tron-text)">
					<label class="flex items-center gap-2"><input type="checkbox" bind:checked={abcMarks} /> A B C marks</label>
					<label class="flex items-center gap-2"><input type="checkbox" bind:checked={humanReadable} /> UUID text</label>
				</div>
			</div>
			<div class="flex flex-wrap items-center gap-3 text-[11px]" style="color: var(--color-tron-text-secondary)">
				<button type="button" onclick={printAlignment} disabled={!selectedPrinter}
					class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-3 py-1 hover:bg-[var(--color-tron-cyan)]/20 disabled:opacity-50"
					style="color: var(--color-tron-cyan)">Print alignment row</button>
				<button type="button" onclick={resetCalib}
					class="rounded border border-[var(--color-tron-border)] px-3 py-1 hover:border-[var(--color-tron-text-secondary)]">Reset to defaults</button>
				<span class="font-mono">{geometry.labelW}×{geometry.labelH} dots · QR {geometry.qrSize} dots · text {geometry.textLines ? `${geometry.textFont} dots` : 'off'} · ^PW{geometry.printWidth}</span>
			</div>
			{#if testMsg}<div class="text-xs" style="color: var(--color-tron-text)">{testMsg}</div>{/if}
		</div>
	</details>

	<!-- Mint form -->
	<form method="POST" action="?/mint"
		use:enhance={() => {
			submitting = true;
			sendError = null;
			sentAtMs = null;
			return async ({ update }) => {
				await update();
				submitting = false;
			};
		}}
		class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4 space-y-3">
		<div class="grid gap-3 sm:grid-cols-3">
			<label class="block">
				<span class="block text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">Labels to print (1–{data.maxLabelsPerJob})</span>
				<input type="number" name="count" bind:value={count} min="1" max={data.maxLabelsPerJob} required
					class="mt-1 w-32 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg)] px-2 py-1 text-sm font-mono" style="color: var(--color-tron-text)" />
			</label>
			<input type="hidden" name="printerName" value={selectedPrinter?.name ?? ''} />
		</div>
		<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">
			{Math.ceil(count / data.columns)} row{Math.ceil(count / data.columns) === 1 ? '' : 's'} of {data.columns}.
			{#if oddCount}<span class="text-amber-300">Odd count — the last row's right-hand label will be blank (peel and discard it).</span>{/if}
		</p>
		<button type="submit" disabled={submitting || hasBatch}
			class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 px-4 py-2 text-sm font-medium hover:bg-[var(--color-tron-cyan)]/20 disabled:opacity-50"
			style="color: var(--color-tron-cyan)">
			{submitting ? 'Generating…' : hasBatch ? 'Batch reserved — send or discard below' : `Generate ${count} & reserve`}
		</button>
	</form>

	{#if form && 'error' in form && form.error}
		<div class="rounded border border-red-500/50 bg-red-900/20 p-3 text-sm text-red-300">{form.error}</div>
	{/if}

	<!-- Reserved batch → send -->
	{#if hasBatch}
		<div class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 p-3 space-y-2">
			<div class="text-sm" style="color: var(--color-tron-cyan)">
				<strong>Minted {barcodes.length} barcode{barcodes.length === 1 ? '' : 's'}</strong>
				&nbsp;<span class="font-mono text-xs">({barcodes[0]}</span> &hellip; <span class="font-mono text-xs">{barcodes[barcodes.length - 1]})</span>
			</div>
			{#if spotCheck}
				{@const ok = spotCheck.collisions.length === 0}
				<div class="text-xs" style="color: {ok ? 'var(--color-tron-text-secondary)' : '#fca5a5'}">
					{#if ok}✓ Spot-check passed: {spotCheck.sampleSize}/{spotCheck.sampleSize} random barcodes verified unique against <code class="font-mono">cartridge_records</code>.
					{:else}✗ Spot-check FAILED: {spotCheck.collisions.join(', ')} already exist — investigate before printing.{/if}
				</div>
			{/if}
			{#if previewExpired}
				<div class="rounded border border-amber-500/50 bg-amber-900/20 p-2 text-xs text-amber-200">
					This batch has expired and can no longer be sent or counted. Generate a new batch — nothing was deducted.
				</div>
			{:else if countdownLabel}
				<div class="text-[11px]" style="color: var(--color-tron-text-secondary)">
					Batch expires in <strong class="font-mono" style="color: var(--color-tron-text)">{countdownLabel}</strong> — send and confirm before then.
				</div>
			{/if}
			{#if job && 'error' in job}
				<div class="rounded border border-red-500/50 bg-red-900/20 p-2 text-xs text-red-300">ZPL build failed: {job.error}</div>
			{/if}
			{#if sendError}
				<div class="rounded border border-red-500/50 bg-red-900/20 p-2 text-xs text-red-300">{sendError}</div>
			{/if}
			<div class="flex flex-wrap items-center gap-2">
				<button type="button" onclick={sendBatch}
					disabled={sending || previewExpired || !selectedPrinter || !job || 'error' in job}
					class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-50">
					{#if previewExpired}Expired — generate a new batch{:else if sending}Sending…{:else if sentAtMs}Sent — send again{:else}Send {barcodes.length} labels to {selectedPrinter?.name ?? 'printer'}{/if}
				</button>
				{#if sentAtMs && !showConfirm}
					<button type="button" onclick={() => (showConfirm = true)}
						class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-sm hover:border-[var(--color-tron-text-secondary)]"
						style="color: var(--color-tron-text)">Labels printed — add to inventory</button>
				{/if}
				<button type="button" onclick={downloadZpl} disabled={previewExpired || !job || 'error' in job}
					class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs hover:border-[var(--color-tron-text-secondary)] disabled:opacity-50"
					style="color: var(--color-tron-text-secondary)" title="Fallback: send the .zpl with Zebra Setup Utilities if the agent is unavailable">Download .zpl</button>
				<button type="button" onclick={discardAndReset}
					class="rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs hover:border-[var(--color-tron-text-secondary)]"
					style="color: var(--color-tron-text-secondary)">Discard batch</button>
			</div>
			<p class="text-[11px]" style="color: var(--color-tron-text-secondary)">
				“Send again” re-sends the <em>same</em> UUIDs — only use it if nothing came out of the printer. Duplicate physical labels must be destroyed.
			</p>
		</div>
	{/if}

	<!-- Preview -->
	<div>
		<p class="text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
			{hasBatch ? 'Preview — first row of the job (same geometry as the ZPL)' : 'Layout preview (placeholder UUIDs until you mint)'}
		</p>
		<canvas bind:this={previewCanvas} class="mt-2 max-w-full rounded border border-[var(--color-tron-border)]" style="image-rendering: pixelated; height: {geometry.labelH * 2 + Math.max(0, cfg.offsetY) * 2}px"></canvas>
	</div>

	<!-- Recent -->
	{#if data.recent.length > 0}
		<details class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-3">
			<summary class="cursor-pointer text-sm font-medium" style="color: var(--color-tron-text)">Recent Zebra batches ({data.recent.length})</summary>
			<table class="mt-3 w-full text-xs">
				<thead><tr class="border-b border-[var(--color-tron-border)] text-[10px] uppercase tracking-wider" style="color: var(--color-tron-text-secondary)">
					<th class="px-2 py-1 text-left">When</th><th class="px-2 py-1 text-left">Range</th><th class="px-2 py-1 text-left">Count</th><th class="px-2 py-1 text-left">Printer</th><th class="px-2 py-1 text-left">By</th></tr></thead>
				<tbody>
					{#each data.recent as r}
						<tr class="border-b border-[var(--color-tron-border)]/40">
							<td class="px-2 py-1" style="color: var(--color-tron-text-secondary)">{new Date(r.printedAt).toLocaleString()}</td>
							<td class="px-2 py-1 font-mono" style="color: var(--color-tron-text)">{r.firstBarcodeId} – {r.lastBarcodeId}</td>
							<td class="px-2 py-1" style="color: var(--color-tron-text)">{r.totalLabels}</td>
							<td class="px-2 py-1" style="color: var(--color-tron-text-secondary)">{r.printerName ?? '—'}</td>
							<td class="px-2 py-1" style="color: var(--color-tron-text-secondary)">{r.printedBy?.username ?? '—'}</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</details>
	{/if}
</div>

<!-- Confirm modal -->
{#if showConfirm && hasBatch}
	<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
		<div class="w-full max-w-md rounded-lg border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-surface)] p-5 shadow-2xl">
			<h3 class="text-lg font-semibold" style="color: var(--color-tron-cyan)">Did the labels print? Add to inventory?</h3>
			<p class="mt-2 text-sm" style="color: var(--color-tron-text)">
				Confirming records <strong class="font-mono">{barcodes.length}</strong> printed label{barcodes.length === 1 ? '' : 's'} against
				<strong>Barcodes (PT-CT-106)</strong> — the part WI-01 cartridge-back consumes. No sheet is deducted for roll media.
			</p>
			<p class="mt-2 text-xs" style="color: var(--color-tron-text-secondary)">
				Choose <em>No</em> if the printer jammed, ran out, or printed nothing. If it printed <em>partially</em>, still confirm — the un-printed UUIDs are simply never used — and destroy any damaged labels.
			</p>
			{#if previewExpired}
				<div class="mt-3 rounded border border-amber-500/50 bg-amber-900/20 p-2 text-xs text-amber-200">
					This batch expired, so it can no longer be added to inventory. <strong>Destroy the printed labels</strong> — they were never recorded — then generate a fresh batch.
				</div>
			{:else if countdownLabel}
				<p class="mt-3 text-xs" style="color: var(--color-tron-text-secondary)">Expires in <strong class="font-mono">{countdownLabel}</strong></p>
			{/if}
			{#if addError}<div class="mt-3 rounded border border-red-500/50 bg-red-900/20 p-2 text-xs text-red-300">{addError}</div>{/if}
			<form method="POST" action="?/confirm" class="mt-4 flex justify-end gap-2"
				use:enhance={() => {
					confirming = true;
					addError = null;
					return async ({ result, update }) => {
						if (result.type === 'success') {
							showConfirm = false;
							confirming = false;
							await update({ reset: true });
							await goto($page.url.pathname, { invalidateAll: true, replaceState: true });
						} else if (result.type === 'failure') {
							addError = (result.data as any)?.addError ?? 'Failed to add to inventory';
							if ((result.data as any)?.addExpired) serverExpired = true;
							confirming = false;
						} else {
							confirming = false;
						}
					};
				}}>
				<input type="hidden" name="batchId" value={(form as any).batchId ?? ''} />
				<input type="hidden" name="totalLabels" value={barcodes.length} />
				<input type="hidden" name="barcodes" value={barcodes.join(',')} />
				<input type="hidden" name="printerName" value={selectedPrinter?.name ?? ''} />
				<input type="hidden" name="printerUid" value={selectedPrinter?.uid ?? ''} />
				<input type="hidden" name="calibration" value={JSON.stringify(cfg)} />
				<button type="button" onclick={discardAndReset} disabled={confirming}
					class="rounded border border-[var(--color-tron-border)] px-4 py-2 text-sm font-medium hover:border-[var(--color-tron-text-secondary)] disabled:opacity-50"
					style="color: var(--color-tron-text-secondary)">No, discard</button>
				<button type="submit" disabled={confirming || previewExpired}
					class="rounded border border-[var(--color-tron-cyan)] bg-[var(--color-tron-cyan)] px-4 py-2 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-50">
					{#if previewExpired}Expired{:else if confirming}Adding…{:else}Yes, add to inventory{/if}
				</button>
			</form>
		</div>
	</div>
{/if}
