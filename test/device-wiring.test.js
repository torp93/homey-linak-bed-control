'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Enhetsklassene kan ikke lastes her — de krever `homey`, som bare finnes på
// Homeyen. Men den feilen som faktisk har rammet appen er triviell å fange
// statisk: en kapabilitetslytter som peker på en metode som ikke finnes.
//
// Det skjedde i 1.0.25: lytteren ble koblet om til refreshStatus(), metoden ble
// aldri lagt inn, og resultatet var «this.refreshStatus is not a function» på
// telefonen. Koden var syntaktisk feilfri hele veien.

// Arvet fra Homeys Device — de står ikke i filene, men finnes på enheten.
const INHERITED = [
  'getName', 'getData', 'getSetting', 'getSettings', 'setSettings',
  'getStoreValue', 'setStoreValue', 'unsetStoreValue',
  'getCapabilityValue', 'setCapabilityValue', 'hasCapability',
  'getAvailable', 'setAvailable', 'setUnavailable', 'log', 'error',
];

const DEVICES = [
  'drivers/bed/device.js',
  'drivers/all_beds/device.js',
].map((file) => [file, path.join(__dirname, '..', file)]);

for (const [name, file] of DEVICES) {
  test(`${name}: hver kapabilitetslytter peker på en metode som finnes`, () => {
    const source = fs.readFileSync(file, 'utf8');

    // Metodene klassen faktisk definerer: «  navn(» eller «  async navn(» på
    // innrykksnivået til en klassekropp.
    const defined = new Set(
      [...source.matchAll(/^ {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]),
    );
    for (const method of INHERITED) defined.add(method);

    // Kallene lytterne gjør: this.noe(...)
    //
    // Mønsteret må gå helt fram til «);» som avslutter registreringen. Et
    // ikke-grådig stopp på første parentes lander midt i «() =>» og ser aldri
    // selve kallet — den varianten passerte med metoden fjernet.
    const listeners = [...source.matchAll(
      /registerCapabilityListener\(\s*'([^']+)'\s*,([\s\S]*?)\);\r?\n/g,
    )].map(([, capability, body]) => [body, capability]);

    assert.ok(listeners.length > 0, 'fant ingen kapabilitetslyttere å sjekke');

    for (const [block, capability] of listeners) {
      for (const [, method] of block.matchAll(/this\.([A-Za-z_$][\w$]*)\s*\(/g)) {
        // runOnAll tar en funksjon som kaller metoder på SENGEN, ikke på gruppa.
        if (method === 'runOnAll') continue;
        assert.ok(
          defined.has(method),
          `${capability} kaller this.${method}(), som ikke er definert i ${name}`,
        );
      }
    }
  });
}

test('gruppa kaller kun metoder som finnes på en seng', () => {
  const group = fs.readFileSync(path.join(__dirname, '..', 'drivers/all_beds/device.js'), 'utf8');
  const bed = fs.readFileSync(path.join(__dirname, '..', 'drivers/bed/device.js'), 'utf8');

  const bedMethods = new Set([
    ...[...bed.matchAll(/^ {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]),
    ...INHERITED,
  ]);

  // runOnAll((bed) => bed.noe(...)) — gruppa fjernstyrer sengene, så et navn
  // som er endret på sengen må ikke bli hengende igjen her.
  const calls = [...group.matchAll(/\bbed\.([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]);
  assert.ok(calls.length > 0, 'fant ingen kall videre til sengene');

  for (const method of new Set(calls)) {
    assert.ok(bedMethods.has(method), `gruppa kaller bed.${method}(), som ikke finnes på sengen`);
  }
});
