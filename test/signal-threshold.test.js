'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { crossedBelow } = require('../lib/signal-threshold');

// Kryssingen er hele poenget med kortet. Fyrer det på hver måling under
// nivået, varsler det deg hver sjette time til sengen flyttes, og da slår man
// det av i stedet for å fikse signalet.

test('fyrer når målingen krysser nivået på vei ned', () => {
  assert.equal(crossedBelow({ signal: -88, previous: -70 }, -85), true);
  assert.equal(crossedBelow({ signal: -86, previous: -85 }, -85), true);
});

test('fyrer ikke når den allerede lå under', () => {
  assert.equal(crossedBelow({ signal: -90, previous: -88 }, -85), false);
  assert.equal(crossedBelow({ signal: -90, previous: -90 }, -85), false);
});

test('fyrer ikke når målingen er over nivået', () => {
  assert.equal(crossedBelow({ signal: -70, previous: -90 }, -85), false);
  // Nøyaktig på nivået er ikke under det.
  assert.equal(crossedBelow({ signal: -85, previous: -70 }, -85), false);
});

test('første måling teller som en kryssing', () => {
  assert.equal(crossedBelow({ signal: -90, previous: null }, -85), true);
  assert.equal(crossedBelow({ signal: -90 }, -85), true);
  // Men bare når den faktisk er under.
  assert.equal(crossedBelow({ signal: -60, previous: null }, -85), false);
});

test('tall som ikke er tall gir ingen utløsning', () => {
  assert.equal(crossedBelow({ signal: null, previous: -70 }, -85), false);
  assert.equal(crossedBelow({ signal: -90, previous: -70 }, null), false);
  assert.equal(crossedBelow({}, -85), false);
  assert.equal(crossedBelow(undefined, -85), false);
});

test('nivået er per flow, så samme måling kan krysse ett og ikke et annet', () => {
  const measurement = { signal: -88, previous: -70 };
  assert.equal(crossedBelow(measurement, -85), true);
  assert.equal(crossedBelow(measurement, -95), false);
});
