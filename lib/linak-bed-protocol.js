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

  // Posisjonstjenesten finnes IKKE på alle kontrollbokser. Den mangler helt på
  // TD5-boksene her, og det er grunnen til at 99fa0003 leser null bytes og
  // aldri varsler: det er ikke en feil, boksen har bare ingenting å si.
  //
  // På TD5 Advanced (TwinDrive TDA, s.w. 1.22) ligger den der derimot, med én
  // karakteristikk per motor. Bekreftet mot ekte maskinvare 2026-10-25 gjennom
  // en logg fra en bruker med den boksen — se docs/positions.md.
  positionService: '99fa0020338a10248a49009c0215f78a',
  legsPositionCharacteristic: '99fa0027338a10248a49009c0215f78a',
  backPositionCharacteristic: '99fa0028338a10248a49009c0215f78a',
});

// Rå telleverdi til grader. Maksverdiene er motorspesifikke og hentet fra den
// samme loggen: rygg 820 teller over 68°, bein 548 over 45°.
//
// MERK at dette er tall fra ÉN boks. Avviker en annen boks, blir vinkelen feil
// mens råverdien fortsatt stemmer — derfor følger `raw` alltid med ut.
const POSITION_RANGES = Object.freeze({
  back: Object.freeze({ maxRaw: 820, maxAngle: 68 }),
  legs: Object.freeze({ maxRaw: 548, maxAngle: 45 }),
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
  const legsPosition = find(LINAK_BED_UUIDS.positionService, LINAK_BED_UUIDS.legsPositionCharacteristic);
  const backPosition = find(LINAK_BED_UUIDS.positionService, LINAK_BED_UUIDS.backPositionCharacteristic);

  if (!command) throw new Error('Could not find LINAK command characteristic 99fa0002 — is this a LINAK bed?');

  return {
    commandHandle: command.handle,
    statusHandle: status ? status.handle : null,
    statusCccdHandle: status ? status.cccdHandle : null,
    dpgHandle: dpg ? dpg.handle : null,
    // Tas med for måleverktøyet: skal man abonnere på DPG-kanalen, trengs
    // deskriptoren, og den kan ikke antas å være dpgHandle + 1 på andre bokser.
    dpgCccdHandle: dpg ? dpg.cccdHandle : null,

    // Null på bokser uten posisjonstjenesten — altså på de fleste. Alt som
    // bruker disse må tåle det; se hasPositionSupport.
    backPositionHandle: backPosition ? backPosition.handle : null,
    backPositionCccdHandle: backPosition ? backPosition.cccdHandle : null,
    legsPositionHandle: legsPosition ? legsPosition.handle : null,
    legsPositionCccdHandle: legsPosition ? legsPosition.cccdHandle : null,
  };
}

// Posisjonsstøtte er en egenskap ved boksen, ikke ved appen: enten svarte
// tjenesteoppdagelsen med 99fa0020, eller så gjorde den det ikke.
function hasPositionSupport(handles) {
  if (!handles) return false;
  return Boolean(handles.backPositionHandle || handles.legsPositionHandle);
}

// Fire bytes: posisjon som uint16 LE, så hastighet som int16 LE.
//
// Hastigheten er fortegnet — negativ på vei ned — og går til 0 når motoren
// står. Det gir «begynte å bevege seg» og «stoppet» uten noen timer.
//
// 0xFFFF i posisjonsfeltet er LINAKs «ukjent», ikke en gyldig stilling. Den
// dukker opp rett etter oppstart, før boksen har referansekjørt.
const POSITION_UNKNOWN = 0xffff;

function parsePosition(data) {
  if (!data || data.length < 4) return null;
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const raw = buffer.readUInt16LE(0);
  if (raw === POSITION_UNKNOWN) return null;
  return { raw, speed: buffer.readInt16LE(2) };
}

// Grader, avrundet til én desimal. Ukjent seksjon eller råverdi gir null i
// stedet for et oppdiktet tall.
function positionAngle(section, raw) {
  const range = POSITION_RANGES[section];
  if (!range || !Number.isFinite(raw)) return null;
  const clamped = Math.min(Math.max(raw, 0), range.maxRaw);
  return Math.round((clamped / range.maxRaw) * range.maxAngle * 10) / 10;
}

// Kun det appen og testene faktisk bruker.
module.exports = {
  ADDRESS_TYPE,
  BED_COMMANDS,
  POSITION_RANGES,
  REPEAT_INTERVAL_MS,
  encodeCommand,
  guessAddressType,
  hasPositionSupport,
  isLinakBed,
  isMotorCommand,
  parsePosition,
  positionAngle,
  resolveAddressType,
  resolveHandles,
};
