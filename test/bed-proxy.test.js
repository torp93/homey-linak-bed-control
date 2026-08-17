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
    this.failWriteWith = -1;         // attError de feilende skrivingene bærer
    this.writes = [];                // { mac, handle, hex } — hvem fikk hva
    this.frames = [];                // { mac, hex } fra buildGattWriteFrame
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
    const hex = Buffer.from(data).toString('hex');
    this._note('gattWrite', handle, hex);
    this.writes.push({ mac, handle, hex });
    if (this.failNextWrites > 0) {
      this.failNextWrites--;
      const err = new Error(`The bed rejected a command (handle 16, error=${this.failWriteWith})`);
      err.attError = this.failWriteWith;
      throw err;
    }
  }

  buildGattWriteFrame(mac, handle, data) {
    const hex = Buffer.from(data).toString('hex');
    this._note('buildFrame', handle, hex);
    this.frames.push({ mac, hex });
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

// En bevegelseskommando er ikke idempotent: skrives den to ganger, kan sengen
// gå lenger enn brukeren ba om. Den eneste tillatte gjentakelsen er etter ATT 5
// (Insufficient Authentication), som betyr at skrivingen ble AVVIST, ikke utført.

test('en fersk økt replayer ikke en bevegelseskommando som feilet', async () => {
  const { proxy, client } = makeProxy();
  client.failNextWrites = 1;
  client.failWriteWith = -1;        // lokal ESP-feil: utfallet er ukjent

  await assert.rejects(
    proxy.sendCommand(MAC, 'legUp', { ...OPTS, durationSeconds: 5 }),
    /rejected a command/,
  );

  const movement = client.writes.filter((w) => w.hex === '0900');
  assert.equal(movement.length, 1, 'bevegelsen ble forsøkt nøyaktig én gang');
  assert.equal(client.count('writeRaw'), 0, 'ingen repetisjoner ble sendt');
});

test('ATT 5 bonder på nytt og skriver om — den skrivingen ble avvist, ikke utført', async () => {
  const { proxy, client } = makeProxy();
  client.failNextWrites = 1;
  client.failWriteWith = 5;

  const result = await proxy.sendCommand(MAC, 'lightOn', OPTS);
  assert.equal(result.repeats, 1);
  assert.equal(client.count('blePair'), 2, 'bonding ble gjort på nytt');
  assert.equal(client.writes.filter((w) => w.hex === '9200').length, 2);
});

test('to senger er isolert: kommandoer krysser ikke, og den ene avbryter ikke den andre', async () => {
  const OTHER = 'F9:A0:BE:5F:BF:A6';
  const { proxy, client } = makeProxy();

  const a = proxy.sendCommand(MAC, 'legUp', { ...OPTS, durationSeconds: 0.4 });
  const b = proxy.sendCommand(OTHER, 'backDown', { ...OPTS, durationSeconds: 0.4 });
  const [ra, rb] = await Promise.all([a, b]);

  // Billettlogikken er per seng — ingen av dem skal ha blitt «erstattet».
  assert.equal(ra.stoppedBy, 'tidsgrense');
  assert.equal(rb.stoppedBy, 'tidsgrense');

  // Og hver seng fikk kun sine egne bytes.
  const forA = client.writes.concat(client.frames).filter((w) => w.mac === MAC).map((w) => w.hex);
  const forB = client.writes.concat(client.frames).filter((w) => w.mac === OTHER).map((w) => w.hex);
  assert.ok(forA.includes('0900') && !forA.includes('0a00'), 'seng A fikk bare sin kommando');
  assert.ok(forB.includes('0a00') && !forB.includes('0900'), 'seng B fikk bare sin kommando');
  assert.equal(client.calls.filter(([n]) => n === 'bleConnect').length, 2, 'én økt per seng');
});

test('stopp på én seng rører ikke den andre', async () => {
  const OTHER = 'F9:A0:BE:5F:BF:A6';
  const { proxy } = makeProxy();

  const a = proxy.sendCommand(MAC, 'legUp', { ...OPTS, durationSeconds: 5 });
  const b = proxy.sendCommand(OTHER, 'legUp', { ...OPTS, durationSeconds: 0.4 });
  await new Promise((r) => setTimeout(r, 120));
  await proxy.stop(MAC, { lingerMs: 0 });

  assert.equal((await a).stoppedBy, 'stopp');
  assert.equal((await b).stoppedBy, 'tidsgrense', 'den andre sengen kjørte ferdig');
});

test('to samtidige kommandoer gir ÉN TCP-oppkobling, ikke to', async () => {
  const OTHER = 'F9:A0:BE:5F:BF:A6';
  const { proxy, client, createdCount } = makeProxy();

  // Begge treffer _ensureClient før den første er ferdig — dette er racen som
  // ellers ville gitt to sockets mot samme proxy.
  await Promise.all([
    proxy.sendCommand(MAC, 'lightOn', OPTS),
    proxy.sendCommand(OTHER, 'lightOn', OPTS),
  ]);

  assert.equal(createdCount(), 1, 'nøyaktig én klient ble opprettet');
  assert.equal(client.count('connect'), 1, 'nøyaktig én oppkobling');
});

test('100 raske trykk: alle settles, bare det siste kjører, køen vokser ikke', async () => {
  const { proxy, client } = makeProxy();

  const presses = [];
  for (let i = 0; i < 100; i++) {
    presses.push(proxy.sendCommand(MAC, i % 2 ? 'legUp' : 'legDown',
      { ...OPTS, durationSeconds: i === 99 ? 0.25 : 5 }));
  }

  const results = await Promise.all(presses);   // ingen henger, ingen kaster
  const ran = results.filter((r) => r.repeats > 0);

  assert.equal(results.length, 100);
  assert.equal(ran.length, 1, 'nøyaktig ett trykk beveget sengen');
  assert.equal(results[99].stoppedBy, 'tidsgrense', 'det siste trykket er det som kjørte');
  assert.ok(client.count('bleConnect') <= 2, `få oppkoblinger, ikke 100 (${client.count('bleConnect')})`);

  // Køen er per seng — én kjede, ikke 100 akkumulerte.
  assert.equal(proxy._queues.size, 1);
  assert.equal(proxy._running.size, 0, 'ingenting står igjen som kjørende');
});

test('ATT 1 forkaster de lagrede handles og replayer ikke kommandoen', async () => {
  const { proxy, client } = makeProxy();
  client.failNextWrites = 1;
  client.failWriteWith = 1;                    // Invalid Handle

  await assert.rejects(proxy.sendCommand(MAC, 'legUp', { ...OPTS, durationSeconds: 5 }));

  assert.equal(client.writes.filter((w) => w.hex === '0900').length, 1, 'ingen replay');
  assert.equal(proxy._handles.has(MAC), false, 'handle-cachen ble kastet');
});

test('handles fra én seng brukes aldri på en annen', async () => {
  const OTHER = 'F9:A0:BE:5F:BF:A6';
  const { proxy, client } = makeProxy();

  // Seng A har lagrede handles på 16. Seng B oppdager sine egne, som ligger
  // et annet sted — de to skal ikke kunne blandes.
  client.getServices = async () => ([{
    uuid: '99fa0001338a10248a49009c0215f78a',
    characteristics: [{ uuid: '99fa0002338a10248a49009c0215f78a', handle: 41, descriptors: [] }],
  }]);

  await proxy.sendCommand(MAC, 'lightOn', OPTS);                              // handles = 16
  await proxy.sendCommand(OTHER, 'lightOn', { ...OPTS, storedHandles: null }); // oppdager 41

  assert.equal(proxy._handles.get(MAC).commandHandle, 16);
  assert.equal(proxy._handles.get(OTHER).commandHandle, 41);
  assert.deepEqual(client.writes.filter((w) => w.mac === MAC).map((w) => w.handle), [16]);
  assert.deepEqual(client.writes.filter((w) => w.mac === OTHER).map((w) => w.handle), [41]);
});

// Sletting av en seng. Proxyen kjenner ingen Homey-enheter, så uten forget()
// ville bevegelsen fortsatt til sikkerhetsgrensen etter at enheten var borte.

test('uten forget() ville bevegelsen fortsatt etter sletting — defekten', async () => {
  const { proxy, client } = makeProxy();
  const moving = proxy.sendCommand(MAC, 'legUp', { ...OPTS, durationSeconds: 5 });
  await new Promise((r) => setTimeout(r, 150));

  // Ingen forget: dette er tilstanden slik den var før fiksen.
  const at = client.count('writeRaw');
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(client.count('writeRaw') > at, 'motoren drives fortsatt');

  await proxy.stop(MAC, { lingerMs: 0 });   // rydd opp etter testen
  await moving;
});

test('forget() stopper bevegelsen straks og slipper økten', async () => {
  const { proxy, client } = makeProxy();
  const moving = proxy.sendCommand(MAC, 'legUp', { ...OPTS, durationSeconds: 5 });
  await new Promise((r) => setTimeout(r, 150));

  proxy.forget(MAC);

  const result = await moving;
  assert.equal(result.stoppedBy, 'slettet');

  // Ingen skrivinger etter at sengen ble sluppet.
  const at = client.count('writeRaw');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(client.count('writeRaw'), at, 'motoren drives ikke videre');

  assert.equal(proxy._live.has(MAC), false, 'BLE-økten er sluppet');
  assert.equal(proxy._running.has(MAC), false);
  assert.equal(proxy._handles.has(MAC), false);
  assert.ok(client.count('bleDisconnect') >= 1, 'linken ble koblet ned');
});

test('forget() kobler ikke opp på nytt bare for å sende stopp', async () => {
  const { proxy, createdCount } = makeProxy();
  proxy.forget(MAC);                       // ingenting kjører, ingen økt
  assert.equal(createdCount(), 0, 'ingen klient ble opprettet');
});

test('forget() er idempotent', async () => {
  const { proxy } = makeProxy();
  const moving = proxy.sendCommand(MAC, 'legUp', { ...OPTS, durationSeconds: 5 });
  await new Promise((r) => setTimeout(r, 120));

  assert.doesNotThrow(() => { proxy.forget(MAC); proxy.forget(MAC); proxy.forget(MAC); });
  assert.equal((await moving).stoppedBy, 'slettet');
  assert.doesNotThrow(() => proxy.forget(MAC));
});

test('sletting midt i en rekke trykk lar ingen av dem løpe videre', async () => {
  // Det andre trykket overtar med én gang (billettlogikken), så det er DET som
  // kjører når slettingen kommer. Poenget er at ingen av dem overlever den.
  const { proxy, client } = makeProxy();
  const first = proxy.sendCommand(MAC, 'legUp', { ...OPTS, durationSeconds: 5 });
  const second = proxy.sendCommand(MAC, 'legDown', { ...OPTS, durationSeconds: 5 });
  await new Promise((r) => setTimeout(r, 120));

  proxy.forget(MAC);
  const [a, b] = await Promise.all([first, second]);

  assert.notEqual(a.stoppedBy, 'tidsgrense', 'det første trykket løp ikke ut tiden');
  assert.equal(b.stoppedBy, 'slettet', 'det kjørende trykket ble avbrutt av slettingen');

  const at = client.count('writeRaw');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(client.count('writeRaw'), at, 'ingen skrivinger etter slettingen');
});

test('et trykk som kommer ETTER sletting starter ikke bevegelsen på nytt', async () => {
  // Billetten ble bumpet av forget(), så et trykk som allerede lå i kjeden når
  // slettingen skjedde blir forbigått i stedet for å starte motoren etterpå.
  const { proxy } = makeProxy();
  const moving = proxy.sendCommand(MAC, 'legUp', { ...OPTS, durationSeconds: 5 });
  const ticketBefore = proxy._latest.get(MAC);
  await new Promise((r) => setTimeout(r, 100));

  proxy.forget(MAC);
  await moving;

  assert.ok(proxy._latest.get(MAC) > ticketBefore, 'billetten ble ugyldiggjort');
});

test('sletting av seng A rører ikke seng B', async () => {
  const OTHER = 'F9:A0:BE:5F:BF:A6';
  const { proxy, client } = makeProxy();

  const a = proxy.sendCommand(MAC, 'legUp', { ...OPTS, durationSeconds: 5 });
  const b = proxy.sendCommand(OTHER, 'backUp', { ...OPTS, durationSeconds: 0.5 });
  await new Promise((r) => setTimeout(r, 150));

  proxy.forget(MAC);

  assert.equal((await a).stoppedBy, 'slettet');
  assert.equal((await b).stoppedBy, 'tidsgrense', 'seng B kjørte ferdig som normalt');

  // B fikk sine egne bytes hele veien, og bare A ble koblet ned.
  assert.ok(client.writes.some((w) => w.mac === OTHER && w.hex === 'ff00'), 'B fikk sin sluttstopp');
  const disconnects = client.calls.filter(([n]) => n === 'bleDisconnect').map(([, mac]) => mac);
  assert.ok(disconnects.includes(MAC));
});

test('sletting av en seng som står stille rører ikke den andre', async () => {
  const OTHER = 'F9:A0:BE:5F:BF:A6';
  const { proxy } = makeProxy();
  const b = proxy.sendCommand(OTHER, 'legUp', { ...OPTS, durationSeconds: 0.4 });
  proxy.forget(MAC);                       // A har aldri gjort noe
  assert.equal((await b).stoppedBy, 'tidsgrense');
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
