/** A JSON-RPC `error` reply from the Rysk WebSocket. */
export class RyskRpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'RyskRpcError';
    this.code = code;
  }
}

/**
 * The WebSocket closed while a call was pending. `sent`: whether its frame was written to the socket (false
 * means the server never saw it).
 */
export class SocketClosedError extends Error {
  readonly sent: boolean;

  constructor(message: string, sent: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SocketClosedError';
    this.sent = sent;
  }
}

/**
 * A call (WebSocket or REST attempt) passed its deadline. Never retried blindly. `sent`: whether the request
 * left the client (false means the server never saw it; REST attempts always count as sent).
 */
export class CallTimeoutError extends Error {
  readonly sent: boolean;

  constructor(message: string, sent: boolean, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CallTimeoutError';
    this.sent = sent;
  }
}

/** A non-2xx REST response, or a 2xx whose body is not what the endpoint returns. */
export class RestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'RestError';
    this.status = status;
  }
}
