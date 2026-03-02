// See https://svelte.dev/docs/kit/types#app.d.ts

declare global {
	namespace App {
		interface Locals {
			user: {
				_id: string;
				username: string;
				email?: string | null;
				firstName?: string | null;
				lastName?: string | null;
				phone?: string | null;
				isActive: boolean;
				lastLoginAt?: Date | null;
				roles: { roleId: string; roleName: string; permissions: string[] }[];
			} | null;
			session: {
				_id: string;
				userId: string;
				expiresAt: Date;
			} | null;
		}
	}
}

export {};
