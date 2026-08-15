'use strict';

const { EsphomeApiClient } = require('./lib/esphome-api');
const { isValidHost, isValidPort } = require('./lib/proxy-config');

module.exports = {
  // Brukes av innstillingssiden for å bekrefte adressen før den lagres.
  // Kobler til, henter enhetsinfo og kobler ned igjen — ingen BLE involvert.
  async testProxy({ homey, query }) {
    const host = String(query.host || '').trim();
    const port = Number(query.port || 6053);

    if (!isValidHost(host)) throw new Error('Ugyldig adresse');
    if (!isValidPort(port)) throw new Error('Ugyldig port');

    const client = new EsphomeApiClient({
      host,
      port,
      clientInfo: 'homey-linak-bed-test',
      log: (...args) => homey.app.log('[test]', ...args),
    });

    // En 'error' uten lytter kaster og tar ned hele appen — og en test mot en
    // proxy som er nede er nettopp situasjonen der socketfeil oppstår. Feilen
    // rapporteres uansett via connect()-avvisningen under.
    client.on('error', () => {});

    try {
      await client.connect({ timeoutMs: 8000 });
      const info = await client.deviceInfo();
      return {
        name: info.friendlyName || info.name,
        esphomeVersion: info.esphomeVersion,
        model: info.model,
        macAddress: info.macAddress,
        // Uten bluetooth_proxy i konfigurasjonen er noden ubrukelig for oss,
        // og feilen ville ellers først dukket opp under paring.
        bluetoothProxy: info.bluetoothProxyFeatureFlags > 0,
      };
    } finally {
      await client.close().catch(() => {});
    }
  },
};
