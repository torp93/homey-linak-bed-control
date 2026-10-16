'use strict';

// Kryptert ESPHome-API: Noise_NNpsk0_25519_ChaChaPoly_SHA256.
//
// ESPHome lager krypteringsnøkkel som standard i nye oppsett, og en proxy som
// allerede gjør noe annet for brukeren har den som regel på. Uten dette laget
// må folk flashe brettet på nytt bare for å bruke appen.
//
// Alt her er skrevet mot ESPHomes egen serverkode (components/noise/noise.h og
// components/api/api_frame_helper_noise.cpp), ikke mot hukommelsen:
//
//   ramme          = 0x01, lengde (2 byte, big endian), nyttelast
//   håndtrykk      = statusbyte (0x00 = ok, 0x01 = avvist + begrunnelse)
//                    etterfulgt av Noise-meldingen
//   prologue       = "NoiseAPIInit" + lengden på klient-hello (2 byte) + selve
//                    klient-hello. Serveren bygger den av det VI sendte, så
//                    den må gjenskapes nøyaktig.
//   server-hello   = 0x01, enhetsnavn, 0x00, MAC, 0x00
//   transport      = kryptert(type (2 byte), lengde (2 byte), nyttelast)
//
// Ingen nye avhengigheter: X25519 og ChaCha20-Poly1305 ligger i Node selv.
// Det er et krav både for Homeys minne og for sertifiseringen.

const crypto = require('node:crypto');

const PROTOCOL_NAME = 'Noise_NNpsk0_25519_ChaChaPoly_SHA256';
const PROLOGUE_INIT = Buffer.from('NoiseAPIInit', 'ascii');

const FRAME_INDICATOR = 0x01;
const FRAME_HEADER_SIZE = 3;
const HANDSHAKE_STATUS_OK = 0x00;

// Denne teksten er en wire-kontrakt i ESPHome: den er den ene begrunnelsen
// klienter skal kjenne igjen, og den betyr alltid feil nøkkel.
const MAC_FAILURE = 'Handshake MAC failure';

const EMPTY = Buffer.alloc(0);

const sha256 = (...parts) => crypto.createHash('sha256').update(Buffer.concat(parts)).digest();
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// HKDF slik Noise definerer den: to eller tre utganger, hver avledet av den
// forrige. Ingen salt, ingen info.
function hkdf(chainingKey, input, outputs) {
  const temp = hmac(chainingKey, input);
  const one = hmac(temp, Buffer.from([0x01]));
  const two = hmac(temp, Buffer.concat([one, Buffer.from([0x02])]));
  if (outputs === 2) return [one, two];
  const three = hmac(temp, Buffer.concat([two, Buffer.from([0x03])]));
  return [one, two, three];
}

// Noise-nonce for ChaChaPoly: fire nullbytes, så telleren som 64-bits little
// endian. Feil rekkefølge her gir «MAC failure» som ser ut som feil nøkkel.
function nonceBuffer(counter) {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64LE(counter, 4);
  return nonce;
}

