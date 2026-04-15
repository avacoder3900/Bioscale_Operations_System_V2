<script lang="ts">
	interface Message {
		role: 'user' | 'assistant';
		content: string;
		toolCalls?: Array<{ name: string; input: any; result: any }>;
		error?: string;
	}

	let messages = $state<Message[]>([]);
	let input = $state('');
	let submitting = $state(false);
	let listEl: HTMLDivElement | undefined = $state();

	const SAMPLE_PROMPTS = [
		'What wax batches are running low?',
		'What is the temperature of the CLIA Freezer right now?',
		'Show me all runs from the last 24 hours',
		'Which parts do I need to reorder?',
		'Are there any unacknowledged temperature alerts?'
	];

	async function submit(e?: Event) {
		e?.preventDefault();
		const text = input.trim();
		if (!text || submitting) return;

		const userMsg: Message = { role: 'user', content: text };
		messages = [...messages, userMsg];
		input = '';
		submitting = true;

		try {
			const res = await fetch('/api/agent/ask', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					history: messages.map(m => ({ role: m.role, content: m.content }))
				})
			});
			const body = await res.json();
			const assistantMsg: Message = {
				role: 'assistant',
				content: body.answer ?? '',
				toolCalls: body.toolCalls,
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
									<details class="mt-2 text-xs text-[var(--color-tron-text-secondary)]">
										<summary class="cursor-pointer hover:text-[var(--color-tron-cyan)]">
											Queried {msg.toolCalls.length} data source{msg.toolCalls.length > 1 ? 's' : ''}
										</summary>
										<ul class="mt-1 list-disc pl-5 font-mono">
											{#each msg.toolCalls as tc (tc.name + JSON.stringify(tc.input))}
												<li>{tc.name}({JSON.stringify(tc.input)})</li>
											{/each}
										</ul>
									</details>
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
