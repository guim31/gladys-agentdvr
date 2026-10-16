// -----------------------------------------------------------------------------
// What Agent DVR becomes in Gladys.
//
// One camera device per Agent DVR camera, with:
//   - its image (`camera/image`), pushed by the integration;
//   - `motion`: Agent DVR detects motion right now (`motion-sensor/binary`);
//   - `recording`: the camera records (`switch/binary`), which the dashboard
//     can start or stop: a manual recording, harmless either way;
//   - `enabled`: the camera is switched on in Agent DVR (`camera/enabled`),
//     read only: turning a surveillance camera off is a deliberate choice,
//     made by a scene action or the widget, never a toggle a voice assistant
//     flips.
// Whether frames come in is the device's transport badge (`local` /
// `unreachable`) and the "Camera offline" scene trigger, not a feature.
//
// One "Agent DVR" device for the server, with:
//   - `armed`: the system is armed (`switch/binary`), read only for the same
//     reason: disarming goes through a scene action or the widget;
//   - `recording-count`: cameras recording now (`counter-sensor/integer`).
//
// Feature keys are forever: they are part of the external ids.
// -----------------------------------------------------------------------------

export const DEVICE_TYPE = 'camera';
export const SERVER_TYPE = 'server';
// One server per integration: its device keeps this id whatever the address.
export const SERVER_ID = 'agent';

export const FEATURE_KEYS = {
  IMAGE: 'image',
  MOTION: 'motion',
  RECORDING: 'recording',
  ENABLED: 'enabled',
};

export const SERVER_KEYS = {
  ARMED: 'armed',
  RECORDING_COUNT: 'recording-count',
};

// Feature names, frozen when the user adds the device.
export const NAMES = {
  en: {
    camera: 'Camera',
    image: 'Image',
    motion: 'Motion',
    recording: 'Recording',
    enabled: 'Camera on',
    armed: 'Armed',
    recording_count: 'Cameras recording',
  },
  fr: {
    camera: 'Caméra',
    image: 'Image',
    motion: 'Mouvement',
    recording: 'Enregistrement',
    enabled: 'Caméra activée',
    armed: 'Armé',
    recording_count: 'Caméras en enregistrement',
  },
  de: {
    camera: 'Kamera',
    image: 'Bild',
    motion: 'Bewegung',
    recording: 'Aufnahme',
    enabled: 'Kamera an',
    armed: 'Scharf',
    recording_count: 'Aufnehmende Kameras',
  },
  es: {
    camera: 'Cámara',
    image: 'Imagen',
    motion: 'Movimiento',
    recording: 'Grabación',
    enabled: 'Cámara activada',
    armed: 'Armado',
    recording_count: 'Cámaras grabando',
  },
};

export const namesFor = (language) => NAMES[language] ?? NAMES.en;

/** The ids of one camera: its Agent DVR object id, unique on the server. */
export function deviceIds(gladys, cameraId) {
  return gladys.externalIds(DEVICE_TYPE, String(cameraId));
}

export function serverIds(gladys) {
  return gladys.externalIds(SERVER_TYPE, SERVER_ID);
}

/** The feature key behind a feature external id (`…:recording`). */
export function featureKeyOf(externalId) {
  return (
    String(externalId ?? '')
      .split(':')
      .pop() || null
  );
}

const binary = (key, category, name, readOnly) => ({
  key,
  category,
  type: 'binary',
  name,
  min: 0,
  max: 1,
  read_only: readOnly,
  has_feedback: true,
  keep_history: true,
});

export function featureSpecs(language) {
  const names = namesFor(language);
  return [
    {
      key: FEATURE_KEYS.IMAGE,
      category: 'camera',
      type: 'image',
      name: names.image,
      min: 0,
      max: 0,
      read_only: true,
      has_feedback: false,
      keep_history: false,
    },
    binary(FEATURE_KEYS.MOTION, 'motion-sensor', names.motion, true),
    binary(FEATURE_KEYS.RECORDING, 'switch', names.recording, false),
    {
      ...binary(FEATURE_KEYS.ENABLED, 'camera', names.enabled, true),
      type: 'enabled',
    },
  ];
}

/** The camera name in Agent DVR, or "Camera 3". */
export function deviceName(camera, language) {
  const name = String(camera.name ?? '').trim();
  return (name || `${namesFor(language).camera} ${camera.id}`).slice(0, 80);
}

export function buildDevice(gladys, camera, language) {
  const ids = deviceIds(gladys, camera.id);
  return {
    name: deviceName(camera, language),
    external_id: ids.device,
    model: 'Agent DVR',
    // The container reads the cameras at its own pace (poll interval): the
    // Gladys scheduler has no use here.
    should_poll: false,
    params: [{ name: 'AGENTDVR_CAMERA_ID', value: String(camera.id) }],
    features: featureSpecs(language).map(({ key, ...spec }) => ({
      ...spec,
      external_id: ids.feature(key),
    })),
  };
}

export function buildServerDevice(gladys, language) {
  const ids = serverIds(gladys);
  const names = namesFor(language);
  return {
    name: 'Agent DVR',
    external_id: ids.device,
    model: 'Agent DVR',
    should_poll: false,
    features: [
      { ...binary(SERVER_KEYS.ARMED, 'switch', names.armed, true) },
      {
        key: SERVER_KEYS.RECORDING_COUNT,
        category: 'counter-sensor',
        type: 'integer',
        name: names.recording_count,
        min: 0,
        max: 1000,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    ].map(({ key, ...spec }) => ({ ...spec, external_id: ids.feature(key) })),
  };
}
