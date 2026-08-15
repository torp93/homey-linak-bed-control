'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ADDRESS_TYPE,
  BED_COMMANDS,
  encodeCommand,
  guessAddressType,
  isLinakBed,
  isMotorCommand,
  resolveAddressType,
  resolveHandles,
} = require('../lib/linak-bed-protocol');

test('kommandorammen er to bytes: [kode, 0x00]', () => {
  assert.deepEqual([...encodeCommand('legUp')], [0x09, 0x00]);
  assert.deepEqual([...encodeCommand('legDown')], [0x08, 0x00]);
  assert.deepEqual([...encodeCommand('backUp')], [0x0b, 0x00]);
  assert.deepEqual([...encodeCommand('backDown')], [0x0a, 0x00]);
  assert.deepEqual([...encodeCommand('lightOn')], [0x92, 0x00]);
  assert.deepEqual([...encodeCommand('lightOff')], [0x93, 0x00]);
  assert.deepEqual([...encodeCommand('stop')], [0xff, 0x00]);
});

test('ukjent kommando avvises i stedet for å sende søppel til sengen', () => {
  assert.throws(() => encodeCommand('headUp'), RangeError);
});

test('0x03 er IKKE hodeenden på TD4 — den øvre delen er 0x0B', () => {
  // Dokumentasjonen kaller 0x03 "head up". Fysisk testing viste at den ikke
  // gjør noe, og at den øvre seksjonen svarer på 0x0B. Testen låser funnet.
  assert.equal(BED_COMMANDS.backUp, 0x0b);
  assert.equal(BED_COMMANDS.backDown, 0x0a);
  assert.ok(!('headUp' in BED_COMMANDS));
});

test('de kombinerte bevegelsene er egne koder i 0x3x', () => {
  // Alle fire verifisert fysisk 2026-08-12. Fletting av enkeltkanaler ble
  // prøvd først og ga ingen bevegelse i det hele tatt — hver ny kanalkommando
  // avbryter den forrige, så kombinert kjøring MÅ ha sin egen kode.
  assert.deepEqual([...encodeCommand('bothDown')], [0x34, 0x00]);
  assert.deepEqual([...encodeCommand('sitUp')], [0x35, 0x00]);
  assert.deepEqual([...encodeCommand('legRelief')], [0x36, 0x00]);
  assert.deepEqual([...encodeCommand('bothUp')], [0x37, 0x00]);
});

test('alt appen kan sende koder til en tobyte-ramme', () => {
  for (const name of Object.keys(BED_COMMANDS)) {
    assert.equal(encodeCommand(name).length, 2, name + ' ga feil rammelengde');
  }
});

test('bare motorkommandoer gjentas', () => {
  assert.ok(isMotorCommand('legUp'));
  assert.ok(isMotorCommand('backDown'));
  // Kombinerte bevegelser må også gjentas, ellers stopper motorene straks.
  assert.ok(isMotorCommand('bothUp'));
  assert.ok(isMotorCommand('bothDown'));
  // Lys må ikke gjentas og skal ikke etterfølges av stopp.
  assert.ok(!isMotorCommand('lightOn'));
  assert.ok(!isMotorCommand('stop'));
});

test('den annonserte adressetypen vinner over gjetning', () => {
  // Dette er hele poenget: ESPHome rapporterer typen, og den er autoritativ.
  assert.equal(resolveAddressType('94:A9:A8:2D:77:EF', ADDRESS_TYPE.PUBLIC), ADDRESS_TYPE.PUBLIC);
  assert.equal(resolveAddressType('00:11:22:33:44:55', ADDRESS_TYPE.RANDOM), ADDRESS_TYPE.RANDOM);
});

test('uten annonsert type faller vi tilbake på gjetning', () => {
  for (const missing of [null, undefined, 7, 'random']) {
    assert.equal(resolveAddressType('D7:CC:F2:D7:8A:4E', missing), ADDRESS_TYPE.RANDOM);
  }
});

test('gjetningen treffer sengene, som er random static', () => {
  // 0xD7 og 0xF9 har begge de to øverste bitene satt — random static.
  assert.equal(guessAddressType('D7:CC:F2:D7:8A:4E'), ADDRESS_TYPE.RANDOM);
  assert.equal(guessAddressType('F9:A0:BE:5F:BF:A6'), ADDRESS_TYPE.RANDOM);
});

test('gjetningen er bevisst konservativ for alt annet', () => {
  // Geberit-toalettet er 94:A9:… — public, selv om øverste bit er satt.
  // Bitmønsteret definerer bare undertypen av RANDOM-adresser; for public
  // adresser er det en del av OUI-en og betyr ingenting.
  assert.equal(guessAddressType('94:A9:A8:2D:77:EF'), ADDRESS_TYPE.PUBLIC);
  assert.equal(guessAddressType('00:11:22:33:44:55'), ADDRESS_TYPE.PUBLIC);
});

test('ugyldig MAC gir en tydelig feil', () => {
  assert.throws(() => guessAddressType('ikke-en-mac'), TypeError);
});

test('senger kjennes igjen på navnemønsteret Bed NNNN', () => {
  assert.ok(isLinakBed({ localName: 'Bed 5406' }));
  assert.ok(isLinakBed({ localName: 'Bed 9062' }));
  assert.ok(!isLinakBed({ localName: 'DESK 4601' }));
  assert.ok(!isLinakBed({ localName: 'Geberit AC PRO' }));
  assert.ok(!isLinakBed({ localName: '' }));
});

test('senger kjennes også igjen på 99fa-tjenesten alene', () => {
  // Sengene annonserer ikke tjeneste-UUID, men skulle en variant gjøre det,
  // skal den fanges uten å være avhengig av navnet.
  assert.ok(isLinakBed({ localName: 'Ukjent', serviceUuids: ['99fa0001338a10248a49009c0215f78a'] }));
});

const SERVICES = [
  {
    uuid: '99fa0001338a10248a49009c0215f78a',
    handle: 14,
    characteristics: [
      { uuid: '99fa0002338a10248a49009c0215f78a', handle: 16, properties: 0x0c, cccdHandle: null },
      { uuid: '99fa0003338a10248a49009c0215f78a', handle: 18, properties: 0x12, cccdHandle: 19 },
    ],
  },
  {
    uuid: '99fa0010338a10248a49009c0215f78a',
    handle: 20,
    characteristics: [
      { uuid: '99fa0011338a10248a49009c0215f78a', handle: 22, properties: 0x1e, cccdHandle: 23 },
    ],
  },
];

test('handles slås opp fra tjenestetreet i stedet for å hardkodes', () => {
  const handles = resolveHandles(SERVICES);
  assert.equal(handles.commandHandle, 16);
  assert.equal(handles.statusHandle, 18);
  assert.equal(handles.statusCccdHandle, 19);
  assert.equal(handles.dpgHandle, 22);
});

test('UUID-er matches uavhengig av bindestreker og store bokstaver', () => {
  const dashed = [{
    uuid: '99FA0001-338A-1024-8A49-009C0215F78A',
    handle: 14,
    characteristics: [
      { uuid: '99FA0002-338A-1024-8A49-009C0215F78A', handle: 16, cccdHandle: null },
    ],
  }];
  assert.equal(resolveHandles(dashed).commandHandle, 16);
});

test('en enhet uten kommandokarakteristikk avvises med en forklarende feil', () => {
  assert.throws(() => resolveHandles([]), /99fa0002/);
});
