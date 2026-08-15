'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { BedProxy } = require('../lib/bed-proxy');

// Kø-, billett- og dvele-logikken er der samtlige driftsfeil i appens historie
// har bodd. Fake-klienten lar oss teste den uten seng og uten proxy.

const MAC = 'D7:CC:F2:D7:8A:4E';
const HANDLES = { commandHandle: 16, statusHandle: 18, statusCccdHandle: 19, dpgHandle: 22 };

class FakeClient extends EventEmitter {
  constructor() {
    super();
    this.isConnected = true;
    this.calls = [];                 // [navn, ...args] i kallrekkefølge
    this.failNextWrites = 0;         // antall gattWrite som skal feile
  }

  _note(name, ...args) { this.calls.push([name, ...args]); }
  count(name) { return this.calls.filter(([n]) => n === name).length; }

  async connect() { this._note('connect'); return {}; }
  _acquireAdvertisements() { this._note('advAcquire'); }
  _releaseAdvertisements() { this._note('advRelease'); }
  async scan() { this._note('scan'); return []; }
  async waitForDevice(mac) { this._note('waitForDevice', mac); return { rssi: -60, addressType: 1 }; }
  async bleConnect(mac, options) { this._note('bleConnect', mac, options); return { mtu: 23 }; }
  async blePair(mac) { this._note('blePair', mac); }
  bleDisconnect(mac) { this._note('bleDisconnect', mac); }
  async getServices() { this._note('getServices'); return []; }

  async gattWrite(mac, handle, data) {
    this._note('gattWrite', handle, Buffer.from(data).toString('hex'));
    if (this.failNextWrites > 0) {
      this.failNextWrites--;
      const err = new Error('GATT-feil på handle 16: error=-1');
      err.attError = -1;
      throw err;
    }
  }

  buildGattWriteFrame(mac, handle, data) {
    this._note('buildFrame', handle, Buffer.from(data).toString('hex'));
    return Buffer.from(data);
  }

  writeRaw() { this._note('writeRaw'); }
  async close() { this._note('close'); }
}

function makeProxy() {
  const client = new FakeClient();
  let created = 0;
  const proxy = new BedProxy({
    host: 'fake',
    createClient: () => { created++; return client; },
  });
  return { proxy, client, createdCount: () => created };
}

// Kommandoene bruker lagrede handles og kjent adressetype, som i normal drift.
const OPTS = { addressType: 1, storedHandles: HANDLES, lingerMs: 0 };

test('motorkommando: første skriving med svar, resten rå rammer, sluttstopp', async () => {
  const { proxy, client } = makeProxy();
  const result = await proxy.sendCommand(MAC, 'legUp', { ...OPTS, durationSeconds: 0.35 });

  assert.equal(result.stoppedBy, 'tidsgrense');
  assert.ok(result.repeats >= 3, `forventet flere repetisjoner, fikk ${result.repeats}`);
  assert.equal(client.count('buildFrame'), 1, 'rammen bygges nøyaktig én gang');
  assert.ok(client.count('writeRaw') >= 2, 'repetisjonene går som rå rammer');
  // Første skriving (0900) og sluttstopp (ff00) går med svar.
  const writes = client.calls.filter(([n]) => n === 'gattWrite').map(([, , hex]) => hex);
  assert.deepEqual(writes, ['0900', 'ff00']);
  // Kjent adressetype -> ingen annonseringsventing. Og ALLTID uten cache:
  // with-cache ga umiddelbar frakoblingsloop i drift (revertert i v0.10.1).
  assert.equal(client.count('waitForDevice'), 0);
  assert.ok(!client.calls.find(([n]) => n === 'bleConnect')[2].useCache, 'skal koble uten cache');
});

test('nytt trykk erstatter det som kjører', async () => {
  const { proxy } = makeProxy();
  const first = proxy.sendCommand(MAC, 'legUp', { ...OPTS, durationSeconds: 5 });
  await new Promise((r) => setTimeout(r, 120));
  const second = proxy.sendCommand(MAC, 'legDown', { ...OPTS, durationSeconds: 0.25 });

  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.stoppedBy, 'erstattet', 'den gamle bevegelsen ble erstattet');
  assert.equal(b.stoppedBy, 'tidsgrense', 'den nye kjørte ferdig');
});

test('bare det nyeste av flere køede trykk kjører', async () => {
  const { proxy } = makeProxy();
  const first = proxy.sendCommand(MAC, 'legUp', { ...OPTS, durationSeconds: 0.3 });
  const second = proxy.sendCommand(MAC, 'backUp', { ...OPTS, durationSeconds: 0.3 });
  const third = proxy.sendCommand(MAC, 'bothDown', { ...OPTS, durationSeconds: 0.25 });

  const [a, b, c] = await Promise.all([first, second, third]);
  assert.equal(a.stoppedBy, 'erstattet');
  assert.equal(b.repeats, 0, 'det midterste trykket kjørte aldri');
  assert.equal(b.stoppedBy, 'erstattet');
  assert.equal(c.stoppedBy, 'tidsgrense');
});

