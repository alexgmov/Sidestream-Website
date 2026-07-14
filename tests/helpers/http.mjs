import { Readable } from "node:stream";

export function createRequest(options = {}) {
  const headers = Object.fromEntries(
    Object.entries(options.headers || {}).map(([name, value]) => [name.toLowerCase(), value]),
  );
  const body = serializeBody(options.body);
  const request = Readable.from(body ? [Buffer.from(body)] : []);
  request.method = options.method || "GET";
  request.url = options.url || "/";
  request.headers = headers;
  request.socket = { remoteAddress: "127.0.0.1" };
  request.session = options.session || null;
  request.licenseEnvironment = options.licenseEnvironment;
  request.contractBody = body;
  return request;
}

export function createResponse() {
  const headers = new Map();
  const chunks = [];
  let ended = false;

  return {
    statusCode: 200,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    appendHeader(name, value) {
      const normalized = name.toLowerCase();
      const existing = headers.get(normalized);
      const values = existing === undefined
        ? []
        : Array.isArray(existing) ? existing : [existing];
      headers.set(normalized, [...values, value]);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    getHeaders() {
      return Object.fromEntries(headers);
    },
    write(chunk) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return true;
    },
    end(chunk) {
      if (chunk !== undefined) this.write(chunk);
      ended = true;
    },
    get body() {
      return Buffer.concat(chunks).toString("utf8");
    },
    get json() {
      return this.body ? JSON.parse(this.body) : null;
    },
    get ended() {
      return ended;
    },
  };
}

export async function invokeHandler(handler, requestOptions) {
  const request = createRequest(requestOptions);
  const response = createResponse();
  await handler(request, response);
  if (!response.ended) {
    throw new Error(`Handler ${request.method} ${request.url} did not end its response`);
  }
  return { request, response };
}

function serializeBody(body) {
  if (body === undefined || body === null) return "";
  if (typeof body === "string" || Buffer.isBuffer(body)) return body.toString();
  return JSON.stringify(body);
}
