'use strict';

const Homey = require('homey');

// Undersengslyset som EGEN enhet, med Homeys standard onoff.
//
// Grunnen er stemmestyring. Sengens egne kapabiliteter (linak_bed_*) er
// usynlige for Google Home og Alexa: bare Homeys standardkapabiliteter er
// koblet til deres traits, og en egendefinert knapp har ingen trait å være.
// Lyset er den eneste funksjonen på sengen med ren av/på-semantikk, og dermed
// den eneste som kan mappes ærlig. Motorene krever gjentatte pulser og har
// ingen lesbar posisjon i det hele tatt (målt, se tools/read-status.js), så de
// kan ikke uttrykkes som en dimmer eller en rullegardin uten å lyve.
//
// Enheten har ingen egen radio. Den styrer sengen som alt er paret, akkurat
// som «Begge senger», så paringen her oppretter bare enheten.
class BedLightDriver extends Homey.Driver {
  async onPair(session) {
    // Se kommentaren i bed/driver.js: malen kaller ikke onPairListDevices selv
    // i alle tilfeller, og en eksplisitt lytter koster ingenting.
    session.setHandler('list_devices', () => this.onPairListDevices());
  }

  async onPairListDevices() {
    // Navnet settes direkte i stedet for via homey.__ — appen har ingen
    // locales-mappe, og oversetteren ville returnert selve nøkkelen.
    const norwegian = this.homey.i18n.getLanguage() === 'no';

    let beds = [];
    try {
      beds = this.homey.drivers.getDriver('bed').getDevices();
    } catch (error) {
      this.error('Fant ikke sengedriveren', error.message);
    }

    // Én lysenhet per seng. Uten denne lukingen ville sengene dukket opp på
    // nytt hver gang, og en duplikat ville styrt samme lys som den første.
    const taken = new Set(this.getDevices().map((device) => String(device.getData().id)));

    const candidates = beds.map((bed) => {
      const mac = String(bed.getStoreValue('mac') || bed.getData().id).toUpperCase();
      return { bed, mac, id: `${mac}-light` };
    }).filter(({ id }) => !taken.has(id));

    this.log(`${beds.length} seng(er) paret, ${candidates.length} uten lysenhet`);

    return candidates.map(({ bed, mac, id }) => ({
      name: `${bed.getName()} ${norwegian ? 'lys' : 'light'}`,
      data: { id },
      store: { mac },
    }));
  }
}

module.exports = BedLightDriver;
