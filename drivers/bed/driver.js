'use strict';

const Homey = require('homey');
const { isLinakBed } = require('../../lib/linak-bed-protocol');
const {
  SETTING_HOST, isValidHost, resolveProxyConfig,
} = require('../../lib/proxy-config');

class BedDriver extends Homey.Driver {
  // Proxy-adressen hentes inn i paringen i stedet for å ligge gjemt i
  // appinnstillingene. Den er appomfattende, så den lagres samme sted som før —
  // paringen er bare det første stedet brukeren får sjansen til å sette den.
  async onPair(session) {
    session.setHandler('proxy_get', () => resolveProxyConfig(this.homey.settings).host);

    session.setHandler('proxy_test', async (host) => {
      if (!isValidHost(host)) throw new Error('Adressen ser ikke gyldig ut.');
      // Samme sti som «Test tilkobling» i appinnstillingene, så en seng som
      // pares aldri møter en proxy innstillingene ville avvist.
      return this.homey.app.testProxyConnection(host.trim());
    });

    session.setHandler('proxy_save', async (host) => {
      if (!isValidHost(host)) throw new Error('Adressen ser ikke gyldig ut.');
      await this.homey.settings.set(SETTING_HOST, host.trim());
      return true;
    });
  }

  async onPairListDevices() {
    const proxy = this.homey.app.getProxy();
    const advertisements = await proxy.discover({ durationMs: 12000 });
    const beds = advertisements.filter(isLinakBed);

    this.log(
      `BLE-skann ga ${advertisements.length} annonsering(er); `
      + `fant ${beds.length} LINAK-seng(er)`,
    );

    for (const bed of beds) {
      this.log('Sengekandidat', { navn: bed.localName, mac: bed.mac, rssi: bed.rssi });
    }

    return beds.map((bed) => ({
      name: bed.localName || `LINAK-seng ${bed.mac.slice(-5).replace(':', '')}`,
      data: {
        id: bed.mac,
      },
      store: {
        mac: bed.mac,
        // Lagres fra annonseringen. Adressetypen kan ikke utledes pålitelig
        // fra MAC-en, og feil type gir error=256 ved tilkobling.
        addressType: bed.addressType,
      },
      settings: {
        macAddress: bed.mac,
        advertisedName: bed.localName || '',
      },
    }));
  }
}

module.exports = BedDriver;
