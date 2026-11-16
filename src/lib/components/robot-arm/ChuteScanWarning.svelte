<script lang="ts">
	/**
	 * Chute scan warning (2026-11-16): the newest failed chute barcode scan (a
	 * trapdoor fire step with Scan Barcode After read nothing, or not a whole
	 * cartridge label). It never stops a run (Alejandro, 2026-11-16).
	 *
	 *   Close  dismisses every failed scan up to now, for everyone (server side)
	 *   Hide   folds it into a Show Warning chip in this browser; a newer
	 *          failed scan shows again (the hidden scan id is remembered, as the
	 *          panel's preflight warning remembers its text)
	 *
	 * Polls GET /api/robot-arm/chute-scans every 10 s while the tab is visible.
	 */
	import { onMount } from 'svelte';
	import { chuteWarningText, type ChuteScanWarning } from '$lib/robot-arm/chute-scan';

	const POLL_MS = 10_000;
	const HIDDEN_KEY = 'robot-arm:chute-warning-hidden';

	let warning = $state<ChuteScanWarning | null>(null);
	let hiddenId = $state<string | null>(null);
	let closing = $state(false);
	let closeError = $state<string | null>(null);
	let now = $state(new Date());

	const hidden = $derived(!!warning && hiddenId === warning._id);

	async function poll() {
		if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
		try {
			const r = await fetch('/api/robot-arm/chute-scans');
			if (!r.ok) return;
			const d = (await r.json()) as { warning: ChuteScanWarning | null };
			warning = d.warning;
			now = new Date();
		} catch {
			/* offline: keep what is shown */
		}
	}

	onMount(() => {
		try {
			hiddenId = localStorage.getItem(HIDDEN_KEY);
		} catch {
			/* storage unavailable */
		}
		poll();
		const t = setInterval(poll, POLL_MS);
		const onVisible = () => document.visibilityState === 'visible' && poll();
		document.addEventListener('visibilitychange', onVisible);
		return () => {
			clearInterval(t);
			document.removeEventListener('visibilitychange', onVisible);
		};
	});

	function setHidden(value: boolean) {
		hiddenId = value && warning ? warning._id : null;
		try {
			if (hiddenId) localStorage.setItem(HIDDEN_KEY, hiddenId);
			else localStorage.removeItem(HIDDEN_KEY);
		} catch {
			/* ignore */
		}
	}

	async function close() {
		closing = true;
		closeError = null;
		try {
			const r = await fetch('/api/robot-arm/chute-scans/close', { method: 'POST' });
			if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
			warning = null;
			setHidden(false);
		} catch (err) {
			closeError = `Close failed: ${err instanceof Error ? err.message : String(err)}`;
		} finally {
			closing = false;
		}
	}
</script>

{#if warning && hidden}
	<button
		type="button"
		onclick={() => setHidden(false)}
		class="mt-2 rounded border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-xs font-semibold text-amber-200 hover:bg-amber-500/20"
	>
		Show Warning
	</button>
{:else if warning}
	<div
		class="mt-2 flex items-start gap-3 rounded border p-2 text-xs"
		style="border-color: #f59e0b; background: rgba(245,158,11,0.08); color: var(--color-tron-text)"
		role="alert"
	>
		<span class="flex-1">
			⚠ {chuteWarningText(warning, now)}
			{#if closeError}<span class="mt-1 block text-red-300">{closeError}</span>{/if}
		</span>
		<button
			type="button"
			onclick={() => setHidden(true)}
			class="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 font-semibold text-amber-200 hover:bg-amber-500/20"
		>
			Hide
		</button>
		<button
			type="button"
			onclick={close}
			disabled={closing}
			class="shrink-0 rounded border border-amber-500/40 px-2 py-0.5 font-semibold text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
		>
			{closing ? 'Closing…' : 'Close'}
		</button>
	</div>
{/if}
