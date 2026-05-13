<script lang="ts">
	import { page } from '$app/stores';

	type ModelId = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7';
	type Confidence = 'high' | 'partial' | 'degraded';
	type FeedbackState = 'idle' | 'comment-open' | 'sending' | 'sent';

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
		}
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
				{#if messages.length === 0}
					<div class="py-4 text-center text-xs text-[var(--color-tron-text-secondary)]">
						<p>Ask about wax, runs, temps, inventory, cartridges.</p>
						<p class="mt-2 text-[10px]">Examples:<br>"What's running low?"<br>"Trace cartridge ABC123"<br>"How many carts did we make today?"</p>
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
											{/if}
										</div>
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
