// -----------------------------------------------------------------------------
// The Agent DVR hub: one server, its cameras, and everything Gladys sees of
// them.
//
// Two timers run in the container (the devices are published with
// should_poll: false, see src/devices.js):
//   - the reading, every `poll_interval` seconds: the armed state, the live
//     state of each camera added in Gladys (motion, recording, frames coming
//     in), and the alerts raised since the last reading. Motion starting or a
//     new alert fires its scene trigger and sends the image of the moment; an
//     image also goes every `snapshot_interval`;
//   - the camera list, every minute: names, cameras added or removed in
//     Agent DVR, and whether the server answers at all.
//
// States go through publishChangedStates (only what changed, a heartbeat
// every 12 h so a quiet value never looks stale).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { connectionKey } from './config.js';
import {
  FEATURE_KEYS,
  SERVER_KEYS,
  buildDevice,
  buildServerDevice,
  deviceIds,
  deviceName,
  featureKeyOf,
  serverIds,
} from './devices.js';
import { AgentClient, AgentError, CAMERA_TYPE } from './agent/client.js';
import { CONNECTION_TEXT } from './texts.js';

const logger = createLogger({ name: 'agentdvr' });

export const WIDGET_KEY = 'camera';
export const TRIGGERS = {
  MOTION: 'motion_detected',
  ALERT: 'alert',
  OFFLINE: 'camera_offline',
};

export const IMAGE_PREFIX = 'image/jpg;base64,';
// The core keeps camera images of 150 KB at most, once written as a data URI.
export const MAX_JPEG_BYTES = Math.floor((150 * 1024 - IMAGE_PREFIX.length) / 4) * 3;
// Sizes asked to Agent DVR when a frame is too heavy (it keeps the ratio).
export const FIT_SIZES = ['1280x720', '640x360'];

