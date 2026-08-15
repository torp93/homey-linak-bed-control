'use strict';

const Homey = require('homey');
const { isLinakBed } = require('../../lib/linak-bed-protocol');

class BedDriver extends Homey.Driver {
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
