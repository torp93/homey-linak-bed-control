'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  NoiseSession, parseKey, frame, PROTOCOL_NAME,
  SymmetricState, TransportKey, x25519, HANDSHAKE_STATUS_OK,
} = require('../lib/esphome-noise');

// Krypteringen kan ikke prøves halvveis: enten går håndtrykket igjennom og alt
// virker, eller så faller alt. Testene her bygger derfor RESPONDEREN, altså
// ESP-ens side, av de samme byggeklossene og kjører et helt håndtrykk mot
// klienten. Det beviser at tilstandsmaskinen vår er konsistent. At den er
// riktig mot ekte ESPHome er noe bare maskinvaren kan si, og det er gjort.

const PROLOGUE = Buffer.from('NoiseAPIInit', 'ascii');
const EMPTY = Buffer.alloc(0);

// Skreller rammehodet av: 0x01 + lengde (2 byte, big endian).
function unframe(buf) {
  assert.equal(buf[0], 0x01, 'rammen skal starte med indikatorbyten');
  const length = buf.readUInt16BE(1);
  assert.equal(buf.length, 3 + length, 'lengden i hodet skal stemme med rammen');
  return buf.subarray(3);
}

// ESP-ens side av håndtrykket, bygget av de samme primitivene.
function responder(psk, clientHello = EMPTY) {
  const ss = new SymmetricState(PROTOCOL_NAME);
  const helloLength = Buffer.alloc(2);
  helloLength.writeUInt16BE(clientHello.length, 0);
  ss.mixHash(Buffer.concat([PROLOGUE, helloLength, clientHello]));
  ss.mixKeyAndHash(psk);

  return {
    // Serveren svarer først med navn og MAC.
    hello(name = 'linak-bed-proxy', mac = 'E8:3D:C1:83:E7:E4') {
      return frame(Buffer.concat([
        Buffer.from([0x01]),
        Buffer.from(name, 'utf8'), Buffer.from([0x00]),
        Buffer.from(mac, 'utf8'), Buffer.from([0x00]),
      ]));
    },

    // Leser klientens melding og svarer med sin egen.
    answer(clientFrame) {
      const payload = unframe(clientFrame);
      assert.equal(payload[0], HANDSHAKE_STATUS_OK);
      const message = payload.subarray(1);

      const remote = message.subarray(0, 32);
      ss.mixHash(remote);
      ss.mixKey(remote);
      ss.decryptAndHash(message.subarray(32));

      const ephemeral = x25519.generate();
      ss.mixHash(ephemeral.raw);
      ss.mixKey(ephemeral.raw);
      ss.mixKey(x25519.shared(ephemeral.privateKey, remote));
      const out = Buffer.concat([ephemeral.raw, ss.encryptAndHash(EMPTY)]);

      const [fromClient, toClient] = ss.split();
      this.open = new TransportKey(fromClient);
      this.seal = new TransportKey(toClient);

      return frame(Buffer.concat([Buffer.from([HANDSHAKE_STATUS_OK]), out]));
    },
  };
}

function handshake(key = crypto.randomBytes(32), responderKey = key) {
  const session = new NoiseSession(key);
  const esp = responder(responderKey);

  const [hello] = session.start();
  assert.equal(unframe(hello).length, 0, 'klient-hello er tom');

  const [clientHandshake] = session.readHandshakeFrame(unframe(esp.hello()));
  const sent = session.readHandshakeFrame(unframe(esp.answer(clientHandshake)));
  assert.deepEqual(sent, [], 'ingenting mer skal sendes når håndtrykket er ferdig');

  return { session, esp };
}

test('håndtrykket fullfører og setter opp begge retninger', () => {
  const { session } = handshake();
  assert.equal(session.isReady, true);
  assert.equal(session.serverName, 'linak-bed-proxy');
  assert.equal(session.serverMac, 'E8:3D:C1:83:E7:E4');
});

