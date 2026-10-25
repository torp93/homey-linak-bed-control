# Bed position reporting

Some LINAK control boxes report where each motor actually is. Most do not.
This note records what is known, and why the feature is gated rather than
always on.

## The hardware split

Neither of the two TD5 boxes this app was developed against has the position
service at all. On those, `99fa0003` reads back zero bytes and never notifies,
with or without the `0xFE` wake command — see the measurements in `README.md`.
That is not a bug to be fixed: the box has nothing to say.

A TD5 Advanced (TwinDrive TDA, s.w. 1.22) does have it. The numbers below come
from a debug log captured on such a box on 2026-10-25 and shared in
[issue #1](https://github.com/torp93/homey-linak-bed-control/issues/1).

## What that box exposes

Service `99fa0020`, with one characteristic per motor:

| Characteristic | Motor | Properties |
| --- | --- | --- |
| `99fa0027` | legs | read, notify |
| `99fa0028` | back | read, notify |

`99fa0021`–`99fa0026` are present with the same properties, and `99fa0029` /
`99fa002a` are read-only. What they carry is not known, so nothing here uses
them.

## Payload

Four bytes: position as uint16 LE, then speed as int16 LE.

```
c70040fd  ->  raw 199, speed -704   (moving down)
c7000000  ->  raw 199, speed 0      (stopped)
33000000  ->  raw  51, speed 0      (stopped)
```

Speed is signed, negative downwards, and reaches 0 when the motor stops. A
position of `0xffff` means "unknown", not an end stop — it shows up before the
box has referenced itself after a power cycle.

Raw counts convert to degrees per motor: back 820 counts over 68°, legs 548
over 45°. Those maxima come from the one box above. If another box scales
differently the angle will be wrong while the raw count stays right, which is
why `readPositions` always returns `raw` alongside `angle`.

## Order of operations

On first connect, writes and subscriptions fail with ATT error 5,
`Insufficient authentication`, until BLE bonding completes — about three
seconds. Bond first, read or subscribe after. Done the other way round, a box
that fully supports positions looks exactly like one that does not.

## Why read instead of subscribe

Both characteristics are readable as well as notifying, and this app reads
them. A subscription keeps the BLE session open, and an open session locks the
bed's own handset out. For a value that only needs refreshing after a movement
ends, that is too high a price. Live tracking during a movement would need the
notify path, and would have to be opt-in for the same reason.

## How the gate works

`resolveHandles` returns `backPositionHandle` / `legsPositionHandle`, null when
the service is absent, and those fields are stored on the device alongside the
other handles. Storing them as null matters: it is the difference between
"discovered, the box does not have it" and "never discovered". Devices paired
before this existed have no such field at all, so the stored handles are
dropped once and rediscovered.

`BedDevice._requiredCapabilities()` adds `linak_bed_back_angle` and
`linak_bed_leg_angle` only when support was found. On every other bed
`migrateCapabilities` removes them, so no one gets a tile that is always empty.
