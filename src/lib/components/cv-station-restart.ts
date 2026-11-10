/**
 * Restart a CV station's bims-capture-agent from the browser.
 *
 * Mints a station JWT (it carries the admin claim only for cv:admin users),
 * opens the Pi's /ws directly over Tailscale, waits for hello, sends
 * {cmd: 'admin_restart'} and resolves on restart_pending. The Pi checks the
 * admin claim itself (story F1).
 *
 * Talks to the Pi, not to BIMS, so it works while BIMS shows the station
 * offline — the case it exists for. Shared by /cv/stations/[id], /capture
 * and Post Mortem Inspect.
 */
export async function restartStationAgent(stationId: string, hostname: string): Promise<void> {
	const tokRes = await fetch(`/api/cv/stations/${encodeURIComponent(stationId)}/token`);
	if (!tokRes.ok) throw new Error(`token mint HTTP ${tokRes.status}`);
	const { token } = await tokRes.json();
	if (!token) throw new Error('empty token');

	const sock = new WebSocket(`wss://${hostname}/ws?token=${encodeURIComponent(token)}`);

	await new Promise<void>((resolve, reject) => {
		let helloSeen = false;
		let settled = false;
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (err) reject(err);
			else resolve();
		};
		const timeout = setTimeout(() => {
			try {
				sock.close();
			} catch {
				/* already closed */
			}
			finish(new Error('agent did not respond within 10 s'));
		}, 10_000);

		sock.onmessage = (ev) => {
			let msg: { event?: string; code?: string; message?: string };
			try {
				msg = JSON.parse(ev.data);
			} catch {
				return;
			}
			if (msg.event === 'hello' && !helloSeen) {
				helloSeen = true;
				try {
					sock.send(JSON.stringify({ cmd: 'admin_restart' }));
				} catch (e) {
					finish(e instanceof Error ? e : new Error(String(e)));
				}
			} else if (msg.event === 'restart_pending') {
				finish();
			} else if (msg.event === 'error') {
				finish(new Error(`${msg.code ?? 'error'}: ${msg.message ?? 'unknown'}`));
			}
		};
		sock.onerror = () => finish(new Error('WebSocket error'));
		// The Pi closes the socket as part of the restart. A close before
		// hello means we never reached the agent.
		sock.onclose = () => {
			if (!helloSeen) finish(new Error('socket closed before hello'));
		};
	});
}
