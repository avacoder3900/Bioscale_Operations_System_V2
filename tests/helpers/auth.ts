import { setSessionCookie } from './client';

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5176';
const TEST_USER = process.env.TEST_USER || 'contracttest';
const TEST_PASS = process.env.TEST_PASS || 'contracttest123';

export async function login(): Promise<string> {
  const res = await fetch(`${BASE_URL}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: TEST_USER, password: TEST_PASS }).toString(),
    redirect: 'manual',
  });

  const setCookie = res.headers.get('set-cookie') || '';
  const match = setCookie.match(/auth-session=([^;]+)/);
  if (!match) {
    // SvelteKit form actions return 200 with JSON body for redirects
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      if (json.type === 'redirect') {
        // The cookie should still be in set-cookie header
        throw new Error(`Login redirect but no cookie. Headers: ${JSON.stringify(Object.fromEntries(res.headers.entries()))}`);
      }
    } catch {}
    throw new Error(`Login failed - no session cookie. Status: ${res.status}, Body: ${text.slice(0, 200)}`);
  }

  const cookie = match[1];
  setSessionCookie(cookie);
  return cookie;
}
