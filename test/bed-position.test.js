'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');

const { BedProxy } = require('../lib/bed-proxy');
const {
  hasPositionSupport,
  parsePosition,
  positionAngle,
  resolveHandles,
} = require('../lib/linak-bed-protocol');

// Stillingsavlesning kan ikke prøves mot maskinvaren her: ingen av boksene i
// huset har 99fa0020. Alle tallene under er derfor hentet fra en ekte logg fra
// en TD5 Advanced (TwinDrive TDA, s.w. 1.22), 2026-10-25, og testene er det
// eneste som holder parsingen ærlig.

const MAC = 'EC:F3:6F:4C:ED:5C';

// Tjenestetreet slik den boksen svarte. Forkortet til det som betyr noe.
const SERVICES_WITH_POSITION = [
  {
    uuid: '99fa0001338a10248a49009c0215f78a',
    handle: 12,
    characteristics: [
      { uuid: '99fa0002338a10248a49009c0215f78a', handle: 14, properties: 0x0c },
      { uuid: '99fa0003338a10248a49009c0215f78a', handle: 16, properties: 0x12, cccdHandle: 17 },
    ],
  },
  {
    uuid: '99fa0020338a10248a49009c0215f78a',
    handle: 22,
    characteristics: [
      { uuid: '99fa0027338a10248a49009c0215f78a', handle: 42, properties: 0x12, cccdHandle: 43 },
      { uuid: '99fa0028338a10248a49009c0215f78a', handle: 45, properties: 0x12, cccdHandle: 46 },
    ],
  },
];

// Boksene her hjemme: kommando og status, ingen posisjonstjeneste.
const SERVICES_WITHOUT_POSITION = [SERVICES_WITH_POSITION[0]];

test('resolveHandles finner posisjonskarakteristikkene når tjenesten finnes', () => {
  const handles = resolveHandles(SERVICES_WITH_POSITION);
  assert.equal(handles.legsPositionHandle, 42);
  assert.equal(handles.legsPositionCccdHandle, 43);
  assert.equal(handles.backPositionHandle, 45);
  assert.equal(handles.backPositionCccdHandle, 46);
  assert.equal(hasPositionSupport(handles), true);
});

test('resolveHandles gir null for posisjon på en boks uten tjenesten', () => {
  const handles = resolveHandles(SERVICES_WITHOUT_POSITION);
  assert.equal(handles.commandHandle, 14, 'kommandokanalen skal fortsatt finnes');
  assert.equal(handles.backPositionHandle, null);
  assert.equal(handles.legsPositionHandle, null);
  assert.equal(hasPositionSupport(handles), false);
});

test('hasPositionSupport tåler manglende og halve handles', () => {
  assert.equal(hasPositionSupport(null), false);
  assert.equal(hasPositionSupport({}), false);
  // Én motor er nok: da rapporteres den ene, og den andre står tom.
  assert.equal(hasPositionSupport({ backPositionHandle: 45, legsPositionHandle: null }), true);
});

test('parsePosition leser posisjon og fortegnet hastighet', () => {
  // c70040fd: rå 199 på vei ned.
  assert.deepEqual(parsePosition(Buffer.from('c70040fd', 'hex')), { raw: 199, speed: -704 });
  // Hastighet 0 = motoren står. Det er dette «stoppet å bevege seg» hviler på.
  assert.deepEqual(parsePosition(Buffer.from('c7000000', 'hex')), { raw: 199, speed: 0 });
  assert.deepEqual(parsePosition(Buffer.from('33000000', 'hex')), { raw: 51, speed: 0 });
  // Positiv hastighet på vei opp.
  assert.deepEqual(parsePosition(Buffer.from('0200e000', 'hex')), { raw: 2, speed: 224 });
});

test('parsePosition avviser det som ikke er en stilling', () => {
  assert.equal(parsePosition(null), null);
  assert.equal(parsePosition(Buffer.alloc(0)), null, 'tom lesing er ikke 0°');
  assert.equal(parsePosition(Buffer.from('c700', 'hex')), null, 'for kort ramme');
  // 0xFFFF er LINAKs «ukjent», ikke en gyldig ytterstilling.
  assert.equal(parsePosition(Buffer.from('ffff0000', 'hex')), null);
});

