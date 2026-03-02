/**
 * Spectrophotometer Serial Service
 *
 * Client-side service for communicating with SPU units via USB serial connection.
 * Uses Web Serial API to send laser commands and read AS7341 spectrophotometer data.
 *
 * Firmware protocol (brevitest-device):
 *   99  → Device info (firmware version, DeviceOS, Device ID)
 *   10  → Status (mode, temp, stage position, cartridge)
 *   30:X:1/0 → Laser X on/off (A, B, C)
 *   70  → Read spectrophotometer (F1-F8, CLR, NIR from AS7341)
 *   1   → Reset to IDLE
 */

/** AS7341 channel-to-wavelength mapping (nm) */
export const AS7341_WAVELENGTHS = {
	f1: 415,
	f2: 445,
	f3: 480,
	f4: 515,
	f5: 555,
	f6: 590,
	f7: 630,
	f8: 680
} as const;

/** Single spectrophotometer reading for one laser channel */
export interface AS7341Reading {
	laser: 'A' | 'B' | 'C';
	f1: number;
	f2: number;
	f3: number;
	f4: number;
	f5: number;
	f6: number;
	f7: number;
	f8: number;
	clear: number;
	nir: number;
}

/** Device identification info from command 99 */
export interface DeviceInfo {
	firmwareVersion: string;
	deviceOS: string;
	deviceId: string;
}

/** Device status from command 10 */
export interface DeviceStatus {
	mode: string;
	temperature: string;
	stagePosition: string;
	cartridge: string;
}

/** Complete validation data from a full test sequence */
export interface SpectroValidationData {
	deviceInfo: DeviceInfo;
	readings: AS7341Reading[];
}

/** Connection state */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

/** Progress steps during validation sequence */
export type ValidationStep =
	| { step: 'device_info'; message: string }
	| { step: 'status_check'; message: string }
	| { step: 'laser_on'; laser: string; message: string }
	| { step: 'reading'; laser: string; message: string }
	| { step: 'laser_off'; laser: string; message: string }
	| { step: 'reset'; message: string }
	| { step: 'complete'; message: string };

/** Event types emitted by SpectrophotometerSerial */
export type SpectrophotometerSerialEvent =
	| { type: 'connected' }
	| { type: 'disconnected' }
	| { type: 'error'; error: Error }
	| { type: 'state'; state: ConnectionState }
	| { type: 'progress'; step: ValidationStep }
	| { type: 'response'; command: string; response: string };

export type SpectrophotometerSerialListener = (event: SpectrophotometerSerialEvent) => void;

/** Serial configuration */
export interface SpectrophotometerSerialConfig {
	baudRate: number;
	dataBits?: 7 | 8;
	stopBits?: 1 | 2;
	parity?: 'none' | 'even' | 'odd';
	commandTimeoutMs?: number;
	laserWarmupMs?: number;
}

const DEFAULT_CONFIG: SpectrophotometerSerialConfig = {
	baudRate: 9600,
	dataBits: 8,
	stopBits: 1,
	parity: 'none',
	commandTimeoutMs: 5000,
	laserWarmupMs: 50
};

export class SpectrophotometerSerial {
	private port: SerialPort | null = null;
	private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
	private readLoop: Promise<void> | null = null;
	private listeners: Set<SpectrophotometerSerialListener> = new Set();
	private _state: ConnectionState = 'disconnected';
	private config: SpectrophotometerSerialConfig;
	private buffer: string = '';
	private pendingLines: string[] = [];
	private lineResolvers: Array<(line: string) => void> = [];

	constructor(config: Partial<SpectrophotometerSerialConfig> = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	get state(): ConnectionState {
		return this._state;
	}

	static isSupported(): boolean {
		return typeof navigator !== 'undefined' && 'serial' in navigator;
	}

	addEventListener(listener: SpectrophotometerSerialListener): void {
		this.listeners.add(listener);
	}

	removeEventListener(listener: SpectrophotometerSerialListener): void {
		this.listeners.delete(listener);
	}

	private emit(event: SpectrophotometerSerialEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch (err) {
				console.error('Error in spectrophotometer serial listener:', err);
			}
		}
	}

	private setState(state: ConnectionState): void {
		this._state = state;
		this.emit({ type: 'state', state });
	}

	async connect(): Promise<void> {
		if (!SpectrophotometerSerial.isSupported()) {
			throw new Error('Web Serial API is not supported in this browser');
		}

		if (this._state === 'connected' || this._state === 'connecting') {
			return;
		}

		this.setState('connecting');

		try {
			this.port = await navigator.serial!.requestPort();

			await this.port.open({
				baudRate: this.config.baudRate
			});

			if (this.port.writable) {
				this.writer = this.port.writable.getWriter();
			}

			this.setState('connected');
			this.emit({ type: 'connected' });
			this.startReading();
		} catch (err) {
			this.setState('error');
			const error = err instanceof Error ? err : new Error(String(err));
			this.emit({ type: 'error', error });
			throw error;
		}
	}

