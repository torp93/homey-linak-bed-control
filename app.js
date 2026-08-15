'use strict';

const Homey = require('homey');
const { BedProxy } = require('./lib/bed-proxy');
const { resolveProxyConfig, SETTING_HOST, SETTING_PORT } = require('./lib/proxy-config');

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
    this.log(`LINAK Bed v${this.manifest.version} initialized — proxy ${host}:${port} (${source})`);
  }

  // All BLE går gjennom ESPHome-proxyen, ikke Homeys egen radio. Homey Pro står
  // for langt unna soverommet til at dens egen BLE er brukbar mot sengene.
  getProxy() {
    if (!this._proxy) {
      const { host, port } = resolveProxyConfig(this.homey.settings);
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
