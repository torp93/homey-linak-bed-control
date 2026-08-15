LINAK Bed

Control a LINAK adjustable bed from Homey, through an ESP32 running ESPHome
as a Bluetooth proxy. No cloud, no LINAK account — everything stays on your
own network.

FEATURES

- Buttons on the device page for the head end and the foot end, up and down,
  plus the combined movements: both sections up, both down, sit-up
  (feet down, head up) and leg relief (feet up, head down).
- The under-bed light as its own button, and a Stop button that interrupts
  an ongoing movement immediately.
- Buttons run until you press Stop, the way the physical remote works. A new
  press replaces whatever is running, so changing direction mid-movement
  responds at once instead of queueing behind it.
- A "Both beds" device that sends every command to all your paired beds in
  parallel — useful for a double bed made of two separate frames.
- Flow cards for movement with a chosen duration, stop, and the light, plus
  a condition for whether the light is on.
- Bluetooth signal strength and connection state per bed, so you can see
  whether the proxy is well placed.
- A maximum run time per bed as a safety limit, in case a stop command never
  arrives.
- Considerate Bluetooth: the connection lingers briefly after a command so
  the next press is instant, then releases so the bed's own remote works
  again. How long it lingers is adjustable, down to releasing immediately.

REQUIREMENTS

- A LINAK adjustable bed that advertises over Bluetooth as "Bed" followed by
  a number. Developed and tested against two Svane Zefir beds with LINAK TD5
  control boxes. TD4 uses the same Bluetooth protocol and is expected to work;
  other LINAK beds share the same service and are likely to work too, but are
  untested — feedback from other beds and brands is very welcome.
- An ESP32 (a basic ESP32-C3 is enough) running ESPHome with the
  bluetooth_proxy component, placed near the bed with clear line of sight.
  Enter its address in the app settings after installation. A complete,
  tested ESPHome configuration is included in the repository — copy it, add
  your WiFi secrets and flash.
- The app does not use Homey's own Bluetooth radio, so the bed needs to be
  within range of the ESP32, not of your Homey. The bed transmits weakly and
  its control box sits under the frame, so place the ESP32 close: aim for a
  signal better than -70 dBm, which the app shows on the device page.

ADDING A BED

The bed only accepts a new connection while it is in pairing mode, and that
mode starts only after a full two-minute power cut:

1. Unplug the bed's power.
2. Wait two whole minutes. Shorter breaks do nothing at all.
3. Plug it back in. The light under the bed blinks.
4. Add the device in Homey within the next three minutes.

Each bed needs its own power cut. Once a bed has been added successfully it
connects freely from then on, with no need to repeat this.

GOOD TO KNOW

- Only one controller at a time: while Homey holds the Bluetooth connection,
  the bed's physical remote does not respond. The connection is released a
  short while after each command, and you can set that delay to zero if you
  want the remote free immediately.
- The bed cannot report its position, so there are no sliders and no
  position readout — the buttons work like the remote, running until you
  stop them. The light state shown is what was last commanded.
- Movements are momentary by design. If Homey or the network drops out
  mid-movement, the bed stops on its own within a fraction of a second.

SOURCE, ISSUES AND FEEDBACK

https://github.com/torp93/homey-linak-bed-control

Bug reports, feature requests and reports from other LINAK beds are all
welcome there. The repository also documents the Bluetooth protocol as it
was found in practice, including several details that differ from what is
publicly documented elsewhere.

This is a community project with no affiliation to LINAK A/S or Svane. It
builds on protocol research from the ha-adjustable-bed and linak-desk-spec
projects; see the repository for full third-party notices.