function encrypt(key, counter, ad, plaintext) {
  const cipher = crypto.createCipheriv('chacha20-poly1305', key, nonceBuffer(counter), {
    authTagLength: 16,
  });
  cipher.setAAD(ad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function decrypt(key, counter, ad, data) {
  if (data.length < 16) throw new Error('Encrypted frame is too short to hold its MAC');
  const tag = data.subarray(data.length - 16);
  const body = data.subarray(0, data.length - 16);
  const decipher = crypto.createDecipheriv('chacha20-poly1305', key, nonceBuffer(counter), {
    authTagLength: 16,
  });
  decipher.setAAD(ad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

// Noise-tilstanden: kjedenøkkel, hash og gjeldende symmetriske nøkkel.
class SymmetricState {
  constructor(protocolName) {
    const name = Buffer.from(protocolName, 'ascii');
    // Navnet er lengre enn 32 byte, så h starter som hashen av det.
    this.h = name.length <= 32
      ? Buffer.concat([name, Buffer.alloc(32 - name.length)])
      : sha256(name);
    this.ck = this.h;
    this.k = null;
    this.n = 0n;
  }

  mixHash(data) {
    this.h = sha256(this.h, data);
  }

  mixKey(input) {
    const [ck, k] = hkdf(this.ck, input, 2);
    this.ck = ck;
    this.k = k;
    this.n = 0n;
  }

  mixKeyAndHash(input) {
    const [ck, tempH, tempK] = hkdf(this.ck, input, 3);
    this.ck = ck;
    this.mixHash(tempH);
    this.k = tempK;
    this.n = 0n;
  }

  encryptAndHash(plaintext) {
    if (!this.k) {
      this.mixHash(plaintext);
      return plaintext;
    }
    const ciphertext = encrypt(this.k, this.n, this.h, plaintext);
    this.n += 1n;
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext) {
    if (!this.k) {
      this.mixHash(ciphertext);
      return ciphertext;
    }
    const plaintext = decrypt(this.k, this.n, this.h, ciphertext);
    this.n += 1n;
    this.mixHash(ciphertext);
    return plaintext;
  }

  split() {
    return hkdf(this.ck, EMPTY, 2);
  }
}

// En ferdig nøkkel med egen teller, én per retning.
class TransportKey {
  constructor(key) {
    this.key = key;
    this.counter = 0n;
  }

  seal(plaintext) {
    const out = encrypt(this.key, this.counter, EMPTY, plaintext);
    this.counter += 1n;
    return out;
  }

  open(ciphertext) {
    const out = decrypt(this.key, this.counter, EMPTY, ciphertext);
    this.counter += 1n;
    return out;
  }
}

const x25519 = {
  generate() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('x25519');
    const jwk = publicKey.export({ format: 'jwk' });
    return { publicKey, privateKey, raw: Buffer.from(jwk.x, 'base64url') };
  },
  // Råbytes til en nøkkel Node vil regne med. JWK er den eneste veien inn som
  // ikke krever håndbygd DER.
  fromRaw(raw) {
    return crypto.createPublicKey({
      key: { kty: 'OKP', crv: 'X25519', x: Buffer.from(raw).toString('base64url') },
      format: 'jwk',
    });
  },
  shared(privateKey, remoteRaw) {
    return crypto.diffieHellman({ privateKey, publicKey: x25519.fromRaw(remoteRaw) });
  },
};

// Pakker en nyttelast i ESPHomes rammeformat.
function frame(payload) {
  const header = Buffer.alloc(FRAME_HEADER_SIZE);
  header[0] = FRAME_INDICATOR;
  header.writeUInt16BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

// Normaliserer nøkkelen brukeren limer inn. ESPHome oppgir den som 32 byte i
// base64, og folk tar med mellomrom og anførselstegn fra YAML-en.
function parseKey(value) {
  const text = String(value || '').trim().replace(/^["']|["']$/g, '');
  if (!text) throw new Error('No encryption key was given.');
  const key = Buffer.from(text, 'base64');
  if (key.length !== 32) {
    throw new Error('That does not look like an ESPHome encryption key. It is 32 bytes of base64, as in the api: encryption: key: line.');
  }
  return key;
}

const STATE = Object.freeze({
  HELLO: 'hello',
  HANDSHAKE: 'handshake',
  READY: 'ready',
  FAILED: 'failed',
});

class NoiseSession {
  // `expectedName` sjekkes mot navnet serveren oppgir, når det er satt. Vi
  // kjenner sjelden navnet på forhånd, så standarden er å ikke kreve det.
  constructor(key, { expectedName = null } = {}) {
    this.psk = Buffer.isBuffer(key) ? key : parseKey(key);
    if (this.psk.length !== 32) throw new Error('The encryption key must be 32 bytes.');
    this.expectedName = expectedName;
    this.state = STATE.HELLO;
    this.serverName = null;
    this.serverMac = null;
    this._send = null;
    this._receive = null;
  }

  get isReady() {
    return this.state === STATE.READY;
  }

  // Klient-hello er tom. Innholdet ignoreres av serveren, men det inngår i
  // prologue, så det som sendes her må være det samme som regnes inn under.
  start() {
    this._clientHello = EMPTY;
    return [frame(this._clientHello)];
  }

  // Tar imot nyttelasten fra én ramme og svarer med rammene som skal sendes.
  readHandshakeFrame(payload) {
    if (this.state === STATE.HELLO) return this._readServerHello(payload);
    if (this.state === STATE.HANDSHAKE) return this._readHandshake(payload);
    throw new Error('The encrypted session received a handshake frame after it was established');
  }

  _readServerHello(payload) {
    if (!payload.length) throw this._fail('The proxy sent an empty hello');
    if (payload[0] !== 0x01) {
      throw this._fail(`The proxy asked for API protocol ${payload[0]}, which this app does not speak`);
    }

    const parts = payload.subarray(1).toString('utf8').split('\0');
    this.serverName = parts[0] || null;
    this.serverMac = parts[1] || null;

    if (this.expectedName && this.serverName && this.expectedName !== this.serverName) {
      throw this._fail(`Expected to reach ${this.expectedName}, but ${this.serverName} answered`);
    }

    // Prologue slik serveren bygger den: fast tekst, lengden på klient-hello,
    // og klient-hello selv.
    const helloLength = Buffer.alloc(2);
    helloLength.writeUInt16BE(this._clientHello.length, 0);

    this.ss = new SymmetricState(PROTOCOL_NAME);
    this.ss.mixHash(Buffer.concat([PROLOGUE_INIT, helloLength, this._clientHello]));
    // psk0: nøkkelen blandes inn først av alt i første melding.
    this.ss.mixKeyAndHash(this.psk);

    this.ephemeral = x25519.generate();
    this.ss.mixHash(this.ephemeral.raw);
    // Med PSK gjør `e`-tokenet også en mixKey. Uten denne linja feiler
    // håndtrykket med MAC failure, som ser ut som feil nøkkel.
    this.ss.mixKey(this.ephemeral.raw);

    const message = Buffer.concat([this.ephemeral.raw, this.ss.encryptAndHash(EMPTY)]);
    this.state = STATE.HANDSHAKE;
    return [frame(Buffer.concat([Buffer.from([HANDSHAKE_STATUS_OK]), message]))];
  }

  _readHandshake(payload) {
    if (!payload.length) throw this._fail('The proxy sent an empty handshake message');

    if (payload[0] !== HANDSHAKE_STATUS_OK) {
      const reason = payload.subarray(1).toString('utf8').replace(/\0+$/, '');
      if (reason === MAC_FAILURE) {
        throw this._fail('The encryption key is wrong. Copy it from the api: encryption: key: line in the ESPHome configuration.');
      }
      throw this._fail(`The proxy rejected the connection: ${reason || 'no reason given'}`);
    }

    const message = payload.subarray(1);
    if (message.length < 32) throw this._fail('The proxy sent a handshake message that is too short');

    const remote = message.subarray(0, 32);
    this.ss.mixHash(remote);
    this.ss.mixKey(remote);
    // ee: felles hemmelighet mellom de to flyktige nøklene.
    this.ss.mixKey(x25519.shared(this.ephemeral.privateKey, remote));
    this.ss.decryptAndHash(message.subarray(32));

    const [toServer, toClient] = this.ss.split();
    this._send = new TransportKey(toServer);
    this._receive = new TransportKey(toClient);
    this.state = STATE.READY;
    // Nøkkelmaterialet trengs ikke lenger.
    this.ss = null;
    this.ephemeral = null;
    return [];
  }

  // API-melding ut: type og lengde ligger INNE i det krypterte, ikke utenpå.
  encodeMessage(type, payload) {
    if (!this.isReady) throw new Error('The encrypted session is not established yet');
    const head = Buffer.alloc(4);
    head.writeUInt16BE(type, 0);
    head.writeUInt16BE(payload.length, 2);
    return frame(this._send.seal(Buffer.concat([head, payload])));
  }

  decodeMessage(payload) {
    if (!this.isReady) throw new Error('The encrypted session is not established yet');
    const plain = this._receive.open(payload);
    if (plain.length < 4) throw new Error('Encrypted message is too short to hold a header');
    const type = plain.readUInt16BE(0);
    const length = plain.readUInt16BE(2);
    if (length > plain.length - 4) throw new Error('Encrypted message claims more data than it carries');
    return { type, payload: plain.subarray(4, 4 + length) };
  }

  _fail(message) {
    this.state = STATE.FAILED;
    return new Error(message);
  }
}

module.exports = {
  NoiseSession,
  parseKey,
  frame,
  FRAME_INDICATOR,
  FRAME_HEADER_SIZE,
  PROTOCOL_NAME,
  // Eksportert for testene: de bygger en responder av de samme delene og
  // kjører et helt håndtrykk mot klienten.
  SymmetricState,
  TransportKey,
  hkdf,
  x25519,
  HANDSHAKE_STATUS_OK,
};
