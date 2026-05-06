<script lang="ts">
	import { page } from '$app/stores';

	type ModelId = 'claude-haiku-4-5' | 'claude-sonnet-4-6' | 'claude-opus-4-7';

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
	}

	const HIDDEN_PREFIXES = ['/login', '/logout', '/invite', '/cv'];
	const BUDGET_WARN_USD = 1.0;

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
	let model = $state<ModelId>('claude-sonnet-4-6');
	let listEl: HTMLDivElement | undefined = $state();

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
		'claude-haiku-4-5': 'Haiku · fast',
		'claude-sonnet-4-6': 'Sonnet · default',
		'claude-opus-4-7': 'Opus · admin'
	};

	function msgTokens(u: Usage): number {
		return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
	}

	async function submit(e?: Event) {
		e?.preventDefault();
		const text = input.trim();
		if (!text || submitting) return;

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
					model
				})
			});
			const body = await res.json();
			messages = [...messages, {
				role: 'assistant',
				content: body.answer ?? '',
				toolCalls: body.toolCalls,
				usage: body.usage,
				model: body.model,
				error: body.error
			}];
		} catch (err: any) {
			messages = [...messages, { role: 'assistant', content: '', error: err?.message ?? String(err) }];
		} finally {
			submitting = false;
			setTimeout(() => listEl?.scrollTo({ top: listEl.scrollHeight, behavior: 'smooth' }), 50);
		}
	}

	function toggleOpen() {
		isOpen = !isOpen;
	}

	function clearChat() {
		messages = [];
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
		<div class="ask-bims-panel" role="dialog" aria-label="Ask BIMS chat">
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
											<span class="text-[var(--color-tron-cyan)]">${msg.usage.estCostUsd.toFixed(4)}</span>
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
</style>
