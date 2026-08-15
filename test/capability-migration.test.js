'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { migrateCapabilities } = require('../lib/capability-migration');

// Full riv-og-bygg sletter Insights-historikk og er ikke-atomisk — derfor er
// kontrakten at den bare skjer når rekkefølgen faktisk krever det.

function fakeDevice(initial) {
  const caps = [...initial];
  const device = {
    added: [],
    removed: [],
    getCapabilities: () => [...caps],
    hasCapability: (c) => caps.includes(c),
    async addCapability(c) { caps.push(c); device.added.push(c); },
    async removeCapability(c) {
      const i = caps.indexOf(c);
      if (i >= 0) caps.splice(i, 1);
      device.removed.push(c);
    },
    log: () => {},
    error: () => {},
  };
  return device;
}

test('ingen endring gir ingen kall og returnerer false', async () => {
  const device = fakeDevice(['a', 'b', 'c']);
  const changed = await migrateCapabilities(device, ['a', 'b', 'c']);
  assert.equal(changed, false);
  assert.equal(device.added.length + device.removed.length, 0);
});

test('ny kapabilitet SIST i lista legges til inkrementelt — ingen riving', async () => {
  const device = fakeDevice(['a', 'b']);
  const changed = await migrateCapabilities(device, ['a', 'b', 'c']);
  assert.equal(changed, true);
  assert.deepEqual(device.added, ['c']);
  assert.deepEqual(device.removed, []);
  assert.deepEqual(device.getCapabilities(), ['a', 'b', 'c']);
});

test('fjerning midt i lista skjer inkrementelt — rekkefølgen består', async () => {
  const device = fakeDevice(['a', 'gammel', 'b']);
  await migrateCapabilities(device, ['a', 'b']);
  assert.deepEqual(device.removed, ['gammel']);
  assert.deepEqual(device.added, []);
  assert.deepEqual(device.getCapabilities(), ['a', 'b']);
});

test('ny kapabilitet MIDT i lista utløser ombygging, og sluttresultatet er riktig', async () => {
  const device = fakeDevice(['a', 'c']);
  await migrateCapabilities(device, ['a', 'b', 'c']);
  // addCapability legger sist -> [a, c, b] -> rekkefølge feil -> full ombygging.
  assert.deepEqual(device.getCapabilities(), ['a', 'b', 'c']);
  assert.ok(device.removed.length >= 2, 'ombyggingen fjernet eksisterende');
});

test('ren ombytting av rekkefølge bygger om', async () => {
  const device = fakeDevice(['b', 'a']);
  const changed = await migrateCapabilities(device, ['a', 'b']);
  assert.equal(changed, true);
  assert.deepEqual(device.getCapabilities(), ['a', 'b']);
});

test('en enkelt feilende kapabilitet velter ikke resten', async () => {
  const device = fakeDevice(['a']);
  const originalAdd = device.addCapability;
  device.addCapability = async (c) => {
    if (c === 'b') throw new Error('nope');
    return originalAdd(c);
  };
  await migrateCapabilities(device, ['a', 'b', 'c']);
  // 'b' feilet, men 'c' skal likevel ha blitt forsøkt og lagt til.
  assert.ok(device.getCapabilities().includes('c'));
});
