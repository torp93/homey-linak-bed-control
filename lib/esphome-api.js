'use strict';

// ESPHome native API-klient (plaintext) med BLE-proxy-støtte.
//
// Bygget for Homey: ingen eksterne avhengigheter, kun node:net og node:events.
// Plaintext-ramme: 0x00 <varint payload_len> <varint msg_type> <payload>
//
// API 1.14 har fjernet passord-autentisering — ConnectRequest besvares ikke
// i det hele tatt. Gå rett fra HelloResponse til bruk.

const net = require('node:net');
const { EventEmitter } = require('node:events');

// Kun meldingstypene denne appen faktisk bruker. Resten av protokollen
// (entiteter, sensorer, GATT-lesing/notify) var arv fra Geberit-appen og er
// fjernet — se git-/sesjonshistorikken om den trengs igjen.
const MSG = {
  HELLO_REQ: 1, HELLO_RES: 2,
  DISCONNECT_REQ: 5,
  PING_REQ: 7, PING_RES: 8,
  DEVICE_INFO_REQ: 9, DEVICE_INFO_RES: 10,
  // Entiteter og sensortilstander. Brukes kun til ÉN ting: WiFi-signalet til
  // ESP32-en, som proxyen rapporterer som en vanlig ESPHome-sensor.
  LIST_ENTITIES_REQ: 11, LIST_ENTITIES_SENSOR_RES: 16, LIST_ENTITIES_DONE: 19,
  SUBSCRIBE_STATES_REQ: 20, SENSOR_STATE_RES: 25,
  SUB_BLE_ADV_REQ: 66, BLE_ADV_RES: 67,
  BLE_DEVICE_REQ: 68, BLE_DEVICE_CONN_RES: 69,
  GATT_GET_SERVICES_REQ: 70, GATT_GET_SERVICES_RES: 71, GATT_GET_SERVICES_DONE: 72,
  GATT_WRITE_REQ: 75,
  GATT_ERROR: 82, GATT_WRITE_RES: 83,
  PAIRING_RES: 85,
  UNSUB_BLE_ADV_REQ: 87,
  BLE_RAW_ADV_RES: 93,
};

const BLE_REQUEST = {
  CONNECT: 0,
  DISCONNECT: 1,
  PAIR: 2,
  UNPAIR: 3,
  CONNECT_V3_WITH_CACHE: 4,
  CONNECT_V3_WITHOUT_CACHE: 5,
};

const ADDRESS_TYPE_PUBLIC = 0;

// --- protobuf-primitiver -----------------------------------------------------

function encodeVarint(value) {
  let x = BigInt(value);
  if (x < 0n) throw new RangeError('a varint cannot be negative');
  const out = [];
  do {
    let byte = Number(x & 0x7fn);
    x >>= 7n;
    if (x > 0n) byte |= 0x80;
    out.push(byte);
  } while (x > 0n);
  return Buffer.from(out);
}

function decodeVarint(buf, offset) {
  let result = 0n;
  let shift = 0n;
  let pos = offset;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return { value: result, offset: pos };
    shift += 7n;
    if (shift > 70n) throw new Error('varint is too long');
  }
  return null; // ufullstendig
}

const tag = (field, wire) => encodeVarint((field << 3) | wire);
const pbVarint = (field, value) => Buffer.concat([tag(field, 0), encodeVarint(value)]);
const pbBool = (field, value) => pbVarint(field, value ? 1 : 0);
const pbBytes = (field, data) => {
  const b = Buffer.from(data);
  return Buffer.concat([tag(field, 2), encodeVarint(b.length), b]);
};
const pbString = (field, str) => pbBytes(field, Buffer.from(str, 'utf8'));