test('positionAngle regner om med motorens egen skala', () => {
  // De to avlesningene fra loggen, med fasiten integrasjonen viste.
  assert.equal(positionAngle('back', 199), 16.5);
  assert.equal(positionAngle('legs', 51), 4.2);
  assert.equal(positionAngle('back', 0), 0);
  assert.equal(positionAngle('back', 820), 68);
  assert.equal(positionAngle('legs', 548), 45);
});

test('positionAngle klemmer og avviser ukjent seksjon', () => {
  assert.equal(positionAngle('back', 9999), 68, 'over maks er maks, ikke 800°');
  assert.equal(positionAngle('back', -5), 0);
  assert.equal(positionAngle('head', 199), null, 'seksjon vi ikke har skala for');
  assert.equal(positionAngle('back', NaN), null);
});

// --- proxynivå -------------------------------------------------------------

class FakeClient extends EventEmitter {
  constructor(services) {
    super();
    this.isConnected = true;
    this.calls = [];
    this.services = services;
    this.reads = [];
    this.readValues = new Map();     // handle -> Buffer eller Error
  }

  _note(name, ...args) { this.calls.push([name, ...args]); }
  count(name) { return this.calls.filter(([n]) => n === name).length; }

  async connect() { this._note('connect'); return {}; }
  _acquireAdvertisements() { this._note('advAcquire'); }
  _releaseAdvertisements() { this._note('advRelease'); }
  async scan() { this._note('scan'); return []; }
  async waitForDevice() { return { rssi: -87, addressType: 1 }; }
  async bleConnect(mac, options) { this._note('bleConnect', mac, options); return { mtu: 23 }; }
  async blePair(mac) { this._note('blePair', mac); }
  bleDisconnect(mac) { this._note('bleDisconnect', mac); }
  async getServices() { this._note('getServices'); return this.services; }

  async gattRead(mac, handle) {
    this._note('gattRead', handle);
    this.reads.push(handle);
    const value = this.readValues.get(handle);
    if (value instanceof Error) throw value;
    return value || Buffer.alloc(0);
  }

  async close() { this._note('close'); }
}

const makeProxy = (fake) => new BedProxy({ host: '10.0.0.5', createClient: () => fake });

test('readPositions leser begge motorene og regner om til grader', async () => {
  const fake = new FakeClient(SERVICES_WITH_POSITION);
  fake.readValues.set(45, Buffer.from('c7000000', 'hex'));  // rygg
  fake.readValues.set(42, Buffer.from('33000000', 'hex'));  // bein
  const proxy = makeProxy(fake);

  const positions = await proxy.readPositions(MAC);

  assert.deepEqual(positions.back, { raw: 199, speed: 0, angle: 16.5 });
  assert.deepEqual(positions.legs, { raw: 51, speed: 0, angle: 4.2 });
  // Bonding før lesing: uten den svarer boksen med ATT-feil 5.
  assert.equal(fake.count('blePair'), 1);
  proxy.destroy();
});

test('readPositions kaster på en boks uten posisjonstjenesten', async () => {
  const fake = new FakeClient(SERVICES_WITHOUT_POSITION);
  const proxy = makeProxy(fake);

  await assert.rejects(() => proxy.readPositions(MAC), /does not report positions/);
  assert.equal(fake.reads.length, 0, 'skal ikke lese noe som ikke finnes');
  proxy.destroy();
});

test('readPositions rapporterer den ene motoren når den andre feiler', async () => {
  const fake = new FakeClient(SERVICES_WITH_POSITION);
  fake.readValues.set(45, Buffer.from('c7000000', 'hex'));
  fake.readValues.set(42, new Error('Bluetooth GATT Error'));
  const proxy = makeProxy(fake);

  const positions = await proxy.readPositions(MAC);

  assert.equal(positions.back.angle, 16.5);
  assert.equal(positions.legs, null, 'en feilet lesing er ukjent, ikke 0°');
  proxy.destroy();
});

test('lagrede handles tar med posisjonsfeltene, også når de er null', async () => {
  const fake = new FakeClient(SERVICES_WITHOUT_POSITION);
  const proxy = makeProxy(fake);

  const plain = proxy._plainHandles(resolveHandles(SERVICES_WITHOUT_POSITION));

  // Nøkkelen MÅ finnes: det er forskjellen på «oppdaget, boksen har det ikke»
  // og «aldri oppdaget», og enheten bruker nettopp den forskjellen.
  assert.ok('backPositionHandle' in plain);
  assert.equal(plain.backPositionHandle, null);
  assert.equal(plain.legsPositionHandle, null);
  proxy.destroy();
});
