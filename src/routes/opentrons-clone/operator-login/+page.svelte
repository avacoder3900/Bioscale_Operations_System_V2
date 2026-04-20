<script lang="ts">
	import { enhance } from '$app/forms';
	let { data, form } = $props<{ data: { next: string }; form?: { error?: string } }>();
</script>

<div class="max-w-sm mx-auto mt-16 p-6 rounded border">
	<h2 class="text-lg font-semibold mb-2">Operator Admin</h2>
	<p class="text-sm text-gray-600 mb-4">
		Extra password required to access the Opentrons clone.
	</p>
	<form method="POST" use:enhance>
		<input type="hidden" name="next" value={data.next} />
		<label class="block text-sm mb-1" for="password">Password</label>
		<input
			id="password"
			name="password"
			type="password"
			autocomplete="current-password"
			autofocus
			required
			class="w-full px-3 py-2 border rounded mb-3"
		/>
		{#if form?.error}
			<p class="text-sm text-red-700 mb-3">{form.error}</p>
		{/if}
		<button type="submit" class="w-full py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
			Unlock
		</button>
	</form>
</div>
