<script lang="ts">
	import { page } from '$app/stores';

	type ModelId = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7';
	type Confidence = 'high' | 'partial' | 'degraded';
	type FeedbackState = 'idle' | 'comment-open' | 'sending' | 'sent';
	type FlagState = 'idle' | 'open' | 'sending' | 'sent';

	interface Usage {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		estCostUsd: number;
	}

	interface Message {
		role: 'user' | 'assistant';
		content: string;
		toolCalls?: Array<{ name: string; input: any; result: any }>;
		usage?: Usage;
		model?: ModelId;
		error?: string;
		responseId?: string;
		confidence?: Confidence;
		feedbackState?: FeedbackState;
		feedbackRating?: 'up' | 'down';
		feedbackComment?: string;
		flagState?: FlagState;
		flagReason?: string;
	}

	const HIDDEN_PREFIXES = ['/login', '/logout', '/invite', '/cv'];
	const BUDGET_WARN_USD = 1.0;
	const CIRCUIT_THRESHOLD = 5;
	const CIRCUIT_WINDOW_MS = 60_000;
	const CIRCUIT_COOLDOWN_MS = 5 * 60_000;

	type EntityType =
		| 'cartridge' | 'run' | 'wax_filling_run' | 'wax_batch' | 'reagent_run'
		| 'lot' | 'receiving_lot' | 'part' | 'equipment' | 'document'
		| 'work_instruction' | 'anomaly' | 'experiment' | 'protocol';

	interface PageContext {
		path: string;
		title?: string;
		entityType?: EntityType;
		entityId?: string;
	}

	/**
	 * Parse a BIMS pathname into an entity type + id when the route matches
	 * a known shape. Server side does its own validation, so this list can
	 * stay practical rather than exhaustive — unknown routes simply produce
	 * { path } with no entity, which the agent treats as informational only.
	 */
	function parsePathnameToEntity(pathname: string): { entityType?: EntityType; entityId?: string } {
		const segs = pathname.split('/').filter(Boolean);
		if (segs.length < 2) return {};
		const id = segs[segs.length - 1];
		// /cartridges/{id} or /cartridge-admin/dhr/{id}
		if (segs[0] === 'cartridges' && segs.length === 2) return { entityType: 'cartridge', entityId: id };
		if (segs[0] === 'cartridge-admin' && segs[1] === 'dhr' && segs.length === 3) {
			return { entityType: 'cartridge', entityId: id };
		}
		// /manufacturing/opentron-control/wax/{runId} | /reagent/{runId}
		if (segs[0] === 'manufacturing' && segs[1] === 'opentron-control' && segs[2] === 'wax' && segs.length === 4) {
			return { entityType: 'wax_filling_run', entityId: id };
		}
		if (segs[0] === 'manufacturing' && segs[1] === 'opentron-control' && segs[2] === 'reagent' && segs.length === 4) {
			return { entityType: 'reagent_run', entityId: id };
		}
		// /manufacturing/lots/{lotId} | /_receiving/{lotId} | /parts/accession/{lotId}
		if (segs[0] === 'manufacturing' && segs[1] === 'lots' && segs.length === 3) {
			return { entityType: 'receiving_lot', entityId: id };
		}
		if (segs[0] === '_receiving' && segs.length === 2) {
			return { entityType: 'receiving_lot', entityId: id };
		}
		if (segs[0] === 'parts' && segs[1] === 'accession' && segs.length === 3) {
			return { entityType: 'receiving_lot', entityId: id };
		}
		// /parts/{partId}
		if (segs[0] === 'parts' && segs.length === 2) return { entityType: 'part', entityId: id };
		// /batches/{batchId} — wax batch (legacy in-house wax)
		if (segs[0] === 'batches' && segs.length === 2) return { entityType: 'wax_batch', entityId: id };
		// /documents/instructions/{id} → work_instruction (handle BEFORE /documents/{id})
		if (segs[0] === 'documents' && segs[1] === 'instructions' && segs.length >= 3) {
			return { entityType: 'work_instruction', entityId: segs[2] };
		}
		if (segs[0] === 'documents' && segs.length === 2) return { entityType: 'document', entityId: id };
		// /opentrons/runs/{runId} → run
		if (segs[0] === 'opentrons' && segs[1] === 'runs' && segs.length === 3) {
			return { entityType: 'run', entityId: id };
		}
		// /devices/{deviceId} → equipment
		if (segs[0] === 'devices' && segs.length === 2) return { entityType: 'equipment', entityId: id };
		// /equipment/location/{locationId} — leave entity untyped (location, not a single piece of equipment)
		// /spu/{spuId} — SPU device under test, treat as equipment
		if (segs[0] === 'spu' && segs.length === 2) return { entityType: 'equipment', entityId: id };
		return {};
	}

	function currentPageContext(): PageContext {
		const path = $page.url.pathname;
		const title = typeof document !== 'undefined' ? document.title : undefined;
		const { entityType, entityId } = parsePathnameToEntity(path);
		const ctx: PageContext = { path };
		if (title) ctx.title = title;
		if (entityType) ctx.entityType = entityType;
		if (entityId) ctx.entityId = entityId;
		return ctx;
	}

	const visible = $derived.by(() => {
		const user = $page.data?.user;
		if (!user) return false;
		const path = $page.url.pathname;
		return !HIDDEN_PREFIXES.some(p => path === p || path.startsWith(p + '/'));
	});

	const canUseOpus = $derived.by(() => {
		const user = $page.data?.user as { roles?: { permissions?: string[] }[] } | undefined;
		if (!user?.roles) return false;
		return user.roles.some(r => r.permissions?.includes('admin:full'));
	});

	let isOpen = $state(false);
	let messages = $state<Message[]>([]);
	let input = $state('');
	let submitting = $state(false);
	let model = $state<ModelId>('claude-haiku-4-5');
	let listEl: HTMLDivElement | undefined = $state();

	// L.2 — first-open help banner. Persists dismissal in localStorage so the
	// operator only sees it once per browser session.
	let helpDismissed = $state(false);
	function dismissHelp() {
		helpDismissed = true;
		try { localStorage.setItem('askBimsHelpDismissed', '1'); } catch {}
	}

	// Reliability tier — circuit breaker + degraded-status tracking
	let failureTimes = $state<number[]>([]);
	let circuitOpenUntil = $state<number | null>(null);
	let degradedReason = $state<string | null>(null);
	let healthChecked = $state(false);

	function recordFailure(reason: string) {
		const now = Date.now();
		failureTimes = [...failureTimes.filter(t => now - t < CIRCUIT_WINDOW_MS), now];
		degradedReason = reason;
		if (failureTimes.length >= CIRCUIT_THRESHOLD) {
			circuitOpenUntil = now + CIRCUIT_COOLDOWN_MS;
			failureTimes = [];
		}
	}

	function recordSuccess() {
		failureTimes = [];
		degradedReason = null;
	}

	async function checkHealth() {
		try {
			const res = await fetch('/api/agent/ask/health');
			const body = await res.json();
			if (!body.ok) {
				degradedReason = body.apiKeyConfigured
					? 'Authentication issue'
					: 'Ask BIMS is not configured on this server';
			}
		} catch {
			degradedReason = 'Network error reaching Ask BIMS';
		}
	}

	const sessionTotals = $derived.by(() => {
		let tokens = 0;
		let costUsd = 0;
		for (const m of messages) {
			if (m.usage) {
				tokens += m.usage.inputTokens + m.usage.outputTokens + m.usage.cacheReadTokens + m.usage.cacheWriteTokens;
				costUsd += m.usage.estCostUsd;
			}
		}
		return { tokens, costUsd };
	});

	const MODEL_LABELS: Record<ModelId, string> = {
		'claude-haiku-4-5': 'Haiku · default · fast',
		'claude-sonnet-4-6': 'Sonnet · sharper',
		'claude-opus-4-7': 'Opus · admin · deepest'
	};

	function msgTokens(u: Usage): number {
		return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
	}

	async function submit(e?: Event) {
		e?.preventDefault();
		const text = input.trim();
		if (!text || submitting) return;

		// Circuit breaker check — if open and not yet expired, reject
		if (circuitOpenUntil != null) {
			if (Date.now() < circuitOpenUntil) {
				const minutesLeft = Math.ceil((circuitOpenUntil - Date.now()) / 60_000);
				messages = [...messages, {
					role: 'assistant', content: '',
					error: `Ask BIMS is in cooldown after multiple failures. Try again in ~${minutesLeft} min.`
				}];
				return;
			}
			circuitOpenUntil = null; // cooldown expired
		}

		if (sessionTotals.costUsd >= BUDGET_WARN_USD) {
			const ok = confirm(`This Ask BIMS session has spent $${sessionTotals.costUsd.toFixed(2)}. Continue?`);
			if (!ok) return;
		}

		const userMsg: Message = { role: 'user', content: text };
		messages = [...messages, userMsg];
		input = '';
		submitting = true;

		try {
			const res = await fetch('/api/agent/ask', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					history: messages.map(m => ({ role: m.role, content: m.content })),
					model,
					pageContext: currentPageContext()
				})
			});
			const body = await res.json();
			messages = [...messages, {
				role: 'assistant',
				content: body.answer ?? '',
				toolCalls: body.toolCalls,
				usage: body.usage,
				model: body.model,
				error: body.error,
				responseId: body.responseId,
				confidence: body.confidence,
				feedbackState: 'idle'
			}];
			if (body.error) {
				recordFailure(body.error);
			} else {
				recordSuccess();
			}
		} catch (err: any) {
			const reason = err?.message ?? String(err);
			messages = [...messages, { role: 'assistant', content: '', error: reason }];
			recordFailure(reason);
		} finally {
			submitting = false;
			setTimeout(() => listEl?.scrollTo({ top: listEl.scrollHeight, behavior: 'smooth' }), 50);
		}
	}

	function toggleOpen() {
		isOpen = !isOpen;
		if (isOpen && !healthChecked) {
			healthChecked = true;
			checkHealth();
			try { helpDismissed = localStorage.getItem('askBimsHelpDismissed') === '1'; } catch {}
		}
	}

	// L.1 — page-aware quick-action chips. Each chip is a one-shot question
	// that fills the input and fires. The chip set adapts to entityType from
	// the current page, falling back to a generic "what's going on" set when
	// we're not on a recognized entity route.
	const chipSet = $derived.by<string[]>(() => {
		const ctx = $page.url ? parsePathnameToEntity($page.url.pathname) : {};
		switch (ctx.entityType) {
			case 'cartridge':
				return [
					"Why is this cartridge stuck?",
					"Show this cartridge's genealogy",
					"What's the QC status?",
					"Where is this part physically?"
				];
			case 'run':
			case 'wax_filling_run':
			case 'reagent_run':
				return [
					"What's blocking this run?",
					"Who finalized it?",
					"Show parts consumed in this run",
					"Were there spec deviations?"
				];
			case 'receiving_lot':
			case 'lot':
				return [
					"Where is this lot stored?",
					"What cartridges used this lot?",
					"Is it expiring soon?",
					"Forward genealogy from this lot"
				];
			case 'part':
				return [
					"How much of this part do we have?",
					"What's the reorder threshold?",
					"Recent receiving lots for this part",
					"Where is it physically?"
				];
			case 'equipment':
				return [
					"Is this equipment calibrated?",
					"Recent service tickets",
					"Current temperature",
					"What runs used this equipment today?"
				];
			default:
				return [
					"What's blocked today?",
					"Today's anomalies",
					"Shift summary",
					"What can you do?"
				];
		}
	});

	function fireChip(text: string) {
		if (submitting) return;
		input = text;
		submit();
	}

	function clearChat() {
		messages = [];
	}

	// --- Feedback (thumbs up/down) ---

	function previousUserQuestion(idx: number): string {
		// Look backward from this assistant message to find the user turn that
		// produced it. Most direct: the immediately-preceding user message.
		for (let i = idx - 1; i >= 0; i--) {
			if (messages[i].role === 'user') return messages[i].content;
		}
		return '';
	}

	// L.4 — auto-rephrase. When thumbs-down lands, give the operator a one-click
	// path to re-ask the same question with a hint nudging the agent toward a
	// different tool path. The original thumbs-down POST still goes through
	// (so the review queue captures the verdict); rephrase is purely a
	// recovery option.
	async function rephraseLastQuestion(idx: number) {
		if (submitting) return;
		const question = previousUserQuestion(idx);
		if (!question) return;
		// Append a hint that the prior answer was rated wrong. Agent rule 7
		// already covers safety-critical leading; this hint targets the wrong-
		// answer recovery path specifically.
		input = `${question}\n\n(prior answer marked incorrect — try a different angle or tool path)`;
		await submit();
	}

	async function sendFeedback(idx: number, rating: 'up' | 'down', comment?: string) {
		const msg = messages[idx];
		if (!msg || !msg.responseId) return;
		const question = previousUserQuestion(idx);
		if (!question) return;

		messages[idx] = { ...msg, feedbackState: 'sending', feedbackRating: rating };

		try {
			const res = await fetch('/api/agent/ask/feedback', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					responseId: msg.responseId,
					rating,
					comment: comment?.trim() || undefined,
					question,
					answer: msg.content,
					toolsUsed: msg.toolCalls?.map(tc => tc.name) ?? [],
					model: msg.model,
					confidence: msg.confidence
				})
			});
			if (!res.ok) {
				// Quietly revert — feedback is non-critical, no need to interrupt the user.
				messages[idx] = { ...msg, feedbackState: 'idle' };
				return;
			}
			messages[idx] = { ...msg, feedbackState: 'sent', feedbackRating: rating, feedbackComment: comment };
		} catch {
			messages[idx] = { ...msg, feedbackState: 'idle' };
		}
	}

	function openCommentBox(idx: number) {
		const msg = messages[idx];
		if (!msg) return;
		messages[idx] = { ...msg, feedbackState: 'comment-open', feedbackRating: 'down', feedbackComment: '' };
	}

	// --- Flag for review (separate from thumbs) ---
	// Server-side ready since 2026-05-13. Each flagged row lives in the
	// /admin/ask-bims/review queue until a Claude session sweeps it.
	function openFlagBox(idx: number) {
		const msg = messages[idx];
		if (!msg) return;
		messages[idx] = { ...msg, flagState: 'open', flagReason: '' };
	}

	async function sendFlag(idx: number, reason?: string) {
		const msg = messages[idx];
		if (!msg || !msg.responseId) return;
		const question = previousUserQuestion(idx);
		if (!question) return;

		messages[idx] = { ...msg, flagState: 'sending', flagReason: reason };

		try {
			const res = await fetch('/api/agent/ask/feedback', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					responseId: msg.responseId,
					flagged: true,
					flagReason: reason?.trim() || undefined,
					question,
					answer: msg.content,
					toolsUsed: msg.toolCalls?.map(tc => tc.name) ?? [],
					model: msg.model,
					confidence: msg.confidence
				})
			});
			if (!res.ok) {
				messages[idx] = { ...msg, flagState: 'idle' };
				return;
			}
			messages[idx] = { ...msg, flagState: 'sent', flagReason: reason };
		} catch {
			messages[idx] = { ...msg, flagState: 'idle' };
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && isOpen) {
			isOpen = false;
		}
	}
