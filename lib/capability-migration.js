'use strict';

// En enhet som ble paret under en eldre appversjon beholder sin gamle
// kapabilitetsliste — nye knapper i manifestet dukker ikke opp av seg selv.
//
// Migreringen er så skånsom som mulig:
//  - Manglende kapabiliteter legges til, overflødige fjernes — inkrementelt.
//  - Full riv-og-bygg (som nullstiller Insights-historikk for
//    measure_signal_strength og er ikke-atomisk hvis appen dør midt i)
//    kjøres KUN når rekkefølgen faktisk er feil etterpå. Rekkefølgen er en
//    del av kontrakten: knappene vises i denne rekkefølgen i appen.
//
// Historikk: den gamle varianten rev alt ved ethvert avvik, itererte
// getCapabilities() mens den muterte den, og bar på en død lysbevaring fra
// onoff-tiden (linak_bed_light er getable:false og har ingen verdi å bevare).

async function migrateCapabilities(device, required) {
  const before = [...device.getCapabilities()];
  const missing = required.filter((capability) => !before.includes(capability));
  const obsolete = before.filter((capability) => !required.includes(capability));

  if (missing.length || obsolete.length) {
    device.log(`Migrerer kapabiliteter: +[${missing.join(', ')}] -[${obsolete.join(', ')}]`);
    for (const capability of obsolete) {
      await device.removeCapability(capability).catch((error) =>
        device.error(`Kunne ikke fjerne ${capability}`, error.message));
    }
    for (const capability of missing) {
      await device.addCapability(capability).catch((error) =>
        device.error(`Kunne ikke legge til ${capability}`, error.message));
    }
  }

  const after = [...device.getCapabilities()];
  if (after.join('|') === required.join('|')) {
    return missing.length + obsolete.length > 0;
  }

  // Rekkefølgen er feil (typisk: en ny knapp havnet sist i stedet for på
  // plassen sin). addCapability føyer alltid til på slutten, så eneste vei
  // til riktig rekkefølge er å bygge lista på nytt.
  device.log('Bygger om kapabilitetsrekkefølgen');
  for (const capability of after) {
    await device.removeCapability(capability).catch((error) =>
      device.error(`Kunne ikke fjerne ${capability}`, error.message));
  }
  for (const capability of required) {
    await device.addCapability(capability).catch((error) =>
      device.error(`Kunne ikke legge til ${capability}`, error.message));
  }
  return true;
}

module.exports = { migrateCapabilities };
