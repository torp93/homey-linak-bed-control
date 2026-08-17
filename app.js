'use strict';

const Homey = require('homey');
const { BedProxy } = require('./lib/bed-proxy');
const { EsphomeApiClient } = require('./lib/esphome-api');
const {
  resolveProxyConfig, isValidHost, isValidPort,
  SETTING_HOST, SETTING_PORT, DEFAULT_PORT,
} = require('./lib/proxy-config');

class LinakBedApp extends Homey.App {
  async onInit() {
    this._proxy = null;
    this.registerFlowCards();

    // Endrer brukeren proxy-adressen, rives den gamle klienten ned slik at
    // neste kall bygger en ny mot riktig vert.
    this.homey.settings.on('set', (key) => {
      if (key === SETTING_HOST || key === SETTING_PORT) this.resetProxy();
    });

    const { host, port, source } = resolveProxyConfig(this.homey.settings);
    this.log(`LINAK Bed v${this.manifest.version} initialized — proxy ${host || '(not set)'}:${port} (${source})`);
  }

  // All BLE går gjennom ESPHome-proxyen, ikke Homeys egen radio. Homey Pro står
  // for langt unna soverommet til at dens egen BLE er brukbar mot sengene.
  getProxy() {
    if (!this._proxy) {
      const { host, port } = resolveProxyConfig(this.homey.settings);
      // Fersk installasjon uten lagret adresse. Uten denne beskjeden ville
      // brukeren fått «EsphomeApiClient krever host» ut av et Flow-kort.
      if (!host) {
        throw new Error('No Bluetooth proxy address is set. Open the app settings and enter the address of the ESP32 running ESPHome.');
      }
      this._proxy = new BedProxy({
        host,
        port,
        log: (...args) => this.log('[proxy]', ...args),
      });
      this._proxy.on('error', (error) => this.error('Proxy-feil', error));
      this.log(`ESPHome BLE-proxy klient opprettet mot ${host}:${port}`);
    }
    return this._proxy;
  }

  // Kobler til, henter enhetsinfo og kobler ned igjen — ingen BLE involvert.
  // Ligger her og ikke i api.js fordi både innstillingssiden og paringen bruker
  // den; en seng som pares skal ikke kunne godta en proxy innstillingene avviser.
  async testProxyConnection(host, port = DEFAULT_PORT) {
    if (!isValidHost(host)) throw new Error('Invalid address');
    if (!isValidPort(port)) throw new Error('Invalid port');

    const client = new EsphomeApiClient({
      host: host.trim(),
      port,
      clientInfo: 'homey-linak-bed-test',
      log: (...args) => this.log('[test]', ...args),
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
  }

  // Kalles når en seng slettes. Bruker den EKSISTERENDE klienten — finnes det
  // ingen, er det heller ingenting i gang som må stoppes, og å opprette en her
  // ville kastet på en fersk installasjon uten adresse.
  forgetBed(mac) {
    if (this._proxy) this._proxy.forget(mac);
  }

  resetProxy() {
    const pending = this._destroyProxy('Proxy-innstilling endret — kobler ned eksisterende klient');
    // Fyr-og-glem her er greit: en innstillingsendring haster ikke.
    pending.catch((error) => this.error('Nedkobling av proxy-klient feilet', error));
  }

  async _destroyProxy(reason) {
    if (!this._proxy) return;
    const previous = this._proxy;
    this._proxy = null;
    if (reason) this.log(reason);
    await previous.destroy();
  }

  async onUninit() {
    // MÅ awaites: uten dette dreper Homey prosessen før BLE-nedkoblingen er
    // sendt, og sengen holder linken — fjernkontrollen er da utestengt til
    // ESP-ens egen timeout. Skjer ved hver appoppdatering.
    await this._destroyProxy('Appen stopper — kobler ned proxy-klienten')
      .catch((error) => this.error('Nedkobling ved stopp feilet', error));
  }

  registerFlowCards() {
    this.homey.flow
      .getActionCard('linak_bed_move')
      .registerRunListener(({ device, section, duration }) =>
        device.runMotor(section, Number(duration)));

    this.homey.flow
      .getActionCard('linak_bed_stop_action')
      .registerRunListener(({ device }) => device.stopMovement());

    this.homey.flow
      .getActionCard('linak_bed_light')
      .registerRunListener(({ device, state }) => device.setLight(state === 'on'));

    this.homey.flow
      .getConditionCard('linak_bed_condition_light')
      .registerRunListener(({ device }) => device.lightIsOn());
  }
}

module.exports = LinakBedApp;
