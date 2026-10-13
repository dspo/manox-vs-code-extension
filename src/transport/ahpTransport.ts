// The napi binding dressed as an AHP transport: raw JSON-RPC text frames in
// both directions over the in-process manox connection. The `AhpTransport`
// shape comes from `@microsoft/agent-host-protocol/client`; `AhpClient` owns
// all parsing, correlation and subscription fan-out on top.

import type { AhpTransport, TransportFrame } from '@microsoft/agent-host-protocol/client';
import { TransportError } from '@microsoft/agent-host-protocol/client';
import type { NapiTransport } from './napiTransport';

export class NapiAhpTransport implements AhpTransport {
	/** Inbound frames not yet consumed by the client's receive loop. */
	private inbox: TransportFrame[] = [];
	/** Wake-up for a pending `recv`. */
	private waiter: ((frame: TransportFrame | null) => void) | null = null;
	private closed = false;

	private constructor(private readonly napi: NapiTransport) {}

	/** Bridge one live NapiTransport: subscribe to its raw frames and return
	 * the AHP transport view over it. */
	static over(napi: NapiTransport): NapiAhpTransport {
		const transport = new NapiAhpTransport(napi);
		napi.onRaw((raw) => transport.deliver(raw));
		return transport;
	}

	send(message: Parameters<AhpTransport['send']>[0]): void {
		if (this.closed) throw new TransportError('closed', 'manox transport disposed');
		const text = typeof message === 'string' ? message : JSON.stringify(message);
		try {
			this.napi.send(text);
		} catch (cause) {
			throw new TransportError('io', `manox send failed: ${(cause as Error).message}`, { cause });
		}
	}

	recv(): Promise<TransportFrame | null> {
		if (this.inbox.length > 0) return Promise.resolve(this.inbox.shift() ?? null);
		if (this.closed) return Promise.resolve(null);
		return new Promise((resolve) => {
			this.waiter = resolve;
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		void this.napi.dispose();
		this.wake(null);
	}

	/** The napi callback thread delivers one raw JSON-RPC text frame. */
	private deliver(raw: string): void {
		if (this.closed) return;
		this.wake({ kind: 'text', text: raw });
	}

	private wake(frame: TransportFrame | null): void {
		if (this.waiter) {
			const waiter = this.waiter;
			this.waiter = null;
			waiter(frame);
			return;
		}
		if (frame !== null) this.inbox.push(frame);
	}
}
