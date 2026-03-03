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

// Web Serial API type augmentation
declare global {
	interface Serial {
		requestPort(options?: { filters?: Array<{ usbVendorId?: number; usbProductId?: number }> }): Promise<SerialPort>;
		getPorts(): Promise<SerialPort[]>;
	}

	interface SerialPort {
		open(options: { baudRate: number; dataBits?: number; stopBits?: number; parity?: string; bufferSize?: number; flowControl?: string }): Promise<void>;
		close(): Promise<void>;
		readable: ReadableStream<Uint8Array> | null;
		writable: WritableStream<Uint8Array> | null;
	}

	interface Navigator {
		readonly serial: Serial;
	}
}
