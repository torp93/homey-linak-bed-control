'use strict';

// Terskelen for Bluetooth-signalet.
//
// Homey lager slike kort av seg selv for standardkapabiliteter, men
// linak_bed_signal måtte bli en egen kapabilitet for å få Bluetooth-ikonet i
// stedet for WiFi-ikonet, og da følger det ingen terskler med.
//
// Regelen er at kortet fyrer på selve KRYSSINGEN, ikke på hver måling som
// ligger under nivået. Ligger sengen på -90 og nivået er -85, skal du varsles
// én gang, ikke hver sjette time i all evighet.
//
// Nivået bor i flowen, ikke i enheten: to flows kan følge samme seng med hvert
// sitt nivå. Derfor tar enheten vare på forrige verdi og sender begge videre,
// og sammenligningen gjøres per flow her.

function crossedBelow({ signal, previous } = {}, level) {
  const limit = Number(level);
  if (!Number.isFinite(signal) || !Number.isFinite(limit)) return false;
  if (signal >= limit) return false;

  // Første måling teller som en kryssing: da lærte vi nettopp at det er svakt.
  // Uten dette ville en seng som alltid har vært svak aldri sagt fra.
  if (previous === null || previous === undefined) return true;
  if (!Number.isFinite(previous)) return true;

  return previous >= limit;
}

module.exports = { crossedBelow };
