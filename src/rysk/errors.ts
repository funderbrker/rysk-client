/** A JSON-RPC `error` reply from the Rysk WebSocket. */
export class RyskRpcError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.name = 'RyskRpcError';
    this.code = code;
  }
}

/** The WebSocket closed while a call was pending. */
export class SocketClosedError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SocketClosedError';
  }
}

/** A call (WebSocket or REST attempt) passed its deadline. Never retried blindly. */
export class CallTimeoutError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CallTimeoutError';
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
