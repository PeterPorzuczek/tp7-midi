# TP7-MIDI

Web app to control your **Teenage Engineering TP-7** field recorder via MIDI and Bluetooth.

Works on phones, tablets, and computers - right in your browser.

**Live App:** https://peterporzuczek.github.io/tp7-midi/

Fork of [lucidyan/tp7-midi](https://github.com/lucidyan/tp7-midi), with BPM matching.

---

## How to Use

1. Open the app in your browser
2. Connect your TP-7 via USB or Bluetooth
3. Tap "Connect" and select your device
4. Control playback, recording, cue points, loops, and more

---

## Match a track to a target BPM

In **Playback Speed → Match BPM**, enter the track's BPM at its original speed
and the target BPM, then press **Apply**. Decimal points and decimal commas are
accepted. You can also use **Read BPM from WAV** to read saved ACID tempo metadata
from a local copy of the track. If the file has no valid BPM, enter it manually.
The file is read locally and is never uploaded or modified. This is metadata
reading, not audio beat detection or automatic access to the TP-7's selected file.

Start playback using the TP-7's physical Play button or a cue, set the device's
own SPD to **1×**, and disable external clock sync before applying. Apply releases
the MIDI rocker (CC18=64) and sends the calculated Pitch Bend together, without a
ramp or a correction loop. USB and Bluetooth are supported. The device's screen
SPD is a separate control and will not change. Changing speed/rocker controls
afterwards replaces the applied setting; use Apply again if needed.

**Precision:** the calculation uses exact decimal/rational arithmetic and chooses
the MIDI value with the smallest absolute BPM error under the experimental mapping
in [MIDI_SPEC.md](MIDI_SPEC.md#bpm-matching-and-precision). The preview shows the
predicted BPM and signed error. For example, **120 → 128** sends pitch **+546**,
predicting **127.998046875 BPM**, an error of **−0.001953125 BPM**. MIDI cannot
represent every requested ratio exactly. Targets outside the actual range
**0.25×–1.9998779296875×** are rejected rather than silently clamped.

TP-7's documented MIDI interface has no query for the current track's stored BPM
or screen SPD. Its official documentation identifies Pitch Bend as a speed control
but does not specify the transfer curve. This project's curve remains experimental;
the preview is **not a hardware measurement or a guarantee of the audible BPM**.
An accurate source BPM and neutral device settings are necessary. The app reports
“Sent” only after the transport accepts the message; TP-7 provides no acknowledgement
of the resulting speed. BPM inputs are not restored on reload because the selected
track cannot be verified. The existing speed setting is saved as before.

References: [official MIDI reference](https://teenage.engineering/guides/tp-7#midi-reference),
[TP-7 WAV Editor author](https://www.ecstasyjones.com/tp-7-wav-editor),
[ACID metadata layout in wavesync](https://github.com/pixelate/wavesync/blob/main/lib/wavesync/acid_chunk.rb).

---

## Device cue investigation

The **TP-7 Device Access** panel reads device replies over Bluetooth or USB,
shows the current file, position and playback state, and provides companion
Resume/Stop and experimental **Jump & play** controls. Jump & play uses a
millisecond time position. **It does not yet select existing native cues or read
their count.** Resume does not perform the physical Play button's cue jump.
The existing Cue Markers grid still addresses MIDI notes.

For Bluefy hardware testing, use **Read TP-7**, then **Start remote session**,
enter `10` seconds and try **Jump & play**. For native cue investigation,
select cues with +/− on TP-7 and press **physical Play on TP-7**. **Copy report** exports
the received data for analysis without needing a WAV file. See
[the research and protocol limits](docs/REMOTE_PROTOCOL.md).
The settings-reader unsupported notice on firmware 1.1.11 does not prevent
opening a companion session.

---

## Troubleshooting

### Browsers (READ THIS FIRST)

This app uses **Web Bluetooth (BLE)** for wireless control and **Web MIDI** for USB control.
Browser support is uneven — check compatibility here:
- Web Bluetooth support table: https://caniuse.com/web-bluetooth
- Web MIDI support table: https://caniuse.com/midi
- Web Bluetooth docs (requirements + permissions): https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API
- Web MIDI docs (requirements + permissions): https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API

#### Quick compatibility (TP7-MIDI)
| Platform | Bluetooth (Web Bluetooth / BLE) | USB (Web MIDI) |
|---|---:|---:|
| **iOS (Safari/Chrome/Edge/Firefox)** | ❌ | ❌ |
| **iOS (Bluefy)** | ✅ (BLE only) | ❌ |
| **Android (Chrome/Edge/Samsung Internet/Opera)** | ✅ | ✅ |
| **Android (Firefox)** | ❌ | ❌ |
| **macOS / Windows / Linux (Chrome/Edge/Opera)** | ✅ | ✅ |
| **macOS / Windows / Linux (Firefox)** | ❌ | ✅ (desktop only) |
| **macOS / iOS (Safari)** | ❌ | ❌ |
| **Brave (desktop)** | ⚠️ *usually OFF by default* | ⚠️ *sometimes broken/disabled* |

---

#### iOS (iPhone / iPad) limitations — why only **Bluefy** works
- **Safari on iOS does not support Web Bluetooth** and **does not support Web MIDI**:
  - Web Bluetooth: https://caniuse.com/web-bluetooth
  - Web MIDI: https://caniuse.com/midi
- **All iOS browsers that are “Safari under the hood”** (Chrome/Edge/Firefox on iOS) inherit the same limitations.
- **Bluefy** is a special iOS browser that implements **Web BLE** so it can do **Bluetooth (BLE)** in-browser:
  - App Store: https://apps.apple.com/us/app/bluefy-web-ble-browser/id1492822055
- **USB/MIDI on iOS:** not possible in the browser (no Web MIDI support on iOS).

---

#### Android — which browsers work?
Use a Chromium-based browser with Web Bluetooth + Web MIDI support:
- ✅ **Chrome** (Bluetooth help: https://support.google.com/chrome/answer/6362090)
- ✅ **Microsoft Edge** (Bluetooth/USB help: https://support.microsoft.com/en-us/microsoft-edge/connect-a-website-to-a-bluetooth-or-usb-device-in-microsoft-edge-107ba8a4-60aa-0fd3-2d26-afd63d0964f4)
- ✅ **Samsung Internet** (Web Bluetooth docs: https://samsunginternet.github.io/docs/web-bluetooth)
- ✅ **Opera** (Web Bluetooth support: https://caniuse.com/web-bluetooth / Web MIDI support: https://caniuse.com/midi)
- ❌ **Firefox for Android** (no Web Bluetooth / no Web MIDI): https://caniuse.com/web-bluetooth / https://caniuse.com/midi

If Bluetooth scanning finds **zero devices** on Android:
- Turn **Bluetooth ON**
- Turn **Location Services ON** (BLE scanning is often gated behind Location on Android)
- Allow the browser **Nearby devices / Bluetooth** permission (and Location permission if asked)

---

#### macOS / Windows / Linux — recommended browsers
- ✅ **Chrome** (Web Bluetooth docs: https://developer.chrome.com/docs/capabilities/bluetooth)
- ✅ **Microsoft Edge** (Bluetooth/USB help: https://support.microsoft.com/en-us/microsoft-edge/connect-a-website-to-a-bluetooth-or-usb-device-in-microsoft-edge-107ba8a4-60aa-0fd3-2d26-afd63d0964f4)
- ✅ **Opera** (Web MIDI settings hint: `opera://settings/content/midiDevices`)
- ⚠️ **Firefox (desktop)**: **USB/MIDI can work**, **Bluetooth won’t**:
  - Web MIDI support: https://caniuse.com/midi
  - Web Bluetooth unsupported: https://caniuse.com/web-bluetooth
  - Firefox Web MIDI note (permission add-on): https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/108
- ❌ **Safari (macOS)**: no Web Bluetooth + no Web MIDI:
  - https://caniuse.com/web-bluetooth
  - https://caniuse.com/midi

---

#### Brave notes (desktop)
Brave is Chromium-based but often disables “dangerous” device APIs by default.

**If Bluetooth doesn’t work in Brave:**
1. Open `brave://flags`
2. Search: **Web Bluetooth**
3. Enable it
4. Relaunch Brave  
(Example reports: https://community.brave.app/t/can-you-enable-web-bluetooth-api-in-brave/522553)

**If Brave says “MIDI devices not supported”:**
- Try **Chrome or Edge** first (Brave sometimes disables/breaks Web MIDI in some builds):
  - Example report: https://community.brave.app/t/midi-devices-not-supported/507756

---

### Permissions & feature enablement (Desktop + Android)

#### 1) HTTPS requirement (must-have)
Web Bluetooth and Web MIDI require a **secure context** (HTTPS), except `localhost` for dev:
- Web Bluetooth (MDN): https://developer.mozilla.org/en-US/docs/Web/API/Web_Bluetooth_API
- Web MIDI (MDN): https://developer.mozilla.org/en-US/docs/Web/API/Web_MIDI_API

#### 2) Bluetooth permission (Web Bluetooth)
**Chrome / Chromium browsers**
- Chrome help (Bluetooth site connect): https://support.google.com/chrome/answer/6362090
- Debug page (advanced): `chrome://bluetooth-internals` (Chrome docs mention it: https://developer.chrome.com/docs/capabilities/bluetooth)

**macOS system permission**
- If the browser is blocked at OS level: System Settings → Privacy & Security → **Bluetooth**
  - Apple guide: https://support.apple.com/guide/mac-help/change-privacy-security-settings-on-mac-mchl211c911f/mac

#### 3) MIDI permission (Web MIDI / USB)
**Chrome**
- MIDI permission help: https://support.google.com/chrome/answer/14871962
- Chrome change (permission prompt for all Web MIDI access): https://developer.chrome.com/blog/web-midi-permission-prompt

**Firefox (desktop)**
- Firefox may prompt you to install a **Site Permission Add-On** when a site requests MIDI:
  - https://developer.mozilla.org/en-US/docs/Mozilla/Firefox/Releases/108

---

### Android + USB cable: TP-7 not showing up (only charging)
On Android, you must switch the USB mode to **MIDI**:

1. Use a **data/OTG-capable** USB-C cable/adapter (not charge-only).
2. Plug in the TP-7.
3. Pull down notifications → tap **USB for…**
4. Select **MIDI**
5. Reload the page → press **Connect** → choose the TP-7 from the MIDI device list.

Official Android docs mention this exact flow (“USB for…” → MIDI):
- https://source.android.com/docs/core/audio/midi

Tip: If you want it to default to MIDI every time:
- Settings → Developer options → Networking → **Select USB Configuration** → **MIDI**
  (also documented here: https://source.android.com/docs/core/audio/midi)

---

### Still stuck?
- Update your browser to the latest version.
- Close other tabs/apps that might already be connected to TP-7 via MIDI/Bluetooth.
- Linux note: sandboxed browser packages (Snap/Flatpak) can block USB/Bluetooth access — try official Chrome/Edge, or adjust sandbox permissions.


 ---
 
## Documentation

| Document | Description |
|----------|-------------|
| [MANUAL.md](docs/MANUAL.md) | TP-7 manual (text version, screen reader friendly) |
| [FIRMWARE_CHANGELOG.md](docs/FIRMWARE_CHANGELOG.md) | Firmware updates history |
| [MIDI_SPEC.md](MIDI_SPEC.md) | MIDI commands reference |

---

## Official TP-7 Resources

- Manual: https://teenage.engineering/guides/tp-7
- Firmware: https://teenage.engineering/downloads/tp-7
- Product: https://teenage.engineering/products/tp-7

---

## Known Bugs & Limitations

These are TP-7 firmware limitations discovered through MIDI experimentation:

| Issue | Description |
|-------|-------------|
| **No standard state queries** | The standard MIDI controls have no documented state queries. Their UI may become out of sync after reconnection or physical interaction. Experimental vendor SysEx replies are investigated separately in the Device Access panel. |
| **Controller Mode is separate** | TP-7 only sends button events (CC 20-27) in Controller Mode, which is mutually exclusive with receiving MIDI commands. You cannot control AND receive events simultaneously. |
| **No stop during playback** | In playback mode (after Play or Cue trigger), CC18 value 64 no longer stops. Stop point shifts between 60-61. To stop: set CC18=60 AND Pitch Bend=+708. |
| **SPD/Pitch Bend disconnect** | The Pitch Bend speed multiplier and SPD on screen SHOULD be the same control, but they're completely separate. Pitch Bend changes are NOT visible on TP-7 display. Likely a firmware bug. |
| **Recording via MIDI is useless** | CC14 arms recording, but you can't control playback in record mode via MIDI (only rocker emulation works). Use physical controls for recording. |
| **No MIDI way to clear cues** | To clear cue markers on TP-7, you must change the track manually on the device. |
| **MIDI-CUE setting required** | You must enable MIDI-CUE in TP-7 settings for cue markers to work via MIDI. |
| **Loop is a state machine** | CC17 must follow sequence: Off(0) → In(1) → Out(2) → Off(0). Can't set Out without In first. Can't change points while loop is active. |

See [MIDI_SPEC.md](MIDI_SPEC.md) for full technical details.

---

**Last Updated:** 2026-01-24 | **Firmware:** 1.1.11

*Unofficial community project. TP-7 is a product of Teenage Engineering.*

[For developers](dev/)
