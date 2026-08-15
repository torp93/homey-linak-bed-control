'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_HOST,
  DEFAULT_PORT,
  isValidHost,
  isValidPort,
  resolveProxyConfig,
} = require('../lib/proxy-config');

const settingsFrom = (values) => ({ get: (key) => values[key] });

test('faller tilbake til proxyens faste IP når ingenting er lagret', () => {
  const config = resolveProxyConfig(settingsFrom({}));
  assert.equal(config.host, DEFAULT_HOST);
  assert.equal(config.port, DEFAULT_PORT);
  assert.equal(config.source, 'fallback');
});

test('appinnstillinger overstyrer fallbacken', () => {
  const config = resolveProxyConfig(settingsFrom({ proxyHost: '192.168.10.99', proxyPort: 6054 }));
  assert.equal(config.host, '192.168.10.99');
  assert.equal(config.port, 6054);
  assert.equal(config.source, 'settings');
});

test('mellomrom rundt verten trimmes bort', () => {
  assert.equal(resolveProxyConfig(settingsFrom({ proxyHost: '  10.0.0.5  ' })).host, '10.0.0.5');
});

test('ugyldig vert ignoreres i stedet for å ta ned appen', () => {
  // env.json kommer stille tomt på Homey Pro, så tomme og rare verdier er
  // en realistisk tilstand og må ikke gi krasj ved oppstart.
  for (const bad of ['', '   ', 'http://10.0.0.5', '10.0.0.5:6053', '10.0.0.5/path', null, 42]) {
    assert.equal(resolveProxyConfig(settingsFrom({ proxyHost: bad })).host, DEFAULT_HOST);
  }
});

test('ugyldig port ignoreres', () => {
  for (const bad of [0, -1, 65536, 6053.5, 'seks', null]) {
    assert.equal(resolveProxyConfig(settingsFrom({ proxyPort: bad })).port, DEFAULT_PORT);
  }
});

test('resolveProxyConfig tåler å bli kalt uten innstillinger', () => {
  assert.equal(resolveProxyConfig(undefined).host, DEFAULT_HOST);
  assert.equal(resolveProxyConfig(null).port, DEFAULT_PORT);
  assert.equal(resolveProxyConfig({}).source, 'fallback');
});

test('validatorene er strenge om formatet', () => {
  assert.ok(isValidHost('esphome.local'));
  assert.ok(isValidHost('192.168.10.14'));
  assert.ok(!isValidHost('a'.repeat(254)));
  assert.ok(isValidPort(6053));
  assert.ok(!isValidPort(70000));
});
