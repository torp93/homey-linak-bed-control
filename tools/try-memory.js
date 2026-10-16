'use strict';

// Måleverktøy: har kontrollboksen minneposisjoner, og stemmer de publiserte
// hent-kodene?
//
// Bakgrunnen: `ha-adjustable-bed` oppgir seks minneplasser med hent-kodene
// 0x0E, 0x0F, 0x0C, 0x44, 0x83, 0x84. Ingen av dem er noen gang bekreftet
// fysisk her. Dokumentet tar dessuten feil om merkelappene på de vanlige
// kommandoene (0x03/0x02 er ikke «head»), så kodene må prøves, ikke antas.
//
// På TD5 hører minnefunksjonen til Advanced-boksen. Er boksen standard, skjer
// det ingenting uansett hvor riktig koden er, og et negativt resultat sier da
// ingenting om kodene. Det er en egenskap ved testen, ikke en feil.
//
// LAGRE-kodene prøves IKKE. De ville overskrevet det brukeren har lagret med
// håndkontrollen, og det er ikke vårt å røre. Hent-kodene endrer ingenting.
//
//   node tools/try-memory.js --host 192.168.10.14 --mac D7:CC:F2:D7:8A:4E
//
// Sengen forteller selv hvilken kode som prøves, ved å blinke med
// undersengslyset: ett blink før kode 1, to før kode 2, og så videre. Da kan
// den som ser på stå ved sengen i stedet for ved skjermen.

const { EsphomeApiClient } = require('../lib/esphome-api');
const { ADDRESS_TYPE, BED_COMMANDS, resolveHandles } = require('../lib/linak-bed-protocol');

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const arg = process.argv[i];
  if (!arg.startsWith('--')) continue;
  const next = process.argv[i + 1];
  args.set(arg.slice(2), next && !next.startsWith('--') ? next : 'true');
}

const host = args.get('host');
const mac = (args.get('mac') || '').toUpperCase();
const port = Number(args.get('port') || 6053);
// Krypteringsnokkelen fra `api: encryption: key:`, naar proxyen har en. Nye
// ESPHome-oppsett lager den av seg selv.
const encryptionKey = args.get('key') || '';

const holdSeconds = Number(args.get('hold') || 6);
const leadInSeconds = Number(args.get('leadin') || 20);

if (!host || !mac) {
  console.error('Usage: node tools/try-memory.js --host <proxy ip> --mac <AA:BB:CC:DD:EE:FF>');
  console.error('       [--key <ESPHome api encryption key>] [--hold 6] [--leadin 20]');
  console.error('');
  console.error('Tries the published LINAK memory RECALL codes one by one and lets the bed');
  console.error('announce each one by blinking its light. Nothing is stored or overwritten.');
  process.exit(2);
}

// Rekkefølgen er den dokumentet oppgir, og nummeret er det antall blink
// sengen gir før koden prøves.
const RECALL_CODES = [
  { slot: 1, code: 0x0e },
  { slot: 2, code: 0x0f },
  { slot: 3, code: 0x0c },
  { slot: 4, code: 0x44 },
  { slot: 5, code: 0x83 },
  { slot: 6, code: 0x84 },
];

const REPEAT_MS = 100;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const started = Date.now();
const stamp = () => String(((Date.now() - started) / 1000).toFixed(1)).padStart(6, ' ') + ' s';

(async () => {
  const client = new EsphomeApiClient({
    host,
    port,
    encryptionKey: encryptionKey || null,
    clientInfo: 'linak-memory-probe',
    log: () => {},
  });
  client.on('error', (error) => console.error(stamp(), '[error]', error.message));

  const payload = (code) => Buffer.from([code, 0x00]);

  try {
    await client.connect();
    console.log(stamp(), `connected to ${host}:${port}`);

    // Uten aktivt annonseringsabonnement river ESPHome tilkoblingen med én
    // gang. Bekreftet med prober mot ekte maskinvare, og det ser ut som
    // rekkeviddefeil når det skjer.
    client._acquireAdvertisements();

    // Tjenesteoppdagelsen kan henge hvis en annen økt holder sengen i det
    // øyeblikket. Da hjelper det å slippe linken og koble opp på nytt, i
    // stedet for å gi opp hele kjøringen.
    let handles = null;
    for (let attempt = 1; attempt <= 3 && !handles; attempt += 1) {
      try {
        await client.bleConnect(mac, { addressType: ADDRESS_TYPE.RANDOM });
        handles = resolveHandles(await client.getServices(mac, { timeoutMs: 25000 }));
      } catch (error) {
        console.log(stamp(), `attempt ${attempt} failed: ${error.message}`);
        if (attempt === 3) throw error;
        try { client.bleDisconnect(mac); } catch { /* ignorert */ }
        await sleep(4000);
      }
    }

    // Bonding låser opp kommandokanalen, og den følger økten, ikke enheten.
    await client.blePair(mac);
    console.log(stamp(), `bed open, command handle ${handles.commandHandle}`);

    const frame = (code) => client.buildGattWriteFrame(mac, handles.commandHandle, payload(code));
    const write = (code) => client.gattWrite(mac, handles.commandHandle, payload(code));

    // Blinker med lyset. Lyskommandoer skal IKKE etterfølges av 0xFF: det er
    // en motorkommando, og den slår lyset av igjen.
    async function blink(times) {
      for (let i = 0; i < times; i += 1) {
        await write(BED_COMMANDS.lightOn);
        await sleep(400);
        await write(BED_COMMANDS.lightOff);
        await sleep(400);
      }
    }

    console.log('');
    console.log(`Go to the bed. The test starts in ${leadInSeconds} seconds.`);
    console.log('The bed blinks its light to announce each code: one blink for the first,');
    console.log('two for the second, and so on. Watch for any movement after the blinks.');
    console.log('');
    await sleep(leadInSeconds * 1000);

    for (const { slot, code } of RECALL_CODES) {
      console.log(stamp(), `slot ${slot}: ${slot} blink(s), then code 0x${code.toString(16)} held for ${holdSeconds} s`);
      await blink(slot);
      await sleep(1500);

      // Første skriving MED svar: da kommer en avvisning fram som ATT-feil i
      // stedet for å bli kvittert lokalt av ESP-en.
      try {
        await write(code);
      } catch (error) {
        console.log(stamp(), `  rejected: ${error.message}`);
        continue;
      }

      // Hent krever trolig at kommandoen holdes, slik motorkommandoene gjør.
      const raw = frame(code);
      const until = Date.now() + holdSeconds * 1000;
      while (Date.now() < until) {
        client.writeRaw(raw);
        await sleep(REPEAT_MS);
      }

      // Stopp uansett, i tilfelle noe faktisk beveget seg.
      await write(BED_COMMANDS.stop).catch(() => {});
      await sleep(2500);
    }

    console.log('');
    console.log(stamp(), 'done. Which blink count, if any, was followed by movement?');
  } catch (error) {
    console.error(stamp(), 'FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    try { client.bleDisconnect(mac); } catch { /* ignorert */ }
    try { client._releaseAdvertisements(); } catch { /* ignorert */ }
    await client.close().catch(() => {});
  }
})();
