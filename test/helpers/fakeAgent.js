// -----------------------------------------------------------------------------
// A simulated Agent DVR behind the `fetch` seam, built on the answers
// recorded from a real 7.0.0.0 server (test/fixtures/agentdvr/agent-7.0.json):
// three cameras (1 moving and recording, 2 without frames, 3 still), the
// commands the integration sends, alerts, JPEG frames.
// -----------------------------------------------------------------------------

import { readFileSync } from 'node:fs';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/agentdvr/agent-7.0.json', import.meta.url), 'utf8'),
);
export const FRAME = readFileSync(new URL('../fixtures/agentdvr/frame.jpg', import.meta.url));
export const RECORDED = fixture;

const clone = (value) => JSON.parse(JSON.stringify(value));

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

export class FakeAgent {
  constructor({ origin = 'http://192.0.2.10:8090', auth = null } = {}) {
    this.origin = origin;
    // `user:password` when the server asks for Basic credentials.
    this.auth = auth;
    this.status = clone(fixture.getStatus);
    this.objects = clone(fixture.getObjects);
    // Live states: the getObject answers, keyed by camera id.
    this.cameras = new Map(
      Object.entries(clone(fixture.getObject)).map(([id, o]) => [Number(id), o]),
    );
    // Both lists share one object per camera, as on the server.
    this.objects.objectList = this.objects.objectList.map(
      (object) => this.cameras.get(object.id) ?? object,
    );
    this.alerts = clone(fixture.alerts.alerts);
    this.requests = [];
    this.down = false;
    this.frame = FRAME;
    this.frameBySize = new Map();
    // Readings of a camera before a command shows (Agent DVR 7.0 applies
    // switchOff and recordStop a moment after answering).
    this.lag = 0;
    this.pendingChanges = [];
  }

  /** Apply a command now, or after `lag` readings of the camera. */
  later(camera, change) {
    if (this.lag > 0) {
      this.pendingChanges.push({ camera, change, left: this.lag });
    } else {
      change();
    }
  }

  tick(camera) {
    for (const pending of this.pendingChanges.filter((item) => item.camera === camera)) {
      pending.left -= 1;
      if (pending.left <= 0) {
        pending.change();
      }
    }
    this.pendingChanges = this.pendingChanges.filter((item) => item.left > 0);
  }

  get(id) {
    return this.cameras.get(id);
  }

  /** Change the live data of a camera: `set(1, 'detected', false)`. */
  set(id, key, value) {
    this.get(id).data[key] = value;
  }

  setName(id, name) {
    this.get(id).name = name;
  }

  removeCamera(id) {
    this.cameras.delete(id);
    this.objects.objectList = this.objects.objectList.filter((object) => object.id !== id);
  }

  addAlert(oid, msg = 'Alert') {
    const id = Math.max(0, ...this.alerts.map((alert) => Number(alert.id))) + 1;
    this.alerts.unshift({
      ot: 2,
      oid,
      reason: 'alert',
      msg,
      time: '639277550991234595',
      id: String(id),
      read: false,
      tags: '',
      desc: '',
    });
    return id;
  }

  count(path) {
    return this.requests.filter((request) => request.includes(path)).length;
  }

  fetch = async (href, options = {}) => {
    const url = new URL(href);
    const cmd = url.searchParams.get('cmd');
    this.requests.push(`${url.pathname}${cmd ? `?cmd=${cmd}` : ''}`);
    if (this.down || url.origin !== this.origin) {
      const err = new TypeError('fetch failed');
      err.cause = { code: 'ECONNREFUSED' };
      throw err;
    }
    if (this.auth) {
      const expected = `Basic ${Buffer.from(this.auth).toString('base64')}`;
      if (options.headers?.authorization !== expected) {
        return new Response('Unauthorized', { status: 401 });
      }
    }
    const oid = Number(url.searchParams.get('oid'));
    if (url.pathname === '/grab.jpg') {
      if (!this.cameras.has(oid)) {
        return new Response('', { status: 404 });
      }
      const size = url.searchParams.get('size');
      const body = (size && this.frameBySize.get(size)) ?? this.frame;
      return new Response(body, { headers: { 'content-type': 'image/jpeg' } });
    }
    if (url.pathname === '/alerts.json') {
      return json({ alerts: this.alerts });
    }
    if (url.pathname !== '/command.cgi') {
      return new Response('Not found', { status: 404 });
    }
    const camera = this.cameras.get(oid);
    switch (cmd) {
      case 'getStatus':
        return json(this.status);
      case 'getObjects':
        return json(this.objects);
      case 'getObject':
        if (camera) {
          this.tick(camera);
        }
        return camera ? json(camera) : json(fixture.getObjectMissing);
      case 'arm':
      case 'disarm':
        this.status.armed = cmd === 'arm';
        return json(fixture.ok);
      case 'record':
      case 'recordStop':
        // Agent DVR says ok to an unknown camera too.
        if (camera) {
          this.later(camera, () => {
            camera.data.recording = cmd === 'record';
          });
        }
        return json(fixture.ok);
      case 'switchOn':
      case 'switchOff':
        if (camera) {
          const on = cmd === 'switchOn';
          this.later(camera, () => {
            Object.assign(camera.data, { online: on, connected: on });
            if (!on) {
              Object.assign(camera.data, { recording: false, detected: false });
            }
          });
        }
        return json(fixture.ok);
      default:
        return json({ error: 'Unknown command', message: cmd });
    }
  };
}
