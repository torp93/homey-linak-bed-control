'use strict';

// Måleverktøy: hva sier statuskanalen 99fa0003 på en LINAK-seng?
//
// Appen har alltid slått opp handles for den kanalen og aldri brukt dem. Den
// vet derfor bare hva den selv har sendt, aldri hva sengen gjør. Hva kanalen
// inneholder på TD5 er ukjent: ha-adjustable-bed beskriver egne
// posisjonskarakteristikker (99fa0025 til 99fa0028) som IKKE finnes på denne
// sengen, så dette er eneste kandidat for posisjonsdata.
//
// Verktøyet kjøres fra PC-en, direkte mot ESP32-en. Ingen Homey involvert.
// Utskriften er på engelsk, for den sendes til brukere som rapporterer om
// andre kontrollbokser enn vår.
//
//   node tools/read-status.js --host 192.168.10.14 --mac D7:CC:F2:D7:8A:4E
//
// Mens det kjører holder det BLE-økten åpen, og da er sengens egen
// fjernkontroll utestengt. Derfor er hele kjøringen under et halvt minutt, og
// Ctrl+C slipper økten pent.

const { BedProxy } = require('../lib/bed-proxy');
const { ADDRESS_TYPE } = require('../lib/linak-bed-protocol');

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

const command = args.get('command') || 'backUp';
const moveSeconds = Number(args.get('seconds') || 6);
const idleSeconds = Number(args.get('idle') || 3);
// Egne kanaler på formen handle:cccd, kommaseparert. Står det ingenting, bruker
// vi statuskanalen slik tjenesteoppdagelsen fant den. CCCD-en MÅ være med:
// ESPHome skriver den ikke selv, og uten den sender sengen aldri et varsel
// uansett hvor pent notify-forespørselen kvitteres.
const channels = (args.get('channels') || '').split(',').filter(Boolean).map((pair) => {
  const [handle, cccd] = pair.split(':').map(Number);
  return { handle, cccd };
});
// LINAKs skrivebord strømmer ikke status før de har fått 0xFE. Må utelukkes.
const wakeup = args.get('wakeup') === 'true';
// Appens egen logg er på norsk, som resten av appen. Den er støy for den
// som kjører verktøyet, så den er av med mindre man ber om den.
const verbose = args.get('verbose') === 'true';