test('melding fra appen leses riktig av den andre siden', () => {
  const { session, esp } = handshake();

  // DeviceInfoRequest, type 9, uten nyttelast, slik appen faktisk sender den.
  const empty = esp.open.open(unframe(session.encodeMessage(9, EMPTY)));
  assert.equal(empty.readUInt16BE(0), 9);
  assert.equal(empty.readUInt16BE(2), 0);

  // Og en med innhold: BLE-skriving er den største meldingen appen sender.
  const payload = Buffer.from([0x08, 0x0b, 0x10, 0x00]);
  const plain = esp.open.open(unframe(session.encodeMessage(75, payload)));
  assert.equal(plain.readUInt16BE(0), 75);
  assert.equal(plain.readUInt16BE(2), payload.length);
  assert.deepEqual(plain.subarray(4), payload);
});

test('melding fra proxyen leses riktig av appen', () => {
  const { session, esp } = handshake();

  const body = Buffer.from([0x0d, 0x0a, 0x01]);
  const head = Buffer.alloc(4);
  head.writeUInt16BE(67, 0);
  head.writeUInt16BE(body.length, 2);

  const incoming = esp.seal.seal(Buffer.concat([head, body]));
  const message = session.decodeMessage(incoming);
  assert.equal(message.type, 67);
  assert.deepEqual(message.payload, body);
});

test('tellerne går oppover, så to like meldinger ikke gir like rammer', () => {
  const { session, esp } = handshake();

  const first = unframe(session.encodeMessage(7, EMPTY));
  const second = unframe(session.encodeMessage(7, EMPTY));
  assert.notDeepEqual(first, second, 'samme nyttelast skal ikke gi samme chiffertekst');

  // Og begge skal fortsatt kunne åpnes, i rekkefølge.
  assert.equal(esp.open.open(first).readUInt16BE(0), 7);
  assert.equal(esp.open.open(second).readUInt16BE(0), 7);
});

test('feil nøkkel: responderen klarer ikke å åpne klientens melding', () => {
  const session = new NoiseSession(crypto.randomBytes(32));
  const esp = responder(crypto.randomBytes(32));

  session.start();
  const [clientHandshake] = session.readHandshakeFrame(unframe(esp.hello()));
  // Dette er nøyaktig det ESP-en gjør når nøkkelen er feil: MAC-en stemmer ikke.
  assert.throws(() => esp.answer(clientHandshake), /unable to authenticate|bad decrypt|Unsupported state/i);
});

test('avvisning med MAC failure forklares som feil nøkkel, ikke som rekkevidde', () => {
  const session = new NoiseSession(crypto.randomBytes(32));
  session.start();
  session.readHandshakeFrame(unframe(responder(crypto.randomBytes(32)).hello()));

  const reject = Buffer.concat([
    Buffer.from([0x01]),
    Buffer.from('Handshake MAC failure', 'utf8'),
  ]);
  assert.throws(() => session.readHandshakeFrame(reject), /encryption key is wrong/);
});

test('ukjent API-protokoll fra proxyen sier fra i stedet for å henge', () => {
  const session = new NoiseSession(crypto.randomBytes(32));
  session.start();
  assert.throws(() => session.readHandshakeFrame(Buffer.from([0x02, 0x61, 0x00])), /protocol 2/);
});

test('nøkkelen tåler hermetegn og mellomrom fra YAML-en', () => {
  const key = crypto.randomBytes(32).toString('base64');
  assert.deepEqual(parseKey(`  "${key}"  `), Buffer.from(key, 'base64'));
  assert.throws(() => parseKey('hallo'), /32 bytes of base64/);
  assert.throws(() => parseKey(''), /No encryption key/);
});

test('rammehodet er indikator pluss lengde i big endian', () => {
  const payload = Buffer.alloc(300, 0x41);
  const built = frame(payload);
  assert.equal(built[0], 0x01);
  assert.equal(built.readUInt16BE(1), 300);
  assert.equal(built.length, 303);
});

