'use strict';

// LINAK TD4-sengeprotokoll over BLE.
//
// Alt her er verifisert fysisk mot to senger 2026-08-10. Se merknadene under —
// flere av dem motsier publisert dokumentasjon, og de kostet tid å finne.

// Normalisert form (uten bindestreker) — det er slik ESPHome leverer dem.
// Merk kontrolltjenesten 99fa0001, ikke 99fa0000 som skrivebordsappen bruker.
const LINAK_BED_UUIDS = Object.freeze({
  controlService: '99fa0001338a10248a49009c0215f78a',
  commandCharacteristic: '99fa0002338a10248a49009c0215f78a',
  statusCharacteristic: '99fa0003338a10248a49009c0215f78a',
  dpgService: '99fa0010338a10248a49009c0215f78a',
  dpgCharacteristic: '99fa0011338a10248a49009c0215f78a',
});

// Kommandokoder, alle bekreftet ved fysisk bevegelse.
//
// VIKTIG: `ha-adjustable-bed` kaller 0x03/0x02 «head up/down». På TD4 gjør de
// ingenting. Den øvre seksjonen er 0x0B/0x0A — «back» i LINAKs terminologi.
// Kodesettet i det dokumentet stemmer, men merkelappene gjør det ikke.
const BED_COMMANDS = Object.freeze({
  legUp: 0x09,
  legDown: 0x08,
  backUp: 0x0b,
  backDown: 0x0a,

  // Kombinerte bevegelser — to motorer samtidig. Hele 0x3x-blokka dekker de
  // fire kombinasjonene, funnet ved systematisk sveip 2026-08-12 og hver
  // enkelt bekreftet fysisk.
  bothUp: 0x37,
  bothDown: 0x34,
  sitUp: 0x35,        // bein ned + rygg opp
  legRelief: 0x36,    // bein opp + rygg ned

  lightOn: 0x92,
  lightOff: 0x93,
  wakeup: 0xfe,
  stop: 0xff,
});

// Bevegelseskommandoer må gjentas; av/på-kommandoer sendes én gang og skal
// IKKE etterfølges av stopp — 0xFF er en motorkommando og slår av lyset igjen.
const MOTOR_COMMANDS = Object.freeze([
  'legUp', 'legDown', 'backUp', 'backDown',
  'bothUp', 'bothDown', 'sitUp', 'legRelief',
]);
const REPEAT_INTERVAL_MS = 100;

// MERK: samtidig kjøring kan ikke etterlignes ved å veksle mellom to
// enkeltkanaler. Det ble prøvd — fletting av 0x0B og 0x09 hvert 100. ms ga
// ingen bevegelse i det hele tatt, fordi hver ny kanalkommando avbryter den
// forrige. Kombinert kjøring MÅ bruke kodene i 0x3x.

// DPG-referanse (brukes IKKE i koden): skrivebordsprotokollens håndtrykk
// `7f 86 00` + `7f 86 80 01..11` mot 99fa0011 ble først antatt å låse opp
// kommandokanalen. Det gjør den ikke — skrivingene kvitteres, DPG-laget svarer
// 0b00 på alt, og handle 16 forblir låst. Det er BLE-bonding som åpner kanalen.
//
// Motorobservasjon: beinmotoren gir synlig utslag på ~4 s, den øvre trenger
// ~8 s. En for kort puls ser ut som feil kommandokode — det avsporet
// feilsøkingen en hel runde.

const isMotorCommand = (name) => MOTOR_COMMANDS.includes(name);

// Kommandorammen er to bytes: [kode, 0x00].
function encodeCommand(name) {
  const code = BED_COMMANDS[name];
  if (code === undefined) throw new RangeError(`Unknown LINAK bed command: ${name}`);
  return Buffer.from([code, 0x00]);
}

const normalizeUuid = (value) => String(value || '').toLowerCase().replace(/[^a-f0-9]/g, '');

// Sengene annonserer som "Bed 5406" — samme mønster som skrivebordets "DESK 4601".
const BED_NAME_PATTERN = /^bed\s+\d+/i;

function isLinakBed(advertisement) {
  const name = String(advertisement && advertisement.localName || '');
  if (BED_NAME_PATTERN.test(name.trim())) return true;
  const uuids = (advertisement && advertisement.serviceUuids) || [];
  return uuids.some((uuid) => normalizeUuid(uuid).startsWith('99fa'));
}

// Sengene bruker random static-adresse. Kobler man til som PUBLIC får man
// error=256 fulgt av error=133, som ser ut som rekkeviddeproblem men ikke er det.
const ADDRESS_TYPE = Object.freeze({ PUBLIC: 0, RANDOM: 1 });

// SISTE UTVEI. Bitmønsteret i MSB definerer undertypen av en *random* adresse;
// for public adresser er de samme bitene bare en del av OUI-en og sier
// ingenting. Geberit-toalettet er f.eks. 94:A9:… — public, men 0x94 har begge
// de øverste bitene satt og ville blitt gjettet som random her.
//
// Bruk `addressType` fra annonseringen når den finnes; ESPHome rapporterer den
// eksplisitt, og det er den eneste pålitelige kilden.
function guessAddressType(mac) {
  const first = String(mac).split(':')[0];
  const msb = parseInt(first, 16);
  if (!Number.isInteger(msb)) throw new TypeError(`Invalid MAC address: ${mac}`);
  return (msb & 0xc0) === 0xc0 ? ADDRESS_TYPE.RANDOM : ADDRESS_TYPE.PUBLIC;
}

// Foretrekker den annonserte typen, med gjetning bare som fallback.
function resolveAddressType(mac, advertisedType) {
  if (advertisedType === ADDRESS_TYPE.PUBLIC || advertisedType === ADDRESS_TYPE.RANDOM) {
    return advertisedType;
  }
  return guessAddressType(mac);
}

// Finner handles i det oppdagede tjenestetreet. Vi slår opp i stedet for å
// hardkode 16/18/22, selv om de var like på begge sengene — handles er ikke
// garantert stabile på tvers av firmwareversjoner.
function resolveHandles(services) {
  const find = (serviceUuid, charUuid) => {
    const service = (services || []).find((s) => normalizeUuid(s.uuid) === normalizeUuid(serviceUuid));
    if (!service) return null;
    return (service.characteristics || []).find((c) => normalizeUuid(c.uuid) === normalizeUuid(charUuid)) || null;
  };

  const command = find(LINAK_BED_UUIDS.controlService, LINAK_BED_UUIDS.commandCharacteristic);
  const status = find(LINAK_BED_UUIDS.controlService, LINAK_BED_UUIDS.statusCharacteristic);
  const dpg = find(LINAK_BED_UUIDS.dpgService, LINAK_BED_UUIDS.dpgCharacteristic);

  if (!command) throw new Error('Could not find LINAK command characteristic 99fa0002 — is this a LINAK bed?');

  return {
    commandHandle: command.handle,
    statusHandle: status ? status.handle : null,
    statusCccdHandle: status ? status.cccdHandle : null,
    dpgHandle: dpg ? dpg.handle : null,
  };
}

// Kun det appen og testene faktisk bruker.
module.exports = {
  ADDRESS_TYPE,
  BED_COMMANDS,
  REPEAT_INTERVAL_MS,
  encodeCommand,
  guessAddressType,
  isLinakBed,
  isMotorCommand,
  resolveAddressType,
  resolveHandles,
};
