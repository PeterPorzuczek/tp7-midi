# TP7-MIDI

Web app to control your **Teenage Engineering TP-7** field recorder via MIDI and Bluetooth.

Works on phones, tablets, and computers - right in your browser.

**Live App:** https://peterporzuczek.github.io/tp7-midi/

Fork of [lucidyan/tp7-midi](https://github.com/lucidyan/tp7-midi), with BPM matching and a generated DJ jump grid.

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

## DJ Jump Grid

On Bluefy, connect over Bluetooth, press **Read TP-7**, then **Start remote
session**. The **DJ Jump Grid** reads the current filename and duration from TP-7.
Enter the **original track BPM**, choose **Jump every** and **Beats per bar**, then
tap a generated button to jump and play. Changing grid settings sends no commands.
The default is every **4 bars**, with **4 beats per bar**. Available intervals run
from a quarter beat to 32 bars; long grids have pages of 32 buttons.

Explicit filename labels such as `tempo_88`, `bpm_128`, or `127.125bpm` fill in BPM
automatically. Conflicting labels require manual entry. Numbers such as `cues_15`
are ignored. Manual BPM and interval settings are remembered separately for each
track in this browser. This does not change the separate Match BPM inputs.

Prepare tracks with a constant tempo and the first beat at **0:00**. Beats mean
quarter notes, so choose 4 per bar for 4/4. Use the original BPM even if playback
speed is changed: the buttons address the original file timeline. This is a
calculated grid, not audio/drum detection or an import of embedded native cues.

For a 7,832,495-frame, 48 kHz track at 88 BPM, four-bar spacing generates **15
jumps**, from 0:00.000 through 2:32.727, within a **2:43.177** track. Each position
is calculated independently with exact integer ratios and rounded once to the
nearest millisecond (at most 0.5 ms arithmetic error; no accumulated rounding).
That precision describes the requested file position, not audible device timing.
Each tap uses the working Stop → Set position → Play sequence. Bluetooth and
device latency cause a playback interruption; there is no live beat quantization
or synchronization to another deck. Existing TP-7 cues are not written or erased.

## Prepared Cue Carrier

The user confirmed receiving three cue points from a separate `.tp7-cues.wav`
file over Bluetooth in Bluefy on TP-7 1.1.11. A later report accepted `.cue` and
received audio but stopped after 11 complete 4000-sample blocks (2.75 seconds),
truncating a 2.94-second helper. This exact failure is reproduced in the tests.
New helpers include at least one second of trailing silence and align to 250 ms
blocks so the cue data and CRC precede the potentially omitted tail. **The padded
helper still needs device validation; hiding it from TP-7's track list is not confirmed.**
This does not read the native marker
table or change the recorder's native CUE selection.

Prepare once, when loading music onto TP-7:

1. In [TP-7 WAV Editor for Windows](https://github.com/PeterPorzuczek/tp7-wav-editor-win),
   use version **1.3.1 or newer**, and leave **Export matching .cue companion** checked. Export writes `track.wav`
   and `track.cue` from the same snapshot, including multitrack exports. Alternatively,
   use **Prepare a cue companion once → Prepare from WAV cues** here and choose
   **Save companion file**. This reads headers/markers locally, skipping audio.
2. Copy both files to the same TP-7 folder using your normal music-transfer method.
   Select **track.cue** in this panel. If TP-7 rejects that extension, rename only
   the companion to `track.tp7-cues.wav` and select **older exports** here. That
   fallback works on hardware but appears as another audio track. Keep the original
   WAV filename and companion audio unchanged. The web app does not upload files.
   An experimental **track.txt (extension test)** option prepares and reads the
   same audio under `.txt`; it does not implement plain-text Bluetooth transfer.
   Use the final WAV filename before preparation: renaming both exported files
   does not update the filename embedded inside the companion.
3. In Bluefy, select **the original music track** on TP-7, connect, **Read TP-7 →
   Start remote session → Read cue carrier**. The app requests the helper by name,
   checks its signal, CRC and source identity, then shows cue buttons. Playback is
   stopped during reading; the remote session is restored automatically after
   acknowledged cleanup. Tapping a cue uses the existing Stop → Seek → Play path.

For a first hardware test without the original WAV on hand, **Prepare 0 / 10 / 20 s
test** creates a helper for the currently observed track. These are explicitly
labelled TEST points, not recovered native markers. Save/copy/read it as above.

Sample offsets are preserved as uint32 values and rounded once with integer
arithmetic to the nearest millisecond for the device's seek command. No rhythm
analysis or repeated interval rounding is used. Track matching checks filename,
sample rate and frame count; regenerate a helper after changing the original
audio or markers. It is not an audio-content fingerprint. The carrier is a
separate PCM WAV containing FSK data that can survive the companion's ADPCM
conversion. It is not an ordinary text `.cue` sidecar, and the original WAV's
metadata is not being fetched over Bluetooth.

Transfer is bounded to 512 KiB compressed data and 40 seconds. Invalid, truncated,
corrupted or mismatched data produces no cue buttons. Audio stays in browser
memory for decoding and is omitted from reports. The report includes the checked
marker list, decoder counts and cleanup outcome. Cue buttons are cleared when
the track/connection changes. Bluetooth and device latency still apply to jumps.
Zero through 256 markers are supported. Empty exports clear the web marker list;
markers at the file end (including those rounding to it) are preserved and shown
disabled, since the remote seek must precede EOF. Re-export and copy **both** files
after editing cues. Changes made directly on TP-7 are not synchronized back.

## Companion Bluetooth audio diagnostic

The 23 November 2026 hardware report rejected generic FILE command 5 twice
with status 2 (command not found). Retrying that test does not enable cue access.

**Companion Bluetooth → Test companion audio** uses the separate GATT service
identified in the official companion application's binary. Reconnect Bluetooth
after loading this version, then use **Read TP-7 → Start remote session** first.
Close other companion apps. The test stops playback, opens track 0 of the current
file, requests audio and aborts after a small sample (4 KiB target; 8-second receive
timeout). It then exits transfer mode and closes its session. Press **Start remote
session** again to use the normal playback controls. If cleanup is not acknowledged,
disconnect and reconnect before continuing. Cancel also attempts this cleanup.

The report contains stages, request results and byte counts, not the audio.
**Audio reception is not native cue extraction.** The companion transcodes audio
to ADPCM / 16 kHz mono and reconstructs a WAV, losing original RIFF metadata. A
prepared WAV carrier now supplies an alternative described above. The short
diagnostic remains available separately; it does not read markers.

## Earlier generic FILE experiment

**Bluetooth File Access** tests TE's generic FILE interface over the existing
Bluetooth/MIDI connection. Its command format comes from TE's official Sample
Tool, but **the user's TP-7 rejected this interface on the tested MIDI connection**.

In Bluefy: **Read TP-7 → Start remote session**, stop playback, disconnect other
companion apps, then press **Test file access**. If the device returns a listing,
choose **Read selected file**. The reader can extract actual cue/BPM metadata from
the current WAV by skipping its audio bytes, or download a listed `.cue`/`.json`
file up to 64 KiB. Verified WAV markers become jump buttons. The app does not
create or write any device files. Rejected/unknown responses stop the test and
remain in **Copy file test report**. An unsupported response disables retries for
that connection. This panel is retained for investigating other firmware.

See [source evidence and test boundaries](docs/REMOTE_PROTOCOL.md#2026-11-23-alternative-file-interface).

## Device cue investigation

The **TP-7 Device Access** panel reads device replies over Bluetooth or USB,
shows the current file, length, position and playback state, and provides companion
Resume/Stop and experimental **Jump & play** controls. Jump & play uses a
millisecond time position. The companion events do not expose native cue positions
or counts. The separate FILE experiment attempts to read them from the WAV.
Resume does not perform the physical Play button's cue jump.
The existing Cue Markers grid still addresses MIDI notes.

The user confirmed manual time jumps work on TP-7 / Bluefy on 2026-11-17.
For native cue investigation,
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