// Gjentatte felter samles i array. uint64 beholdes som BigInt — BLE-adresser og
// 128-bits UUID-er overstiger Number.MAX_SAFE_INTEGER.
function decodeFields(buf) {
  const fields = {};
  const put = (no, val) => {
    if (fields[no] === undefined) fields[no] = val;
    else if (Array.isArray(fields[no])) fields[no].push(val);
    else fields[no] = [fields[no], val];
  };

  let pos = 0;
  while (pos < buf.length) {
    const key = decodeVarint(buf, pos);
    if (!key) break;
    pos = key.offset;
    const no = Number(key.value >> 3n);
    const wire = Number(key.value & 7n);

    if (wire === 0) {
      const v = decodeVarint(buf, pos);
      if (!v) break;
      put(no, v.value);
      pos = v.offset;
    } else if (wire === 2) {
      const len = decodeVarint(buf, pos);
      if (!len) break;
      pos = len.offset;
      const n = Number(len.value);
      // En avkortet lengde ville gitt en kortere buffer enn feltet lover, og
      // den ville blitt tolket som et gyldig felt lenger oppe.
      if (n < 0 || pos + n > buf.length) break;
      put(no, buf.subarray(pos, pos + n));
      pos += n;
    } else if (wire === 5) {
      // read*LE kaster RangeError forbi enden. Et forkortet felt skal avslutte
      // dekodingen, ikke velte kallet — dette er bytes fra nettverket.
      if (pos + 4 > buf.length) break;
      put(no, buf.readUInt32LE(pos));
      fields[`${no}_float`] = buf.readFloatLE(pos);
      pos += 4;
    } else if (wire === 1) {
      if (pos + 8 > buf.length) break;
      put(no, buf.readBigUInt64LE(pos));
      pos += 8;
    } else {
      break;
    }
  }
  return fields;
}

const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

// Hver lytter ser ALLE innkommende meldinger, også annonseringsstrømmen der
// felt 1 er en liste med meldinger i stedet for en adresse. Sjekk derfor
// meldingstypen først — ellers kaster BigInt() på hver eneste annonsering.
const isReplyFor = (type, fields, address, ...expectedTypes) => {
  if (!expectedTypes.includes(type)) return false;
  return typeof fields[1] === 'bigint' && fields[1] === address;
};
const zigzag = (v) => { const x = BigInt(v); return Number((x >> 1n) ^ -(x & 1n)); };

const macToAddress = (mac) => BigInt('0x' + String(mac).split(':').join(''));
const addressToMac = (addr) =>
  BigInt(addr).toString(16).padStart(12, '0').match(/.{2}/g).join(':').toUpperCase();

// Tolker rå BLE-annonseringsdata: en sekvens av [lengde][type][data ...].
// Vi trenger navnet (0x08/0x09) og tjeneste-UUID-ene (0x02-0x07) for at
// driveren skal kjenne igjen enheten under paring.
function parseAdvertisementData(buffer) {
  const data = Buffer.from(buffer);
  const serviceUuids = [];
  let localName = '';
  let pos = 0;

  while (pos < data.length) {
    const length = data[pos];
    if (length === 0 || pos + length >= data.length + 1) break;
    const adType = data[pos + 1];
    const body = data.subarray(pos + 2, pos + 1 + length);

    if (adType === 0x08 || adType === 0x09) {
      localName = body.toString('utf8');
    } else if (adType === 0x02 || adType === 0x03) {
      for (let i = 0; i + 1 < body.length; i += 2) {
        // Homey oppgir alltid full 128-bits form, så vi utvider korte UUID-er
        // med Bluetooth Base UUID. Ellers bommer driverens tjenestesjekk.
        const short = body.readUInt16LE(i).toString(16).padStart(4, '0');
        serviceUuids.push(`0000${short}00001000800000805f9b34fb`);
      }
    } else if (adType === 0x06 || adType === 0x07) {
      for (let i = 0; i + 15 < body.length; i += 16) {
        // 128-bits UUID-er ligger little-endian på lufta.
        serviceUuids.push(Buffer.from(body.subarray(i, i + 16)).reverse().toString('hex'));
      }
    }
    pos += length + 1;
  }

  return { localName, serviceUuids };
}

function formatUuid(parts) {
  const list = asArray(parts);
  if (!list.length) return '';
  const hi = BigInt(list[0]).toString(16).padStart(16, '0');
  const lo = BigInt(list[1] !== undefined ? list[1] : 0).toString(16).padStart(16, '0');
  return hi + lo;
}

// --- klient ------------------------------------------------------------------