export const DEFAULT_TIMINGS = {
  listMs: 60 * 1000,
  // A camera switched on but without frames this long is said offline: a
  // camera reconnecting after a network blip does not fire the trigger.
  offlineAfterMs: 30 * 1000,
  // After a camera is switched on by the integration, missing frames are not
  // counted this long (Agent DVR connects to it again).
  restartGraceMs: 30 * 1000,
  // 12 images a minute per camera at most (the core's bound).
  minImageSpacingMs: 5000,
  heartbeatMs: 12 * 60 * 60 * 1000,
  concurrency: 4,
  // Agent DVR answers a command at once but applies it a moment later (seen
  // on 7.0: switchOff and recordStop read back unchanged right after): the
  // camera is read again until it says so, this many times at most.
  settleTries: 8,
  settleMs: 500,
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// How old the last image may be to stand in for a fresh one.
const STALE_IMAGE_MS = 5 * 60 * 1000;

export const toDataUri = (jpeg) => `${IMAGE_PREFIX}${jpeg.toString('base64')}`;

export class AgentHub {
  /**
   * @param {object} options
   * @param {object} options.gladys GladysIntegration (or the SDK's fake)
   * @param {Function} [options.fetch] fetch for the Agent DVR client (tests)
   * @param {boolean} [options.timers] run the periodic timers
   * @param {object} [options.timings] overrides of DEFAULT_TIMINGS
   */
  constructor({ gladys, fetch, timers = true, timings = {} }) {
    this.gladys = gladys;
    this.fetch = fetch;
    this.useTimers = timers;
    this.timings = { ...DEFAULT_TIMINGS, ...timings };
    this.config = null;
    this.client = null;
    this.clientKey = null;
    this.cameras = new Map();
    // null (not tried yet), 'ok', 'auth', 'unreachable', 'error', 'noUrl'
    this.server = null;
    this.armed = null;
    this.recordingCount = null;
    this.lastAlertId = null;
    this.publishedDevicesKey = null;
    this.pending = new Set();
    this.timers = [];
    this.stopped = false;
  }

  // --- Lifecycle ---------------------------------------------------------------

  async start(config) {
    this.applyConfig(config);
    logger.info(
      this.client
        ? `Starting with the Agent DVR server ${this.client.label}`
        : 'No valid Agent DVR address in the configuration',
    );
    await this.refresh();
    this.startTimers();
  }

  /** Gladys came back: re-send what it may have lost. */
  async resync(config) {
    this.applyConfig(config);
    this.publishedDevicesKey = null;
    await this.refresh();
    for (const device of this.gladys.devices ?? []) {
      this.gladys.forgetPublishedStates(device.external_id);
    }
    await this.publishAllStates();
    await this.publishTransports();
    if (this.server && this.server !== 'noUrl') {
      await this.publishServerTransport(this.server === 'ok');
    }
  }

  async reconfigure(config) {
    const language = this.config?.language;
    this.applyConfig(config);
    if (language !== config.language) {
      this.publishedDevicesKey = null;
    }
    await this.refresh();
    this.startTimers();
  }

  applyConfig(config) {
    this.config = config;
    const key = connectionKey(config);
    if (key === this.clientKey) {
      return;
    }
    this.clientKey = key;
    this.generation = (this.generation ?? 0) + 1;
    this.cameras.clear();
    this.lastAlertId = null;
    this.armed = null;
    this.recordingCount = null;
    // The cameras already added in Gladys, known before Agent DVR answers:
    // they can be said unreachable when it never does.
    for (const device of this.gladys.devices ?? []) {
      const param = (device.params ?? []).find((item) => item.name === 'AGENTDVR_CAMERA_ID');
      const id = Number(param?.value);
      if (param && Number.isInteger(id)) {
        this.cameras.set(id, { ...this.newCamera(id), name: String(device.name ?? '') });
      }
    }
    this.server = null;
    this.publishedDevicesKey = null;
    this.client = config.validUrl
      ? new AgentClient({
          url: config.url,
          username: config.username,
          password: config.password,
          fetch: this.fetch,
        })
      : null;
  }

  startTimers() {
    this.clearTimers();
    if (!this.useTimers || this.stopped) {
      return;
    }
    this.timers.push(
      setInterval(() => this.track(this.pollAll()), this.config.pollSeconds * 1000),
      setInterval(() => this.track(this.refresh()), this.timings.listMs),
    );
    for (const timer of this.timers) {
      timer.unref?.();
    }
  }

  clearTimers() {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
  }

  /** Keep a background task, so stop() and the tests can wait for it. */
  track(promise) {
    const task = Promise.resolve(promise).catch((err) => logger.debug(err.message));
    this.pending.add(task);
    task.finally(() => this.pending.delete(task));
    return task;
  }

  async idle() {
    while (this.pending.size > 0) {
      await Promise.all([...this.pending]);
    }
  }

  async stop() {
    this.stopped = true;
    this.clearTimers();
    await this.idle();
  }

  // --- Server and camera list ------------------------------------------------------

  /** Read the server and its camera list; publish what changed. */
  refresh() {
    // A refresh started before a change of configuration speaks of the old
    // server: chain a new one rather than share its result.
    if (!this.refreshing || this.refreshing.generation !== this.generation) {
      const previous = this.refreshing ?? Promise.resolve();
      const generation = this.generation;
      const run = previous
        .catch(() => {})
        .then(() => this.doRefresh(generation))
        .finally(() => {
          if (this.refreshing === run) {
            this.refreshing = null;
          }
        });
      run.generation = generation;
      this.refreshing = run;
    }
    return this.refreshing;
  }

  async doRefresh(generation = this.generation) {
    if (!this.client) {
      await this.setServer('noUrl');
      return;
    }
    let status;
    let list;
    try {
      status = await this.client.status();
      list = await this.client.listCameras();
    } catch (err) {
      if (generation === this.generation) {
        await this.serverFailed(err);
      }
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    this.applyStatus(status);
    const seen = new Set();
    for (const item of list) {
      seen.add(item.id);
      const camera = this.cameras.get(item.id) ?? this.newCamera(item.id);
      this.cameras.set(item.id, camera);
      this.applyCamera(camera, item, { live: false });
    }
    for (const id of [...this.cameras.keys()]) {
      if (!seen.has(id)) {
        logger.info(`Camera ${id} is no longer in Agent DVR`);
        this.cameras.delete(id);
      }
    }
    await this.setServer('ok');
    await this.publishDevices();
    for (const camera of this.cameras.values()) {
      await this.checkOnline(camera);
    }
    await this.publishAllStates();
  }

  newCamera(id) {
    return {
      id,
      name: '',
      enabled: true,
      connected: null,
      motion: null,
      recording: null,
      alertsActive: false,
      online: null,
      offlineSince: null,
      image: null,
      imageSeq: 0,
      lastPublishAt: 0,
      fitSize: null,
      polling: null,
    };
  }

  applyStatus(status) {
    this.armed = status.armed;
    this.recordingCount = status.recording;
  }

  /**
   * @param {boolean} [options.live] false for the camera list: motion is left
   * to the reading of each camera, which fires the trigger when it starts.
   */
  applyCamera(camera, item, { live = true } = {}) {
    camera.name = item.name;
    camera.enabled = item.enabled;
    camera.connected = item.connected;
    if (live || camera.motion === null || !item.enabled) {
      camera.motion = item.enabled && item.motion;
    }
    camera.recording = item.recording;
    camera.alertsActive = item.alertsActive;
  }

  async serverFailed(err) {
    const state = err.kind === 'auth' ? 'auth' : err.kind === 'network' ? 'unreachable' : 'error';
    if (state !== this.server) {
      const line = `Agent DVR ${this.client.label}: ${err.message}`;
      if (state === 'unreachable' && this.server === 'ok') {
        logger.warn(line);
      } else {
        logger.error(line);
      }
    } else {
      logger.debug(err.message);
    }
    await this.setServer(state);
  }

  async setServer(state) {
    const previous = this.server;
    this.server = state;
    if (state === 'ok' && previous && previous !== 'ok') {
      logger.info(`Agent DVR ${this.client.label} answers again`);
    }
    if (state === previous) {
      return;
    }
    if (state !== 'ok') {
      // Nothing can be read any more: no stale motion, no "local" badge.
      const outage = state === 'unreachable' || state === 'error';
      for (const camera of this.cameras.values()) {
        camera.motion = camera.motion === null ? null : false;
        await this.publishStates(camera);
        // Agent DVR down: its cameras are lost too ("Camera offline").
        await this.setOnline(camera, false, { quiet: !outage });
      }
      await this.publishServerTransport(false);
    } else {
      await this.publishServerTransport(true);
    }
    try {
      if (state === 'ok') {
        await this.gladys.setConnectionStatus(true);
      } else {
        await this.gladys.setConnectionStatus(false, CONNECTION_TEXT[state]);
      }
    } catch (err) {
      logger.debug(`Cannot send the connection status: ${err.message}`);
    }
  }

  // --- Devices -------------------------------------------------------------------

  ids(camera) {
    return deviceIds(this.gladys, camera.id);
  }

  get serverIds() {
    return serverIds(this.gladys);
  }

  async publishDevices() {
    const devices = [
      buildServerDevice(this.gladys, this.config.language),
      ...[...this.cameras.values()].map((camera) =>
        buildDevice(this.gladys, camera, this.config.language),
      ),
    ];
    // Republished when a camera appears, goes or is renamed: an upsert on
    // the devices already added, a new entry in the Discovery tab otherwise.
    const key = JSON.stringify(devices.map((device) => [device.external_id, device.name]));
    if (key === this.publishedDevicesKey) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.publishedDevicesKey = key;
      if (this.devicesFailing) {
        this.devicesFailing = false;
        logger.info('The cameras are published to Gladys again');
      }
    } catch (err) {
      // Tried again at the next reading of the list.
      if (!this.devicesFailing) {
        this.devicesFailing = true;
        logger.warn(`Cannot publish the cameras to Gladys: ${err.message}`);
      }
    }
  }

  isAdded(externalId) {
    return (this.gladys.devices ?? []).some((device) => device.external_id === externalId);
  }

  isCreated(camera) {
    return this.isAdded(this.ids(camera).device);
  }

  /** The camera behind a Gladys device external id, or null. */
  resolveDevice(externalId) {
    for (const camera of this.cameras.values()) {
      if (this.ids(camera).device === externalId) {
        return camera;
      }
    }
    return null;
  }

  require(externalId) {
    const camera = this.resolveDevice(externalId);
    if (!camera) {
      throw new Error(`Unknown Agent DVR camera ${externalId}: check the integration`);
    }
    return camera;
  }

  /** The cameras added in Gladys. */
  createdCameras() {
    return [...this.cameras.values()].filter((camera) => this.isCreated(camera));
  }

  // --- States --------------------------------------------------------------------

  statesOf(camera) {
    const ids = this.ids(camera);
    const states = [
      {
        device_feature_external_id: ids.feature(FEATURE_KEYS.ENABLED),
        state: camera.enabled ? 1 : 0,
      },
    ];
    if (camera.motion !== null) {
      states.push({
        device_feature_external_id: ids.feature(FEATURE_KEYS.MOTION),
        state: camera.motion ? 1 : 0,
      });
    }
    if (camera.recording !== null) {
      states.push({
        device_feature_external_id: ids.feature(FEATURE_KEYS.RECORDING),
        state: camera.recording ? 1 : 0,
      });
    }
    return states;
  }

  serverStates() {
    const ids = this.serverIds;
    const states = [];
    if (this.armed !== null) {
      states.push({
        device_feature_external_id: ids.feature(SERVER_KEYS.ARMED),
        state: this.armed ? 1 : 0,
      });
    }
    if (this.recordingCount !== null) {
      states.push({
        device_feature_external_id: ids.feature(SERVER_KEYS.RECORDING_COUNT),
        state: this.recordingCount,
      });
    }
    return states;
  }

  async publish(states, what) {
    if (states.length === 0) {
      return;
    }
    try {
      // Only what changed; a value that never changes again every 12 h.
      await this.gladys.publishChangedStates(states, { heartbeat: this.timings.heartbeatMs });
      if (this.statesFailing) {
        this.statesFailing = false;
        logger.info('States are published to Gladys again');
      }
    } catch (err) {
      if (this.statesFailing) {
        logger.debug(`Cannot publish the states of ${what}: ${err.message}`);
      } else {
        this.statesFailing = true;
        logger.warn(`Cannot publish the states of ${what}: ${err.message}`);
      }
    }
  }

  async publishStates(camera) {
    if (this.isCreated(camera)) {
      await this.publish(this.statesOf(camera), `camera ${camera.id}`);
    }
  }

  async publishServerStates() {
    if (this.isAdded(this.serverIds.device)) {
      await this.publish(this.serverStates(), 'the server');
    }
  }

  async publishAllStates() {
    await this.publishServerStates();
    for (const camera of this.cameras.values()) {
      await this.publishStates(camera);
    }
  }

  async publishTransports(cameras = [...this.cameras.values()]) {
    const entries = cameras
      .filter((camera) => camera.online !== null && this.isCreated(camera))
      .map((camera) => ({
        external_id: this.ids(camera).device,
        transport: camera.online ? 'local' : 'unreachable',
      }));
    if (entries.length > 0) {
      await this.gladys.publishTransports(entries).catch((err) => logger.debug(err.message));
    }
  }

  async publishServerTransport(online) {
    if (this.isAdded(this.serverIds.device)) {
      await this.gladys
        .publishTransports([
          { external_id: this.serverIds.device, transport: online ? 'local' : 'unreachable' },
        ])
        .catch((err) => logger.debug(err.message));
    }
  }

  /**
   * The user added a device: the states sent before were dropped by Gladys,
   * and so was the transport badge. Send them again, with an image.
   */
  async onDeviceCreated(device) {
    const externalId = device?.external_id;
    if (externalId === this.serverIds.device) {
      this.gladys.forgetPublishedStates(externalId);
      await this.publishServerStates();
      await this.publishServerTransport(this.server === 'ok');
      this.requestWidgetRefresh();
      return;
    }
    const camera = this.resolveDevice(externalId);
    if (!camera) {
      return;
    }
    this.gladys.forgetPublishedStates(externalId);
    camera.lastPublishAt = 0;
    await this.poll(camera);
    await this.publishStates(camera);
    if (camera.enabled && camera.online !== false) {
      await this.publishImage(camera);
    }
    await this.publishTransports([camera]);
    this.requestWidgetRefresh();
  }

  requestWidgetRefresh() {
    try {
      this.gladys.requestWidgetRefresh(WIDGET_KEY);
    } catch (err) {
      logger.debug(`Widget refresh refused: ${err.message}`);
    }
  }

  // --- Online / offline ------------------------------------------------------------

  async checkOnline(camera) {
    if (!camera.enabled) {
      // Switched off in Agent DVR: no frame expected, no "offline" alarm.
      camera.offlineSince = null;
      await this.setOnline(camera, false, { quiet: true });
      return;
    }
    if (camera.connected) {
      camera.offlineSince = null;
      await this.setOnline(camera, true);
      return;
    }
    const now = Date.now();
    if (now < (camera.restartUntil ?? 0)) {
      return;
    }
    camera.offlineSince ??= now;
    if (camera.online === null || now - camera.offlineSince >= this.timings.offlineAfterMs) {
      await this.setOnline(camera, false);
    }
  }

  async setOnline(camera, online, { quiet = false } = {}) {
    if (camera.online === online) {
      return;
    }
    const was = camera.online;
    camera.online = online;
    const name = deviceName(camera, this.config.language);
    if (online && was === false) {
      logger.info(`Camera ${camera.id} (${name}) receives images again`);
    } else if (!online && was === true && !quiet) {
      logger.info(`Camera ${camera.id} (${name}) receives no images any more`);
    }
    await this.publishTransports([camera]);
    this.requestWidgetRefresh();
    if (!online && was === true && !quiet && this.isCreated(camera)) {
      this.track(
        this.gladys.publishSceneEvent(TRIGGERS.OFFLINE, {
          camera: this.ids(camera).device,
          camera_name: name,
        }),
      );
    }
  }

  // --- Reading -----------------------------------------------------------------------

  /** One reading: the armed state, every camera added in Gladys, new alerts. */
  async pollAll() {
    // A slow reading is not run twice at once: the same alert would fire twice.
    if (!this.client || this.server !== 'ok' || this.pollingAll) {
      return;
    }
    this.pollingAll = true;
    try {
      await this.doPollAll();
    } finally {
      this.pollingAll = false;
    }
  }

  async doPollAll() {
    try {
      const status = await this.client.status();
      if (status.armed !== this.armed || status.recording !== this.recordingCount) {
        this.applyStatus(status);
        await this.publishServerStates();
        this.requestWidgetRefresh();
      }
    } catch (err) {
      if (err.kind === 'auth') {
        await this.serverFailed(err);
        return;
      }
      // A network error waits for the camera list, once a minute: one lost
      // answer is not an outage.
      logger.debug(`Cannot read the server status: ${err.message}`);
    }
    const cameras = this.createdCameras().filter((camera) => !camera.polling);
    for (let at = 0; at < cameras.length; at += this.timings.concurrency) {
      await Promise.all(
        cameras.slice(at, at + this.timings.concurrency).map((camera) => this.poll(camera)),
      );
    }
    await this.checkAlerts();
    for (const camera of cameras) {
      if (
        camera.enabled &&
        camera.online !== false &&
        Date.now() - camera.lastPublishAt >= this.config.snapshotSeconds * 1000
      ) {
        await this.publishImage(camera);
      }
    }
  }

  poll(camera) {
    if (!camera.polling) {
      camera.polling = this.readCamera(camera).finally(() => {
        camera.polling = null;
      });
    }
    return camera.polling;
  }

  async readCamera(camera) {
    if (!this.client || this.stopped) {
      return;
    }
    let item;
    try {
      item = await this.client.camera(camera.id);
    } catch (err) {
      if (err.kind === 'auth') {
        await this.serverFailed(err);
      } else {
        logger.debug(`Camera ${camera.id}: ${err.message}`);
      }
      return;
    }
    const before = this.statesKey(camera);
    const rising = item.enabled && item.motion && camera.motion === false;
    this.applyCamera(camera, item);
    await this.checkOnline(camera);
    if (this.statesKey(camera) !== before) {
      await this.publishStates(camera);
      this.requestWidgetRefresh();
    }
    if (rising && this.isCreated(camera)) {
      // The image of the moment first: a "Send a camera image" right after
      // the trigger sends it.
      await this.publishImage(camera, { wait: true });
      this.track(
        this.gladys.publishSceneEvent(TRIGGERS.MOTION, {
          camera: this.ids(camera).device,
          camera_name: deviceName(camera, this.config.language),
        }),
      );
    }
  }

  statesKey(camera) {
    return JSON.stringify([camera.enabled, camera.motion, camera.recording]);
  }

  /** The alerts raised since the last reading: triggers and images. */
  async checkAlerts() {
    let alerts;
    try {
      alerts = await this.client.alerts();
    } catch (err) {
      if (err.kind === 'auth') {
        await this.serverFailed(err);
      } else {
        logger.debug(`Cannot read the alerts: ${err.message}`);
      }
      return;
    }
    const newest = alerts.reduce((max, alert) => Math.max(max, alert.id), 0);
    if (this.lastAlertId === null || newest < this.lastAlertId) {
      // The first reading (what happened before is not news), or Agent DVR
      // started counting again (restarted, alerts cleared).
      this.lastAlertId = this.lastAlertId === null ? newest : 0;
      if (this.lastAlertId === newest) {
        return;
      }
    }
    const fresh = alerts.filter((alert) => alert.id > this.lastAlertId).sort((a, b) => a.id - b.id);
    this.lastAlertId = Math.max(this.lastAlertId, newest);
    const imaged = new Set();
    for (const alert of fresh) {
      const camera = alert.type === CAMERA_TYPE ? this.cameras.get(alert.cameraId) : null;
      if (!camera || !this.isCreated(camera)) {
        continue;
      }
      if (!imaged.has(camera)) {
        imaged.add(camera);
        await this.publishImage(camera, { wait: true });
      }
      this.track(
        this.gladys.publishSceneEvent(TRIGGERS.ALERT, {
          camera: this.ids(camera).device,
          camera_name: deviceName(camera, this.config.language),
          message: (alert.message || alert.reason || '-').slice(0, 100),
        }),
      );
    }
    if (imaged.size > 0) {
      this.requestWidgetRefresh();
    }
  }

  // --- Images --------------------------------------------------------------------

  /** A JPEG Gladys keeps (≤ MAX_JPEG_BYTES), at full size or smaller. */
  async grab(camera) {
    const sizes = camera.fitSize ? [camera.fitSize] : [null, ...FIT_SIZES];
    for (const size of sizes) {
      const jpeg = await this.client.image(camera.id, { size });
      if (jpeg.length <= MAX_JPEG_BYTES) {
        camera.fitSize = size;
        camera.image = { jpeg, at: Date.now() };
        camera.imageSeq += 1;
        return jpeg;
      }
    }
    camera.fitSize = null;
    throw new AgentError(`The frames of camera ${camera.id} stay over 150 KB`);
  }

  /** Send a fresh frame to Gladys, at most one every 5 s per camera. */
  async publishImage(camera, { wait = false } = {}) {
    if (!this.isCreated(camera) || !this.client) {
      return false;
    }
    const left = camera.lastPublishAt + this.timings.minImageSpacingMs - Date.now();
    if (left > 0) {
      if (!wait) {
        return false;
      }
      await sleep(left);
    }
    camera.lastPublishAt = Date.now();
    try {
      const jpeg = await this.grab(camera);
      // The DEVICE external id: the core answers 404 to a feature's.
      await this.gladys.publishCameraImage(this.ids(camera).device, toDataUri(jpeg));
      return true;
    } catch (err) {
      // 404: the camera is turned off in Gladys, or not added; 429: too many.
      logger.debug(`Image of camera ${camera.id} not sent: ${err.message}`);
      return false;
    }
  }

  /** A fresh image for Gladys (dashboard, "show me the camera"): data URI. */
  async imageFor(externalId) {
    const camera = this.require(externalId);
    try {
      return toDataUri(await this.grab(camera));
    } catch (err) {
      logger.debug(`No fresh image of camera ${camera.id}: ${err.message}`);
      if (!camera.image || Date.now() - camera.image.at > STALE_IMAGE_MS) {
        throw new Error(`Camera ${camera.id} has no image right now`, { cause: err });
      }
      return toDataUri(camera.image.jpeg);
    }
  }

  // --- Commands ------------------------------------------------------------------

  requireClient() {
    if (!this.client) {
      throw new Error('No Agent DVR address in the configuration');
    }
    return this.client;
  }

  /** The recording switch of the dashboard, or a scene's "Control a device". */
  async setValue(device, feature, value) {
    const camera = this.require(device?.external_id);
    if (featureKeyOf(feature?.external_id) !== FEATURE_KEYS.RECORDING) {
      throw new Error(`The feature ${feature?.external_id} cannot be set`);
    }
    await this.setRecording(camera, Number(value) === 1);
  }

  /** Arm or disarm Agent DVR, then read it back. */
  async setArmed(on) {
    const client = this.requireClient();
    await client.setArmed(on);
    logger.info(on ? 'Agent DVR armed' : 'Agent DVR disarmed');
    try {
      this.applyStatus(await client.status());
    } catch (err) {
      logger.debug(`Cannot read the server status: ${err.message}`);
      this.armed = on;
    }
    await this.publishServerStates();
    this.requestWidgetRefresh();
  }

  /** Start or stop a manual recording. */
  async setRecording(camera, on) {
    const client = this.requireClient();
    if (on && !camera.enabled) {
      throw new AgentError(`Camera ${camera.id} is switched off in Agent DVR`, { kind: 'off' });
    }
    await client.setRecording(camera.id, on);
    logger.info(`Recording ${on ? 'started' : 'stopped'} on camera ${camera.id}`);
    await this.settle(camera, () => camera.recording === on);
    this.requestWidgetRefresh();
  }

  /** Read a camera again until `done` holds (a command applied), or give up. */
  async settle(camera, done) {
    for (let attempt = 0; attempt < this.timings.settleTries; attempt += 1) {
      if (attempt > 0) {
        await sleep(this.timings.settleMs);
      }
      await this.poll(camera);
      if (done()) {
        return;
      }
    }
    logger.debug(`Camera ${camera.id} does not show the change yet`);
  }

  /** Switch cameras on or off; returns how many changed. */
  async setEnabled(cameras, on) {
    const client = this.requireClient();
    // Sent to every camera, even one already read in that state: a command
    // sent a moment ago may not show yet.
    const changed = cameras.filter((camera) => camera.enabled !== on);
    for (const camera of cameras) {
      await client.setEnabled(camera.id, on);
      // Agent DVR connects to the camera again: not an outage.
      camera.restartUntil = Date.now() + this.timings.restartGraceMs;
    }
    logger.info(
      `Camera ${cameras.map((camera) => camera.id).join(', ')} switched ${on ? 'on' : 'off'}`,
    );
    for (const camera of cameras) {
      await this.settle(camera, () => camera.enabled === on);
    }
    this.requestWidgetRefresh();
    return changed.length;
  }

  // --- Report --------------------------------------------------------------------

  summary() {
    if (this.server !== 'ok') {
      return { problem: this.server ?? 'unreachable' };
    }
    return {
      url: this.client.label,
      version: this.client.version,
      armed: this.armed,
      cameras: [...this.cameras.values()].map((camera) => ({
        name: deviceName(camera, this.config.language),
        enabled: camera.enabled,
        online: camera.online,
        recording: camera.recording,
      })),
    };
  }
}
