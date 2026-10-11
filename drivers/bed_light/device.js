'use strict';

const Homey = require('homey');

class BedLightDevice extends Homey.Device {
  async onInit() {
    // MAC-en knytter lyset til sengen. Enhetens egen id er «<mac>-light», men
    // store er det sengen selv bruker, så oppslaget blir identisk.
    this._mac = String(this.getStoreValue('mac') || '').toUpperCase();

    this.registerCapabilityListener('onoff', (value) => this.setLight(value));

    const bed = this._bed();
    if (bed) {
      // Sengen rapporterer ikke lysstatus, og knappen er ikke lesbar. Dette er
      // siste kommanderte tilstand, samme kilde som Flow-betingelsen bruker.
      await this.setCapabilityValue('onoff', Boolean(bed.lightIsOn())).catch(() => {});
      await this.setAvailable().catch(() => {});
      this.log(`Sengelys klar — følger ${bed.getName()} (${this._mac})`);
    } else {
      // Sengen kan være slettet mens lysenheten står igjen. Da er bryteren her
      // bare pynt, og det skal den si i stedet for å feile ved hvert trykk.
      await this.bedGone();
    }
  }

  // Sengen som eier lyset. Slås opp ved behov i stedet for å holdes i en
  // referanse: enheten kan bli slettet og paret på nytt mens denne lever.
  _bed() {
    try {
      return this.homey.drivers.getDriver('bed').getDevices().find((device) =>
        String(device.getStoreValue('mac') || device.getData().id).toUpperCase() === this._mac) || null;
    } catch (error) {
      return null;
    }
  }

  async setLight(on) {
    const bed = this._bed();
    if (!bed) {
      await this.bedGone();
      throw new Error('The bed this light belongs to is no longer paired.');
    }

    // Hele BLE-jobben gjøres av sengen: kø, dveling, bonding og gjenoppkobling
    // ligger der. Dette er en ren videresending, med vilje.
    await bed.setLight(Boolean(on));
    await this.setAvailable().catch(() => {});
    return true;
  }

  // Kalles fra sengen når lyset settes et annet sted: sengens egen knapp, et
  // Flow-kort eller «Begge senger». Uten dette ville bryteren her stått og
  // løyet, og det samme ville Google Home gjort.
  async syncFromBed(on) {
    await this.setCapabilityValue('onoff', Boolean(on)).catch(() => {});
  }

  async bedGone() {
    const message = this.homey.i18n.getLanguage() === 'no'
      ? 'Sengen dette lyset hører til er ikke paret lenger.'
      : 'The bed this light belongs to is no longer paired.';
    await this.setUnavailable(message).catch(() => {});
  }
}

module.exports = BedLightDevice;
