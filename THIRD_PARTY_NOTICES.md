# Third-party notices

## Material Design Icons

The capability icons in `assets/capability-icons/` use path data from
[Material Design Icons](https://github.com/Templarian/MaterialDesign) by
Pictogrammers, licensed under the Apache License 2.0.

Icons used: `chevron-double-up`, `chevron-double-down`,
`stop-circle-outline`, `bluetooth`, `lightbulb-on-outline`. The bed-profile
pictograms they are composed with are original work.

```
Copyright (c) 2014, Austin Andrews / Pictogrammers

Licensed under the Apache License, Version 2.0 (the "License");
you may not use these files except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Protocol

The LINAK BLE command set was reverse-engineered against the author's own beds.
Initial pointers came from [ha-adjustable-bed](https://github.com/kristofferR/ha-adjustable-bed)
and [linak-desk-spec](https://github.com/anson-vandoren/linak-desk-spec); note
that several details in both differ from what this bed actually does, and the
values in `lib/linak-bed-protocol.js` are the ones verified in practice.

The ESPHome native API client in `lib/esphome-api.js` is original work,
written against the wire format of [ESPHome](https://esphome.io) (MIT/GPL).
