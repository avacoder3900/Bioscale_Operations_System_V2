/**
 * Resolves the Cloudflare R2 account ID that becomes part of the S3 endpoint hostname
 * (<accountId>.r2.cloudflarestorage.com).
 *
 * Why this exists: on 2026-09-25 the deployed R2_ACCOUNT_ID was not the bare 32-hex account ID,
 * and Cloudflare answered every upload with a TLS handshake_failure (alert 40) — an opaque
 * "EPROTO … ssl3_read_bytes" error — because the SNI hostname matched no certificate. Nobody with
 * Vercel dashboard access was available to correct the variable, so the ID is recovered here:
 *
 *   1. R2_ACCOUNT_ID is exactly 32 hex chars → use it.
 *   2. R2_ACCOUNT_ID contains a 32-hex run (a pasted URL, "account: <id>", …) → extract it.
 *   3. R2_PUBLIC_URL contains a 32-hex run that is NOT a `pub-<hash>` r2.dev subdomain → use it.
 *      (`pub-<hash>.r2.dev` hashes are per-bucket, not the account ID, so they are skipped.)
 *   4. Otherwise throw with a message that names the actual values.
 *
 * The account ID is not a secret (it is in every public R2 URL), so recovering it from other
 * variables leaks nothing. Falling back is logged once so Vercel function logs show which source
 * was used — the dashboard variable should still be corrected.
 */

const HEX32_EXACT = /^[0-9a-f]{32}$/i;
const HEX32_ANY = /[0-9a-f]{32}/i;

export type R2AccountSource = 'R2_ACCOUNT_ID' | 'R2_ACCOUNT_ID (extracted)' | 'R2_PUBLIC_URL';

export function resolveR2AccountId(
	rawAccountId: string | undefined,
	rawPublicUrl: string | undefined
): { accountId: string; source: R2AccountSource } {
	const v = (rawAccountId ?? '').trim();
	if (HEX32_EXACT.test(v)) return { accountId: v.toLowerCase(), source: 'R2_ACCOUNT_ID' };

	const inValue = v.match(HEX32_ANY);
	if (inValue) return { accountId: inValue[0].toLowerCase(), source: 'R2_ACCOUNT_ID (extracted)' };

	const p = (rawPublicUrl ?? '').trim();
	const inUrl = p.match(HEX32_ANY);
	if (inUrl && !/pub-[0-9a-f]{32}/i.test(p)) {
		return { accountId: inUrl[0].toLowerCase(), source: 'R2_PUBLIC_URL' };
	}

	throw new Error(
		`R2 account ID not found: R2_ACCOUNT_ID is "${v.slice(0, 12)}…" (${v.length} chars, expected 32 hex) ` +
			`and R2_PUBLIC_URL ("${p.slice(0, 40)}") has no usable 32-hex segment. ` +
			'Set R2_ACCOUNT_ID to the Cloudflare account ID.'
	);
}

let warned = false;

/** Resolve from the process env once, warning (once) when a fallback source was needed. */
export function resolveR2AccountIdFromEnv(env: Record<string, string | undefined>): string {
	const { accountId, source } = resolveR2AccountId(env.R2_ACCOUNT_ID, env.R2_PUBLIC_URL);
	if (source !== 'R2_ACCOUNT_ID' && !warned) {
		warned = true;
		console.warn(
			`[r2] R2_ACCOUNT_ID is not a bare 32-hex account ID (got "${(env.R2_ACCOUNT_ID ?? '').trim().slice(0, 12)}…"); ` +
				`using ${accountId} from ${source}. Fix the variable in Vercel.`
		);
	}
	return accountId;
}