</script>

<svelte:window onkeydown={handleKeydown} />

{#if visible}
	{#if !isOpen}
		<!-- Collapsed pill -->
		<button
			type="button"
			onclick={toggleOpen}
			class="ask-bims-pill"
			title="Ask BIMS — natural-language question about manufacturing data"
			aria-label="Open Ask BIMS"
		>
			<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-5 w-5">
				<path stroke-linecap="round" stroke-linejoin="round" d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
			</svg>
			<span>Ask BIMS</span>
		</button>
	{:else}
		<!-- Expanded panel -->
		<div class="ask-bims-panel {circuitOpenUntil != null && Date.now() < circuitOpenUntil ? 'is-circuit-open' : ''}" role="dialog" aria-label="Ask BIMS chat">
			<!-- Status banner (degraded service or circuit open) -->
			{#if degradedReason || (circuitOpenUntil != null && Date.now() < circuitOpenUntil)}
				<div class="ask-bims-banner">
					{#if circuitOpenUntil != null && Date.now() < circuitOpenUntil}
						⚠ Cooldown active — too many recent failures. Retry in {Math.ceil((circuitOpenUntil - Date.now()) / 60_000)} min.
					{:else}
						⚠ {degradedReason}
					{/if}
				</div>
			{/if}
			<!-- Header -->
			<div class="ask-bims-header">
				<div class="flex items-center gap-2">
					<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4 text-[var(--color-tron-cyan)]">
						<path stroke-linecap="round" stroke-linejoin="round" d="M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
					</svg>
					<span class="text-sm font-semibold text-[var(--color-tron-text)]">Ask BIMS</span>
					{#if sessionTotals.tokens > 0}
						<span class="ml-2 font-mono text-[10px] {sessionTotals.costUsd >= BUDGET_WARN_USD ? 'text-[var(--color-tron-yellow)]' : 'text-[var(--color-tron-text-secondary)]'}">
							{sessionTotals.tokens.toLocaleString()} tok · ${sessionTotals.costUsd.toFixed(4)}
						</span>
					{/if}
				</div>
				<div class="flex items-center gap-1">
					{#if messages.length > 0}
						<button
							type="button"
							onclick={clearChat}
							class="rounded p-1 text-xs text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
							title="Clear chat"
							aria-label="Clear chat"
						>
							<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4">
								<path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
							</svg>
						</button>
					{/if}
					<button
						type="button"
						onclick={toggleOpen}
						class="rounded p-1 text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
						title="Minimize"
						aria-label="Minimize Ask BIMS"
					>
						<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-4 w-4">
							<path stroke-linecap="round" stroke-linejoin="round" d="M19 13H5" />
						</svg>
					</button>
				</div>
			</div>

			<!-- Model selector -->
			<div class="ask-bims-toolbar">
				<select
					bind:value={model}
					class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-2 py-1 text-[10px] text-[var(--color-tron-text)]"
					aria-label="Select Claude model"
				>
					<option value="claude-haiku-4-5">{MODEL_LABELS['claude-haiku-4-5']}</option>
					<option value="claude-sonnet-4-6">{MODEL_LABELS['claude-sonnet-4-6']}</option>
					{#if canUseOpus}
						<option value="claude-opus-4-7">{MODEL_LABELS['claude-opus-4-7']}</option>
					{/if}
				</select>
			</div>

			<!-- Messages -->
			<div bind:this={listEl} class="ask-bims-messages">
				{#if !helpDismissed && messages.length === 0}
					<!-- L.2 — first-open help banner. One-time per browser session. -->
					<div class="mb-3 rounded border border-[var(--color-tron-cyan)]/40 bg-[var(--color-tron-cyan)]/10 px-2.5 py-2 text-[10px] text-[var(--color-tron-text)]">
						<div class="flex items-start justify-between gap-2">
							<div>
								I can help with cartridges, runs, equipment, chemicals, anomalies, and shift summaries. Try a suggestion below — or just ask.
							</div>
							<button
								type="button"
								onclick={dismissHelp}
								class="-mr-1 -mt-0.5 rounded p-0.5 text-[var(--color-tron-text-secondary)] hover:text-[var(--color-tron-cyan)]"
								title="Dismiss"
								aria-label="Dismiss help banner"
							>
								<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="h-3 w-3">
									<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
								</svg>
							</button>
						</div>
					</div>
				{/if}
				{#if messages.length === 0}
					<div class="py-3 text-center text-xs text-[var(--color-tron-text-secondary)]">
						<p>Ask about wax, runs, temps, inventory, cartridges.</p>
					</div>
				{:else}
					{#each messages as msg, i (i)}
						<div class="mb-3 flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
							<div
								class="max-w-[90%] rounded-lg border px-3 py-2 text-xs {msg.role === 'user'
									? 'border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/10 text-[var(--color-tron-text)]'
									: 'border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] text-[var(--color-tron-text)]'}"
							>
								{#if msg.error}
									<div class="text-red-400">Error: {msg.error}</div>
								{:else}
									{#if msg.toolCalls && msg.toolCalls.length > 0}
										{@const hazardReasons = msg.toolCalls.flatMap((tc: any) => (
											tc.result?.safetyCritical === true && Array.isArray(tc.result?.safetyCriticalReasons)
												? tc.result.safetyCriticalReasons as string[]
												: []
										))}
										{#if hazardReasons.length > 0}
											<!-- L.3 — Hazard banner. Rendered ABOVE the answer so operators see
												 it before the rest of the response. Server-set safetyCritical
												 from K.6 (HTX chemicals, overdue calibrations, etc). -->
											<div class="mb-2 rounded-md border-2 border-amber-500 bg-amber-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-amber-200">
												<div class="flex items-center gap-1 text-amber-300">
													<span class="text-base leading-none">⚠</span>
													<span class="uppercase tracking-wide">Safety-critical</span>
												</div>
												<ul class="mt-1 list-disc pl-4 font-normal">
													{#each hazardReasons as reason (reason)}
														<li>{reason}</li>
													{/each}
												</ul>
											</div>
										{/if}
									{/if}
									<div style="white-space: pre-wrap;">{msg.content}</div>
									{#if msg.toolCalls && msg.toolCalls.length > 0}
										{@const integrityNotes = msg.toolCalls.flatMap((tc: any) => tc.result?.dataIntegrityNotes ?? [])}
										{#if integrityNotes.length > 0}
											<div class="mt-1 rounded border border-[var(--color-tron-yellow)]/40 bg-[var(--color-tron-yellow)]/10 px-2 py-1 text-[10px] text-[var(--color-tron-yellow)]">
												<div class="font-semibold">⚠ Integrity</div>
												<ul class="mt-1 list-disc pl-3 text-[var(--color-tron-text-secondary)]">
													{#each integrityNotes as note (note)}
														<li>{note}</li>
													{/each}
												</ul>
											</div>
										{/if}
										<details class="mt-1 text-[10px] text-[var(--color-tron-text-secondary)]">
											<summary class="cursor-pointer">Queried {msg.toolCalls.length} source{msg.toolCalls.length > 1 ? 's' : ''}</summary>
											<ul class="mt-1 list-disc pl-4">
												{#each msg.toolCalls as tc (tc.name + JSON.stringify(tc.input))}
													<li class="break-all">
														<span class="font-mono">{tc.name}</span>
														{#if tc.result?.sourceUrl}
															<a href={tc.result.sourceUrl} class="ml-1 text-[var(--color-tron-cyan)] hover:underline">→ verify</a>
														{/if}
													</li>
												{/each}
											</ul>
										</details>
									{/if}
									{#if msg.usage}
										<div class="mt-1 flex justify-between gap-2 border-t border-[var(--color-tron-border)] pt-1 font-mono text-[9px] text-[var(--color-tron-text-secondary)]">
											<span>{msgTokens(msg.usage).toLocaleString()} tok</span>
											{#if msg.confidence}
												<span
													class="rounded px-1.5 py-0.5 font-mono text-[9px] font-semibold"
													class:bg-emerald-500={msg.confidence === 'high'}
													class:text-emerald-50={msg.confidence === 'high'}
													class:bg-yellow-500={msg.confidence === 'partial'}
													class:text-yellow-50={msg.confidence === 'partial'}
													class:bg-red-500={msg.confidence === 'degraded'}
													class:text-red-50={msg.confidence === 'degraded'}
													title="Confidence based on what the underlying data returned. High = clean, partial = some gap or truncation, degraded = a known data caveat was surfaced."
												>
													{msg.confidence}
												</span>
											{/if}
											<span class="text-[var(--color-tron-cyan)]">${msg.usage.estCostUsd.toFixed(4)}</span>
										</div>
									{/if}
									<!-- Thumbs feedback -->
									{#if msg.role === 'assistant' && !msg.error && msg.responseId}
										<div class="mt-1.5 flex items-center gap-2 border-t border-[var(--color-tron-border)] pt-1.5 text-[10px]">
											{#if msg.feedbackState === 'sent'}
												<span class="text-[var(--color-tron-text-secondary)]">
													{msg.feedbackRating === 'up' ? '👍 Thanks — noted.' : '👎 Thanks — we\'ll look at this.'}
												</span>
												{#if msg.feedbackRating === 'down'}
													<!-- L.4 — auto-rephrase recovery -->
													<button
														type="button"
														onclick={() => rephraseLastQuestion(i)}
														disabled={submitting}
														class="ml-auto rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/15 px-2 py-0.5 text-[10px] font-semibold text-[var(--color-tron-cyan)] hover:bg-[var(--color-tron-cyan)]/25 disabled:opacity-40"
														title="Try the same question again with a hint to use a different tool path"
													>
														Try again
													</button>
												{/if}
											{:else if msg.feedbackState === 'comment-open'}
												<input
													type="text"
													bind:value={messages[i].feedbackComment}
													placeholder="What was wrong? (optional)"
													class="flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-[10px] text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)]/60 focus:outline-none"
													onkeydown={(e) => { if (e.key === 'Enter') sendFeedback(i, 'down', messages[i].feedbackComment); }}
												/>
												<button
													type="button"
													onclick={() => sendFeedback(i, 'down', messages[i].feedbackComment)}
													disabled={msg.feedbackState === 'sending'}
													class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-2 py-0.5 text-[10px] font-semibold text-[var(--color-tron-cyan)]"
													title="Send feedback"
												>
													Send
												</button>
											{:else if msg.feedbackState === 'sending'}
												<span class="text-[var(--color-tron-text-secondary)]">Sending…</span>
											{:else}
												<span class="text-[var(--color-tron-text-secondary)]">Was this useful?</span>
												<button
													type="button"
													onclick={() => sendFeedback(i, 'up')}
													class="rounded px-1.5 py-0.5 hover:bg-emerald-500/20"
													title="Yes, this was useful"
													aria-label="Thumbs up"
												>
													👍
												</button>
												<button
													type="button"
													onclick={() => openCommentBox(i)}
													class="rounded px-1.5 py-0.5 hover:bg-red-500/20"
													title="Not useful — tell us why"
													aria-label="Thumbs down"
												>
													👎
												</button>
												<button
													type="button"
													onclick={() => openFlagBox(i)}
													class="ml-auto rounded px-1.5 py-0.5 hover:bg-amber-500/20"
													title="Flag for review — Claude will look at this later"
													aria-label="Flag for review"
												>
													🚩
												</button>
											{/if}
										</div>
										<!-- Flag for review (independent of thumbs) -->
										{#if msg.flagState === 'open'}
											<div class="mt-1.5 flex items-center gap-2 text-[10px]">
												<input
													type="text"
													bind:value={messages[i].flagReason}
													placeholder="Why flag this? (optional)"
													class="flex-1 rounded border border-amber-500/40 bg-[var(--color-tron-bg-tertiary)] px-2 py-0.5 text-[10px] text-[var(--color-tron-text)] focus:border-amber-500/80 focus:outline-none"
													onkeydown={(e) => { if (e.key === 'Enter') sendFlag(i, messages[i].flagReason); }}
												/>
												<button
													type="button"
													onclick={() => sendFlag(i, messages[i].flagReason)}
													class="rounded border border-amber-500/50 bg-amber-500/20 px-2 py-0.5 text-[10px] font-semibold text-amber-300"
													title="Flag for review"
												>
													Flag
												</button>
											</div>
										{:else if msg.flagState === 'sending'}
											<div class="mt-1.5 text-[10px] text-[var(--color-tron-text-secondary)]">Flagging…</div>
										{:else if msg.flagState === 'sent'}
											<div class="mt-1.5 text-[10px] text-amber-300">🚩 Flagged — Claude will look at this in the next session.</div>
										{/if}
									{/if}
								{/if}
							</div>
						</div>
					{/each}
					{#if submitting}
						<div class="flex justify-start">
							<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)]">
								<span class="inline-block animate-pulse">Thinking…</span>
							</div>
						</div>
					{/if}
				{/if}
			</div>

			<!-- L.1 — page-aware quick-action chips. One click fills + fires. -->
			<div class="ask-bims-chips">
				{#each chipSet as chip (chip)}
					<button
						type="button"
						onclick={() => fireChip(chip)}
						disabled={submitting}
						class="ask-bims-chip"
						title={chip}
					>
						{chip}
					</button>
				{/each}
			</div>

			<!-- Input -->
			<form onsubmit={submit} class="ask-bims-input-row">
				<input
					type="text"
					bind:value={input}
					placeholder="Ask BIMS…"
					disabled={submitting}
					class="flex-1 rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-2 py-1.5 text-xs text-[var(--color-tron-text)] focus:border-[var(--color-tron-cyan)]/60 focus:outline-none"
				/>
				<button
					type="submit"
					disabled={submitting || !input.trim()}
					class="rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-3 py-1.5 text-xs font-semibold text-[var(--color-tron-cyan)] disabled:opacity-40"
				>
					{submitting ? '…' : 'Ask'}
				</button>
			</form>
		</div>
	{/if}
{/if}

<style>
	/* Never show the floating widget on print pages — was leaking into
	   /manufacturing/print-barcodes' bottom-left corner. */
	@media print {
		.ask-bims-pill,
		.ask-bims-panel {
			display: none !important;
		}
	}
	.ask-bims-pill {
		position: fixed;
		bottom: 1.25rem;
		left: 1.25rem;
		z-index: 40;
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.625rem 1rem;
		border-radius: 999px;
		border: 1px solid rgba(186, 230, 253, 0.6);
		background: linear-gradient(135deg, #ffffff 0%, #cffafe 100%);
		color: #0c4a6e;
		font-size: 0.8125rem;
		font-weight: 600;
		box-shadow:
			0 10px 25px -5px rgba(0, 0, 0, 0.4),
			0 4px 10px -3px rgba(0, 0, 0, 0.3),
			0 0 0 1px rgba(34, 211, 238, 0.15);
		cursor: pointer;
		transition: transform 0.15s ease, box-shadow 0.15s ease, background 0.15s ease;
	}
	.ask-bims-pill:hover {
		transform: translateY(-2px);
		background: linear-gradient(135deg, #ffffff 0%, #a5f3fc 100%);
		box-shadow:
			0 14px 30px -5px rgba(0, 0, 0, 0.5),
			0 6px 12px -3px rgba(0, 0, 0, 0.4),
			0 0 0 1px rgba(34, 211, 238, 0.4);
	}
	.ask-bims-pill:active {
		transform: translateY(0);
	}

	.ask-bims-panel {
		position: fixed;
		bottom: 1.25rem;
		left: 1.25rem;
		z-index: 40;
		width: 22rem;
		max-width: calc(100vw - 2.5rem);
		height: 32rem;
		max-height: calc(100vh - 2.5rem);
		display: flex;
		flex-direction: column;
		border-radius: 0.75rem;
		border: 1px solid var(--color-tron-border);
		background: var(--color-tron-bg-secondary);
		box-shadow:
			0 25px 50px -12px rgba(0, 0, 0, 0.7),
			0 0 0 1px rgba(34, 211, 238, 0.2);
		overflow: hidden;
	}

	.ask-bims-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 0.625rem 0.75rem;
		border-bottom: 1px solid var(--color-tron-border);
		background: linear-gradient(180deg, var(--color-tron-bg-tertiary) 0%, var(--color-tron-bg-secondary) 100%);
	}

	.ask-bims-toolbar {
		padding: 0.375rem 0.75rem;
		border-bottom: 1px solid var(--color-tron-border);
		display: flex;
		justify-content: flex-end;
	}

	.ask-bims-messages {
		flex: 1;
		overflow-y: auto;
		padding: 0.75rem;
	}

	.ask-bims-input-row {
		display: flex;
		gap: 0.375rem;
		padding: 0.625rem 0.75rem;
		border-top: 1px solid var(--color-tron-border);
		background: var(--color-tron-bg-tertiary);
	}

	.ask-bims-chips {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
		padding: 0.375rem 0.625rem 0.25rem;
		border-top: 1px solid var(--color-tron-border);
		background: var(--color-tron-bg-secondary);
	}
	.ask-bims-chip {
		font-size: 0.6875rem;
		line-height: 1;
		padding: 0.3125rem 0.5rem;
		border-radius: 999px;
		border: 1px solid var(--color-tron-border);
		background: var(--color-tron-bg-tertiary);
		color: var(--color-tron-text);
		cursor: pointer;
		transition: border-color 0.15s ease, background 0.15s ease;
		white-space: nowrap;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.ask-bims-chip:hover {
		border-color: rgba(34, 211, 238, 0.6);
		background: rgba(34, 211, 238, 0.08);
	}
	.ask-bims-chip:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.ask-bims-banner {
		padding: 0.5rem 0.75rem;
		font-size: 0.6875rem;
		color: var(--color-tron-yellow);
		background: rgba(250, 204, 21, 0.08);
		border-bottom: 1px solid rgba(250, 204, 21, 0.3);
	}

	.ask-bims-panel.is-circuit-open {
		opacity: 0.85;
	}

	/* Mobile: full bottom-sheet on small screens */
	@media (max-width: 600px) {
		.ask-bims-panel {
			bottom: 0;
			left: 0;
			right: 0;
			width: 100vw;
			max-width: 100vw;
			height: 80vh;
			max-height: 80vh;
			border-radius: 1rem 1rem 0 0;
			border-bottom: none;
		}
		.ask-bims-pill {
			bottom: 1rem;
			left: 1rem;
			padding: 0.5rem 0.875rem;
			font-size: 0.75rem;
		}
	}
</style>
