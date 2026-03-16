const BASE_URL = process.env.TEST_BASE_URL || 'http://127.0.0.1:5176';

let sessionCookie = '';

export function setSessionCookie(cookie: string) {
  sessionCookie = cookie;
}

export function getSessionCookie() {
  return sessionCookie;
}

export async function appFetch(path: string, opts: {
  method?: string;
  body?: any;
  headers?: Record<string, string>;
  redirect?: RequestRedirect;
} = {}): Promise<Response> {
  const url = `${BASE_URL}${path}`;
  const headers: Record<string, string> = { ...(opts.headers || {}) };

  if (sessionCookie) {
    headers['cookie'] = `auth-session=${sessionCookie}`;
  }

  const fetchOpts: RequestInit = {
    method: opts.method || 'GET',
    headers,
    redirect: opts.redirect || 'follow',
  };

  if (opts.body instanceof URLSearchParams) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    fetchOpts.body = opts.body.toString();
  } else if (opts.body && typeof opts.body === 'object') {
    headers['content-type'] = 'application/json';
    fetchOpts.body = JSON.stringify(opts.body);
  } else if (opts.body) {
    fetchOpts.body = opts.body;
  }

  return fetch(url, fetchOpts);
}

/**
 * Fetch SvelteKit __data.json and extract page data keys.
 * Returns { status, layoutKeys, pageKeys, raw }
 */
export async function getPageData(path: string): Promise<{
  status: number;
  layoutKeys: string[];
  pageKeys: string[];
  raw: any;
}> {
  const dataPath = path.endsWith('/') ? `${path}__data.json` : `${path}/__data.json`;
  const res = await appFetch(dataPath);
  if (!res.ok) {
    return { status: res.status, layoutKeys: [], pageKeys: [], raw: null };
  }
  const raw = await res.json();

  const layoutKeys: string[] = [];
  const pageKeys: string[] = [];

  if (raw?.type === 'data' && Array.isArray(raw.nodes)) {
    for (let i = 0; i < raw.nodes.length; i++) {
      const node = raw.nodes[i];
      if (node?.type === 'data' && Array.isArray(node.data) && node.data.length > 0) {
        const keys = Object.keys(node.data[0]);
        // All keys go to both for easy assertions
        layoutKeys.push(...keys);
        pageKeys.push(...keys);
      }
    }
  }

  return { status: res.status, layoutKeys, pageKeys, raw };
}

/** Submit a SvelteKit form action */
export async function submitAction(path: string, action: string | null, data: Record<string, string>): Promise<Response> {
  const actionPath = action ? `${path}?/${action}` : path;
  return appFetch(actionPath, {
    method: 'POST',
    body: new URLSearchParams(data),
    redirect: 'manual',
  });
}
