# TP-7 remote cue investigation

The requested behavior is selection and playback of **existing, device-loaded
cue markers**, without asking the user for a WAV. Automatic marker enumeration
and cue-number selection are **not yet implemented**. **TP-7 Device Access** now
reads live track/transport events and implements the companion application's
position command. A time jump is not selection of a device-native cue number.

## Evidence checked on 2026-11-16

1. [TE's MIDI reference](https://teenage.engineering/guides/tp-7) documents Note
   On/Off cue triggering and CC16 cue recording. It does not document a query for
   the current file's marker list or equivalents of the physical +/− buttons.
2. [TE's updater](https://teenage.engineering/apps/update) currently serves
   [this JavaScript bundle](https://teenage.engineering/apps/update/assets/index-C5siZ7yC.js).
   Inspection established the request/response envelope, seven-bit packing,
   request IDs, error statuses, GREET, and the Settings API. It did not reveal
   a TP-7 cue-selection command. No updater/DFU code is included in this app.
3. [This original hardware report](https://github.com/lucidyan/tp7-midi/issues/1)
   describes companion Start Session `0x40`, Play `0x50`, and Stop `0x51` under
   outer command `0x7F`. Its firmware version is unknown and its physical tests
   used USB, not BLE. Treat Bluetooth transport behavior as experimental.
4. [The BLE-MIDI reference implementation](https://github.com/lathoub/Arduino-BLE-MIDI/blob/master/src/BLEMIDI_Transport.h)
   describes timestamps, SysEx fragmentation and the timestamp before `F7`.
   The previous application's ordinary CC/Note writer is insufficient for
   fragmented SysEx responses, and did not subscribe to BLE notifications.
5. TEKit's current TP-7 handler is a placeholder, and its SysEx envelope differs
   from TE's updater. It was not used as evidence for cue support. MTP tools read
   files by switching device modes; that is not live cue selection.

## Real Bluefy capture and companion application analysis

The user's BLE report from TP-7 firmware **1.1.11**, normal mode, established:

- GREET and Start Session succeed over Bluefy. Settings command `0x06` returns
  status `2` (command not found); this is not a Bluetooth connection failure.
- Session response data is `[0x42, 1]`. Play and Stop return `[0x4E, 1]` and
  `[0x4E, 0]`. The user confirmed that remote Play resumes playback but does not
  perform the physical Play button's jump to the selected native cue.
- Unsolicited events have envelope flags `0x40`, ID byte `0`, outer command
  `0x7F`, and packed data starting at byte 9, **without a status byte**. They
  cannot acknowledge a pending host request. The old response-only parser kept
  these frames as unknown; the new parser decodes them separately.
- `0x4D` carries a little-endian unsigned 32-bit position in milliseconds.
  The capture has 124 such events; the final position is 54,781 ms.
- `0x4B` contains track metadata and the current folder/filename. The capture
  reports 48,000 Hz, 7,832,495 sample frames and five tracks. It contains no cue
  list or BPM field. Numbers in the filename are not treated as metadata.

The protocol was additionally checked by static analysis of the
[TP-7 Android companion application](https://play.google.com/store/apps/details?id=com.teenageengineering.tp7),
version **1.1.4, build 54**, arm64. The package was obtained from its
[APKPure mirror](https://apkpure.net/tp%E2%80%937/com.teenageengineering.tp7/download/1.1.4),
not run or installed. Archive SHA-256:
`7a859b21a11f332be8deac1d80318eca026a6d216c5fe99c9935cef478db78ec`.
The package and generated application dumps are not part of this repository.

Relevant findings, recorded for reproducibility:

- `Gro.midi.sysex.te.Tp7Command.SET_POSITION` is decimal 76 (`0x4C`).
- `Tp7NewRecorderService.SetPosition(uint offset)`, ARM64 RVA `0xCADB48`, builds
  an outer `0x7F` request with a byte `0x4C` followed by the uint32 offset.
- `TeArguments.Add(uint)`, RVA `0xCEC5A8`, uses `BitConverter.GetBytes`; the
  ARM64 payload is little-endian. No scaling, cue index or extra mode byte is
  added. A jump to 10,000 ms therefore has raw payload `[76,16,39,0,0]`.
- `OnMidiDataReceived` reads the track event as two uint32 values (sample rate,
  frames), one byte (track count), six date/time bytes, then two zero-terminated
  UTF-8 strings. This independently matches the captured `0x4B` event.
- The companion command table has no command named for cue enumeration or
  selection. That does not prove no other firmware interface exists.

The **position command has not yet been tested on the user's hardware**. The
source-derived wire format and simulated acknowledgements must not be presented
as a hardware-verified cue-navigation implementation.

## Implemented panel

- **Read TP-7** subscribes to BLE MIDI notifications (or requests USB SysEx access
  and attaches the matching input), then sends GREET (`0x01`). Identification must
  actually return `product:TP-7` before companion controls become available.
- It attempts the manufacturer's read API: command `0x06`, INIT payload
  `[1, 0x03, 0xE8]`, followed by GET_ALL `[2, pageHi, pageLo]`. Pages have a two-byte
  prefix and null-terminated JSON segments. Reads stop on the empty page, with
  bounds on time, message length, page count and total catalogue size.
- Cue-related settings are included in the report **without interpreting them
  as a list of markers**. In particular, a MIDI mode option named `cue` is not a
  cue selector. The panel never writes settings (`SET`, subcommand 3).
- **Start remote session** sends product-specific opcode `0x40`. Resume/Stop
  only become available after a matching successful response. Play disables
  record arm and cue-record mode before sending opcode `0x50`; Stop sends `0x51`.
  An acknowledgement is not proof that playback jumped to a selected cue.
- **Jump & play** stops playback, sends `SET_POSITION` and resumes only after
  matching successful replies. Input is converted from decimal seconds to
  integer milliseconds without floating-point rounding. Invalid or out-of-track
  positions are disabled, and failed seeks do not resume playback. The operation
  is cancelled before further transmission if the file, input or connection
  changes. Millisecond command precision is not a claim of sample-accurate
  hardware positioning.
- Live file, position and playback status are updated from incoming events.
  Position history is kept separately (last 600 samples) so routine progress
  updates do not erase the initial track information and command history.
- Incoming device events and the last 64 non-clock BLE packets are kept as raw,
  bounded data, including MIDI input that is not recognized as vendor SysEx.
  Physical cue selection
  on the device can reveal whether the companion session emits useful events.
  Unknown event payloads remain raw. There is no opcode sweep, file transfer or firmware
  update operation. The panel does nothing automatically upon connection.
- Reports stay in the browser until the user copies them. They contain firmware,
  raw protocol replies and possibly device identifiers or track information.
  The report is reset when the connection changes.

## Next hardware observation

On Bluefy: connect TP-7, press **Read TP-7**, then **Start remote session** if
identification succeeds. The unsupported settings-reader notice on 1.1.11 is
expected. Test **Jump & play** at a known time (for example 10 seconds), compare
the device's actual playback position, and copy the report. To investigate native
cues, select two existing cues using the device's +/− buttons and trigger each
with **physical Play on TP-7**, not Resume in the web app. Copy the report.
This can supply evidence about available settings and events without requiring
the audio file. An unsupported-command response is an actual result, not a
reason to send speculative command numbers.

The pure protocol and simulated browser tests validate framing, fragmentation,
acknowledgement matching, error paths and controls. They do not establish native
cue support on real TP-7 hardware.
