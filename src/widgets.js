// -----------------------------------------------------------------------------
// Dashboard widget (manifest `widgets`, Gladys 5.1+): `camera`.
//
// The Gladys camera box shows the image only. This widget adds what Agent DVR
// knows: motion, recording, whether the system is armed, and buttons to start
// or stop a recording, arm or disarm, switch a camera back on and bring a new
// image.
//
// Budget (8 components, 2 texts, 4 buttons): a caption, the image, one status
// list, three buttons.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';
import { deviceName, namesFor } from './devices.js';
import { WIDGET_KEY } from './hub.js';

// Numbered: the core drops a button whose action key is already taken.
export const ACTIONS = {
  RECORD: 'record_start_1',
  STOP: 'record_stop_1',
  SWITCH_ON: 'switch_on_1',
  ARM: 'arm_1',
  DISARM: 'disarm_1',
  REFRESH: 'refresh_1',
};
// How long `get` waits for a first image before showing the caption alone.
const FIRST_IMAGE_WAIT_MS = 8000;

export const TEXT = {
  pick: {
    en: 'Choose a camera in the settings of this widget.',
    fr: 'Choisissez une caméra dans les réglages de ce widget.',
    de: 'Wähle in den Einstellungen dieses Widgets eine Kamera aus.',
    es: 'Elija una cámara en la configuración de este widget.',
  },
  unknown: {
    en: 'This camera is no longer in Agent DVR, or Agent DVR does not answer.',
    fr: 'Cette caméra n’est plus dans Agent DVR, ou Agent DVR ne répond pas.',
    de: 'Diese Kamera ist nicht mehr in Agent DVR, oder Agent DVR antwortet nicht.',
    es: 'Esta cámara ya no está en Agent DVR, o Agent DVR no responde.',
  },
  imageAt: { en: 'Image', fr: 'Image', de: 'Bild', es: 'Imagen' },
  noImage: {
    en: 'No image yet',
    fr: 'Pas encore d’image',
    de: 'Noch kein Bild',
    es: 'Aún no hay imagen',
  },
  offline: { en: 'no images', fr: 'pas d’images', de: 'keine Bilder', es: 'sin imágenes' },
  disabled: { en: 'camera off', fr: 'caméra désactivée', de: 'Kamera aus', es: 'cámara apagada' },
  yes: { en: 'Yes', fr: 'Oui', de: 'Ja', es: 'Sí' },
  no: { en: 'No', fr: 'Non', de: 'Nein', es: 'No' },
  detected: { en: 'Detected', fr: 'Détecté', de: 'Erkannt', es: 'Detectado' },
  none: { en: 'None', fr: 'Aucun', de: 'Keine', es: 'Ninguno' },
  record: {
    en: 'Record',
    fr: 'Enregistrer',
    de: 'Aufnehmen',
    es: 'Grabar',
  },
  stop: {
    en: 'Stop recording',
    fr: 'Arrêter l’enregistrement',
    de: 'Aufnahme beenden',
    es: 'Detener la grabación',
  },
  switchOn: {
    en: 'Switch the camera on',
    fr: 'Activer la caméra',
    de: 'Kamera einschalten',
    es: 'Activar la cámara',
  },
  arm: { en: 'Arm', fr: 'Armer', de: 'Scharf schalten', es: 'Armar' },
  disarm: { en: 'Disarm', fr: 'Désarmer', de: 'Unscharf schalten', es: 'Desarmar' },
  refresh: { en: 'New image', fr: 'Nouvelle image', de: 'Neues Bild', es: 'Nueva imagen' },
  recordingStarted: {
    en: 'Recording started',
    fr: 'Enregistrement démarré',
    de: 'Aufnahme gestartet',
    es: 'Grabación iniciada',
  },
  recordingStopped: {
    en: 'Recording stopped',
    fr: 'Enregistrement arrêté',
    de: 'Aufnahme beendet',
    es: 'Grabación detenida',
  },
  switchedOn: {
    en: 'Camera switched on',
    fr: 'Caméra activée',
    de: 'Kamera eingeschaltet',
    es: 'Cámara activada',
  },
  armed: {
    en: 'Agent DVR armed: alerts are on',
    fr: 'Agent DVR armé : les alertes sont actives',
    de: 'Agent DVR scharf: Alarme sind aktiv',
    es: 'Agent DVR armado: las alertas están activas',
  },
  disarmed: {
    en: 'Agent DVR disarmed: no more alerts',
    fr: 'Agent DVR désarmé : plus d’alertes',
    de: 'Agent DVR unscharf: keine Alarme mehr',
    es: 'Agent DVR desarmado: no hay más alertas',
  },
  cameraOff: {
    en: 'This camera is switched off in Agent DVR: switch it on first.',
    fr: 'Cette caméra est désactivée dans Agent DVR : activez-la d’abord.',
    de: 'Diese Kamera ist in Agent DVR ausgeschaltet: Schalte sie zuerst ein.',
    es: 'Esta cámara está desactivada en Agent DVR: actívela primero.',
  },
};

const t = (text, language) => text[language] ?? text.en;

export const imageKey = (camera) => `cam-${camera.id}-${camera.imageSeq.toString(36)}`;

