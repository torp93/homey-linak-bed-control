'use strict';

const Homey = require('homey');

// Virtuell enhet — ingen BLE-skanning. Den styrer sengene som allerede er
// paret, så det eneste paringen gjør er å opprette den.
class AllBedsDriver extends Homey.Driver {
  async onPairListDevices() {
    // Navnet settes direkte i stedet for via homey.__ — appen har ingen
    // locales-mappe, og oversetteren ville returnert selve nøkkelen.
    return [{
      name: this.homey.i18n.getLanguage() === 'no' ? 'Begge senger' : 'Both beds',
      data: { id: 'all-beds' },
    }];
  }
}

module.exports = AllBedsDriver;
