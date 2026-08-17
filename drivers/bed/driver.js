'use strict';

const Homey = require('homey');
const { isLinakBed } = require('../../lib/linak-bed-protocol');
const {
  SETTING_HOST, SETTING_PORT, isValidHost, isValidPort, resolveProxyConfig,
} = require('../../lib/proxy-config');

class BedDriver extends Homey.Driver {
  // Proxy-adressen hentes inn i paringen i stedet for å ligge gjemt i
  // appinnstillingene. Den er appomfattende, så den lagres samme sted som før —
  // paringen er bare det første stedet brukeren får sjansen til å sette den.
  async onPair(session) {
    session.setHandler('getProxy', () => {
      const { host, port } = resolveProxyConfig(this.homey.settings);
      return { host: host || '', port };
    });

    session.setHandler('testProxy', ({ host, port }) =>
      this.homey.app.testProxyConnection(host, port));

    session.setHandler('saveProxy', async ({ host, port }) => {
      const address = String(host || '').trim();
      const number = Number(port);
      // Engelsk: vises ordrett i paringsvisningen, og engelsk er grunnspråket.
      if (!isValidHost(address)) throw new Error('That address does not look valid.');
      if (!isValidPort(number)) throw new Error('That port does not look valid.');
      // Å skrive disse to innstillingene får app.js til å kaste den bufrede
      // klienten, så skanningen som følger går til adressen som nettopp ble satt.
      await this.homey.settings.set(SETTING_HOST, address);
      await this.homey.settings.set(SETTING_PORT, number);
      this.log('Proxy-adresse satt under paring', { host: address, port: number });
      return true;
    });

    // MÅ registreres eksplisitt. Malene kaller ikke onPairListDevices av seg
    // selv når man kommer til dem fra en egen visning — de viser bare en tom
    // liste, uten feil noe sted.
    session.setHandler('list_devices', () => this.onPairListDevices());

    // Søkevisningen trenger mer enn lista: den må kunne skille «fant ingen
    // seng» fra «fant sengen, men den er lagt til fra før». Malen viser samme
    // tomme skjerm i begge tilfeller, og de krever helt ulik handling av
    // brukeren — ta strømbruddet på nytt, kontra ingenting.
    session.setHandler('search_beds', async () => {
      const devices = await this.onPairListDevices();
      return { devices, seen: this._lastSeen, known: this._lastKnown };
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

    // Allerede parede senger må lukes ut her. list_devices-malen gjorde dette
    // for oss, men paringen bruker en egen visning som kaller createDevice
    // direkte — uten dette ville sengene dine dukket opp på nytt hver gang, og
    // et trykk ville laget en duplikat av en enhet som allerede virker.
    const known = new Set(this.getDevices()
      .map((device) => String(device.getData().id).toUpperCase()));

    const fresh = beds.filter((bed) => !known.has(bed.mac.toUpperCase()));

    if (fresh.length !== beds.length) {
      this.log(`${beds.length - fresh.length} seng(er) er lagt til fra før — utelatt`);
    }

    // Tallene søkevisningen bruker for å forklare en tom liste.
    this._lastSeen = beds.length;
    this._lastKnown = beds.length - fresh.length;

    return fresh.map((bed) => ({
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
