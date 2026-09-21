/**
 * SPU Serial Service — direct USB (micro-USB → USB) control of the SPU stage.
 *
 * WHY THIS EXISTS
 * ---------------
 * BIMS runs on Vercel. A serverless function in a datacenter has no USB bus, so
 * the server can never open the SPU's COM port — the existing calibration
 * endpoint therefore proxies through Particle Cloud. The browser, however, is
 * running on the very machine the SPU is plugged into, so Web Serial is the only
 * part of BIMS that can hold a direct wire to the device.
 *
 * NO FIRMWARE CHANGES ARE REQUIRED. `process_serial_port()` reads
 * newline-terminated ASCII off USB and hands it to the same `particle_command()`
 * dispatcher the cloud path uses, so the numeric commands below are behavioural
 * twins of the `stage_control` cloud function:
 *
 *   cloud "home"          == serial `20`                  -> reset_stage(true)
 *   cloud "jog,<um>"      == serial `22,<um>,<delay>`     -> move_stage(um, delay)
 *   cloud "goto,<um>"     == serial `23,<um>,<delay>`     -> reset_stage(false)
 *                                                           move_stage_to_position()
 *                                                           sleep_motor()
 *
 * Every command reply is the firmware's own completion line, emitted by
 * `Log.info` through the registered `SerialLogHandler`:
 *
 *   Completed command: 23, result: 5000, p1: 5000, p2: 1200, ...
 *
 * `result` is `stage_position`, i.e. exactly what the cloud path returns.
 *
 * KNOWN LIMIT — no mid-move telemetry over USB. `move_stage()` blocks in its
 * eighth-step loop and emits nothing while stepping (the progress `Log.info` is
 * commented out in firmware). Live position during a move still has to come from
 * the Particle variable poll, which keeps answering because the device runs
 * SYSTEM_THREAD(ENABLED). USB gives us instant, deterministic command dispatch
 * and the authoritative final position.
 */

/** Particle's USB vendor ID. The M-SoM enumerates as VID_2B04. */
export const PARTICLE_USB_VENDOR_ID = 0x2b04;

/** Matches `Serial.begin(115200)` in firmware setup. */
const BAUD_RATE = 115200;

/**
 * Homing from the far end of travel at MOTOR_SLOW_STEP_DELAY is the slowest
 * thing we issue. Generous, because a timeout here aborts a real move.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 180_000;

/** `Log.info` output is prefixed by the Particle log handler, so search, don't anchor. */
const COMPLETION_RE = /Completed command:\s*(\d+),\s*result:\s*(-?\d+)/;

export type SpuConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export type SpuSerialEvent =
	| { type: 'state'; state: SpuConnectionState }
	| { type: 'line'; line: string }
	| { type: 'error'; error: Error };

export type SpuSerialListener = (event: SpuSerialEvent) => void;

export interface SpuCommandResult {
	/** Echoed command number from the completion line. */
	command: number;
	/** `stage_position` after the command — same value the cloud path returns. */
	result: number;
	/** Every line the device emitted while the command was in flight. */
	raw: string[];
}

interface PendingCommand {
	command: number;
	raw: string[];
	resolve: (value: SpuCommandResult) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Holds one Web Serial port open against an SPU and serialises commands onto it.
 *
 * Usage:
 *   const spu = new SpuSerial();
 *   if (SpuSerial.isSupported()) {
 *     await spu.connect();                  // requires a user gesture
 *     const { result } = await spu.home();  // result === stage_position
 *   }
 */
export class SpuSerial {
	private port: SerialPort | null = null;
	private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
	private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
	private readLoop: Promise<void> | null = null;
	private buffer = '';
	private pending: PendingCommand | null = null;
	/** Commands are strictly serialised — the firmware dispatcher is single-threaded. */
	private queue: Promise<unknown> = Promise.resolve();
	private listeners = new Set<SpuSerialListener>();
	private state: SpuConnectionState = 'disconnected';

	/** Chrome/Edge only. Firefox and Safari do not implement Web Serial. */
	static isSupported(): boolean {
		return typeof navigator !== 'undefined' && 'serial' in navigator;
	}

	getState(): SpuConnectionState {
		return this.state;
	}

	isConnected(): boolean {
		return this.state === 'connected';
	}

	addEventListener(listener: SpuSerialListener): void {
		this.listeners.add(listener);
	}

	removeEventListener(listener: SpuSerialListener): void {
		this.listeners.delete(listener);
	}

	private emit(event: SpuSerialEvent): void {
		for (const listener of this.listeners) {
			try {
				listener(event);
			} catch {
				// A broken listener must never take down the serial link.
			}
		}
	}

	private setState(state: SpuConnectionState): void {
		if (this.state === state) return;
		this.state = state;
		this.emit({ type: 'state', state });
	}

	/**
	 * Prompt for a port and open it. MUST be called from a user gesture — Web
	 * Serial has no way to open a port silently, by design.
	 *
	 * Filtered to Particle's vendor ID so the picker shows SPUs rather than every
	 * CH340/CH343 adapter on the bench; Chrome still offers "show all devices".
	 */
	async connect(): Promise<void> {
		if (!SpuSerial.isSupported()) {
			throw new Error('Web Serial is not available. Use Chrome or Edge to drive the SPU over USB.');
		}
		if (this.state === 'connected' || this.state === 'connecting') return;

		this.setState('connecting');
		try {
			this.port = await navigator.serial.requestPort({
				filters: [{ usbVendorId: PARTICLE_USB_VENDOR_ID }]
			});
			await this.port.open({ baudRate: BAUD_RATE, bufferSize: 4096 });

			if (!this.port.readable || !this.port.writable) {
				throw new Error('Serial port opened without readable/writable streams.');
			}

			this.reader = this.port.readable.getReader();
			this.writer = this.port.writable.getWriter();
			this.buffer = '';
			this.setState('connected');
			this.readLoop = this.runReadLoop();
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			// The user dismissing the port picker is a cancellation, not a fault.
			const cancelled = err.name === 'NotFoundError';
			await this.teardown();
			this.setState(cancelled ? 'disconnected' : 'error');
			if (!cancelled) this.emit({ type: 'error', error: err });
			throw err;
		}
	}

