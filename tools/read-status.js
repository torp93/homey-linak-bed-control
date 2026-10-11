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
const command = args.get('command') || 'backUp';
const moveSeconds = Number(args.get('seconds') || 6);
const idleSeconds = Number(args.get('idle') || 3);
// Egen handleliste. Statuskanalen er handle 18 på begge sengene her, og DPG er
// 22. DPG kan også varsle, og den er aldri prøvd som kilde.
const handles = (args.get('handles') || '').split(',').map(Number).filter(Boolean);
// LINAKs skrivebord strømmer ikke status før de har fått 0xFE. Må utelukkes.
const wakeup = args.get('wakeup') === 'true';

if (!host || !mac) {
  console.error('Bruk: node tools/read-status.js --host <ip> --mac <AA:BB:..> [--command backUp] [--seconds 6] [--idle 3]');
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
  return `len=${buf.length}  hex=[${hex}]  byte=[${bytes}]  u16le=[${words.join(' ')}]`;
}

let frames = 0;

(async () => {
  const proxy = new BedProxy({
    host,
    port,
    log: (...parts) => console.log(stamp(), '[proxy]', ...parts),
  });
  proxy.on('error', (error) => console.error(stamp(), '[proxy-feil]', error.message));

  // Økten skal slippes uansett hvordan dette ender, ellers står
  // fjernkontrollen død til ESP-ens egen timeout.
  let stopWatching = null;
  const shutdown = async () => {
    if (stopWatching) { await stopWatching().catch(() => {}); stopWatching = null; }
    await proxy.destroy().catch(() => {});
  };
  process.on('SIGINT', async () => {
    console.log('\nAvbrutt, slipper økten ...');
    await shutdown();
    process.exit(130);
  });

  try {
    console.log(stamp(), `kobler til ${host}:${port}, seng ${mac}`);

    // Adressetypen er kjent: sengene bruker random static. Da slipper vi å
    // vente på en annonsering først.
    const options = { addressType: ADDRESS_TYPE.RANDOM, lingerMs: 60000 };

    // Les først. Kanalen er lesbar etter bonding, og en engangsverdi forteller
    // allerede om feltet er statisk eller følger sengen.
    try {
      const value = await proxy.readStatus(mac, options);
      console.log(stamp(), 'LESING  ', describe(value));
    } catch (error) {
      console.log(stamp(), 'LESING feilet:', error.message);
    }

    stopWatching = await proxy.watchStatus(mac, (data, handle) => {
      frames += 1;
      console.log(stamp(), `VARSEL h${handle}`, describe(data));
    }, { ...options, handles, wakeup });

    console.log(stamp(), `abonnement på plass${wakeup ? ' (med wakeup)' : ''}, `
      + `${idleSeconds} s i ro (ser om sengen sender uoppfordret)`);
    await sleep(idleSeconds * 1000);
    const idleFrames = frames;

    console.log(stamp(), `kjører ${command} i ${moveSeconds} s`);
    await proxy.sendCommand(mac, command, { ...options, durationSeconds: moveSeconds });
    const moveFrames = frames - idleFrames;

    console.log(stamp(), `bevegelsen ferdig, ${idleSeconds} s i ro igjen`);
    await sleep(idleSeconds * 1000);

    console.log();
    console.log(`Varsler i ro før bevegelse : ${idleFrames}`);
    console.log(`Varsler under bevegelsen   : ${moveFrames}`);
    console.log(`Varsler i ro etterpå       : ${frames - idleFrames - moveFrames}`);
    if (!frames) {
      console.log('Ingen varsler i det hele tatt. Kanalen finnes, men sier ingenting av seg selv.');
    }
  } catch (error) {
    console.error(stamp(), 'FEILET:', error.message);
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
})();
