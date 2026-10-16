// -----------------------------------------------------------------------------
// HTTP client of one Agent DVR server (iSpyConnect), its local API on port
// 8090 by default. What the integration uses:
//   GET command.cgi?cmd=getStatus                  armed, version, server id
//   GET command.cgi?cmd=getObjects                 every device (cameras: typeID 2)
//   GET command.cgi?cmd=getObject&oid=N&ot=2       one camera and its live state
//   GET command.cgi?cmd=arm | disarm               the whole system
//   GET command.cgi?cmd=record | recordStop&oid=N&ot=2
//   GET command.cgi?cmd=switchOn | switchOff&oid=N&ot=2
//   GET alerts.json                                the alerts, newest first
//   GET grab.jpg?oid=N[&size=WxH]                  one JPEG frame
//
// Found on a real server (7.0.0.0, see CLAUDE.md): a refused command still
// answers HTTP 200, with `{ "error": …, "message": … }`; a command on an
// unknown camera answers `{ "status": "ok" }` (the hub checks the id first);
// getObjects weighs about 100 KB (its icons), getObject under 1 KB.
//
// Errors carry a `kind`: `network` (no answer), `auth` (401/403), `notFound`
// (no such camera), `refused` (Agent DVR said no), `http` (anything else).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'agentdvr-api' });

export const REQUEST_TIMEOUT_MS = 15000;
export const DEFAULT_PORT = 8090;
export const CAMERA_TYPE = 2;
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export class AgentError extends Error {
  constructor(message, { kind = 'http', status } = {}) {
    super(message);
    this.name = 'AgentError';
    this.kind = kind;
    this.status = status;
  }
}

/**
 * The address typed by the user: `192.0.2.10`, `nvr.lan:8090`,
 * `https://agent.example/`… Resolves to `{ origin, basePath }`, or null.
 * Without a scheme nor a port, Agent DVR's own port (8090) is used.
 * Credentials in the address are refused: they go in their own fields.
 */
