'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EsphomeApiClient,
  encodeVarint,
  decodeVarint,
  decodeFields,
  parseAdvertisementData,
} = require('../lib/esphome-api');

// TCP leverer bytes, ikke meldinger. Rammingen under er egen kode, og den er
// det eneste som står mellom en delt pakke og en kommando som aldri svarer.
const frame = (type, payload) => Buffer.concat([
  Buffer.from([0x00]),
  encodeVarint(payload.length),
  encodeVarint(type),
  payload,
]);

// Klienten kobler ikke til her — _onData mates direkte, som om socketen leverte.
function fakeClient() {
  const client = new EsphomeApiClient({ host: '127.0.0.1' });
  const seen = [];
  client.on('message', ({ type, fields }) => seen.push({ type, fields }));
  // PING besvares med _send, som kaster uten socket. Vi pinger ikke i testene.
  return { client, seen };
}

test('ramming: én melding delt over flere TCP-biter settes sammen', () => {
  const { client, seen } = fakeClient();
  const whole = frame(42, Buffer.from([(1 << 3) | 0, 7]));
  for (const byte of whole) client._onData(Buffer.from([byte]));
  assert.equal(seen.length, 1, 'nøyaktig én melding');
  assert.equal(seen[0].type, 42);
  assert.equal(seen[0].fields[1], 7n);
});

test('ramming: flere meldinger i én TCP-bit leses alle sammen', () => {
  const { client, seen } = fakeClient();
  client._onData(Buffer.concat([
    frame(10, Buffer.from([(1 << 3) | 0, 1])),
    frame(11, Buffer.from([(1 << 3) | 0, 2])),
    frame(12, Buffer.from([(1 << 3) | 0, 3])),
  ]));
  assert.deepEqual(seen.map((m) => m.type), [10, 11, 12]);
});

test('ramming: halv melding venter på resten i stedet for å bli tolket', () => {
  const { client, seen } = fakeClient();
  const whole = frame(20, Buffer.from([(1 << 3) | 0, 9]));
  client._onData(whole.subarray(0, whole.length - 1));
  assert.equal(seen.length, 0, 'ingenting sendes videre før rammen er hel');
  client._onData(whole.subarray(whole.length - 1));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].fields[1], 9n);
});

test('ramming: en stor nyttelast delt i to biter tolkes riktig', () => {
  const { client, seen } = fakeClient();
  // 300 bytes -> lengden krever to varint-bytes, som også skal tåle å bli delt.
  const body = Buffer.concat([Buffer.from([(1 << 3) | 2]), encodeVarint(300), Buffer.alloc(300, 0x41)]);
  const whole = frame(30, body);
  client._onData(whole.subarray(0, 2));
  client._onData(whole.subarray(2));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].fields[1].length, 300);
});

// Wire-primitivene tolker bytes fra nettverket — en stille regresjon her gir
// feil som ser ut som maskinvareproblemer. Derfor testes de eksplisitt.

test('varint går rundtur for hele verdiområdet vi bruker', () => {
  const values = [0n, 1n, 127n, 128n, 300n, 65535n, 2n ** 31n, 0xD7CCF2D78A4En];
  for (const value of values) {
    const encoded = encodeVarint(value);
    const decoded = decodeVarint(encoded, 0);
    assert.equal(decoded.value, value, `verdi ${value}`);
    assert.equal(decoded.offset, encoded.length, `offset for ${value}`);
  }
});

test('varint: 48-bits BLE-adresse overlever uten presisjonstap', () => {
  // Adressen til Bed 5406. Number ville mistet presisjon over 2^53.
  const address = 0xD7CCF2D78A4En;
  assert.equal(decodeVarint(encodeVarint(address), 0).value, address);
});

test('decodeVarint på ufullstendig buffer gir null, ikke kast', () => {
  // Halv varint (fortsettelsesbit satt, ingen neste byte) — skjer midt i en
  // TCP-strøm og skal bety «vent på mer data».
  assert.equal(decodeVarint(Buffer.from([0x80]), 0), null);
});