test('stopp uten noe å stoppe er en no-op uten oppkobling', async () => {
  const { proxy, createdCount } = makeProxy();
  const result = await proxy.stop(MAC, { lingerMs: 20000 });
  assert.equal(result.noop, true);
  assert.equal(createdCount(), 0, 'ingen klient ble opprettet');
});

test('stopp avbryter det som kjører', async () => {
  const { proxy } = makeProxy();
  const moving = proxy.sendCommand(MAC, 'legUp', { ...OPTS, durationSeconds: 5 });
  await new Promise((r) => setTimeout(r, 120));

  const stop = await proxy.stop(MAC, { lingerMs: 0 });
  const result = await moving;

  assert.equal(stop.interrupted, true);
  assert.equal(result.stoppedBy, 'stopp');
});

test('etter stopp beveger ingenting seg — verken kjørende eller køede trykk', async () => {
  const { proxy, client } = makeProxy();
  // Bruker trykker opp, så ned, så stopp — raskt etter hverandre. Uansett
  // hvilket trykk som rakk å starte, skal INGENTING kjøre videre etter stopp.
  const first = proxy.sendCommand(MAC, 'legUp', { ...OPTS, durationSeconds: 5 });
  const second = proxy.sendCommand(MAC, 'legDown', { ...OPTS, durationSeconds: 5 });
  await new Promise((r) => setTimeout(r, 60));
  await proxy.stop(MAC, { lingerMs: 0 });

  const [a, b] = await Promise.all([first, second]);
  assert.notEqual(a.stoppedBy, 'tidsgrense', 'første trykket løp ikke ut tiden');
  assert.notEqual(b.stoppedBy, 'tidsgrense', 'andre trykket løp ikke ut tiden');

  // Og ingen flere bevegelsesrammer skrives etter at stoppen har landet.
  const writesAtStop = client.count('writeRaw');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(client.count('writeRaw'), writesAtStop, 'ingen skrivinger etter stopp');
});

test('lys under bevegelse går i side-kanalen, ikke i kø bak den', async () => {
  const { proxy, client } = makeProxy();
  const started = Date.now();
  const moving = proxy.sendCommand(MAC, 'legUp', { ...OPTS, durationSeconds: 0.6 });
  await new Promise((r) => setTimeout(r, 150));

  const light = await proxy.sendCommand(MAC, 'lightOn', OPTS);
  const lightDoneAfter = Date.now() - started;

  assert.equal(light.repeats, 1);
  assert.ok(lightDoneAfter < 500, `lyset ventet ikke på bevegelsen (${lightDoneAfter} ms)`);

  const result = await moving;
  assert.equal(result.stoppedBy, 'tidsgrense', 'bevegelsen ble IKKE avbrutt av lyset');
  const writes = client.calls.filter(([n]) => n === 'gattWrite').map(([, , hex]) => hex);
  assert.ok(writes.includes('9200'), 'lyskommandoen ble faktisk skrevet');
});

test('annonseringsabonnementet følger BLE-økten, og slippes ETTER frakobling', async () => {
  // Bevist mot maskinvare 2026-08-14: uten aktivt abonnement river ESPHome
  // tilkoblingsforsøket umiddelbart. Og slippes abonnementet FØR frakobling,
  // river det linken. Begge invariantene låses her.
  const { proxy, client } = makeProxy();
  await proxy.sendCommand(MAC, 'lightOn', OPTS);   // lingerMs 0 -> full syklus

  const names = client.calls.map(([n]) => n);
  const acquire = names.indexOf('advAcquire');
  const connect = names.indexOf('bleConnect');
  const disconnect = names.indexOf('bleDisconnect');
  const release = names.indexOf('advRelease');

  assert.ok(acquire >= 0 && acquire < connect, 'abonner FØR tilkobling');
  assert.ok(disconnect >= 0, 'BLE kobles ned');
  assert.ok(release > disconnect, 'abonnementet slippes ETTER BLE-frakobling');
  assert.equal(client.count('advAcquire'), client.count('advRelease'), 'balansert refcount');
});

test('feilet tilkobling slipper abonnementet igjen', async () => {
  const { proxy, client } = makeProxy();
  client.bleConnect = async () => { throw new Error('BLE-tilkobling avvist (error=62)'); };
  await assert.rejects(proxy.sendCommand(MAC, 'lightOn', OPTS));
  assert.equal(client.count('advAcquire'), client.count('advRelease'), 'ingen lekkasje ved feil');
});

test('død dvele-økt gjenåpnes automatisk med ett nytt forsøk', async () => {
  const { proxy, client } = makeProxy();
  // Første kommando etablerer økten og lar den dvele.
  await proxy.sendCommand(MAC, 'lightOn', { ...OPTS, lingerMs: 5000 });
  assert.equal(client.count('bleConnect'), 1);

  // Neste kommando treffer en gjenbrukt økt der linken i virkeligheten er død.
  client.failNextWrites = 1;
  const result = await proxy.sendCommand(MAC, 'lightOff', { ...OPTS, lingerMs: 0 });

  assert.equal(result.repeats, 1);
  assert.equal(client.count('bleConnect'), 2, 'økten ble kastet og åpnet på nytt');
});
