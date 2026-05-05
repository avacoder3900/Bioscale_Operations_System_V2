<script lang="ts">
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

	interface Props {
		data: { canUseOpus: boolean };
	}
	let { data }: Props = $props();

	let messages = $state<Message[]>([]);
	let input = $state('');
	let submitting = $state(false);
	let listEl: HTMLDivElement | undefined = $state();
	let model = $state<ModelId>('claude-haiku-4-5');

	const BUDGET_WARN_USD = 1.0;

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
		'claude-haiku-4-5': 'Haiku 4.5 — default, fastest, cheapest',
		'claude-sonnet-4-6': 'Sonnet 4.6 — sharper for complex reasoning',
		'claude-opus-4-7': 'Opus 4.7 — deepest analysis (admin only)'
	};

	function msgTokens(u: Usage): number {
		return u.inputTokens + u.outputTokens + u.cacheReadTokens + u.cacheWriteTokens;
	}

	const SAMPLE_PROMPTS = [
		'What wax batches are running low?',
		'What is the temperature of the CLIA Freezer right now?',
		'Show me all runs from the last 24 hours',
		'Which parts do I need to reorder?',
		'Are there any unacknowledged temperature alerts?',
		'How many cartridges did we make today?'
	];

	async function submit(e?: Event) {
		e?.preventDefault();
		const text = input.trim();
		if (!text || submitting) return;

		if (sessionTotals.costUsd >= BUDGET_WARN_USD) {
			const ok = confirm(`This session has spent $${sessionTotals.costUsd.toFixed(2)}. Continue?`);
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
			const assistantMsg: Message = {
				role: 'assistant',
				content: body.answer ?? '',
				toolCalls: body.toolCalls,
				usage: body.usage,
				model: body.model,
				error: body.error
			};
			messages = [...messages, assistantMsg];
		} catch (err: any) {
			messages = [...messages, { role: 'assistant', content: '', error: err?.message ?? String(err) }];
		} finally {
			submitting = false;
			setTimeout(() => listEl?.scrollTo({ top: listEl.scrollHeight, behavior: 'smooth' }), 50);
		}
	}

	function usePrompt(p: string) {
		input = p;
	}

	function clearChat() {
		messages = [];
	}
</script>