class EsphomeApiClient extends EventEmitter {
  constructor({ host, port = 6053, clientInfo = 'homey-linak-bed', log = () => {} } = {}) {
    super();
    if (!host) throw new TypeError('EsphomeApiClient requires a host');
    this.host = host;
    this.port = port;
    this.clientInfo = clientInfo;
    this._log = log;

    this._socket = null;
    this._rx = Buffer.alloc(0);
    this._waiters = [];
    this._connected = false;
    // Telleverk, ikke boolsk: scan() og waitForDevice() kan overlappe (paring
    // mens en kald kommando venter), og abonnementet skal først slippes når
    // SISTE bruker er ferdig. ESP32 tillater kun ett abonnement totalt.
    this._advRefs = 0;
    this._bleConnected = new Set();   // BigInt-adresser
    this._closing = false;
    // Sensoroppslaget gjelder én TCP-økt: nøklene tildeles av ESP-en og er
    // ikke gyldige etter en reconnect.
    this._sensors = null;
    this._sensorValues = new Map();
    this._statesSubscribed = false;
  }

  get isConnected() { return this._connected; }

  connect({ timeoutMs = 10000 } = {}) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port });
      this._socket = socket;

      // Uten keepalive oppdages en halvåpen forbindelse (WiFi-glipp på ESP-en)
      // først når en skriving med svar går i 8 s timeout. Med keepalive får vi
      // 'close' fra OS-et i stedet, og neste kommando kobler friskt.
      socket.setKeepAlive(true, 30000);

      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`Timed out contacting the Bluetooth proxy at ${this.host}:${this.port}`));
      }, timeoutMs);

      // `on`, ikke `once`: en socket kan feile flere ganger, og en 'error'
      // uten lytter kaster og tar med seg hele appen. reject på et allerede
      // avgjort promise er en no-op, så gjentatte kall er trygge.
      socket.on('error', (err) => {
        clearTimeout(timer);
        this._failAll(err);
        reject(err);
      });

      socket.on('data', (chunk) => this._onData(chunk));
      socket.on('close', () => {
        this._connected = false;
        this._advRefs = 0;
        this._bleConnected.clear();
        this._sensors = null;
        this._sensorValues.clear();
        this._statesSubscribed = false;
        this._failAll(new Error('The connection to the Bluetooth proxy was closed'));
        this.emit('close');
      });

      socket.once('connect', async () => {
        try {
          const hello = await this._request(
            MSG.HELLO_REQ,
            Buffer.concat([pbString(1, this.clientInfo), pbVarint(2, 1), pbVarint(3, 9)]),
            MSG.HELLO_RES,
            timeoutMs,
          );
          clearTimeout(timer);
          this._connected = true;
          const info = {
            apiVersion: `${hello[1]}.${hello[2]}`,
            serverInfo: hello[3] ? hello[3].toString('utf8') : '',
            name: hello[4] ? hello[4].toString('utf8') : '',
          };
          this._log('esphome connected', info);
          resolve(info);
        } catch (err) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  async deviceInfo(timeoutMs = 8000) {
    const f = await this._request(MSG.DEVICE_INFO_REQ, Buffer.alloc(0), MSG.DEVICE_INFO_RES, timeoutMs);
    const str = (v) => (v ? v.toString('utf8') : '');
    return {
      name: str(f[2]),
      macAddress: str(f[3]),
      esphomeVersion: str(f[4]),
      model: str(f[6]),
      friendlyName: str(f[13]),
      bluetoothProxyFeatureFlags: Number(f[15] || 0),
    };
  }

  // Annonseringsstrømmen er DYR: alle husets BLE-enheter (60+) strømmer over
  // TCP med dekoding og allokeringer per melding, på en Homey med ~5 % ledig
  // RAM. Derfor holdes abonnementet KUN åpent mens noen faktisk lytter —
  // acquire/release-paret under, aldri permanent.
  _acquireAdvertisements() {
    if (this._advRefs++ === 0) this._send(MSG.SUB_BLE_ADV_REQ, pbVarint(1, 0));
  }

  _releaseAdvertisements() {
    if (this._advRefs > 0 && --this._advRefs === 0 && this._socket && !this._socket.destroyed) {
      this._send(MSG.UNSUB_BLE_ADV_REQ, Buffer.alloc(0));
    }
  }

  // Skanner etter enheter i durationMs og returnerer alt som ble sett.
  // Navnet kommer i scan response, ikke i selve annonseringen, så samme
  // adresse dukker opp både med og uten navn — navnet beholdes.
  async scan({ durationMs = 12000 } = {}) {
    const seen = new Map();
    const off = this._collect((type, fields, raw) => {
      for (const entry of this._addressesFromAdvertisement(type, fields, raw)) {
        const previous = seen.get(entry.address);
        if (previous && !entry.localName) {
          previous.rssi = entry.rssi;
          continue;
        }
        seen.set(entry.address, { ...previous, ...entry });
      }
    });

    this._acquireAdvertisements();
    try {
      await new Promise((resolve) => setTimeout(resolve, durationMs));
    } finally {
      off();
      this._releaseAdvertisements();
    }
    return [...seen.values()];
  }

  // Venter på at en gitt adresse dukker opp i advertisements.
  // Abonnerer selv og slipper abonnementet igjen uansett utfall.
  waitForDevice(mac, { timeoutMs = 15000 } = {}) {
    const target = macToAddress(mac);
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (fn, value) => {
        if (done) return;
        done = true;
        off();
        clearTimeout(timer);
        this._releaseAdvertisements();
        fn(value);
      };
      const off = this._collect((type, fields, raw) => {
        for (const entry of this._addressesFromAdvertisement(type, fields, raw)) {
          if (entry.address === target) {
            finish(resolve, entry);
            return;
          }
        }
      });
      const timer = setTimeout(() => {
        finish(reject, new Error(`The bed ${mac} did not answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this._acquireAdvertisements();
    });
  }

  _addressesFromAdvertisement(type, fields) {
    if (type === MSG.BLE_ADV_RES) {
      if (fields[1] === undefined) return [];
      return [{
        address: BigInt(fields[1]),
        rssi: zigzag(fields[3] || 0),
        addressType: null,   // legacy-annonsering oppgir den ikke
        localName: fields[2] ? Buffer.from(fields[2]).toString('utf8') : '',
        serviceUuids: asArray(fields[4]).map((u) => Buffer.from(u).toString('utf8')),
      }];
    }
    if (type === MSG.BLE_RAW_ADV_RES) {
      return asArray(fields[1]).map((buf) => {
        const a = decodeFields(buf);
        // Rå annonsering leveres som AD-strukturer og må tolkes her — uten
        // navn og tjeneste-UUID-er kan driveren ikke kjenne igjen enheten.
        const parsed = a[4] ? parseAdvertisementData(a[4]) : { localName: '', serviceUuids: [] };
        return {
          address: BigInt(a[1] || 0),
          rssi: zigzag(a[2] || 0),
          // Felt 3 er adressetypen. Den kan ikke utledes pålitelig fra MAC-en,
          // så dette er den eneste kilden vi kan stole på ved tilkobling.
          addressType: a[3] === undefined ? null : Number(a[3]),
          localName: parsed.localName,
          serviceUuids: parsed.serviceUuids,
        };
      });
    }
    return [];
  }

  // Lister ESP-ens sensorer én gang per TCP-økt. Nøkkelen er det eneste som
  // knytter en tilstandsmelding til en sensor.
  async _ensureSensorIndex(timeoutMs = 8000) {
    if (this._sensors) return this._sensors;

    const sensors = new Map();
    await new Promise((resolve, reject) => {
      const off = this._collect((type, fields) => {
        if (type === MSG.LIST_ENTITIES_SENSOR_RES) {
          const str = (v) => (v ? Buffer.from(v).toString('utf8') : '');
          sensors.set(Number(fields[2] || 0), {
            objectId: str(fields[1]),
            name: str(fields[3]),
            unit: str(fields[6]),
            deviceClass: str(fields[9]),
          });
          return;
        }
        if (type === MSG.LIST_ENTITIES_DONE) {
          off();
          clearTimeout(timer);
          resolve();
        }
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error('The Bluetooth proxy did not list its sensors in time'));
      }, timeoutMs);
      this._send(MSG.LIST_ENTITIES_REQ, Buffer.alloc(0));
    });

    this._sensors = sensors;
    return sensors;
  }

  // WiFi-signalet til selve ESP32-en, i dBm. Returnerer null når proxyen ikke
  // har en slik sensor — da er det riktigere å vise ingenting enn et tall.
  //
  // Det finnes ingen «unsubscribe states» i protokollen, så abonnementet står
  // ut TCP-øktens levetid. Det er billig: noen få sensorer med ett minutts
  // oppdatering, mot annonseringsstrømmen som var titusener av meldinger.
  async wifiSignal({ timeoutMs = 8000 } = {}) {
    const sensors = await this._ensureSensorIndex();

    let key = null;
    for (const [sensorKey, sensor] of sensors) {
      const haystack = `${sensor.objectId} ${sensor.name} ${sensor.deviceClass}`.toLowerCase();
      if (sensor.deviceClass === 'signal_strength' || haystack.includes('wifi')) {
        key = sensorKey;
        break;
      }
    }
    if (key === null) return null;

    if (!this._statesSubscribed) {
      this._statesSubscribed = true;
      this._send(MSG.SUBSCRIBE_STATES_REQ, Buffer.alloc(0));
    }

    if (this._sensorValues.has(key)) return this._sensorValues.get(key);

    // Første gang må vi vente på at ESP-en sender tilstanden sin.
    return new Promise((resolve) => {
      const off = this._collect((type, fields) => {
        if (type !== MSG.SENSOR_STATE_RES) return;
        if (Number(fields[1] || 0) !== key) return;
        off();
        clearTimeout(timer);
        resolve(Number(fields[3] || 0) === 1 ? null : (fields['2_float'] ?? null));
      });
      const timer = setTimeout(() => {
        off();
        resolve(null);
      }, timeoutMs);
    });
  }

  // useCache lar ESP-en gjenbruke sin lagrede GATT-struktur i stedet for full
  // tjenesteoppdagelse ved hver oppkobling — brukes når appen allerede har
  // handles lagret. Uten cache når strukturen er ukjent.
  async bleConnect(mac, { addressType = ADDRESS_TYPE_PUBLIC, useCache = false, timeoutMs = 25000 } = {}) {
    const address = macToAddress(mac);
    const payload = Buffer.concat([
      pbVarint(1, address),
      pbVarint(2, useCache ? BLE_REQUEST.CONNECT_V3_WITH_CACHE : BLE_REQUEST.CONNECT_V3_WITHOUT_CACHE),
      pbBool(3, true),
      pbVarint(4, addressType),
    ]);

    return new Promise((resolve, reject) => {
      const off = this._collect((type, fields) => {
        if (!isReplyFor(type, fields, address, MSG.BLE_DEVICE_CONN_RES)) return;
        off();
        clearTimeout(timer);
        if (Number(fields[2] || 0) === 1) {
          this._bleConnected.add(address);
          resolve({ mtu: Number(fields[3] || 0) });
        } else {
          reject(new Error(`The bed refused the Bluetooth connection (error=${Number(fields[4] || 0)})`));
        }
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out connecting to the bed after ${timeoutMs} ms`));
      }, timeoutMs);
      this._send(MSG.BLE_DEVICE_REQ, payload);
    });
  }

  // Ekte BLE-bonding. Uten dette avviser LINAK-sengen statuskarakteristikken
  // med ATT-feil 5 (Insufficient Authentication). Motorkommandoer virker
  // derimot ubondet, så dette trengs bare når vi vil lese tilstand.
  // Bondingen overlever ikke frakobling og må gjentas per økt.
  blePair(mac, { timeoutMs = 15000 } = {}) {
    const address = macToAddress(mac);
    return new Promise((resolve, reject) => {
      const off = this._collect((type, fields) => {
        if (!isReplyFor(type, fields, address, MSG.PAIRING_RES)) return;
        off();
        clearTimeout(timer);
        if (Number(fields[2] || 0) === 1) resolve();
        else reject(new Error(`The bed refused Bluetooth pairing (error=${Number(fields[3] || 0)})`));
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out pairing with the bed after ${timeoutMs} ms`));
      }, timeoutMs);
      this._send(MSG.BLE_DEVICE_REQ, Buffer.concat([
        pbVarint(1, address),
        pbVarint(2, BLE_REQUEST.PAIR),
      ]));
    });
  }

  bleDisconnect(mac) {
    const address = macToAddress(mac);
    this._bleConnected.delete(address);
    this._send(MSG.BLE_DEVICE_REQ, Buffer.concat([
      pbVarint(1, address),
      pbVarint(2, BLE_REQUEST.DISCONNECT),
    ]));
  }

  getServices(mac, { timeoutMs = 20000 } = {}) {
    const address = macToAddress(mac);
    return new Promise((resolve, reject) => {
      const services = [];
      const off = this._collect((type, fields) => {
        if (!isReplyFor(type, fields, address,
          MSG.GATT_GET_SERVICES_RES, MSG.GATT_GET_SERVICES_DONE)) return;
        if (type === MSG.GATT_GET_SERVICES_RES) {
          for (const svcBuf of asArray(fields[2])) {
            const s = decodeFields(svcBuf);
            services.push({
              uuid: formatUuid(s[1]),
              handle: Number(s[2] || 0),
              characteristics: asArray(s[3]).map((chBuf) => {
                const c = decodeFields(chBuf);
                const descriptors = asArray(c[4]).map((dBuf) => {
                  const d = decodeFields(dBuf);
                  return { uuid: formatUuid(d[1]), handle: Number(d[2] || 0) };
                });
                // 0x2902 = Client Characteristic Configuration Descriptor.
                const cccd = descriptors.find((d) => d.uuid.includes('2902'));
                return {
                  uuid: formatUuid(c[1]),
                  handle: Number(c[2] || 0),
                  properties: Number(c[3] || 0),
                  descriptors,
                  cccdHandle: cccd ? cccd.handle : null,
                };
              }),
            });
          }
        } else if (type === MSG.GATT_GET_SERVICES_DONE) {
          off();
          clearTimeout(timer);
          resolve(services);
        }
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error('Timed out reading the services the bed offers'));
      }, timeoutMs);
      this._send(MSG.GATT_GET_SERVICES_REQ, pbVarint(1, address));
    });
  }

  // Bygger den ferdige rammen for en GATT-skriving uten svar. Bevegelsesløkka
  // sender samme to bytes hvert 100. ms i opptil flere minutter — å bygge
  // protobuf-rammen (4x Buffer.concat + BigInt-varint av adressen) på nytt
  // hver gang er bortkastet. Bygg én gang, skriv med writeRaw().
  buildGattWriteFrame(mac, handle, data) {
    const payload = Buffer.concat([
      pbVarint(1, macToAddress(mac)),
      pbVarint(2, handle),
      pbBool(3, false),
      pbBytes(4, data),
    ]);
    return Buffer.concat([
      Buffer.from([0x00]),
      encodeVarint(payload.length),
      encodeVarint(MSG.GATT_WRITE_REQ),
      payload,
    ]);
  }

  writeRaw(frame) {
    if (!this._socket || this._socket.destroyed) {
      throw new Error('Not connected to the Bluetooth proxy');
    }
    this._socket.write(frame);
  }

  // withResponse=false gir ATT_WRITE_COMMAND — kvitteres av ESPHome lokalt
  // uansett hva sengen mener, så det brukes kun etter at tilgangen er
  // bekreftet med en skriving MED svar.
  gattWrite(mac, handle, data, { withResponse = true, timeoutMs = 8000 } = {}) {
    const address = macToAddress(mac);
    const payload = Buffer.concat([
      pbVarint(1, address),
      pbVarint(2, handle),
      pbBool(3, withResponse),
      pbBytes(4, data),
    ]);

    if (!withResponse) {
      this._send(MSG.GATT_WRITE_REQ, payload);
      return Promise.resolve();
    }

    return new Promise((resolve, reject) => {
      const off = this._collect((type, fields) => {
        if (!isReplyFor(type, fields, address, MSG.GATT_WRITE_RES, MSG.GATT_ERROR)) return;
        if (Number(fields[2] || 0) !== handle) return;
        off(); clearTimeout(timer);
        if (type === MSG.GATT_ERROR) reject(this._gattError(fields));
        else resolve();
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out sending a command to the bed (handle ${handle})`));
      }, timeoutMs);
      this._send(MSG.GATT_WRITE_REQ, payload);
    });
  }

  _gattError(fields) {
    // ESP-en sender -1 ved lokale feil (typisk død BLE-link). Feltet er en
    // varint dekodet som BigInt, så uten fortegnsdekoding blir -1 til
    // 18446744073709552000 (2^64) i feilmeldingen brukeren ser.
    const raw = fields[3];
    const att = typeof raw === 'bigint' ? Number(BigInt.asIntN(64, raw)) : Number(raw || 0);
    const err = new Error(`The bed rejected a command (handle ${Number(fields[2] || 0)}, error=${att})`);
    err.code = 'GATT_ERROR';
    err.attError = att;
    return err;
  }

  async close() {
    this._closing = true;
    // Rekkefølgen er kritisk: BLE ned FØRST, deretter unsubscribe, så TCP.
    // Motsatt rekkefølge river ned BLE-linken og etterlater abonnementet
    // hengende på ESP32-en til ping-timeout (~90 s).
    for (const address of [...this._bleConnected]) {
      this.bleDisconnect(addressToMac(address));
    }
    if (this._bleConnected.size) await new Promise((r) => setTimeout(r, 400));
    if (this._advRefs > 0 && this._socket && !this._socket.destroyed) {
      this._advRefs = 0;
      this._send(MSG.UNSUB_BLE_ADV_REQ, Buffer.alloc(0));
    }
    await new Promise((r) => setTimeout(r, 200));
    if (this._socket && !this._socket.destroyed) {
      this._send(MSG.DISCONNECT_REQ, Buffer.alloc(0));
      await new Promise((r) => setTimeout(r, 200));
      this._socket.destroy();
    }
    this._connected = false;
  }

  // --- internt ---------------------------------------------------------------

  _send(type, payload) {
    if (!this._socket || this._socket.destroyed) {
      throw new Error('Not connected to the Bluetooth proxy');
    }
    this._socket.write(Buffer.concat([
      Buffer.from([0x00]),
      encodeVarint(payload.length),
      encodeVarint(type),
      payload,
    ]));
  }

  _request(type, payload, expectType, timeoutMs) {
    return new Promise((resolve, reject) => {
      const off = this._collect((t, fields) => {
        if (t !== expectType) return;
        off();
        clearTimeout(timer);
        resolve(fields);
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error(`The Bluetooth proxy did not reply (message type ${expectType})`));
      }, timeoutMs);
      this._send(type, payload);
    });
  }

  _collect(handler) {
    this._waiters.push(handler);
    return () => {
      const i = this._waiters.indexOf(handler);
      if (i >= 0) this._waiters.splice(i, 1);
    };
  }

  _failAll(error) {
    // Waiters rydder seg selv via sine timeouts; her varsler vi bare oppover.
    // Planlagt nedkobling er ikke en feil og skal ikke støye. Og en emit av
    // 'error' UTEN lytter kaster — det ville tatt ned hele appen fra en
    // socket-callback, så vi sjekker først.
    if (this._closing) return;
    if (this.listenerCount('error') > 0) this.emit('error', error);
    else this._log('esphome error (ingen lytter)', error.message);
  }

  _onData(chunk) {
    this._rx = Buffer.concat([this._rx, chunk]);

    for (;;) {
      if (this._rx.length < 1) return;
      if (this._rx[0] !== 0x00) {
        // Via _failAll — direkte emit uten lytter kaster fra socket-callbacken.
        this._failAll(new Error('Expected a plaintext frame from the Bluetooth proxy — is API encryption enabled?'));
        this._socket.destroy();
        return;
      }
      const lenV = decodeVarint(this._rx, 1);
      if (!lenV) return;
      const typeV = decodeVarint(this._rx, lenV.offset);
      if (!typeV) return;
      const end = typeV.offset + Number(lenV.value);
      if (this._rx.length < end) return;

      const payload = this._rx.subarray(typeV.offset, end);
      this._rx = this._rx.subarray(end);
      const type = Number(typeV.value);

      let fields;
      try {
        fields = decodeFields(payload);
      } catch (err) {
        this._log('esphome decode failed', { type, error: err.message });
        continue;
      }

      this._dispatch(type, fields, payload);
    }
  }

  _dispatch(type, fields, payload) {
    // Rå innsyn for feilsøking av meldingstyper mot ekte maskinvare.
    this.emit('message', { type, fields, payload });

    if (type === MSG.PING_REQ) {
      this._send(MSG.PING_RES, Buffer.alloc(0));
      return;
    }

    if (type === MSG.SENSOR_STATE_RES) {
      const key = Number(fields[1] || 0);
      const missing = Number(fields[3] || 0) === 1;
      this._sensorValues.set(key, missing ? null : (fields['2_float'] ?? null));
    }

    if (type === MSG.BLE_DEVICE_CONN_RES && Number(fields[2] || 0) === 0) {
      const address = BigInt(fields[1] || 0);
      if (this._bleConnected.delete(address)) {
        this.emit('bleDisconnected', {
          mac: addressToMac(address),
          error: Number(fields[4] || 0),
        });
      }
    }

    for (const handler of [...this._waiters]) {
      try {
        handler(type, fields, payload);
      } catch (err) {
        this._log('esphome handler failed', err.message);
      }
    }
  }
}

// Wire-primitivene eksporteres for testene — de tolker bytes fra nettverket
// og er der en stille regresjon gjør mest skade.
module.exports = {
  EsphomeApiClient,
  addressToMac,
  decodeFields,
  decodeVarint,
  encodeVarint,
  parseAdvertisementData,
};
