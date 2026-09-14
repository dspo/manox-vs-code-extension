// Transport abstraction between the extension host and the manox agent
// server. The protocol vocabulary lives in src/protocol; a transport moves
// serialized `FromServer` JSON strings, one per delivery. The napi binding is
// the only implementation (in-process agent server on its own tokio runtime);
// a stdio child process or WS gateway client could implement the same
// interface. Frame parsing/guarding happens in the Wire adapter that feeds
// `AgentConnection`, not here.

export interface Transport {
	/** Resolves once the actor is up and commands may be sent. */
	readonly ready: Promise<void>;
	/** Subscribe to raw server frames (serialized `FromServer` JSON). */
	onRaw(handler: (raw: string) => void): () => void;
	/** Deliver one serialized `FromClient` JSON string. Throws when the actor
	 * is unreachable or rejects the frame. */
	send(command: string): void;
	/** Shut the actor down and release its resources. */
	dispose(): Promise<void>;
}
