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
  'drivers/bed_light/device.js',
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

// Samme feilklasse på den andre siden av paringen: visningen sender et navn
// ingen setHandler lytter på. Homey svarer da med en tidsavbrutt emit og
// ingenting i loggen som peker på årsaken, mens både HTML og JS er feilfri.
//
// onPair og onRepair har hvert sitt sett med lyttere, så de må sjekkes hver for
// seg: search_beds finnes bare i paringen, resetConnection bare i reparasjonen.
test('hver Homey.emit i paringsvisningene har en setHandler i driveren', () => {
  const driver = fs.readFileSync(path.join(__dirname, '..', 'drivers/bed/driver.js'), 'utf8');

  const split = driver.indexOf('async onRepair(');
  assert.ok(split > 0, 'fant ikke onRepair i driveren');

  const handlers = (source) => new Set(
    [...source.matchAll(/setHandler\(\s*'([^']+)'/g)].map((m) => m[1]),
  );

  const sections = {
    pair: handlers(driver.slice(0, split)),
    repair: handlers(driver.slice(split)),
  };

  let checked = 0;
  for (const [section, known] of Object.entries(sections)) {
    const dir = path.join(__dirname, '..', 'drivers/bed', section);
    for (const file of fs.readdirSync(dir).filter((name) => name.endsWith('.html'))) {
      const view = fs.readFileSync(path.join(dir, file), 'utf8');
      for (const [, event] of view.matchAll(/Homey\.emit\(\s*'([^']+)'/g)) {
        checked += 1;
        assert.ok(
          known.has(event),
          `${section}/${file} sender '${event}', som ingen setHandler i ${section} lytter på`,
        );
      }
    }
  }

  assert.ok(checked > 0, 'fant ingen Homey.emit i visningene å sjekke');
});
// Samme feilklasse en tredje gang: et kortnavn som ikke finnes noe sted.
// getDeviceTriggerCard kaster da, og uten denne testen ville en skrivefeil i
// en trigger-id bare blitt en linje i enhetsloggen som ingen leser.
test('hver Flow-trigger enheten fyrer av finnes i manifestet', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8'));
  const declared = new Set(((manifest.flow || {}).triggers || []).map((card) => card.id));

  let checked = 0;
  for (const [name, file] of DEVICES) {
    const source = fs.readFileSync(file, 'utf8');
    for (const [, id] of source.matchAll(/_trigger\(\s*'([^']+)'/g)) {
      checked += 1;
      assert.ok(declared.has(id), `${name} fyrer '${id}', som ikke er erklaert i app.json`);
    }
    // Og tokenene: et navn som ikke staar i kortet blir stille borte i flowen.
    for (const [, id, body] of source.matchAll(/_trigger\(\s*'([^']+)'\s*,\s*\{([^}]*)\}/g)) {
      const card = ((manifest.flow || {}).triggers || []).find((c) => c.id === id);
      if (!card) continue;
      const names = new Set((card.tokens || []).map((token) => token.name));
      // Del paa komma og ta FORSTE navn i hver bit. Et enklere monster leser
      // verdien i { command: section } som om den var et tokennavn.
      for (const part of body.split(',')) {
        const match = part.match(/^\s*([A-Za-z_$][\w$]*)\s*(?::|$)/);
        if (!match) continue;
        const key = match[1];
        assert.ok(names.has(key), `${id} far tokenet '${key}', som ikke finnes i kortet`);
      }
    }
  }

  assert.ok(checked > 0, 'fant ingen Flow-triggere a sjekke');
});
