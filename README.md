# LINAK Bed for Homey

Control a **LINAK TD4 Advanced** adjustable bed from a Homey Pro over Bluetooth
LE, through an **ESP32 running ESPHome**. No cloud, no manufacturer account, no
dependency on the LINAK app.

Built for and verified against two Svane Zefir beds with LINAK TD4 control
boxes. The command set was reverse-engineered against the actual hardware —
see [What was learned about the protocol](#what-was-learned-about-the-protocol),
which corrects several details that are wrong in the public documentation.

## Features

- Head end and foot end, up and down
- Combined movements: both up, both down, sit-up, leg relief
- Under-bed light
- Stop — interrupts an ongoing movement immediately
- A **Both beds** device that drives every paired bed in parallel
- Flow cards for movement, stop and light, plus a light condition
- Signal strength and connection state per bed

Buttons run until you press **Stop**, like the physical remote. A new press
replaces the running movement. A per-device maximum run time (default 45 s) is
the safety net if a stop never arrives.

## Architecture

```
Homey Pro  ──TCP 6053──▶  ESP32-C3 (ESPHome)  ──BLE──▶  LINAK TD4 control box
           native API          bluetooth_proxy           99fa0002 / 99fa0011
```

The app speaks the ESPHome native API directly (plaintext protobuf, no external
dependencies) and performs raw GATT through `bluetooth_proxy`. Homey's own
Bluetooth radio is not used — the bed transmits at −8 dBm from under the bed
frame, so a proxy placed nearby is what makes this reliable at all.

The BLE link lingers open for a configurable window after each command
(default 20 s) so subsequent presses respond instantly. **While the link is
open the physical remote does not work** — the control box accepts one
controller at a time. Set the linger to 0 to disconnect immediately instead.

## Requirements

- Homey Pro (tested on Homey Pro 2023, firmware ≥ 12.2.0)
- An ESP32 running ESPHome with `bluetooth_proxy`, placed near the bed
- A LINAK bed that advertises as `Bed NNNN` (TD4 Advanced and relatives)

Aim for better than **−70 dBm** between the ESP32 and the bed. Below that the
link fails in confusing ways: connection succeeds, then GATT times out.

## Setup

### 1. Flash the ESP32

[`esphome/linak-bed-proxy.yaml`](esphome/linak-bed-proxy.yaml) is the config
this app is developed against. Adjust the IP addresses to your network and add
`wifi_ssid`, `wifi_password` and `fallback_password` to your ESPHome secrets.

Notes that matter on an ESP32-C3:

- `esp-idf` framework, BLE 5.0 disabled — the C3 shares one core between WiFi
  and BLE and has 400 KB SRAM
- `power_save_mode: NONE` avoids WiFi/BLE radio contention
- `connection_slots: 2` for two beds
- `captive_portal` is deliberately left out; together with `web_server` it can
  push *Max Free Block* below the ~25 KB where GATT becomes unreliable

### 2. Put the bed in pairing mode

The bed only accepts a first connection during its pairing window, and that
window opens **only after a full two-minute power cut**:

1. Unplug the bed's power
2. Wait two whole minutes — shorter cuts do nothing
3. Plug it back in; the light under the bed blinks
4. Add the device in Homey within the next three minutes

Each bed needs its own power cycle. Once a bed has connected successfully it
reconnects freely afterwards.

### 3. Point the app at the proxy

App settings take the ESP32's address and have a **Test connection** button
that verifies the node is reachable and has `bluetooth_proxy` enabled.

## What was learned about the protocol

Everything below was verified against real hardware. Several points contradict
what is documented publicly.

### Command set

| Function | Code | | Function | Code |
|---|---|---|---|---|
| Foot end up / down | `0x09` / `0x08` | | Both up / down | `0x37` / `0x34` |
| Head end up / down | `0x0B` / `0x0A` | | Sit up | `0x35` |
| Light on / off | `0x92` / `0x93` | | Leg relief | `0x36` |
| Stop | `0xFF` | | | |

Commands are two bytes, `[code, 0x00]`, written to characteristic `99fa0002`.
Motor commands must be repeated every 100 ms; the motor stops on its own within
~200 ms of the last one.

### Corrections to the public documentation

- **`0x03`/`0x02` are not "head up/down".** They do nothing on a TD4. The upper
  section is `0x0B`/`0x0A` — "back" in LINAK's terminology.
- **The per-actuator position characteristics don't exist.** `99fa0025`–`99fa0028`
  and battery `99fa0061` are absent; this bed exposes one status characteristic
  `99fa0003` and the DPG pair `99fa0010`/`99fa0011`. There is no readable position.
- **The control service is `99fa0001`**, not `99fa0000` as desk implementations use.

### Things that cost real debugging time

- **Bonding is mandatory.** Without ESPHome's `PAIR` request, every write to the
  command characteristic returns ATT error 5 (Insufficient Authentication). The
  bond does not survive a disconnect and must be repeated every session. The DPG
  handshake from the desk protocol (`7f 86 00` + 20-byte sequence) is *not* what
  unlocks the channel — it is acknowledged but changes nothing.
- **ESPHome needs an active advertisement subscription for BLE connections to
  work at all.** Without one, connection attempts are torn down instantly with
  `Disconnect before connected` in the ESP log. This looks exactly like a range
  or cache problem and is not.
- **Simultaneous movement cannot be emulated.** Interleaving `0x0B` and `0x09`
  every 100 ms produces no movement whatsoever — each new channel command aborts
  the previous one. Combined movement requires the dedicated `0x3x` codes.
- **Always write with response the first time.** With `response=false` ESPHome
  acknowledges locally regardless of what the bed thinks, so a rejected write
  looks identical to a successful one.
- **Address type cannot be inferred from the MAC.** The beds use random static
  addresses; connecting as PUBLIC gives `error=256` followed by `error=133`.
  Use the type ESPHome reports in the advertisement.
- **A short pulse is not proof.** The upper-section motor needs ~8 s to show
  visible movement where the leg motor needs ~4 s — a 4-second test made a
  correct command code look wrong.

## Development

```bash
npm test                              # 46 unit tests, no hardware needed
homey app validate --level publish
homey app run --remote                # dev session on the Homey
homey app install                     # permanent install
```

Pure logic lives in `lib/` and is covered by `node --test`: the protocol
encoding, the ESPHome wire format, the capability migration, and the command
queue/ticket logic (with a fake client, so the concurrency behaviour is testable
without a bed).

## Credits

Protocol starting points came from
[ha-adjustable-bed](https://github.com/kristofferR/ha-adjustable-bed) and
[linak-desk-spec](https://github.com/anson-vandoren/linak-desk-spec) — with the
corrections noted above. Capability icons use path data from
[Material Design Icons](https://github.com/Templarian/MaterialDesign); see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT — see [LICENSE](LICENSE).
