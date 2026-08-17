'use strict';

// Hvor ESPHome BLE-proxyen finnes.
//
// env.json leveres ikke på Homey Pro (kommer stille tomt via `app run --remote`),
// så verdien kommer fra appinnstillingene med en fallback her i lib/.

const SETTING_HOST = 'proxyHost';
const SETTING_PORT = 'proxyPort';

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

function resolveProxyConfig(settings) {
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  let source = 'unset';

  if (settings && typeof settings.get === 'function') {
    const storedHost = settings.get(SETTING_HOST);
    if (isValidHost(storedHost)) {
      host = storedHost.trim();
      source = 'settings';
    }

    const storedPort = Number(settings.get(SETTING_PORT));
    if (isValidPort(storedPort)) port = storedPort;
  }

  return { host, port, source };
}

module.exports = {
  DEFAULT_HOST,
  DEFAULT_PORT,
  SETTING_HOST,
  SETTING_PORT,
  isValidHost,
  isValidPort,
  resolveProxyConfig,
};
