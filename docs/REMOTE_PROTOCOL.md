# TP-7 remote cue investigation

The requested behavior is selection and playback of **existing, device-loaded
cue markers**, without asking the user for a WAV. That behavior is **not yet
implemented**. The new **TP-7 Device Access** panel is a hardware investigation
tool; it must not be presented as working native cue navigation.

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
- **Start remote session** sends product-specific opcode `0x40`. Native Play/Stop
  only become available after a matching successful response. Play disables
  record arm and cue-record mode before sending opcode `0x50`; Stop sends `0x51`.
  An acknowledgement is not proof that playback jumped to a selected cue.
- Incoming device events and the last 64 non-clock BLE packets are kept as raw,
  bounded data, including MIDI input that is not recognized as vendor SysEx.
  Physical cue selection
  on the device can reveal whether the companion session emits useful events.
  There is no guessed event decoder, opcode sweep, file transfer or firmware
  update operation. The panel does nothing automatically upon connection.
- Reports stay in the browser until the user copies them. They contain firmware,
  raw protocol replies and possibly device identifiers or track information.
  The report is reset when the connection changes.

## Next hardware observation

On Bluefy: connect TP-7, press **Read TP-7**, then **Start remote session** if
identification succeeds. Select two existing cues using the device's +/− buttons
and trigger each with physical Play. Copy the report from the details section.
This can supply evidence about available settings and events without requiring
the audio file. An unsupported-command response is an actual result, not a
reason to send speculative command numbers.

The pure protocol and simulated browser tests validate framing, fragmentation,
acknowledgement matching, error paths and controls. They do not establish native
cue support on real TP-7 hardware.
