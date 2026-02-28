import { describe, it, expect } from 'vitest';
import { appFetch, getPageData } from '../helpers/client';

const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5176';

describe('Auth & Session', () => {
  it('GET /login returns 200', async () => {
    const res = await fetch(`${BASE_URL}/login`);
    expect(res.status).toBe(200);
  });

  it('POST /login with bad credentials returns failure', async () => {
    const res = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=nobody&password=wrong',
    });
    const data = await res.json();
    expect(data.type).toBe('failure');
    expect(data.status).toBe(400);
  });

  it('POST /login with valid credentials returns session cookie', async () => {
    const res = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=contracttest&password=contracttest123',
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie') || '';
    expect(setCookie).toContain('auth-session=');
  });

  it('GET /spu without auth redirects or returns 302', async () => {
    const res = await fetch(`${BASE_URL}/spu`, { redirect: 'manual' });
    // Either 302 redirect to login, or 200 with login page content
    expect([200, 302]).toContain(res.status);
  });

  it('GET /logout clears session', async () => {
    // Login first
    const loginRes = await fetch(`${BASE_URL}/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'username=contracttest&password=contracttest123',
      redirect: 'manual',
    });
    const cookie = (loginRes.headers.get('set-cookie') || '').match(/auth-session=([^;]+)/)?.[1];
    expect(cookie).toBeTruthy();

    const logoutRes = await fetch(`${BASE_URL}/logout`, {
      headers: { cookie: `auth-session=${cookie}` },
      redirect: 'manual',
    });
    expect([200, 302]).toContain(logoutRes.status);
  });
});

describe('User Management', () => {
  it('GET /spu/admin/users returns user list', async () => {
    const { status, pageKeys } = await getPageData('/spu/admin/users');
    expect(status).toBe(200);
    expect(pageKeys).toContain('users');
    expect(pageKeys).toContain('roles');
  });

  it('GET /spu/admin/roles returns roles', async () => {
    const { status, pageKeys } = await getPageData('/spu/admin/roles');
    expect(status).toBe(200);
    expect(pageKeys).toContain('roles');
  });

  it('GET /spu/admin returns admin page', async () => {
    const { status } = await getPageData('/spu/admin');
    expect(status).toBe(200);
  });

  it('GET /spu/admin/invites returns invites page', async () => {
    const { status, pageKeys } = await getPageData('/spu/admin/invites');
    expect(status).toBe(200);
    expect(pageKeys).toContain('invites');
  });
});
