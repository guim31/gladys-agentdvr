// -----------------------------------------------------------------------------
// Texts the integration sends to Gladys outside the widget (src/widgets.js):
// connection status and the "Check the connection" report. Four languages,
// the four of the Gladys interface; German says "du", Spanish "usted".
// test/i18n.test.js checks every table.
// -----------------------------------------------------------------------------

export const INIT_FAILED = {
  en: 'Initialization failed, check the integration logs.',
  fr: "L'initialisation a échoué, consultez les logs de l'intégration.",
  de: 'Initialisierung fehlgeschlagen, sieh dir die Protokolle der Integration an.',
  es: 'La inicialización ha fallado, consulte los registros de la integración.',
};

// Shown by Gladys under the integration name when it is not connected.
export const CONNECTION_TEXT = {
  noUrl: {
    en: 'Enter the address of Agent DVR (e.g. 192.168.1.20, port 8090 by default) in the configuration.',
    fr: "Saisissez l'adresse d'Agent DVR (ex. 192.168.1.20, port 8090 par défaut) dans la configuration.",
    de: 'Gib die Adresse von Agent DVR (z. B. 192.168.1.20, standardmäßig Port 8090) in der Konfiguration ein.',
    es: 'Introduzca la dirección de Agent DVR (p. ej. 192.168.1.20, puerto 8090 por defecto) en la configuración.',
  },
  auth: {
    en: 'Agent DVR refuses the user name or password.',
    fr: "Agent DVR refuse l'identifiant ou le mot de passe.",
    de: 'Agent DVR lehnt Benutzername oder Passwort ab.',
    es: 'Agent DVR rechaza el usuario o la contraseña.',
  },
  unreachable: {
    en: 'Agent DVR does not answer at this address.',
    fr: 'Agent DVR ne répond pas à cette adresse.',
    de: 'Agent DVR antwortet unter dieser Adresse nicht.',
    es: 'Agent DVR no responde en esta dirección.',
  },
  error: {
    en: 'Something answers, but not like Agent DVR: check the address and port, and the logs.',
    fr: "Quelque chose répond, mais pas comme Agent DVR : vérifiez l'adresse, le port et les logs.",
    de: 'Etwas antwortet, aber nicht wie Agent DVR: Prüfe Adresse, Port und die Protokolle.',
    es: 'Algo responde, pero no como Agent DVR: compruebe la dirección, el puerto y los registros.',
  },
};

const MAX_LISTED = 10;

// The pieces of the "Check the connection" report, one table per language.
export const CHECK_TEXT = {
  en: {
    connected: (url, version, count) =>
      `Agent DVR ${version ?? ''} answers at ${url}: ${count} camera(s).`,
    armed: 'System armed.',
    disarmed: 'System disarmed.',
    online: 'receives images',
    offline: 'no images',
    disabled: 'switched off in Agent DVR',
    recording: 'recording',
  },
  fr: {
    connected: (url, version, count) =>
      `Agent DVR ${version ?? ''} répond à ${url} : ${count} caméra(s).`,
    armed: 'Système armé.',
    disarmed: 'Système désarmé.',
    online: 'reçoit des images',
    offline: "pas d'images",
    disabled: 'désactivée dans Agent DVR',
    recording: 'enregistre',
  },
  de: {
    connected: (url, version, count) =>
      `Agent DVR ${version ?? ''} antwortet unter ${url}: ${count} Kamera(s).`,
    armed: 'System scharf.',
    disarmed: 'System unscharf.',
    online: 'empfängt Bilder',
    offline: 'keine Bilder',
    disabled: 'in Agent DVR ausgeschaltet',
    recording: 'nimmt auf',
  },
  es: {
    connected: (url, version, count) =>
      `Agent DVR ${version ?? ''} responde en ${url}: ${count} cámara(s).`,
    armed: 'Sistema armado.',
    disarmed: 'Sistema desarmado.',
    online: 'recibe imágenes',
    offline: 'sin imágenes',
    disabled: 'desactivada en Agent DVR',
    recording: 'grabando',
  },
};

/** The report of the "Check the connection" action, in the four languages. */
export function checkMessage(summary) {
  if (summary.problem) {
    return CONNECTION_TEXT[summary.problem];
  }
  const message = {};
  for (const [language, text] of Object.entries(CHECK_TEXT)) {
    const lines = [
      `${text.connected(summary.url, summary.version, summary.cameras.length).replace(/ {2}/, ' ')} ${
        summary.armed ? text.armed : text.disarmed
      }`,
    ];
    for (const camera of summary.cameras.slice(0, MAX_LISTED)) {
      const flags = [
        !camera.enabled
          ? text.disabled
          : camera.online === false
            ? text.offline
            : camera.online === true
              ? text.online
              : null,
        camera.recording ? text.recording : null,
      ].filter(Boolean);
      lines.push(flags.length > 0 ? `- ${camera.name}: ${flags.join(', ')}` : `- ${camera.name}`);
    }
    if (summary.cameras.length > MAX_LISTED) {
      lines.push('…');
    }
    message[language] = lines.join('\n');
  }
  return message;
}