test('for kort melding avvises i stedet for å leses som søppel', () => {
  const { session, esp } = handshake();
  const short = esp.seal.seal(Buffer.from([0x00, 0x09]));
  assert.throws(() => session.decodeMessage(short), /too short/);
});
// Og så hele klienten, mot en falsk kryptert ESPHome over ekte TCP. Det er
// denne som fanger feil i sammenkoblingen: rammelesing, rekkefølgen på
// håndtrykk og HELLO, og at meldinger etterpå går begge veier.
const net = require('node:net');
const { EsphomeApiClient } = require('../lib/esphome-api');

const varintField = (no, value) => {
  const out = [(no << 3) | 0];
  let v = value;
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; out.push(b); } while (v);
  return Buffer.from(out);
};
const stringField = (no, text) => {
  const body = Buffer.from(text, 'utf8');
  return Buffer.concat([Buffer.from([(no << 3) | 2]), Buffer.from([body.length]), body]);
};

function fakeProxy(key, { name = 'linak-bed-proxy' } = {}) {
  const esp = responder(key);
  let rx = Buffer.alloc(0);
  let ready = false;

  const server = net.createServer((socket) => {
    const reply = (type, payload) => {
      const head = Buffer.alloc(4);
      head.writeUInt16BE(type, 0);
      head.writeUInt16BE(payload.length, 2);
      socket.write(frame(esp.seal.seal(Buffer.concat([head, payload]))));
    };

    socket.on('data', (chunk) => {
      rx = Buffer.concat([rx, chunk]);
      for (;;) {
        if (rx.length < 3) return;
        const length = rx.readUInt16BE(1);
        if (rx.length < 3 + length) return;
        const payload = rx.subarray(3, 3 + length);
        rx = rx.subarray(3 + length);

        if (!ready && !esp.seal) {
          // Første ramme er klient-hello, andre er selve håndtrykket.
          if (payload.length === 0) {
            socket.write(esp.hello(name));
          } else {
            try {
              socket.write(esp.answer(frame(payload)));
              ready = true;
            } catch (error) {
              // Slik ESPHome gjør det: statusbyte 1 og begrunnelsen, så lukk.
              socket.write(frame(Buffer.concat([
                Buffer.from([0x01]), Buffer.from('Handshake MAC failure', 'utf8'),
              ])));
              socket.end();
              return;
            }
          }
          continue;
        }

        const plain = esp.open.open(payload);
        const type = plain.readUInt16BE(0);
        if (type === 1) {
          reply(2, Buffer.concat([
            varintField(1, 1), varintField(2, 16),
            stringField(3, '2026.9.1'), stringField(4, name),
          ]));
        } else if (type === 9) {
          reply(10, Buffer.concat([
            stringField(2, name), stringField(3, 'E8:3D:C1:83:E7:E4'),
            stringField(4, '2026.9.1'), stringField(6, 'esp32c3'),
            varintField(15, 1),
          ]));
        }
      }
    });
  });

  return server;
}

test('klienten kobler til en kryptert proxy og snakker med den', async () => {
  const key = crypto.randomBytes(32);
  const server = fakeProxy(key);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const client = new EsphomeApiClient({
    host: '127.0.0.1', port, encryptionKey: key.toString('base64'),
  });
  client.on('error', () => {});

  try {
    const hello = await client.connect({ timeoutMs: 5000 });
    assert.equal(hello.name, 'linak-bed-proxy');
    assert.equal(hello.serverInfo, '2026.9.1');
    assert.equal(client.isConnected, true);

    const info = await client.deviceInfo(5000);
    assert.equal(info.macAddress, 'E8:3D:C1:83:E7:E4');
    assert.equal(info.model, 'esp32c3');
    assert.equal(info.bluetoothProxyFeatureFlags, 1);
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});

test('feil nøkkel gir en feil som peker på nøkkelen', async () => {
  const server = fakeProxy(crypto.randomBytes(32));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const client = new EsphomeApiClient({
    host: '127.0.0.1', port, encryptionKey: crypto.randomBytes(32).toString('base64'),
  });
  client.on('error', () => {});

  try {
    await assert.rejects(client.connect({ timeoutMs: 5000 }), /encryption key is wrong/);
  } finally {
    await client.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
  }
});
