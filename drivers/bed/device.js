'use strict';

const Homey = require('homey');
const { migrateCapabilities } = require('../../lib/capability-migration');

// Homey har ingen «hold inne»-hendelse — en knapp gir ett trykk, uten noe
// signal om at brukeren slapp. Derfor kjører knappene til stopp trykkes,
// i stedet for en fast varighet.
const MOTOR_CAPABILITIES = Object.freeze({
  linak_bed_leg_up: 'legUp',
  linak_bed_leg_down: 'legDown',
  linak_bed_back_up: 'backUp',
  linak_bed_back_down: 'backDown',
  linak_bed_both_up: 'bothUp',
  linak_bed_both_down: 'bothDown',
  linak_bed_sit_up: 'sitUp',
  linak_bed_leg_relief: 'legRelief',
});

// Knappene kjører til brukeren trykker stopp. Grensen er et sikkerhetsnett,
// ikke en normal kjøretid — den slår bare inn hvis stoppen aldri kommer.
const DEFAULT_MAX_RUN_SECONDS = 45;

// Rekkefølgen her er den enheten skal ende opp med i appen.
const REQUIRED_CAPABILITIES = Object.freeze([
  'linak_bed_back_up',
  'linak_bed_back_down',
  'linak_bed_leg_up',
  'linak_bed_leg_down',
  'linak_bed_light',
  'linak_bed_stop',
  'linak_bed_sit_up',
  'linak_bed_leg_relief',
  'linak_bed_both_up',
  'linak_bed_both_down',
  'linak_bed_connection',
  'measure_signal_strength',
]);

class BedDevice extends Homey.Device {
  async onInit() {
    this._mac = this.getStoreValue('mac') || this.getData().id;
    this._addressType = this.getStoreValue('addressType');
    if (this._addressType === undefined) this._addressType = null;

    // GATT-handles lagret etter første tjenesteoppdagelse — sparer ~1 s per
    // oppkobling. Forkastes i _onCommandError hvis de viser seg å være feil.
    this._storedHandles = this.getStoreValue('gattHandles') || null;

    await migrateCapabilities(this, REQUIRED_CAPABILITIES);

    for (const capability of Object.keys(MOTOR_CAPABILITIES)) {
      this.registerCapabilityListener(capability, () => this._onMotorButton(capability));
    }

    this.registerCapabilityListener('linak_bed_stop', () => this.stopMovement());
    this.registerCapabilityListener('linak_bed_light', () => this.setLight(!this.lightIsOn()));

    await this._setConnection('idle');
    this.log(`LINAK-seng klar — ${this._mac}`);
  }

  _proxy() {
    return this.homey.app.getProxy();
  }

  async _setConnection(state) {
    if (!this.hasCapability('linak_bed_connection')) return;
    await this.setCapabilityValue('linak_bed_connection', state).catch(() => {});
  }

  async _reportSignal(rssi) {
    if (!Number.isFinite(rssi)) return;
    if (!this.hasCapability('measure_signal_strength')) return;
    await this.setCapabilityValue('measure_signal_strength', rssi).catch(() => {});
  }

  // setAvailable() er en IPC-rundtur mot Homey-kjernen — unødvendig når
  // enheten allerede er tilgjengelig, som er nesten alltid.
  async _markAvailable() {
    if (this.getAvailable()) return;
    await this.setAvailable().catch(() => {});
  }

  maxRunSeconds() {
    const configured = Number(this.getSetting('maxRunSeconds'));
    if (Number.isFinite(configured) && configured > 0) return configured;
    return DEFAULT_MAX_RUN_SECONDS;
  }

  // Hvor lenge BLE-økten dveler åpen etter siste kommando. 0 = koble ned med
  // én gang (fjernkontrollen er utestengt så lenge økten er åpen).
  _lingerMs() {
    const configured = Number(this.getSetting('lingerSeconds'));
    if (Number.isFinite(configured) && configured >= 0) return configured * 1000;
    return 20000;
  }

  _commandOptions(extra = {}) {
    return {
      addressType: this._addressType,
      storedHandles: this._storedHandles,
      lingerMs: this._lingerMs(),
      ...extra,
    };
  }

  async _rememberHandles(result) {
    if (this._storedHandles || !result || !result.handles) return;
    this._storedHandles = result.handles;
    await this.setStoreValue('gattHandles', result.handles).catch(() => {});
    this.log('GATT-handles lagret', result.handles);
  }

