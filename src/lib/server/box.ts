/**
 * Box.com API client for file storage.
 * Uses OAuth 2.0 with tokens stored in the Integration collection (type: 'box').
 */
import { env } from '$env/dynamic/private';
import { connectDB, Integration } from '$lib/server/db';

const BOX_API_BASE = 'https://api.box.com/2.0';
const BOX_UPLOAD_BASE = 'https://upload.box.com/api/2.0';
const BOX_AUTH_BASE = 'https://account.box.com/api/oauth2';

export interface BoxItem {
	id: string;
	type: 'file' | 'folder';
	name: string;
	size: number | null;
	modified_at: string | null;
}

/** Build the OAuth authorization URL */
export function getAuthUrl(): string {
	const params = new URLSearchParams({
		response_type: 'code',
		client_id: env.BOX_CLIENT_ID!,
		redirect_uri: env.BOX_REDIRECT_URI!
	});
	return `${BOX_AUTH_BASE}/authorize?${params.toString()}`;
}

/** Exchange an authorization code for access + refresh tokens */
export async function exchangeCode(code: string): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
	const res = await fetch(`${BOX_AUTH_BASE}/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'authorization_code',
			code,
			client_id: env.BOX_CLIENT_ID!,
			client_secret: env.BOX_CLIENT_SECRET!,
			redirect_uri: env.BOX_REDIRECT_URI!
		})
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error_description || body.error || `Box OAuth error: ${res.status}`);
	}
	const data = await res.json();
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresIn: data.expires_in
	};
}

/** Refresh the access token using the stored refresh token */
async function refreshAccessToken(integ: any): Promise<string> {
	const res = await fetch(`${BOX_AUTH_BASE}/token`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: integ.refreshToken,
			client_id: env.BOX_CLIENT_ID!,
			client_secret: env.BOX_CLIENT_SECRET!
		})
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({}));
		throw new Error(body.error_description || body.error || `Box token refresh failed: ${res.status}`);
	}
	const data = await res.json();

	await Integration.updateOne(
		{ _id: integ._id },
		{
			$set: {
				accessToken: data.access_token,
				refreshToken: data.refresh_token,
				expiresAt: new Date(Date.now() + data.expires_in * 1000)
			}
		}
	);

	return data.access_token;
}

/** Get a valid access token, refreshing if needed */
async function getAccessToken(): Promise<string> {
	await connectDB();
	const integ = await Integration.findOne({ type: 'box' }).lean() as any;
	if (!integ?.accessToken) {
		throw new Error('Box integration not configured');
	}

	// Refresh if expired or expiring within 5 minutes
	if (integ.expiresAt && new Date(integ.expiresAt).getTime() < Date.now() + 5 * 60 * 1000) {
		if (integ.refreshToken) {
			return refreshAccessToken(integ);
		}
		throw new Error('Box token expired and no refresh token available');
	}

	return integ.accessToken;
}

async function boxFetch(path: string, options: RequestInit = {}, base = BOX_API_BASE): Promise<Response> {
	const token = await getAccessToken();
	const res = await fetch(`${base}${path}`, {
		...options,
		headers: {
			Authorization: `Bearer ${token}`,
			...options.headers
		}
	});
	if (!res.ok) {
		const body = await res.json().catch(() => ({ message: res.statusText }));
		throw new Error(body.message || `Box API error: ${res.status}`);
	}
	return res;
}

/** List items in a Box folder */
export async function listFolder(folderId: string): Promise<{ items: BoxItem[]; name: string }> {
	const params = new URLSearchParams({
		fields: 'id,type,name,size,modified_at',
		limit: '1000'
	});
	const res = await boxFetch(`/folders/${folderId}/items?${params.toString()}`);
	const data = await res.json();

	// Also get folder name
	const folderRes = await boxFetch(`/folders/${folderId}?fields=name`);
	const folder = await folderRes.json();

	return {
		name: folder.name,
		items: (data.entries ?? []).map((item: any) => ({
			id: item.id,
			type: item.type,
			name: item.name,
			size: item.size ?? null,
			modified_at: item.modified_at ?? null
		}))
	};
}

/** Download a file — returns a Response with the file stream */
export async function downloadFile(fileId: string): Promise<Response> {
	const token = await getAccessToken();
	const res = await fetch(`${BOX_API_BASE}/files/${fileId}/content`, {
		headers: { Authorization: `Bearer ${token}` },
		redirect: 'follow'
	});
	if (!res.ok) {
		throw new Error(`Box download failed: ${res.status}`);
	}
	return res;
}

/** Get file info (name, size, etc.) */
export async function getFileInfo(fileId: string): Promise<{ name: string; size: number }> {
	const res = await boxFetch(`/files/${fileId}?fields=name,size`);
	return res.json();
}

/** Search for files in Box by name/query */
export async function searchFiles(query: string): Promise<BoxItem[]> {
	const params = new URLSearchParams({
		query,
		type: 'file',
		fields: 'id,type,name,size,modified_at',
		limit: '20'
	});
	const res = await boxFetch(`/search?${params.toString()}`);
	const data = await res.json();
	return (data.entries ?? []).map((item: any) => ({
		id: item.id,
		type: item.type as 'file' | 'folder',
		name: item.name,
		size: item.size ?? null,
		modified_at: item.modified_at ?? null
	}));
}

/** Upload a file to a Box folder */
export async function uploadFile(
	folderId: string,
	fileName: string,
	fileBuffer: ArrayBuffer
): Promise<{ id: string; name: string; size: number }> {
	const token = await getAccessToken();

	const formData = new FormData();
	formData.append('attributes', JSON.stringify({
		name: fileName,
		parent: { id: folderId }
	}));
	formData.append('file', new Blob([fileBuffer]), fileName);

	const res = await fetch(`${BOX_UPLOAD_BASE}/files/content`, {
		method: 'POST',
		headers: { Authorization: `Bearer ${token}` },
		body: formData
	});

	if (!res.ok) {
		const body = await res.json().catch(() => ({ message: res.statusText }));
		throw new Error(body.message || `Box upload failed: ${res.status}`);
	}

	const data = await res.json();
	const file = data.entries?.[0];
	return { id: file.id, name: file.name, size: file.size };
}
