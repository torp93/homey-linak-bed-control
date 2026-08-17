'use strict';

const Homey = require('homey');
const { migrateCapabilities } = require('../../lib/capability-migration');

// Speiler knappene på en enkelt seng, men sender til alle parede senger.
const MOTOR_CAPABILITIES = Object.freeze({
  linak_bed_both_up: 'bothUp',
  linak_bed_both_down: 'bothDown',
  linak_bed_sit_up: 'sitUp',
  linak_bed_leg_relief: 'legRelief',
  linak_bed_back_up: 'backUp',
  linak_bed_back_down: 'backDown',
  linak_bed_leg_up: 'legUp',
  linak_bed_leg_down: 'legDown',
});

// Samme rekkefølge som på en enkelt seng, men uten signalstyrke — gruppa har
// ingen egen radio, og et snitt av to senger ville vært misvisende.
const REQUIRED_CAPABILITIES = Object.freeze([
  'linak_bed_back_up',
  'linak_bed_back_down',
  'linak_bed_leg_up',
  'linak_bed_leg_down',
  'linak_bed_light',
  'linak_bed_stop',
  'linak_bed_both_up',
  'linak_bed_both_down',
  'linak_bed_sit_up',
  'linak_bed_leg_relief',
  'linak_bed_connection',
]);

class AllBedsDevice extends Homey.Device {
  async onInit() {
    await migrateCapabilities(this, REQUIRED_CAPABILITIES);

    for (const capability of Object.keys(MOTOR_CAPABILITIES)) {
      // pressMotor løses ved bevegelsesSTART — se bed/device.js. Uten den
      // ville gruppeknappen hengt til begge sengene var ferdige (opptil 45 s).
      this.registerCapabilityListener(capability, () =>
        this.runOnAll((bed) => bed.pressMotor(MOTOR_CAPABILITIES[capability])));
    }

    this.registerCapabilityListener('linak_bed_stop', () =>
      this.runOnAll((bed) => bed.stopMovement()));

    // Veksler på gruppens egen huskede tilstand, så begge sengene alltid
    // settes LIKT — også om de skulle stå ulikt fra før.
    this.registerCapabilityListener('linak_bed_light', async () => {
      const next = !this.getStoreValue('lightOn');
      await this.runOnAll((bed) => bed.setLight(next));
      await this.setStoreValue('lightOn', next).catch(() => {});
    });

    await this._setConnection('idle');
    this.log('Begge senger klar');
  }

  _beds() {
    return this.homey.drivers.getDriver('bed').getDevices();
  }

  async _setConnection(state) {
    if (!this.hasCapability('linak_bed_connection')) return;
    await this.setCapabilityValue('linak_bed_connection', state).catch(() => {});
  }

  // Kjører på alle senger SAMTIDIG. Køen i BedProxy er per seng, så to senger
  // deler ikke kø — de bruker hver sin tilkoblingsplass på proxyen.
  //
  // Én seng som feiler skal ikke stoppe den andre, så vi samler resultatene
  // i stedet for å la første avvisning rive hele kallet.
  async runOnAll(action) {
    const beds = this._beds();
    // Engelsk: feilen vises for brukeren i Flow-kort og på knappen, og engelsk
    // er appens grunnspråk. Logglinjene under er interne og forblir norske.
    if (!beds.length) throw new Error('No beds have been added yet');

    // Gruppa påstår ikke 'moving': pressMotor løses ved bevegelsesSTART, så
    // gruppa vet ikke når sengene faktisk er ferdige. Sengene viser sin egen
    // tilstand; gruppa viser bare feil.
    const results = await Promise.allSettled(beds.map((bed) => action(bed)));

    const failed = results
      .map((result, index) => ({ result, bed: beds[index] }))
      .filter(({ result }) => result.status === 'rejected');

    if (failed.length === beds.length) {
      await this._setConnection('error');
      throw failed[0].result.reason;
    }

    if (failed.length) {
      await this._setConnection('error');
      for (const { result, bed } of failed) {
        this.error(`${bed.getName()} feilet`, result.reason && result.reason.message);
      }
      // Delvis suksess er ikke en feil for brukeren — den andre sengen gikk.
      this.log(`${beds.length - failed.length} av ${beds.length} senger utført`);
    } else {
      await this._setConnection('idle');
    }

    return true;
  }

  // --- Flow ---------------------------------------------------------------
  // Flow-kortene kaller de samme metodene på gruppa som på en enkelt seng, så
  // kortene kan filtreres på begge driverne uten at app.js trenger å vite
  // hvilken av dem den snakker med.

  // Med varighet, i motsetning til knappene: et Flow-steg skal være ferdig når
  // bevegelsen er ferdig, ellers går neste steg i gang mens sengen står midt i.
  // Derfor runMotor og ikke pressMotor her.
  async runMotor(command, durationSeconds, extraOptions = {}) {
    return this.runOnAll((bed) => bed.runMotor(command, durationSeconds, extraOptions));
  }

  async stopMovement() {
    return this.runOnAll((bed) => bed.stopMovement());
  }

  async setLight(on) {
    await this.runOnAll((bed) => bed.setLight(on));
    await this.setStoreValue('lightOn', on).catch(() => {});
    return true;
  }

  // Gruppas egen huskede tilstand, satt av både knappen og Flow-kortet. Å
  // spørre sengene ville gitt et vilkårlig svar når de står ulikt.
  lightIsOn() {
    return this.getStoreValue('lightOn') === true;
  }
}

module.exports = AllBedsDevice;