<div class="flex h-[calc(100vh-200px)] flex-col gap-4">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-semibold text-[var(--color-tron-text)]">Ask BIMS</h1>
			<p class="text-sm text-[var(--color-tron-text-secondary)]">
				Ask natural-language questions about manufacturing, inventory, temperature, and runs.
			</p>
		</div>
		<div class="flex items-center gap-3">
			{#if sessionTotals.tokens > 0}
				<div class="text-right text-xs text-[var(--color-tron-text-secondary)]">
					<div>Session: {sessionTotals.tokens.toLocaleString()} tokens</div>
					<div class="font-mono {sessionTotals.costUsd >= BUDGET_WARN_USD ? 'text-[var(--color-tron-yellow)]' : 'text-[var(--color-tron-cyan)]'}">${sessionTotals.costUsd.toFixed(4)}</div>
				</div>
			{/if}
			{#if messages.length > 0}
				<button
					type="button"
					onclick={clearChat}
					class="min-h-[44px] rounded border border-[var(--color-tron-border)] px-3 py-2 text-xs text-[var(--color-tron-text-secondary)] hover:border-[var(--color-tron-cyan)]/30"
				>
					Clear chat
				</button>
			{/if}
		</div>
	</div>

	<!-- Model selector -->
	<div class="flex items-center gap-2 text-xs">
		<label for="model-select" class="text-[var(--color-tron-text-secondary)]">Model:</label>
		<select
			id="model-select"
			bind:value={model}
			class="tron-input rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-2 py-1 text-xs text-[var(--color-tron-text)]"
		>
			<option value="claude-haiku-4-5">{MODEL_LABELS['claude-haiku-4-5']}</option>
			<option value="claude-sonnet-4-6">{MODEL_LABELS['claude-sonnet-4-6']}</option>
			{#if data.canUseOpus}
				<option value="claude-opus-4-7">{MODEL_LABELS['claude-opus-4-7']}</option>
			{/if}
		</select>
	</div>

	<!-- Messages -->
	<div
		bind:this={listEl}
		class="flex-1 overflow-y-auto rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-surface)] p-4"
	>
		{#if messages.length === 0}
			<div class="py-8 text-center">
				<p class="text-sm text-[var(--color-tron-text-secondary)]">Start by asking a question, or try one of these:</p>
				<div class="mt-4 flex flex-wrap justify-center gap-2">
					{#each SAMPLE_PROMPTS as prompt (prompt)}
						<button
							type="button"
							onclick={() => usePrompt(prompt)}
							class="rounded border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-3 py-2 text-xs text-[var(--color-tron-text)] hover:border-[var(--color-tron-cyan)]/40 hover:text-[var(--color-tron-cyan)]"
						>
							{prompt}
						</button>
					{/each}
				</div>
			</div>
		{:else}
			<div class="space-y-4">
				{#each messages as msg, i (i)}
					<div class="flex {msg.role === 'user' ? 'justify-end' : 'justify-start'}">
						<div
							class="max-w-[85%] rounded-lg border px-4 py-3 text-sm {msg.role === 'user'
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
										<div class="mt-2 rounded border border-[var(--color-tron-yellow)]/40 bg-[var(--color-tron-yellow)]/10 px-2 py-1.5 text-xs text-[var(--color-tron-yellow)]">
											<div class="font-semibold">⚠ Data integrity notes</div>
											<ul class="mt-1 list-disc pl-4 text-[var(--color-tron-text-secondary)]">
												{#each integrityNotes as note (note)}
													<li>{note}</li>
												{/each}
											</ul>
										</div>
									{/if}
									<details class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">
										<summary class="cursor-pointer hover:text-[var(--color-tron-cyan)]">
											Queried {msg.toolCalls.length} data source{msg.toolCalls.length > 1 ? 's' : ''}
										</summary>
										<ul class="mt-1 list-disc pl-5">
											{#each msg.toolCalls as tc (tc.name + JSON.stringify(tc.input))}
												<li>
													<span class="font-mono">{tc.name}</span>
													{#if tc.result?.sourceUrl}
														<a href={tc.result.sourceUrl} class="ml-2 text-[var(--color-tron-cyan)] hover:underline">Verify in BIMS →</a>
													{/if}
													{#if tc.result?.source}
														<div class="pl-4 text-[10px] text-[var(--color-tron-text-secondary)]">{tc.result.source}</div>
													{/if}
												</li>
											{/each}
										</ul>
									</details>
								{/if}
								{#if msg.usage}
									<div class="mt-2 flex justify-between gap-3 border-t border-[var(--color-tron-border)] pt-2 font-mono text-[10px] text-[var(--color-tron-text-secondary)]">
										<span>
											{msg.model ?? ''} · {msgTokens(msg.usage).toLocaleString()} tok (in {msg.usage.inputTokens.toLocaleString()} · out {msg.usage.outputTokens.toLocaleString()}{msg.usage.cacheReadTokens > 0 ? ` · cache-rd ${msg.usage.cacheReadTokens.toLocaleString()}` : ''}{msg.usage.cacheWriteTokens > 0 ? ` · cache-wr ${msg.usage.cacheWriteTokens.toLocaleString()}` : ''})
										</span>
										<span class="text-[var(--color-tron-cyan)]">${msg.usage.estCostUsd.toFixed(4)}</span>
									</div>
								{/if}
							{/if}
						</div>
					</div>
				{/each}
				{#if submitting}
					<div class="flex justify-start">
						<div class="rounded-lg border border-[var(--color-tron-border)] bg-[var(--color-tron-bg-tertiary)] px-4 py-3 text-sm text-[var(--color-tron-text-secondary)]">
							<span class="inline-block animate-pulse">Thinking…</span>
						</div>
					</div>
				{/if}
			</div>
		{/if}
	</div>

	<!-- Input -->
	<form onsubmit={submit} class="flex gap-2">
		<input
			type="text"
			bind:value={input}
			placeholder="Ask about wax batches, temps, runs, inventory…"
			disabled={submitting}
			class="tron-input flex-1"
		/>
		<button
			type="submit"
			disabled={submitting || !input.trim()}
			class="min-h-[44px] rounded border border-[var(--color-tron-cyan)]/50 bg-[var(--color-tron-cyan)]/20 px-6 py-2 text-sm font-semibold text-[var(--color-tron-cyan)] disabled:opacity-40"
		>
			{submitting ? 'Asking…' : 'Ask'}
		</button>
	</form>
</div>