test('decodeFields håndterer varint-, bytes- og fixed32-felter', () => {
  const buf = Buffer.concat([
    Buffer.from([(1 << 3) | 0, 5]),                       // felt 1, varint 5
    Buffer.from([(2 << 3) | 2, 3]), Buffer.from('abc'),   // felt 2, bytes 'abc'
    Buffer.from([(3 << 3) | 5, 0x2a, 0, 0, 0]),           // felt 3, fixed32 42
  ]);
  const fields = decodeFields(buf);
  assert.equal(fields[1], 5n);
  assert.equal(fields[2].toString('utf8'), 'abc');
  assert.equal(fields[3], 42);
});

test('gjentatte felter samles i array', () => {
  const item = (text) => Buffer.concat([
    Buffer.from([(1 << 3) | 2, text.length]), Buffer.from(text),
  ]);
  const fields = decodeFields(Buffer.concat([item('ab'), item('cd'), item('ef')]));
  assert.ok(Array.isArray(fields[1]));
  assert.deepEqual(fields[1].map((b) => b.toString('utf8')), ['ab', 'cd', 'ef']);
});

// TCP er en bytestrøm. En ramme kan komme avkuttet, og et lengdefelt kan lyve.
// Ingen av delene skal kaste ut av dekoderen — da ville en enkelt rar pakke fra
// proxyen tatt ned kommandoen som ventet på svar.

test('decodeFields stopper pent på avkuttet fixed32', () => {
  // Felt 3, wire 5, men bare to av fire bytes kom med.
  const buf = Buffer.from([(1 << 3) | 0, 5, (3 << 3) | 5, 0x2a, 0x00]);
  const fields = decodeFields(buf);
  assert.equal(fields[1], 5n, 'feltet før det avkuttede skal være med');
  assert.equal(fields[3], undefined, 'det avkuttede feltet skal ikke dukke opp');
});

test('decodeFields stopper pent på avkuttet fixed64', () => {
  const buf = Buffer.from([(1 << 3) | 0, 7, (2 << 3) | 1, 0x01, 0x02, 0x03]);
  const fields = decodeFields(buf);
  assert.equal(fields[1], 7n);
  assert.equal(fields[2], undefined);
});

test('decodeFields godtar ikke et lengdefelt som peker forbi bufferet', () => {
  // Felt 2 lover 200 bytes, men bufferet har tre. Uten grensesjekk ble en
  // kortere buffer levert som om den var hel.
  const buf = Buffer.concat([
    Buffer.from([(1 << 3) | 0, 9]),
    Buffer.from([(2 << 3) | 2, 200]), Buffer.from('abc'),
  ]);
  const fields = decodeFields(buf);
  assert.equal(fields[1], 9n);
  assert.equal(fields[2], undefined);
});

test('decodeFields kaster ikke på vilkårlig søppel', () => {
  for (let byte = 0; byte < 256; byte++) {
    assert.doesNotThrow(() => decodeFields(Buffer.from([byte, byte, byte])));
  }
});

test('parseAdvertisementData leser navn, 16-bits og 128-bits tjenester', () => {
  // Slik sengene faktisk annonserer: flaggstruktur + navn i scan response,
  // pluss konstruerte tjenestefelter for å dekke begge UUID-lengdene.
  const uuid128le = Buffer.from('8af715029c00498a2410a338010 0fa99'.replace(/ /g, ''), 'hex').reverse();
  const ad = Buffer.concat([
    Buffer.from([0x02, 0x01, 0x04]),                       // Flags: BR/EDR ikke støttet
    Buffer.from([0x09, 0x09]), Buffer.from('Bed 5406'),    // Fullt navn
    Buffer.from([0x03, 0x03, 0x0f, 0x18]),                 // 16-bit tjeneste 0x180f
    Buffer.concat([Buffer.from([0x11, 0x07]), Buffer.from(uuid128le).reverse()]),  // 128-bit
  ]);
  const parsed = parseAdvertisementData(ad);
  assert.equal(parsed.localName, 'Bed 5406');
  // 16-bits utvides med Bluetooth Base UUID slik Homey oppgir dem.
  assert.ok(parsed.serviceUuids.includes('0000180f00001000800000805f9b34fb'));
  assert.equal(parsed.serviceUuids.length, 2);
});

test('parseAdvertisementData tåler søppel uten å kaste', () => {
  // Lengdebyte som peker forbi bufferet — forekommer ved avkuttede pakker.
  const parsed = parseAdvertisementData(Buffer.from([0x1f, 0x09, 0x41]));
  assert.equal(parsed.localName, '');
  assert.deepEqual(parsed.serviceUuids, []);
});