	private startReading(): void {
		if (!this.port?.readable) return;
		this.readLoop = this.readLoopAsync();
	}

	private async readLoopAsync(): Promise<void> {
		if (!this.port?.readable) return;

		this.reader = this.port.readable.getReader();
		const decoder = new TextDecoder();

		try {
			while (true) {
				const { value, done } = await this.reader.read();
				if (done) break;

				if (value) {
					this.buffer += decoder.decode(value, { stream: true });
					this.processBuffer();
				}
			}
		} catch (err) {
			if (this._state === 'connected') {
				const error = err instanceof Error ? err : new Error(String(err));
				this.emit({ type: 'error', error });
			}
		} finally {
			this.reader?.releaseLock();
			this.reader = null;
		}
	}

	private processBuffer(): void {
		const lines = this.buffer.split('\n');
		this.buffer = lines.pop() || '';

		for (const line of lines) {
			const trimmed = line.trim();
			if (!trimmed) continue;

			// If someone is waiting for a line, resolve their promise
			if (this.lineResolvers.length > 0) {
				const resolve = this.lineResolvers.shift()!;
				resolve(trimmed);
			} else {
				this.pendingLines.push(trimmed);
			}
		}
	}

	/**
	 * Wait for a line of serial output. Returns immediately if a line is already buffered.
	 */
	private waitForLine(timeoutMs?: number): Promise<string> {
		const timeout = timeoutMs ?? this.config.commandTimeoutMs ?? 5000;

		// Check if we already have a buffered line
		if (this.pendingLines.length > 0) {
			return Promise.resolve(this.pendingLines.shift()!);
		}

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				const idx = this.lineResolvers.indexOf(wrappedResolve);
				if (idx >= 0) this.lineResolvers.splice(idx, 1);
				reject(new Error(`Timeout waiting for serial response (${timeout}ms)`));
			}, timeout);

			const wrappedResolve = (line: string) => {
				clearTimeout(timer);
				resolve(line);
			};

			this.lineResolvers.push(wrappedResolve);
		});
	}

	/**
	 * Send a command and collect response lines until no more data arrives.
	 */
	async sendCommand(command: string, expectedLines: number = 1): Promise<string[]> {
		if (!this.writer || this._state !== 'connected') {
			throw new Error('Not connected');
		}

		// Clear any stale buffered lines
		this.pendingLines = [];

		const encoder = new TextEncoder();
		await this.writer.write(encoder.encode(command + '\n'));

		this.emit({ type: 'response', command, response: '(sent)' });

		const lines: string[] = [];
		for (let i = 0; i < expectedLines; i++) {
			try {
				const line = await this.waitForLine();
				lines.push(line);
				this.emit({ type: 'response', command, response: line });
			} catch {
				// Timeout — return what we have
				break;
			}
		}

		return lines;
	}

	/**
	 * Send command 99 and parse device info.
	 */
	async getDeviceInfo(): Promise<DeviceInfo> {
		const lines = await this.sendCommand('99', 3);

		const info: DeviceInfo = {
			firmwareVersion: 'unknown',
			deviceOS: 'unknown',
			deviceId: 'unknown'
		};

		for (const line of lines) {
			const fwMatch = line.match(/^Firmware:\s*(.+)$/i);
			if (fwMatch) info.firmwareVersion = fwMatch[1].trim();

			const osMatch = line.match(/^DeviceOS:\s*(.+)$/i);
			if (osMatch) info.deviceOS = osMatch[1].trim();

			const idMatch = line.match(/^Device ID:\s*(.+)$/i);
			if (idMatch) info.deviceId = idMatch[1].trim();
		}

		return info;
	}

	/**
	 * Send command 10 and parse device status.
	 */
	async getStatus(): Promise<DeviceStatus> {
		const lines = await this.sendCommand('10', 4);

		const status: DeviceStatus = {
			mode: 'unknown',
			temperature: 'unknown',
			stagePosition: 'unknown',
			cartridge: 'unknown'
		};

		for (const line of lines) {
			const modeMatch = line.match(/^Mode:\s*(.+)$/i);
			if (modeMatch) status.mode = modeMatch[1].trim();

			const tempMatch = line.match(/^Temp:\s*(.+)$/i);
			if (tempMatch) status.temperature = tempMatch[1].trim();

			const stageMatch = line.match(/^Stage:\s*(.+)$/i);
			if (stageMatch) status.stagePosition = stageMatch[1].trim();

			const cartMatch = line.match(/^Cartridge:\s*(.+)$/i);
			if (cartMatch) status.cartridge = cartMatch[1].trim();
		}

		return status;
	}

	/**
	 * Parse a spectrophotometer response line.
	 * Format: "Spectro: F1=123 F2=456 F3=789 F4=012 F5=345 F6=678 F7=901 F8=234 CLR=567 NIR=890"
	 */
	parseSpectroResponse(line: string): Omit<AS7341Reading, 'laser'> | null {
		if (!line.startsWith('Spectro:')) return null;

		const data = line.substring('Spectro:'.length).trim();
		const pairs = data.split(/\s+/);
		const values: Record<string, number> = {};

		for (const pair of pairs) {
			const [key, val] = pair.split('=');
			if (key && val) {
				values[key.toLowerCase()] = parseInt(val, 10);
			}
		}

		if (
			values.f1 === undefined ||
			values.f2 === undefined ||
			values.f3 === undefined ||
			values.f4 === undefined ||
			values.f5 === undefined ||
			values.f6 === undefined ||
			values.f7 === undefined ||
			values.f8 === undefined ||
			values.clr === undefined ||
			values.nir === undefined
		) {
			return null;
		}

		return {
			f1: values.f1,
			f2: values.f2,
			f3: values.f3,
			f4: values.f4,
			f5: values.f5,
			f6: values.f6,
			f7: values.f7,
			f8: values.f8,
			clear: values.clr,
			nir: values.nir
		};
	}

	/**
	 * Run the full validation sequence:
	 * 1. Get device info (cmd 99)
	 * 2. Check status (cmd 10)
	 * 3. For each laser A,B,C: on → read spectro → off
	 * 4. Reset (cmd 1)
	 */
	async runValidationSequence(): Promise<SpectroValidationData> {
		if (this._state !== 'connected') {
			throw new Error('Not connected to device');
		}

		// Step 1: Get device info
		this.emit({
			type: 'progress',
			step: { step: 'device_info', message: 'Reading device info...' }
		});
		const deviceInfo = await this.getDeviceInfo();

		// Step 2: Check status
		this.emit({
			type: 'progress',
			step: { step: 'status_check', message: 'Checking device status...' }
		});
		await this.getStatus();

		// Step 3: Read each laser channel
		const lasers: Array<'A' | 'B' | 'C'> = ['A', 'B', 'C'];
		const readings: AS7341Reading[] = [];

		for (const laser of lasers) {
			// Turn on laser
			this.emit({
				type: 'progress',
				step: { step: 'laser_on', laser, message: `Turning on Laser ${laser}...` }
			});
			const onResponse = await this.sendCommand(`30:${laser}:1`, 1);
			const onLine = onResponse[0] ?? '';
			if (!onLine.includes('ON')) {
				throw new Error(`Failed to turn on Laser ${laser}: ${onLine}`);
			}

			// Wait for laser warmup
			await this.delay(this.config.laserWarmupMs ?? 50);

			// Read spectrophotometer
			this.emit({
				type: 'progress',
				step: { step: 'reading', laser, message: `Reading spectrophotometer (Laser ${laser})...` }
			});
			const spectroResponse = await this.sendCommand('70', 1);
			const spectroLine = spectroResponse[0] ?? '';

			if (spectroLine.includes('failed')) {
				// Turn off laser before throwing
				await this.sendCommand(`30:${laser}:0`, 1);
				throw new Error(`Spectrophotometer read failed on Laser ${laser}`);
			}

			const reading = this.parseSpectroResponse(spectroLine);
			if (!reading) {
				await this.sendCommand(`30:${laser}:0`, 1);
				throw new Error(`Failed to parse spectro response for Laser ${laser}: ${spectroLine}`);
			}

			// Turn off laser
			this.emit({
				type: 'progress',
				step: { step: 'laser_off', laser, message: `Turning off Laser ${laser}...` }
			});
			await this.sendCommand(`30:${laser}:0`, 1);

			readings.push({ laser, ...reading });
		}

		// Step 4: Reset device
		this.emit({
			type: 'progress',
			step: { step: 'reset', message: 'Resetting device...' }
		});
		await this.sendCommand('1', 1);

		this.emit({
			type: 'progress',
			step: { step: 'complete', message: 'Validation sequence complete' }
		});

		return { deviceInfo, readings };
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	async disconnect(): Promise<void> {
		if (this._state === 'disconnected') return;

		try {
			if (this.reader) {
				await this.reader.cancel();
				this.reader.releaseLock();
				this.reader = null;
			}

			if (this.readLoop) {
				await this.readLoop;
				this.readLoop = null;
			}

			if (this.writer) {
				this.writer.releaseLock();
				this.writer = null;
			}

			if (this.port) {
				await this.port.close();
				this.port = null;
			}

			this.setState('disconnected');
			this.emit({ type: 'disconnected' });
		} catch (err) {
			console.warn('Error during spectrophotometer disconnect:', err);
			this.setState('disconnected');
			this.emit({ type: 'disconnected' });
		}
	}
}

export function createSpectrophotometerSerial(
	config?: Partial<SpectrophotometerSerialConfig>
): SpectrophotometerSerial {
	return new SpectrophotometerSerial(config);
}
