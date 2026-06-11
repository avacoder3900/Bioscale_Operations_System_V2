import { env } from '$env/dynamic/private';

/**
 * Fire a GitHub `repository_dispatch` event to kick off an ephemeral Actions
 * runner. This is how BIMS (Vercel, serverless — cannot run torch) hands heavy
 * training off to GitHub-hosted compute that scales to zero.
 *
 * Required env:
 *   GITHUB_DISPATCH_TOKEN  PAT with `repo`/contents:write on the BIMS repo
 *   GITHUB_REPO            owner/repo (defaults to the BIMS repo)
 */
const GITHUB_REPO = env.GITHUB_REPO || 'avacoder3900/Bioscale_Operations_System_V2';

export async function dispatchWorkflow(
	eventType: string,
	clientPayload: Record<string, unknown>
): Promise<void> {
	const token = env.GITHUB_DISPATCH_TOKEN;
	if (!token) throw new Error('GITHUB_DISPATCH_TOKEN is not configured');

	const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/dispatches`, {
		method: 'POST',
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: 'application/vnd.github+json',
			'X-GitHub-Api-Version': '2022-11-28',
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({ event_type: eventType, client_payload: clientPayload })
	});

	// GitHub returns 204 No Content on success.
	if (res.status !== 204) {
		const text = await res.text();
		throw new Error(`GitHub dispatch failed (${res.status}): ${text}`);
	}
}