if (!host || !mac) {
  console.error('Usage: node tools/read-status.js --host <proxy ip> --mac <AA:BB:CC:DD:EE:FF>');
  console.error('       [--key <ESPHome api encryption key>] [--channels 18:19,22:23] [--wakeup]');
  console.error('       [--verbose]');
  console.error('       [--command backUp] [--seconds 6] [--idle 3]');
  console.error('');
  console.error('Connects to the bed through an ESPHome Bluetooth proxy, subscribes to its');
  console.error('status channel, and prints every notification it sends while a motor runs.');
  process.exit(2);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const started = Date.now();
const stamp = () => String(Date.now() - started).padStart(6, ' ') + ' ms';

// Hver tolkning skrives ut ved siden av rådataene. Vi vet ikke formatet, så
// gjetningene står side om side: ett varsel sier ingenting, men et varsel per
// 100 ms under en bevegelse avslører raskt hvilken kolonne som er posisjon.
function describe(buf) {
  const hex = buf.toString('hex').replace(/(..)/g, '$1 ').trim();
  const bytes = [...buf].join(' ');
  const words = [];
  for (let i = 0; i + 1 < buf.length; i += 2) words.push(buf.readUInt16LE(i));
  return `len=${buf.length}  hex=[${hex}]  bytes=[${bytes}]  uint16le=[${words.join(' ')}]`;
}

// GATT-egenskapene som bitmaske, slik de star i BLE-spesifikasjonen. Uten
// dem er en handle bare et tall: det er props som sier om kanalen kan
// skrives, leses eller varsle.
function properties(bits) {
  const names = [];
  if (bits & 0x02) names.push('read');
  if (bits & 0x04) names.push('write-no-response');
  if (bits & 0x08) names.push('write');
  if (bits & 0x10) names.push('notify');
  if (bits & 0x20) names.push('indicate');
  return names.length ? names.join(', ') : 'none';
}

let frames = 0;

(async () => {
  const proxy = new BedProxy({
    host,
    port,
    encryptionKey: encryptionKey || null,
    log: (...parts) => { if (verbose) console.log(stamp(), '[proxy]', ...parts); },
  });
  proxy.on('error', (error) => console.error(stamp(), '[proxy error]', error.message));

  // Økten skal slippes uansett hvordan dette ender, ellers står
  // fjernkontrollen død til ESP-ens egen timeout.
  let stopWatching = null;
  const shutdown = async () => {
    if (stopWatching) { await stopWatching().catch(() => {}); stopWatching = null; }
    await proxy.destroy().catch(() => {});
  };
  process.on('SIGINT', async () => {
    console.log('\nInterrupted, releasing the connection ...');
    await shutdown();
    process.exit(130);
  });

  try {
    console.log(stamp(), `connecting to ${host}:${port}`
      + `${encryptionKey ? ' (encrypted)' : ''}, bed ${mac}`);

    // Adressetypen er kjent: sengene bruker random static. Da slipper vi å
    // vente på en annonsering først.
    const options = { addressType: ADDRESS_TYPE.RANDOM, lingerMs: 60000 };

    // Proben kobler opp, bonder og slipper igjen. Den gir oss handles uten å
    // røre en motor, og de er det første en annen kontrollboks må vise fram.
    // Hele treet forst. Det er dette en bruker med en annen kontrollboks
    // skal sende tilbake, og det er ikke noe vits i a be om det hvis
    // verktoyet bare viser det vi kjente fra for.
    const services = await proxy.listServices(mac, options);
    console.log(stamp(), `GATT TREE (${services.length} services)`);
    for (const service of services) {
      console.log(`         service ${service.uuid}  (handle ${service.handle})`);
      for (const ch of service.characteristics || []) {
        const cccd = ch.cccdHandle ? `  CCCD ${ch.cccdHandle}` : '';
        console.log(`           ${ch.uuid}  handle ${ch.handle}`
          + `  [${properties(ch.properties)}]${cccd}`);
      }
    }
    console.log('');

    const probed = await proxy.probe(mac, options);
    const h = probed.handles || {};
    console.log(stamp(), 'THE ONES THIS APP USES');
    console.log(`         command  99fa0002 = ${h.commandHandle}`);
    console.log(`         status   99fa0003 = ${h.statusHandle} (CCCD ${h.statusCccdHandle})`);
    console.log(`         dpg      99fa0011 = ${h.dpgHandle} (CCCD ${h.dpgCccdHandle})`);
    console.log(`         signal   ${probed.rssi === null ? 'not measured' : probed.rssi + ' dBm'}`);

    // Les først. Kanalen er lesbar etter bonding, og en engangsverdi forteller
    // allerede om feltet er statisk eller følger sengen.
    try {
      const value = await proxy.readStatus(mac, options);
      console.log(stamp(), 'READ     ', describe(value));
    } catch (error) {
      console.log(stamp(), 'READ failed:', error.message);
    }

    stopWatching = await proxy.watchStatus(mac, (data, handle) => {
      frames += 1;
      console.log(stamp(), `NOTIFY h${handle}`, describe(data));
    }, {
      ...options,
      channels,
      wakeup,
      // Den leste CCCD-verdien er beviset for at abonnementet er ekte.
      // ESPHome kvitterer notify-forespørselen uansett, så uten dette ser et
      // dødt abonnement nøyaktig ut som et levende.
      onSubscribed: ({ handle, cccd, cccdValue }) => {
        console.log(stamp(), `SUBSCRIBED handle ${handle}, CCCD ${cccd} now reads ${cccdValue}`
          + `${cccdValue === '0100' ? ' (notifications enabled)' : ' (NOT enabled)'}`);
      },
    });

    console.log(stamp(), `subscribed${wakeup ? ' (wake command sent)' : ''}, `
      + `${idleSeconds} s idle first, to see whether the bed reports on its own`);
    await sleep(idleSeconds * 1000);
    const idleFrames = frames;

    console.log(stamp(), `running ${command} for ${moveSeconds} s`);
    await proxy.sendCommand(mac, command, { ...options, durationSeconds: moveSeconds });
    const moveFrames = frames - idleFrames;

    console.log(stamp(), `movement done, ${idleSeconds} s idle again`);
    await sleep(idleSeconds * 1000);

    console.log();
    console.log(`Notifications while idle   : ${idleFrames}`);
    console.log(`Notifications while moving : ${moveFrames}`);
    console.log(`Notifications after moving : ${frames - idleFrames - moveFrames}`);
    if (!frames) {
      console.log('Nothing at all. The channel exists, but this control box never reports.');
    }
  } catch (error) {
    console.error(stamp(), 'FAILED:', error.message);
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
})();