	async disconnect(): Promise<void> {
		await this.teardown();
		this.setState('disconnected');
	}

	private async teardown(): Promise<void> {
		this.failPending(new Error('Serial connection closed.'));

		try {
			await this.reader?.cancel();
		} catch {
			// already gone
		}
		try {
			this.reader?.releaseLock();
		} catch {
			// already released
		}
		this.reader = null;

		try {
			await this.readLoop;
		} catch {
			// read loop errors are surfaced via events
		}
		this.readLoop = null;

		try {
			await this.writer?.close();
		} catch {
			// already gone
		}
		try {
			this.writer?.releaseLock();
		} catch {
			// already released
		}
		this.writer = null;

		try {
			await this.port?.close();
		} catch {
			// already closed
		}
		this.port = null;
		this.buffer = '';
	}

	/** Continuously drain the port, splitting on newlines and dispatching lines. */
	private async runReadLoop(): Promise<void> {
		const decoder = new TextDecoder();
		try {
			while (this.reader) {
				const { value, done } = await this.reader.read();
				if (done) break;
				if (!value) continue;

				this.buffer += decoder.decode(value, { stream: true });

				let newline: number;
				while ((newline = this.buffer.indexOf('\n')) >= 0) {
					const line = this.buffer.slice(0, newline).replace(/\r$/, '');
					this.buffer = this.buffer.slice(newline + 1);
					if (line.length > 0) this.handleLine(line);
				}
			}
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			this.failPending(err);
			this.emit({ type: 'error', error: err });
			this.setState('error');
		}
	}

	private handleLine(line: string): void {
		this.emit({ type: 'line', line });

		const pending = this.pending;
		if (!pending) return;

		pending.raw.push(line);

		const match = COMPLETION_RE.exec(line);
		if (!match) return;

		const command = Number(match[1]);
		// Ignore completions for anything we did not just send — the device also
		// logs commands triggered by the cloud or by its own state machine.
		if (command !== pending.command) return;

		clearTimeout(pending.timer);
		this.pending = null;
		pending.resolve({ command, result: Number(match[2]), raw: pending.raw });
	}

	private failPending(error: Error): void {
		const pending = this.pending;
		if (!pending) return;
		clearTimeout(pending.timer);
		this.pending = null;
		pending.reject(error);
	}

	/**
	 * Send one command and resolve with its completion line.
	 *
	 * Commands are queued: the firmware processes serial input from its main loop
	 * and blocks for the whole duration of a move, so overlapping sends would
	 * interleave unpredictably.
	 */
	send(command: number, params: number[] = [], timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS): Promise<SpuCommandResult> {
		const run = () => this.sendNow(command, params, timeoutMs);
		// Chain onto the queue, but never let one failure poison the next command.
		const result = this.queue.then(run, run);
		this.queue = result.catch(() => undefined);
		return result;
	}

	private async sendNow(command: number, params: number[], timeoutMs: number): Promise<SpuCommandResult> {
		if (!this.writer || this.state !== 'connected') {
			throw new Error('SPU is not connected over USB.');
		}

		const payload = [command, ...params].join(',');
		const promise = new Promise<SpuCommandResult>((resolve, reject) => {
			this.pending = {
				command,
				raw: [],
				resolve,
				reject,
				timer: setTimeout(() => {
					this.pending = null;
					reject(new Error(`SPU did not acknowledge command ${payload} within ${Math.round(timeoutMs / 1000)}s.`));
				}, timeoutMs)
			};
		});

		await this.writer.write(new TextEncoder().encode(`${payload}\n`));
		return promise;
	}

	// ---- Stage control ----------------------------------------------------
	// Numeric equivalents of the cloud `stage_control` actions. See file header
	// for the firmware line-by-line equivalence.

	/** `20` — reset_stage(true). Homes against the proximal limit switch. */
	home(): Promise<SpuCommandResult> {
		return this.send(20);
	}

	/** `22,<microns>,<stepDelay>` — relative move. Negative microns = proximal. */
	jog(microns: number, stepDelay: number): Promise<SpuCommandResult> {
		return this.send(22, [microns, stepDelay]);
	}

	/** `23,<microns>,<stepDelay>` — re-home, then move to an absolute position. */
	goto(microns: number, stepDelay: number): Promise<SpuCommandResult> {
		return this.send(23, [microns, stepDelay]);
	}

	/**
	 * `29` — sleep_motor, used as a side-effect-free position read.
	 *
	 * The firmware has no pure "report position" serial command, but every
	 * completion line carries `stage_position` as its result. sleep_motor is the
	 * safest carrier: it de-energises the motor (which `goto` already does on
	 * completion) and moves nothing. move_stage re-wakes the motor automatically.
	 */
	readPosition(): Promise<SpuCommandResult> {
		return this.send(29, [], 15_000);
	}
}