export function parseServerUrl(text) {
  const raw = String(text ?? '').trim();
  if (!raw) {
    return null;
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url;
  try {
    url = new URL(hasScheme ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    !url.hostname
  ) {
    return null;
  }
  if (!hasScheme && !url.port) {
    url.port = String(DEFAULT_PORT);
  }
  return { origin: url.origin, basePath: url.pathname.replace(/\/+$/, '') };
}

const bool = (value) => value === true;

/** One camera of getObjects / getObject, with the state the hub reads. */
export function normalizeCamera(object) {
  const data = object?.data ?? {};
  return {
    id: Number(object?.id),
    name: String(object?.name ?? data.name ?? '').trim(),
    // `online` is Agent DVR's "switched on"; `connected`: frames come in.
    enabled: bool(data.online),
    connected: bool(data.connected),
    motion: bool(data.detected),
    recording: bool(data.recording),
    alertsActive: bool(data.alertsActive),
    detectorActive: bool(data.detectorActive),
  };
}

/** One entry of alerts.json; its id grows with each alert of the server. */
export function normalizeAlert(alert) {
  return {
    id: Number(alert?.id),
    cameraId: Number(alert?.oid),
    type: Number(alert?.ot),
    reason: String(alert?.reason ?? ''),
    message: String(alert?.msg ?? ''),
  };
}

async function readLimited(response, limit) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel().catch(() => {});
    throw new AgentError(`Answer too large (${length} bytes)`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > limit) {
    throw new AgentError(`Answer too large (${buffer.length} bytes)`);
  }
  return buffer;
}

const isJpeg = (buffer) => buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8;

/** The message of an error body, short and on one line. */
const errorText = (body) =>
  [body?.error, body?.message]
    .filter((item) => typeof item === 'string' && item.trim())
    .join(': ')
    .replace(/\s+/g, ' ')
    .slice(0, 200);

export class AgentClient {
  /**
   * @param {object} options
   * @param {string} options.url the server address (parseServerUrl)
   * @param {string} [options.username] empty when Agent DVR asks for nothing
   * @param {string} [options.password]
   * @param {Function} [options.fetch] fetch (tests replace it)
   */
  constructor({ url, username = '', password = '', fetch = globalThis.fetch }) {
    const server = parseServerUrl(url);
    if (!server) {
      throw new AgentError('Invalid Agent DVR address', { kind: 'config' });
    }
    this.origin = server.origin;
    this.basePath = server.basePath;
    this.fetch = fetch;
    this.version = null;
    this.headers = username
      ? {
          authorization: `Basic ${Buffer.from(`${username}:${password ?? ''}`).toString('base64')}`,
        }
      : {};
  }

  /** The address, for messages and logs (never with credentials). */
  get label() {
    return `${this.origin}${this.basePath}`;
  }

  async send(path, params = {}) {
    const url = new URL(`${this.label}/${path}`);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
    // The path and the command only: never the Authorization header.
    logger.debug(
      `GET ${path}${params.cmd ? ` ${params.cmd}` : ''}${params.oid ? ` ${params.oid}` : ''}`,
    );
    let response;
    try {
      response = await this.fetch(url.href, {
        headers: this.headers,
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? 'timeout' : (err?.cause?.code ?? err?.message);
      throw new AgentError(`${this.label} does not answer (${reason})`, { kind: 'network' });
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => {});
      throw new AgentError(`Agent DVR refuses the account (HTTP ${response.status})`, {
        kind: 'auth',
        status: response.status,
      });
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AgentError(`Agent DVR answered HTTP ${response.status} to ${path}`, {
        status: response.status,
      });
    }
    return response;
  }

  async json(path, params) {
    const response = await this.send(path, params);
    const buffer = await readLimited(response, MAX_JSON_BYTES);
    let body;
    try {
      body = JSON.parse(buffer.toString('utf8').replace(/^\uFEFF/, ''));
    } catch {
      throw new AgentError(`Agent DVR answered something else than JSON to ${path}`);
    }
    if (!body || typeof body !== 'object') {
      throw new AgentError(`Agent DVR answered something else than JSON to ${path}`);
    }
    if (body.error !== undefined && body.error !== null) {
      const text = errorText(body);
      throw new AgentError(`Agent DVR: ${text || 'error'}`, {
        kind: /not found/i.test(text) ? 'notFound' : 'refused',
      });
    }
    return body;
  }

  command(cmd, params = {}) {
    return this.json('command.cgi', { cmd, ...params });
  }

  async status() {
    const body = await this.command('getStatus');
    if (typeof body.armed !== 'boolean') {
      throw new AgentError('This server does not answer like Agent DVR (no "armed")');
    }
    this.version = typeof body.version === 'string' ? body.version : null;
    return {
      armed: body.armed,
      recording: Number.isFinite(body.recording) ? body.recording : null,
      version: this.version,
      name: typeof body.name === 'string' ? body.name : '',
    };
  }

  async listCameras() {
    const body = await this.command('getObjects');
    if (!Array.isArray(body.objectList)) {
      throw new AgentError('This server does not answer like Agent DVR (no "objectList")');
    }
    return body.objectList
      .filter((object) => Number(object?.typeID) === CAMERA_TYPE)
      .map(normalizeCamera)
      .filter((camera) => Number.isInteger(camera.id));
  }

  async camera(id) {
    return normalizeCamera(await this.command('getObject', { oid: id, ot: CAMERA_TYPE }));
  }

  async alerts() {
    const body = await this.json('alerts.json');
    return (Array.isArray(body.alerts) ? body.alerts : [])
      .map(normalizeAlert)
      .filter((alert) => Number.isFinite(alert.id));
  }

  async setArmed(on) {
    await this.command(on ? 'arm' : 'disarm');
  }

  async setRecording(id, on) {
    await this.command(on ? 'record' : 'recordStop', { oid: id, ot: CAMERA_TYPE });
  }

  async setEnabled(id, on) {
    await this.command(on ? 'switchOn' : 'switchOff', { oid: id, ot: CAMERA_TYPE });
  }

  /** One JPEG frame, at its own size or fit in `size` (`640x360`). */
  async image(id, { size } = {}) {
    const response = await this.send('grab.jpg', size ? { oid: id, size } : { oid: id });
    const buffer = await readLimited(response, MAX_IMAGE_BYTES);
    if (!isJpeg(buffer)) {
      throw new AgentError(`Camera ${id} sent no JPEG image`);
    }
    return buffer;
  }
}
