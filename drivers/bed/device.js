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

// Signalstyrke hadde ingen kilde i normal drift: RSSI følger annonseringen,
// og en vanlig kommando hopper over annonseringsventingen fordi adressetypen
// er lagret fra paringen. Flisen ble derfor stående på samme tall i dagevis.
//
// Et kort skann med jevne mellomrom fyller den, og forteller samtidig om
// sengen svarer i det hele tatt. Skanning låser IKKE ut sengens fjernkontroll
// — det er bare BLE-tilkobling som gjør det — så dette koster ingenting annet
// enn noen sekunder med annonseringer.
const DEFAULT_SIGNAL_INTERVAL_MINUTES = 6 * 60;
// 12 sekunder, ikke 8. Paringen bruker 12, og det er den lengden som er bevist
// å finne begge sengene her — den svakeste ligger på -87 dBm og rakk ikke å
// annonsere innenfor 8 sekunder.
const SIGNAL_SCAN_MS = 12000;
const SIGNAL_FIRST_DELAY_MS = 90 * 1000;

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
  // De to siste står i denne rekkefølgen fordi migreringen fjerner først og
  // legger til etterpå: en enhet som hadde measure_signal_strength ender opp
  // nøyaktig slik av seg selv, uten at rekkefølgen må bygges om.
  //
  // measure_signal_strength er Homeys innebygde kapabilitet, og den tegner et
  // WiFi-ikon som ikke kan overstyres. Dette er Bluetooth-signalet mellom
  // ESP32-en og sengen, så det fikk sin egen kapabilitet med riktig ikon.
  'linak_bed_signal_refresh',
  'linak_bed_signal',
  // ESP32-ens eget WiFi-signal. Her er Homeys innebygde kapabilitet riktig
  // brukt — dette ER WiFi, og WiFi-ikonet hører hjemme på den.
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
    this.registerCapabilityListener('linak_bed_signal_refresh', () => this.refreshStatus());

    await this._setConnection('idle');
    this._startSignalRefresh();
    this.log(`LINAK-seng klar — ${this._mac}`);
  }

  // Ulagret innstilling er udefinert på enheter som ble paret før den fantes.
  // Standarden er på for begge.
  _bluetoothAutoEnabled() {
    return this.getSetting('signalAutoRefresh') !== false;
  }

  _wifiAutoEnabled() {
    return this.getSetting('wifiAutoRefresh') !== false;
  }

  _readyAutoEnabled() {
    return this.getSetting('readyAutoRefresh') !== false;
  }

  _signalAutoEnabled() {
    return this._bluetoothAutoEnabled() || this._wifiAutoEnabled() || this._readyAutoEnabled();
  }

  _signalIntervalMs() {
    const minutes = Number(this.getSetting('signalIntervalMinutes'));
    // Nedre grense 5 min: hvert skann tar 12 s, og knappen dekker behovet for
    // et svar med én gang.
    const safe = Number.isFinite(minutes) && minutes >= 5
      ? minutes : DEFAULT_SIGNAL_INTERVAL_MINUTES;
    return safe * 60 * 1000;
  }

  // Første måling kommer et lite stykke etter oppstart, ikke midt i den —
  // Homey har nok å gjøre da. Sengene sprer seg ut fra hverandre etter MAC-en,
  // så to senger ikke skanner i samme sekund ved hver oppstart.
  _startSignalRefresh() {
    this._stopSignalRefresh();
    if (!this._signalAutoEnabled()) return;
    const spreadMs = ((parseInt(this._mac.slice(-2), 16) || 0) % 60) * 1000;
    this._signalFirstTimer = this.homey.setTimeout(() => {
      this._refreshSignal();
      this._signalTimer = this.homey.setInterval(() => this._refreshSignal(), this._signalIntervalMs());
    }, SIGNAL_FIRST_DELAY_MS + spreadMs);
  }

  _stopSignalRefresh() {
    if (this._signalFirstTimer) this.homey.clearTimeout(this._signalFirstTimer);
    if (this._signalTimer) this.homey.clearInterval(this._signalTimer);
    this._signalFirstTimer = null;
    this._signalTimer = null;
  }

  // Knappen: alt som kan måles, i én omgang. Her venter noen på svaret, så en
  // feil skal vises i stedet for å gå stille i loggen. Skannet er felles for
  // Bluetooth-tallet og klar-statusen — å skanne to ganger for det samme ville
  // vært 24 sekunder til ingen nytte.
  async measureStatus() {
    const entry = await this._scanForBed();
    if (entry) await this._reportSignal(entry.rssi);
    await this._applyReadyState(Boolean(entry));

    const wifi = await this._measureWifiOnce().catch(() => null);

    if (!entry && wifi === null) {
      throw new Error('Neither the bed nor the proxy answered. Check that the proxy is powered and on the network.');
    }

    this.log(`Statusmåling ferdig — seng ${entry ? `${entry.rssi} dBm` : 'svarte ikke'}, `
      + `WiFi ${wifi === null ? 'ukjent' : `${wifi} dBm`}`);
    return true;
  }

  // Klar-status: sengen svarte på skannet, eller den gjorde det ikke. En
  // bevegelse som pågår eier tilstandsfeltet og skal ikke overskrives.
  async _applyReadyState(seen) {
    const state = this.getCapabilityValue('linak_bed_connection');
    if (state === 'moving' || state === 'busy') return;
    await this._setConnection(seen ? 'idle' : 'error');
  }

  // Bakgrunnsarbeid: ingenting her skal nå brukeren eller velte appen. Er
  // proxy-adressen ikke satt, kaster _proxy() — og det er riktig svar her også,
  // bare stille.
  async _refreshSignal() {
    if (this._bluetoothAutoEnabled() || this._readyAutoEnabled()) {
      try {
        const entry = await this._scanForBed();
        if (entry && this._bluetoothAutoEnabled()) {
          await this._reportSignal(entry.rssi);
          this.log(`Signalstyrke oppdatert: ${entry.rssi} dBm`);
        }
        if (!entry) {
          this.log(`Sengen annonserte ikke innen ${SIGNAL_SCAN_MS} ms`);
        }
        if (this._readyAutoEnabled()) await this._applyReadyState(Boolean(entry));
      } catch (error) {
        this.log('Statusmåling hoppet over', error.message);
      }
    }

    if (this._wifiAutoEnabled()) {
      try {
        await this._measureWifiOnce();
      } catch (error) {
        this.log('WiFi-måling hoppet over', error.message);
      }
    }
  }

  // WiFi-signalet leses fra proxyen, ikke fra sengen. Verdien er den samme på
  // begge sengene — det er én ESP32 — og det er riktig: det er dén lenken som
  // er felles for dem.
  async _measureWifiOnce() {
    if (!this.hasCapability('measure_signal_strength')) return null;

    const dbm = await this._proxy().wifiSignal();
    if (!Number.isFinite(dbm)) return null;

    const rounded = Math.round(dbm);
    await this.setCapabilityValue('measure_signal_strength', rounded).catch(() => {});
    this.log(`WiFi-signal oppdatert: ${rounded} dBm`);
    return rounded;
  }

  // Returnerer målt RSSI, eller null når sengen ikke svarte. Ingen annonsering
  // betyr utenfor rekkevidde eller stille — da er det riktigere å la forrige tall
  // stå enn å finne på et nytt.
  async _scanForBed() {
    // Ikke stjel socketen fra en bevegelse som pågår.
    if (this.getCapabilityValue('linak_bed_connection') === 'moving') return null;

    const seen = await this._proxy().discover({ durationMs: SIGNAL_SCAN_MS });
    return seen.find((entry) =>
      String(entry.mac).toUpperCase() === String(this._mac).toUpperCase()) || null;
  }

  async _measureSignalOnce() {
    const mine = await this._scanForBed();

    if (!mine || !Number.isFinite(mine.rssi)) {
      // Uten denne linja er «sengen svarte ikke» og «målingen ble aldri gjort»
      // like tause i loggen, og de betyr helt ulike ting.
      this.log(`Sengen annonserte ikke innen ${SIGNAL_SCAN_MS} ms — signalet står uendret`);
      return null;
    }

    await this._reportSignal(mine.rssi);
    this.log(`Signalstyrke oppdatert: ${mine.rssi} dBm`);
    return mine.rssi;
  }

  // Slår brukeren automatikken av eller på, skal det virke uten omstart.
  async onSettings({ changedKeys }) {
    const signalKeys = [
      'signalAutoRefresh', 'wifiAutoRefresh', 'readyAutoRefresh', 'signalIntervalMinutes',
    ];
    if (changedKeys.some((key) => signalKeys.includes(key))) {
      // Innstillingen er ikke skrevet ennå når denne kalles, så timeren settes
      // opp på neste tick.
      this.homey.setTimeout(() => this._startSignalRefresh(), 100);
    }
  }

  // onDeleted er hendelsen Homey gir når BRUKEREN sletter enheten. Uten den
  // fortsetter en bevegelse som var i gang å kjøre i proxyen — den kjenner
  // ingen Homey-enheter og ville stoppet først på sikkerhetsgrensen.
  async onDeleted() {
    this._stopSignalRefresh();
    this.homey.app.forgetBed(this._mac);
    this.log(`Seng slettet — ${this._mac} sluppet`);
    // Gruppa teller sengene på nytt uten denne.
    this._notifyGroups();
  }

  // homey.setInterval ryddes automatisk når instansen rives, men en slettet
  // seng skal slutte å skanne med én gang — ikke først når appen stopper.
  async onUninit() {
    this._stopSignalRefresh();
  }

  // --- Reparasjon -----------------------------------------------------------

  // Det brukeren mener med «start appen på nytt»: slipp BLE-økten for denne
  // sengen og riv ned proxy-klienten, så neste kommando bygger alt friskt.
  // En app kan ikke restarte seg selv gjennom SDK-et, men dette er den delen
  // en restart faktisk fikser.
  async resetConnection() {
    this.homey.app.forgetBed(this._mac);
    this.homey.app.resetProxy();
    await this._setConnection('idle');
    this.log('Tilkoblingen nullstilt fra reparasjonsvisningen');
    return true;
  }

  // Lagrede GATT-handles sparer ~1 s per oppkobling, men blir feil hvis sengen
  // har fått ny firmware. ATT-feil 1 rydder dem av seg selv; dette er veien ut
  // når sengen svarer med noe annet i stedet.
  async forgetStoredHandles() {
    this._storedHandles = null;
    await this.unsetStoreValue('gattHandles').catch(() => {});
    this.log('Lagrede GATT-handles tømt fra reparasjonsvisningen');
    return true;
  }

  _proxy() {
    return this.homey.app.getProxy();
  }

  async _setConnection(state) {
    if (!this.hasCapability('linak_bed_connection')) return;
    await this.setCapabilityValue('linak_bed_connection', state).catch(() => {});
    this._notifyGroups();
  }

  // «Begge senger» viser summen av sengene, så den må få vite når denne endrer
  // seg. Fyr-og-glem: gruppa er pynt, og en feil her skal ikke velte en
  // kommando som er på vei til sengen.
  _notifyGroups() {
    try {
      for (const group of this.homey.drivers.getDriver('all_beds').getDevices()) {
        if (typeof group.refreshConnection === 'function') {
          Promise.resolve(group.refreshConnection()).catch(() => {});
        }
      }
    } catch (error) {
      // Gruppa finnes ikke nødvendigvis — den er en valgfri enhet.
    }
  }

  async _reportSignal(rssi) {
    if (!Number.isFinite(rssi)) return;
    if (!this.hasCapability('linak_bed_signal')) return;
    await this.setCapabilityValue('linak_bed_signal', rssi).catch(() => {});
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
