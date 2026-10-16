'use strict';

// Hvor ESPHome BLE-proxyen finnes.
//
// env.json leveres ikke på Homey Pro (kommer stille tomt via `app run --remote`),
// så verdien kommer fra appinnstillingene med en fallback her i lib/.

const SETTING_HOST = 'proxyHost';
const SETTING_PORT = 'proxyPort';
// Krypteringsnøkkelen fra `api: encryption: key:` i ESPHome-konfigurasjonen.
// Tom betyr ukryptert API, som er det nettinstallasjonen vår setter opp. Nye
// ESPHome-oppsett lager en nøkkel av seg selv, og en proxy brukeren allerede
// har til noe annet har den nesten alltid på.
const SETTING_KEY = 'proxyKey';

// Ingen standardvert. Adressen er alltid brukerens egen ESP32, og en innebygd
// IP her ville pekt hver installasjon mot en tilfeldig maskin på brukerens eget
// nett (den var utviklerens egen proxy). Uten lagret adresse skal appen si
// tydelig fra i stedet for å skrive i blinde.
const DEFAULT_HOST = '';
const DEFAULT_PORT = 6053;

const isValidHost = (value) => {
  if (typeof value !== 'string') return false;
  const host = value.trim();
  if (!host || host.length > 253) return false;
  return /^[a-zA-Z0-9._-]+$/.test(host);
};

const isValidPort = (value) => Number.isInteger(value) && value > 0 && value <= 65535;

// Nøkkelen er 32 byte base64. Tom er gyldig: det betyr ukryptert.
const isValidKey = (value) => {
  if (value === null || value === undefined || value === '') return true;
  if (typeof value !== 'string') return false;
  const text = value.trim().replace(/^["']|["']$/g, '');
  if (!text) return true;
  if (!/^[A-Za-z0-9+/]{43}=$/.test(text)) return false;
  return Buffer.from(text, 'base64').length === 32;
};

const cleanKey = (value) => String(value || '').trim().replace(/^["']|["']$/g, '');

function resolveProxyConfig(settings) {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let key = '';
  let source = 'unset';

  if (settings && typeof settings.get === 'function') {
    const storedHost = settings.get(SETTING_HOST);
    if (isValidHost(storedHost)) {
      host = storedHost.trim();
      source = 'settings';
    }

    const storedPort = Number(settings.get(SETTING_PORT));
    if (isValidPort(storedPort)) port = storedPort;

    const storedKey = cleanKey(settings.get(SETTING_KEY));
    if (isValidKey(storedKey)) key = storedKey;
  }

  return { host, port, key, source };
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  SETTING_HOST,
  SETTING_PORT,
  SETTING_KEY,
  cleanKey,
  isValidHost,
  isValidKey,
  isValidPort,
  resolveProxyConfig,
};