  // ATT-feil 1 (Invalid Handle) betyr at de lagrede handles ikke stemmer
  // lenger — typisk etter firmwareoppdatering på sengen. Forkast dem, så
  // gjør neste kommando full tjenesteoppdagelse i stedet for å feile evig.
  _onCommandError(error) {
    if (error && error.attError === 1 && this._storedHandles) {
      this._storedHandles = null;
      this.unsetStoreValue('gattHandles').catch(() => {});
      this.log('Lagrede GATT-handles forkastet — neste kommando gjør full oppdagelse');
    }
  }

  async _onMotorButton(capability) {
    return this.pressMotor(MOTOR_CAPABILITIES[capability]);
  }

  // Knappetrykk: løses når bevegelsen har STARTET, ikke når den er ferdig.
  // En bevegelse kan vare i 45 sekunder, og en lytter som henger så lenge får
  // knappen til å spinne og hele appen til å føles køet. Kjøringen fortsetter
  // i bakgrunnen; nye trykk erstatter den via billettlogikken i proxyen, og
  // feil etter start logges av runMotor som før.
  pressMotor(command) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };
      this.runMotor(command, this.maxRunSeconds(), { onStarted: () => settle(resolve, true) })
        .then(() => settle(resolve, true))
        .catch((error) => settle(reject, error));
    });
  }

  // Felles vei for både knapper og Flow-kort. Venter til bevegelsen er helt
  // ferdig — Flow-kortene skal blokkere til «kjør i X sekunder» faktisk er gjort.
  async runMotor(command, durationSeconds, extraOptions = {}) {
    // Sikkerhetsgrensen gjelder ALLE veier inn, også Flow-kort — før gjaldt
    // den bare knappene, så en Flow kunne kjøre lenger enn grensen brukeren
    // hadde satt. NaN (manglende Flow-argument) faller også trygt ned her.
    const limit = this.maxRunSeconds();
    const seconds = Number.isFinite(Number(durationSeconds))
      ? Math.min(Number(durationSeconds), limit)
      : limit;

    await this._setConnection('moving');
    try {
      const result = await this._proxy().sendCommand(this._mac, command,
        this._commandOptions({ durationSeconds: seconds, ...extraOptions }));

      if (result.stoppedBy === 'erstattet') {
        // Et nyere trykk tok over. Det trykket eier tilstanden nå — å sette
        // 'idle' her ville overskrevet dets 'moving' mens sengen faktisk går.
        this.log(`${command}: erstattet av nyere trykk`);
        return true;
      }

      this.log(`${command}: ${result.repeats} skrivinger, stoppet av ${result.stoppedBy || 'kommando'}, RSSI ${result.rssi}`);
      await this._rememberHandles(result);
      await this._reportSignal(result.rssi);
      await this._markAvailable();
      await this._setConnection('idle');
      return true;
    } catch (error) {
      this._onCommandError(error);
      await this._setConnection('error');
      this.error(`${command} feilet`, error.message);
      // Feilen kastes videre slik at Flow-kortet viser den for brukeren.
      throw error;
    }
  }

  // Brukes av Flow-betingelsen. Speiler siste kommanderte tilstand.
  lightIsOn() {
    return Boolean(this.getStoreValue('lightOn'));
  }

  async stopMovement() {
    try {
      await this._proxy().stop(this._mac, { lingerMs: this._lingerMs() });
      await this._setConnection('idle');
      return true;
    } catch (error) {
      this.error('Stopp feilet', error.message);
      throw error;
    }
  }

  async setLight(on) {
    // Under en pågående bevegelse går lyset via side-kanalen i proxyen, og
    // bevegelsen eier tilstandsfeltet — ikke overskriv 'moving' med 'busy'.
    const moving = this.getCapabilityValue('linak_bed_connection') === 'moving';
    if (!moving) await this._setConnection('busy');
    try {
      const result = await this._proxy().sendCommand(this._mac, on ? 'lightOn' : 'lightOff',
        this._commandOptions());
      await this._rememberHandles(result);
      await this._reportSignal(result.rssi);
      // Sengen rapporterer ikke lysstatus, og knappen er ikke lesbar —
      // tilstanden holdes i store for Flow-betingelsen «lyset er på».
      await this.setStoreValue('lightOn', on).catch(() => {});
      await this._markAvailable();
      if (!moving) await this._setConnection('idle');
      return true;
    } catch (error) {
      this._onCommandError(error);
      if (!moving) await this._setConnection('error');
      this.error('Lyskommando feilet', error.message);
      throw error;
    }
  }
}

module.exports = BedDevice;