function message(text, language) {
  return {
    ttl_seconds: 60,
    components: [{ type: 'text', variant: 'body', text: t(text, language) }],
  };
}

function timeOf(at, language) {
  return new Intl.DateTimeFormat(language, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(at));
}

const button = (label, icon, key) => ({
  type: 'button',
  label,
  icon,
  style: 'secondary',
  action: { key },
});

async function get(hub, { settings, language = 'en' }) {
  const camera = settings?.camera ? hub.resolveDevice(settings.camera) : null;
  if (!camera) {
    // The server device is in the device list too: not a camera.
    const unknown = settings?.camera && settings.camera !== hub.serverIds.device;
    return message(unknown ? TEXT.unknown : TEXT.pick, language);
  }
  if (!camera.image && camera.online !== false && hub.client && hub.server === 'ok') {
    // The first look at this camera: wait a little for an image.
    await Promise.race([
      hub.grab(camera).catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, FIRST_IMAGE_WAIT_MS).unref?.()),
    ]);
  }
  const names = namesFor(language);
  const caption = [
    camera.image
      ? `${t(TEXT.imageAt, language)} ${timeOf(camera.image.at, language)}`
      : t(TEXT.noImage, language),
  ];
  if (!camera.enabled) {
    caption.push(t(TEXT.disabled, language));
  } else if (camera.online === false) {
    caption.push(t(TEXT.offline, language));
  }
  const components = [{ type: 'text', variant: 'caption', text: caption.join(' · ') }];
  if (camera.image) {
    components.push({
      type: 'image',
      key: imageKey(camera),
      alt: deviceName(camera, language),
      fit: 'contain',
    });
  }
  components.push({
    type: 'status',
    items: [
      {
        label: names.motion,
        icon: 'eye',
        value: t(camera.motion ? TEXT.detected : TEXT.none, language),
        color: camera.motion ? WIDGET_COLORS.WARNING : WIDGET_COLORS.NEUTRAL,
      },
      {
        label: names.recording,
        icon: 'video',
        value: t(camera.recording ? TEXT.yes : TEXT.no, language),
        color: camera.recording ? WIDGET_COLORS.DANGER : WIDGET_COLORS.NEUTRAL,
      },
      {
        label: names.armed,
        icon: 'shield',
        value: hub.armed === null ? '-' : t(hub.armed ? TEXT.yes : TEXT.no, language),
        color: hub.armed ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.NEUTRAL,
      },
    ],
  });
  if (!camera.enabled) {
    components.push(button(t(TEXT.switchOn, language), 'power', ACTIONS.SWITCH_ON));
  } else if (camera.recording) {
    components.push(button(t(TEXT.stop, language), 'square', ACTIONS.STOP));
  } else {
    components.push(button(t(TEXT.record, language), 'circle', ACTIONS.RECORD));
  }
  if (hub.armed !== null) {
    components.push(
      hub.armed
        ? button(t(TEXT.disarm, language), 'shield-off', ACTIONS.DISARM)
        : button(t(TEXT.arm, language), 'shield', ACTIONS.ARM),
    );
  }
  components.push(button(t(TEXT.refresh, language), 'refresh-cw', ACTIONS.REFRESH));
  return {
    ttl_seconds: Math.min(Math.max(hub.config.snapshotSeconds, 10), 300),
    components,
  };
}

async function action(hub, { actionKey, settings }) {
  if (!settings?.camera) {
    throw new Error(TEXT.pick.en);
  }
  const camera = hub.require(settings.camera);
  switch (actionKey) {
    case ACTIONS.REFRESH:
      if (!camera.enabled) {
        // Agent DVR would send a stand-in picture, not the camera's.
        return { message: TEXT.cameraOff };
      }
      await hub.grab(camera);
      return {};
    case ACTIONS.RECORD:
    case ACTIONS.STOP: {
      const on = actionKey === ACTIONS.RECORD;
      try {
        await hub.setRecording(camera, on);
      } catch (err) {
        if (err.kind === 'off') {
          return { message: TEXT.cameraOff };
        }
        throw err;
      }
      return { message: on ? TEXT.recordingStarted : TEXT.recordingStopped };
    }
    case ACTIONS.SWITCH_ON:
      await hub.setEnabled([camera], true);
      return { message: TEXT.switchedOn };
    case ACTIONS.ARM:
    case ACTIONS.DISARM: {
      const on = actionKey === ACTIONS.ARM;
      await hub.setArmed(on);
      return { message: on ? TEXT.armed : TEXT.disarmed };
    }
    default:
      throw new Error(`Unknown action ${actionKey}`);
  }
}

/** The bytes behind an image key of the widget (raw base64). */
export async function widgetImage(hub, key) {
  const match = /^cam-(\d+)-[0-9a-z]+$/.exec(String(key));
  const camera = match ? hub.cameras.get(Number(match[1])) : null;
  if (!camera?.image) {
    throw new Error(`Unknown image ${key}`);
  }
  // Already fit for Gladys (150 KB), well under the 300 KB of a widget image.
  return camera.image.jpeg.toString('base64');
}

export const WIDGETS = {
  [WIDGET_KEY]: { get, action },
};
