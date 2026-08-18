'use strict';

// Én delt ESPHome-forbindelse for hele appen, med BLE per seng.
//
// BLE-økten kan dvele åpen en stund etter siste kommando (lingerMs). Det gjør
// påfølgende trykk nesten øyeblikkelige — oppkobling + bonding koster ~1,5 s.
// Prisen er at den fysiske fjernkontrollen er utestengt så lenge vi holder
// forbindelsen (bekreftet empirisk: kontrollboksen godtar én klient om gangen).
// Derfor er dvelingen en innstilling per seng, med 0 = koble ned med én gang.

const { EventEmitter } = require('node:events');
const { EsphomeApiClient, addressToMac } = require('./esphome-api');
const {
  encodeCommand,
  isMotorCommand,
  REPEAT_INTERVAL_MS,
  resolveAddressType,
  resolveHandles,
} = require('./linak-bed-protocol');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class BedProxy extends EventEmitter {
  // `createClient` kan overstyres i tester med en fake-klient — det er den
  // eneste grunnen til at den er en parameter.
  constructor({ host, port = 6053, log = () => {}, createClient = null } = {}) {
    super();
    this.host = host;
    this.port = port;
    this._log = log;
    this._createClient = createClient
      || ((options) => new EsphomeApiClient(options));
    this._client = null;
    this._connecting = null;
    this._handles = new Map();   // mac -> { commandHandle, ... } (per TCP-økt)
    this._queues = new Map();    // mac -> Promise-kjede
    this._running = new Map();   // mac -> { cancelled } for bevegelse i gang
    this._live = new Map();      // mac -> { client, lingerTimer } for åpen BLE-økt
    this._latest = new Map();    // mac -> billettnummer for siste bevegelsestrykk
  }

  // Køen er PER SENG, ikke global. To kommandoer mot samme seng må stå i kø —
  // de deler én BLE-forbindelse — men to ulike senger skal kunne kjøre
  // samtidig, ellers ville «begge senger» blitt den ene etter den andre.
  // Proxyen har connection_slots: 2, så det er dekning for det.
  _serialize(key, task) {
    const previous = this._queues.get(key) || Promise.resolve();
    const run = previous.then(task, task);
    this._queues.set(key, run.catch(() => {}));
    return run;
  }

  async _ensureClient() {
    if (this._client && this._client.isConnected) return this._client;
    if (this._connecting) return this._connecting;

    this._connecting = (async () => {
      const client = this._createClient({
        host: this.host,
        port: this.port,
        clientInfo: 'homey-linak-bed',
        log: this._log,
      });

      client.on('close', () => {
        if (this._client === client) {
          this._client = null;
          this._handles.clear();   // handles i denne cachen gjelder kun TCP-økten
          for (const mac of [...this._live.keys()]) this._dropLive(mac);
        }
      });
      client.on('error', (error) => this.emit('error', error));

      // Sengen (eller radioforholdene) kan rive BLE-linken uten at vi ba om
      // det. Da er dvele-økten død og neste kommando må koble opp på nytt —
      // uten denne oppryddingen ville vi skrevet i blinde mot en lukket link.
      client.on('bleDisconnected', ({ mac }) => {
        if (this._live.has(mac)) {
          this._log('BLE-økten falt', { mac });
          this._dropLive(mac);
          // Økten holdt et annonseringsabonnement — slipp det, ellers står
          // strømmen på til neste kommando tilfeldigvis rydder.
          try { client._releaseAdvertisements(); } catch { /* ignorert */ }
        }
      });

      // MERK: ikke noe permanent annonseringsabonnement. Strømmen (alle husets
      // BLE-enheter) kostet kontinuerlig CPU døgnet rundt. Men den MÅ være på
      // mens en BLE-økt lever — se _openBed — så abonnementet følger øktene,
      // pluss scan()/waitForDevice() når de kjører.
      await client.connect();
      this._client = client;
      return client;
    })();

    try {
      return await this._connecting;
    } finally {
      this._connecting = null;
    }
  }

  _dropLive(mac) {
    const live = this._live.get(mac);
    if (!live) return;
    if (live.lingerTimer) clearTimeout(live.lingerTimer);
    this._live.delete(mac);
  }

  // Kobler ned BLE nå, eller etter lingerMs. Kalles etter hver kommando.
  _scheduleRelease(mac, lingerMs) {
    const live = this._live.get(mac);
    if (!live) return;
    if (live.lingerTimer) clearTimeout(live.lingerTimer);

    if (lingerMs > 0) {
      live.lingerTimer = setTimeout(() => this._release(mac), lingerMs);
      // Node må kunne avslutte selv om en dvele-timer står — Homey dreper
      // appen ellers ikke rent ved oppgradering.
      if (typeof live.lingerTimer.unref === 'function') live.lingerTimer.unref();
    } else {
      this._release(mac);
    }
  }

  _release(mac) {
    if (!this._live.has(mac)) return;
    this._dropLive(mac);
    try {
      if (this._client && this._client.isConnected) {
        // BLE ned FØRST, deretter abonnementet — motsatt rekkefølge river
        // linken (TCP-strømmen er seriell, så ESP-en behandler dem i orden).
        this._client.bleDisconnect(mac);
        this._client._releaseAdvertisements();
      }
    } catch (error) {
      this._log('nedkobling feilet', error.message);
    }
  }

  // Skanner etter senger. Brukes av paringsflyten. Selve innsamlingen (og
  // abonnementshåndteringen) bor i klienten — dette laget oversetter bare til
  // driverens format.
  async discover({ durationMs = 12000 } = {}) {
    return this._serialize('__scan__', async () => {
      const client = await this._ensureClient();
      const entries = await client.scan({ durationMs });

      return entries.map((entry) => ({
        mac: addressToMac(entry.address),
        localName: entry.localName || '',
        rssi: entry.rssi,
        addressType: entry.addressType ?? null,
        serviceUuids: entry.serviceUuids || [],
      })).sort((a, b) => b.rssi - a.rssi);
    });
  }

  // WiFi-signalet til ESP32-en som kjører proxyen. Ingen BLE involvert, så
  // dette låser ikke ut sengens fjernkontroll.
  async wifiSignal() {
    return this._serialize('__scan__', async () => {
      const client = await this._ensureClient();
      return client.wifiSignal();
    });
  }

  // Åpner (eller gjenbruker) BLE-økten mot sengen og returnerer handles.
  //
  //  - Er dvele-økten fortsatt åpen, gjenbrukes den som den er: ingen
  //    annonseringsventing, ingen tilkobling, ingen bonding. Det er hele
  //    poenget med dvelingen.
  //  - `advertisedType` er lagret på enheten fra paringen. Med den kjent
  //    hopper vi over annonseringsventingen og ber ESP-en koble til direkte —
  //    den venter selv på neste annonsering.
  //  - `storedHandles` er GATT-handles lagret på enheten etter første
  //    tjenesteoppdagelse. Med dem hopper vi over getServices (~1 s).
  async _openBed(client, mac, advertisedType = null, storedHandles = null) {
    const live = this._live.get(mac);
    if (live && live.client === client) {
      if (live.lingerTimer) { clearTimeout(live.lingerTimer); live.lingerTimer = null; }
      const handles = this._handles.get(mac) || storedHandles;
      if (handles) return { ...handles, rssi: null, reused: true };
      // Ingen handles å gjenbruke — fall gjennom til full åpning.
      this._release(mac);
    }

    let addressType;
    let rssi = null;
    if (advertisedType === null || advertisedType === undefined) {
      const seen = await client.waitForDevice(mac, { timeoutMs: 15000 });
      addressType = resolveAddressType(mac, seen.addressType);
      rssi = seen.rssi;
    } else {
      addressType = resolveAddressType(mac, advertisedType);
    }

    // KRITISK, bevist med prober mot ekte maskinvare 2026-08-14: uten et
    // aktivt annonseringsabonnement på API-forbindelsen river ESPHome
    // (2026.7.4) tilkoblingsforsøket umiddelbart («Disconnect before
    // connected») — det var dette som brakk v0.10.0, ikke cache-flagget.
    // Abonnementet holdes derfor så lenge BLE-økten lever, og slippes ETTER
    // frakobling (motsatt rekkefølge river linken — dokumentert allerede i
    // Geberit-tiden). Refcounten i klienten tåler to senger + skanning.
    client._acquireAdvertisements();
    let handles = this._handles.get(mac) || storedHandles || null;
    try {
      // Alltid uten cache — CONNECT_V3_WITH_CACHE feiler også på andre måter
      // mot denne ESPHome-versjonen (prøvd og reversert i v0.10.1).
      await client.bleConnect(mac, { addressType });
    } catch (error) {
      client._releaseAdvertisements();
      throw error;
    }

    try {
      if (!handles) {
        handles = resolveHandles(await client.getServices(mac));
        this._log('handles oppdaget', { mac, ...handles });
      }
      this._handles.set(mac, handles);

      // Bonding låser opp kommandokanalen. Uten den svarer handle 16 med
      // ATT-feil 5 på alt. Bondingen følger BLE-økten, ikke enheten, så den må
      // gjøres på nytt hver gang vi kobler til.
      //
      // DPG-sekvensen (7f 86 00 + håndtrykk) ble først antatt å være nøkkelen.
      // Den er den ikke: skrivingene kvitteres, men kommandokanalen forblir
      // låst. Bekreftet i drift 2026-08-10.
      await client.blePair(mac);
    } catch (error) {
      // Feiler oppdagelse eller bonding, må både BLE-linken og abonnementet
      // ryddes — i riktig rekkefølge (BLE først).
      try { client.bleDisconnect(mac); } catch { /* ignorert */ }
      client._releaseAdvertisements();
      throw error;
    }

    this._live.set(mac, { client, lingerTimer: null });
    return { ...handles, rssi };
  }

  // Sikkerhetsnett rundt skriving:
  //  - ATT 5: bondingen glapp — bond på nytt og prøv igjen (én gang).
  //  - ATT 1: Invalid Handle — lagrede handles stemmer ikke lenger (f.eks.
  //    etter firmwareoppdatering på sengen). Kast cachen så neste kommando
  //    kjører full tjenesteoppdagelse i stedet for å feile for alltid.
  async _write(client, mac, handles, payload) {
    try {
      await client.gattWrite(mac, handles.commandHandle, payload);
    } catch (error) {
      if (error.attError === 1) {
        // Enheten oppdager dette selv via error.attError og forkaster sine
        // lagrede handles — neste kommando gjør full oppdagelse.
        this._handles.delete(mac);
        throw error;
      }
      if (error.attError !== 5 || handles._repaired) throw error;
      this._log('kommandokanalen var låst — bonder på nytt');
      handles._repaired = true;
      await client.blePair(mac);
      await client.gattWrite(mac, handles.commandHandle, payload);
    }
  }

  // Åpner økten og gjør FØRSTE skriving, med gjenåpning hvis en gjenbrukt
  // dvele-økt viser seg å være død.
  //
  // Sengen kan slippe BLE-linken før dvele-vinduet er ute, og et knappetrykk
  // kan treffe før bleDisconnected-hendelsen er behandlet. Da feiler første
  // skriving med ESP-feil -1 mot en link vi trodde var åpen. Løsningen er å
  // kaste økten og koble friskt én gang — ikke å vise feilen til brukeren.
  //
  // Første skriving går alltid MED svar: den avslører også at kanalen er låst
  // (ATT 5), som ellers ville forsvunnet i stillhet siden response=false
  // kvitteres lokalt av ESPHome uansett hva sengen mener.
  async _openAndWrite(client, mac, addressType, storedHandles, payload) {
    let handles = await this._openBed(client, mac, addressType, storedHandles);
    try {
      await this._write(client, mac, handles, payload);
    } catch (error) {
      if (!handles.reused) throw error;
      this._log('dvele-økten var død — kobler opp på nytt', error.message);
      this._release(mac);
      handles = await this._openBed(client, mac, addressType, storedHandles);
      await this._write(client, mac, handles, payload);
    }
    return handles;
  }

  // Kjører en kommando. `durationSeconds` gjelder bare motorkommandoer —
  // lys og stopp sendes én gang. `lingerMs` styrer hvor lenge BLE-økten
  // holdes åpen etterpå.
  async sendCommand(mac, command, {
    durationSeconds = 4,
    addressType = null,
    storedHandles = null,
    lingerMs = 0,
    onStarted = null,
  } = {}) {
    const motor = isMotorCommand(command);

    // Et nytt bevegelsestrykk ERSTATTER det som kjører, som på fjernkontrollen.
    // Uten dette stiller trykket seg i kø bak en bevegelse som kan vare i
    // 45 sekunder, og flere trykk avvikles i tur og orden — opplevd som at
    // appen henger. Billetten avlyser også trykk som ligger i kø: bare det
    // NYESTE trykket skal faktisk kjøre.
    let ticket = null;
    if (motor) {
      ticket = (this._latest.get(mac) || 0) + 1;
      this._latest.set(mac, ticket);
      const running = this._running.get(mac);
      if (running) running.cancelled = 'erstattet';
    } else {
      // Lys midt i en bevegelse skal ikke stå i kø bak den (opptil 45 s og
      // knappen timer ut). Bevegelsesløkka drenerer side-kanalen mellom
      // repetisjonene — trygt, siden løkka eier socketen og styrer timingen.
      // Å skrive utenom løkka kolliderer i ESP-ens BLE-kø (dokumentert -1).
      const running = this._running.get(mac);
      if (running && !running.cancelled) {
        return new Promise((resolve, reject) => {
          running.pending.push({ payload: encodeCommand(command), command, resolve, reject });
        });
      }
    }

    return this._serialize(mac, async () => {
      if (motor && this._latest.get(mac) !== ticket) {
        this._log('trykk forbigått av nyere trykk', { mac, command });
        return { command, repeats: 0, stoppedBy: 'erstattet' };
      }

      const client = await this._ensureClient();
      let handles = null;

      // Token settes FØR oppkoblingen: et stopp-trykk som kommer mens vi
      // fortsatt kobler opp skal avlyse bevegelsen, ikke overkjøres av den.
      // `cancelled` bærer årsaken ('stopp'/'erstattet') — enheten trenger
      // skillet for å ikke sette feil tilstand. `pending` er side-kanalen
      // for lys under bevegelse.
      const token = { cancelled: null, pending: [] };

      try {
        const payload = encodeCommand(command);
        if (motor) this._running.set(mac, token);

        handles = await this._openAndWrite(client, mac, addressType, storedHandles, payload);

        // Bevegelsen er i gang — kvitter til den som venter på start. Brukes
        // av knappene, som ikke skal henge til bevegelsen er FERDIG.
        if (onStarted) {
          try { onStarted(); } catch { /* lytterfeil skal ikke velte kommandoen */ }
        }

        if (!motor) {
          // Lyskommandoer må IKKE etterfølges av stopp — 0xFF er en
          // motorkommando og slår lyset av igjen umiddelbart.
          return { command, repeats: 1, rssi: handles.rssi, handles: this._plainHandles(handles) };
        }

        // durationSeconds er en øvre grense, ikke en fast kjøretid. Knappene
        // kjører til brukeren trykker stopp; grensen er sikkerhetsnettet som
        // hindrer at sengen blir stående og gå hvis noe henger.
        const deadline = Date.now() + Math.max(0, durationSeconds) * 1000;
        let repeats = 1;   // første skriving gikk i _openAndWrite

        // Identisk ramme hver 100. ms i opptil flere minutter — bygg den én
        // gang i stedet for 4x Buffer.concat + BigInt-varint per skriving.
        const frame = client.buildGattWriteFrame(mac, handles.commandHandle, payload);

        // Resten uten svar. Med svar rakk vi bare ~3 skrivinger i sekundet på
        // en svak lenke, og motoren stopper hvis den ikke hører kommandoen
        // igjen innen ~200 ms. Tilgangen er allerede bekreftet over.
        while (Date.now() < deadline && !token.cancelled) {
          client.writeRaw(frame);
          repeats++;
          await this._drainPending(client, mac, handles, token);
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          await sleep(Math.min(REPEAT_INTERVAL_MS, remaining));
        }

        // Kom stoppen fra brukeren, har stop() allerede skrevet 0xFF rett inn
        // i økten. Å sende enda en stopp oppå den kolliderer i ESP-ens BLE-kø
        // og avvises med ESP_FAIL (-1) — det var feilbanneret som dukket opp
        // i appen. Motoren er uansett trygg: uten gjentakelser stopper den av
        // seg selv innen ~200 ms.
        if (!token.cancelled) {
          try {
            await client.gattWrite(mac, handles.commandHandle, encodeCommand('stop'));
          } catch (error) {
            this._log('sluttstopp nådde ikke fram', error.message);
            this._release(mac);
          }
        }

        // Lys som kom inn i det bevegelsen sluttet: økten er fortsatt åpen.
        await this._drainPending(client, mac, handles, token);

        return {
          command,
          repeats,
          rssi: handles.rssi,
          handles: this._plainHandles(handles),
          stoppedBy: token.cancelled || 'tidsgrense',
        };
      } finally {
        this._running.delete(mac);
        // Døde bevegelsen med lys-jobber i side-kanalen, må de avvises —
        // et løfte som aldri settles gir en knapp som spinner evig.
        for (const job of token.pending.splice(0)) {
          job.reject(new Error('The movement was interrupted before the light command was sent'));
        }
        this._scheduleRelease(mac, lingerMs);
      }
    });
  }

  // Drenerer side-kanalen: lyskommandoer som kom inn mens bevegelsen pågår.
  // Skrives MED svar mellom repetisjonene, i løkkas egen takt — det er den
  // eneste kollisjonsfrie måten å dele socketen på.
  async _drainPending(client, mac, handles, token) {
    while (token.pending.length) {
      const job = token.pending.shift();
      try {
        await client.gattWrite(mac, handles.commandHandle, job.payload);
        job.resolve({ command: job.command, repeats: 1, rssi: null });
      } catch (error) {
        job.reject(error);
      }
    }
  }

  // Uten _repaired-flagget og andre interne felter — dette er det som lagres
  // på enheten.
  _plainHandles(handles) {
    return {
      commandHandle: handles.commandHandle,
      statusHandle: handles.statusHandle,
      statusCccdHandle: handles.statusCccdHandle,
      dpgHandle: handles.dpgHandle,
    };
  }

  // Stopper umiddelbart. Går IKKE i kø — en stopp som må vente på at
  // bevegelsen den skal avbryte blir ferdig, er ubrukelig.
  async stop(mac, { lingerMs = 0 } = {}) {
    const token = this._running.get(mac);
    if (token) token.cancelled = 'stopp';

    // Stopp forkaster også trykk som venter i kø. Uten dette ville et køet
    // trykk startet bevegelsen på nytt ETTER at brukeren trykket stopp.
    this._latest.set(mac, (this._latest.get(mac) || 0) + 1);

    // Ingenting kjører og ingen økt er åpen: det finnes ingenting å stoppe.
    // Å koble opp (~1,5 s) og deretter dvele (som stenger fjernkontrollen
    // ute i 20 s) for å skrive 0xFF til en stillestående seng er bare kostnad.
    if (!token && !this._live.has(mac)) {
      return { command: 'stop', repeats: 0, noop: true };
    }

    const client = await this._ensureClient();
    const handles = this._handles.get(mac);

    // Med åpen økt (bevegelse i gang, eller dveling) skrives stopp rett inn.
    // Ellers må vi koble opp på vanlig vis.
    if (!handles || !this._live.has(mac)) return this.sendCommand(mac, 'stop', { lingerMs });

    await client.gattWrite(mac, handles.commandHandle, encodeCommand('stop'), { withResponse: false });
    this._scheduleRelease(mac, lingerMs);
    return { command: 'stop', repeats: 1, interrupted: Boolean(token) };
  }

  // Sengen er slettet fra Homey. Uten dette lever bevegelsen videre i denne
  // klassen — enheten som startet den er borte, men løkka her kjenner ikke
  // Homey-enheter, så den ville drevet motoren til sikkerhetsgrensen (opptil
  // 45 s) etter at brukeren slettet sengen.
  //
  // Ingen NY oppkobling for å sende stopp: uten gjentakelser stanser motoren
  // av seg selv innen ~200 ms, og å koble opp mot en seng brukeren nettopp
  // fjernet ville stengt fjernkontrollen ute uten grunn.
  //
  // Alt her er per MAC, så en annen seng røres ikke. Kallet er idempotent.
  forget(mac) {
    const token = this._running.get(mac);
    if (token) token.cancelled = 'slettet';

    // Trykk som står i kø skal ikke starte bevegelsen på nytt etterpå.
    this._latest.set(mac, (this._latest.get(mac) || 0) + 1);

    // Slipper BLE-linken hvis en er åpen. _release er en no-op uten økt, og
    // _scheduleRelease i finally-blokka finner da ingenting å gjøre.
    this._release(mac);
    this._handles.delete(mac);
    // _queues beholdes bevisst: kjeden kan ha en kommando i luften, og å bytte
    // den ut ville sluppet en ny kommando forbi serialiseringen.
  }

  async destroy() {
    const client = this._client;
    this._client = null;
    for (const mac of [...this._live.keys()]) this._dropLive(mac);
    this._handles.clear();
    if (client) await client.close().catch(() => {});
  }
}

module.exports = { BedProxy };
