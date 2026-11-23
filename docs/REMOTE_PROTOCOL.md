# TP-7 remote cue investigation

The requested behavior is selection and playback of **existing, device-loaded
cue markers**, without asking the user for a WAV. Automatic marker enumeration
and cue-number selection are **not hardware-verified**. **TP-7 Device Access** now
reads live track/transport events and implements the companion application's
position command. A time jump is not selection of a device-native cue number.
On 2026-11-17 the user confirmed manual time jumps work and requested generated
beat/bar jumps as an alternative. That workflow is implemented in **DJ Jump Grid**.
On 2026-11-23 a separate **Bluetooth File Access** experiment was added: TE's
generic FILE command can potentially read the original WAV's marker chunks or
a small sidecar over the existing MIDI connection. Its availability on TP-7
was tested on hardware later that day and rejected (details below).

## 2026-11-23 hardware result and separate companion GATT channel

**Subsequent hardware confirmation:** the user's version-4 report at 21:13 UTC
identifies TP-7 firmware 1.1.11, receives **4237 audio bytes, 3 DATA_FIRST and 16
DATA_CONT packets**, and gets status 0 for all eight companion-channel requests.
Abort receives `49 01`; transfer exit receives `45 00`; session stop receives
`42 00`; `cleanupErrors` is empty. This validates the GATT service, request framing,
current-track transfer and cleanup on Bluefy. Subsequently the user confirmed all
three test points were recovered from the separate `.tp7-cues.wav` helper. This
also validates opening that helper, PCM decoding and carrier recovery. Native cue
extraction, `.cue` extension acceptance and hiding that extension from the track
list remain unverified.

The user's latest, partially pasted report contains two complete FILE INIT
transactions at 20:50:54 and 20:50:57 UTC. Request IDs 12 and 13 use outer command
5 and payload `01 00 00 00 10 00`. Both responses have **status 2, empty data**.
Companion transport requests in the same report succeed. This is an explicit
command-not-found response, not a timeout or a BLE reassembly failure. The raw
report is private and is not committed. The UI now describes this result and
disables further FILE attempts in a connection after an unsupported reply.

Further static inspection of companion Android 1.1.4 (54), arm64, found a distinct
BLE transport in `TeMidiBleService`. Binary provenance is recorded below; the
application was never installed or executed. Relevant RVAs in `libil2cpp.so`:

| Method | RVA | Finding |
| --- | --- | --- |
| `TeMidiBleService..ctor` | `0xCAA750` | service `cc12911c-ce96-4100-9db2-35b1b534d5cf`, characteristic `36a339c2-991a-486a-acfe-c840b39ae499` |
| `SendSysex` | `0xCA94D4` | 20-byte packets from `TeMidiOverBleSysexSendBuffer` |
| `SetData` (send buffer) | `0xCBA2A4` | message-type prefix 1 on every packet, initial BLE timestamps, final timestamp before F7; no header on continuation fragments |
| `OnCharacteristicValueChanged` | `0xCA9E54` | prefix 1 MIDI; prefix 2 first audio block, skipping four following bytes; prefix 3 continuation audio |
| `FinishAudioData` | `0xCA9694` | DVI ADPCM blocks decoded before emitting PCM |
| `EnterFileTransfer` | `0xCAD560` | `43`, track byte, NUL-terminated folder, NUL-terminated filename |
| `RequestAudio` | `0xCAD7C4` | `46`, two uint32 LE arguments; download menu calls with `(0, 0)` |
| `DownloadMenu.BeginState` | `0xC97F10` | first track index 0; waits for transfer-active before requesting audio |

The constructor's relocations at `0x1B028F0` and `0x1B028F8` point to string slots
`0x1B81AC8` and `0x1B792C0`, respectively. These resolve to the UUIDs above, **not**
the standard MIDI service `03b80e5a-…` or the other BLE UUIDs in the binary.

`companion-ble.js` implements this separate packet transport. The explicit test
opens the service, GREET-identifies TP-7, starts a session, stops playback, enters
track-0 transfer for the already observed file, waits for `45 01`, then requests
audio with `(0, 0)`. It aborts at a 4096-byte target or waits for a natural completion;
an 8-second audio deadline and 64 KiB receive-count limit bound the sample. Request
ACKs have five-second deadlines. This uses the app's full-track request followed
by early abort; the units of nonzero offset/duration arguments are not inferred.
This short diagnostic retains no audio payload. The separate carrier reader
described below retains bounded blocks temporarily for decoding.

Finally it attempts ABORT_AUDIO (`48`), QUIT_FILE_TRANSFER (`44`) and STOP_SESSION
(`41`) in order, each with a two-second reply deadline. Failed cleanup is shown
explicitly, with instructions to reconnect. Cancel and track changes also clean
up. MIDI writes and the other remote operations are blocked during the test;
the ordinary session must be restarted afterwards. Updated Bluetooth selection
requests access to the additional service, so the page must be reloaded and the
device reconnected once. No arbitrary opcode scan or device file write is used.

Report version 4 includes `companionAccess`: stage, requests, ACK status, audio
packet/byte counts and cleanup outcome. It never labels audio receipt as native
cue support. Unit and browser simulations cover packet boundaries, notification
DataView offsets, missing service, rejection, cancellation, track changes,
malformed audio and cleanup. Real Bluefy/device reception was confirmed by the
later report summarized above.

## Prepared cue carrier (report version 5)

`cue-carrier.js` and `carrier-panel.js` implement a prepared audio sidecar. A local
WAV's RIFF `cue ` sample offsets and optional ACID BPM are read with the existing
bounded parser; its `data` chunk is skipped. This preparation call explicitly
passes `expected = null`, while device FILE reads still require matching the live
track. A test-only generator uses 0/10/20 seconds within the current track and
sets a flag that remains visible after decoding. Neither generator changes the
original WAV or writes to TP-7.

### Codec evidence

Static inspection of `libGroAudio.so` from the same companion package found
`dvi_adpcm_decode` at RVA `0x4458` (672 bytes), wrapper `_dvi_adpcm_decode` at
`0x46F8`. Library SHA-256:
`65d80ec3fe9807255f48fe528bc97ecb26348a2e03d506b6d685c2f60675347e`.
The decoder reads a **signed big-endian 16-bit predictor followed by one step-index
byte**. Compressed nibbles start immediately at byte 3, high nibble first. The
initial predictor is not emitted as a sample. Each block yields `(length - 3) * 2`
PCM samples. Step and index tables at `0x7D0` / `0x882` match IMA's 89-step table.
The code clamps predictor to signed 16-bit and index to 0–88 after each nibble.

This differs from ordinary little-endian IMA WAV block framing. It also omits the
reserved fourth byte in the [RFC 3551 DVI4 header](https://www.rfc-editor.org/rfc/rfc3551#section-4.5.1).
The receiver removes the separate four-byte DATA_FIRST prefix before collecting
the compressed block, exactly as the companion does. A new DATA_FIRST finalizes
the preceding block; natural AUDIO_COMPLETE finalizes the last block. No binary
from the app is executed or distributed with this project.

### On-disk audio and payload

The helper name replaces `.wav` with `.cue`, in the source track's folder. A
selector retains the hardware-confirmed `.tp7-cues.wav` fallback and adds an
experimental `.txt` extension test; the bytes are identical encoded audio, not text.
A later 1.1.11 report accepted `.cue`, transferred 22,033 ADPCM bytes in 11 blocks
(44,000 decoded samples), and signaled natural completion. The corresponding old
helper was 2.94 seconds long. Dropping its partial 4000-sample tail reproduces the
exact truncation failure, consistent with the firmware omitting a partial block.
This is an inference from the report and local reproduction, not firmware source.
New generators keep 150 ms leading silence, add at least one second of trailing
silence, and round total duration up to a 250 ms block boundary. Payload v1 is
unchanged; old complete helpers still decode. Device validation of the padded
helper and `.txt` extension remains outstanding.
The file is mono PCM, 48 kHz, signed 16-bit. Bits are
MSB first, 400 baud, using 1200 Hz for zero and 2400 Hz for one (3/6 cycles per
120-sample symbol). At the companion's 16 kHz output each symbol is 40 samples.
An eight-byte `55` training sequence precedes sync `D3 91 6B C5 A7 2E 84 F0`,
uint16 LE payload length, payload, and uint32 LE CRC-32/IEEE covering length plus
payload. This is a project-specific carrier format, not a TE command or text CUE.

Payload v1 (all multibyte numeric fields LE):

| Offset | Field |
| --- | --- |
| 0 | version 1 |
| 1 | source kind: 0 original WAV markers, 1 test points |
| 2 | uint32 original sample rate |
| 6 | uint32 original frame count |
| 10 | float64 stored BPM; zero means absent |
| 18 | uint16 UTF-8 filename byte count |
| 20 | uint16 cue count (0–256) |
| 22 | two reserved zero bytes |
| 24 | UTF-8 original filename, then uint32 cue sample offsets in time order |

The decoder searches the initial 0.75 seconds over all 40 sample phases, requires
a matching training/sync sequence, then compares quadrature tone energy inside
each symbol. It rejects weak symbols, truncation, bad CRC, unknown versions,
reserved bits, invalid ranges, invalid UTF-8 and mismatched source identity.
Filename, sample rate and total frames must match the still-current TP-7 track.
This identity check is not a hash of the audio: the helper must be regenerated
after replacing audio or changing markers. CRC detects transmission corruption;
it is not an authenticity mechanism.

Each original sample offset is converted independently with integer arithmetic to
nearest-millisecond seek position. No rounded time intervals are accumulated.
EOF offsets are retained; a cue at EOF or rounding to EOF is marked unseekable
and disabled in the panel. Empty lists are valid and replace previously read cues.
Device/Bluetooth latency and the millisecond seek interface still limit playback
accuracy. The generated waveform contains the cue data, not the original music.

### Transfer, UI and validation boundaries

The carrier reader opens track 0 of the helper using the observed source folder
and derived helper filename. It requests `(0, 0)` and waits for natural completion
instead of aborting at 4 KiB. Limits: 512 KiB received, 40 seconds wall-clock for
audio, 40 seconds decoded audio, 32 KiB per ADPCM block. It always exits transfer
and closes the companion session; ABORT is sent only if natural completion has
not occurred. After clean teardown it reopens the ordinary remote session without
resuming playback. Cleanup failure suppresses cue buttons and asks for reconnect.
Cancellation and source-track/connection changes invalidate the operation. The
report contains decoded marker metadata and counts, never audio blocks/samples.

Report version 6 adds received sample count/duration, the detected sync end,
payload byte length, required sample count and missing sample count on truncation.
No missing bits or cue offsets are guessed. CRC and track identity remain mandatory.
After a rename, regenerate from the WAV under its final filename; changing a helper's
filesystem name cannot update the filename stored in its payload.

Tests cover fixed codec vectors (header endian, nibble order, saturation), local
WAV metadata reads without audio, all 40 symbol phases under resampling/ADPCM/noise,
256 cues and UTF-8 names, deliberate CRC corruption, invalid lengths/identity,
browser download → simulated BLE decoding → restored session → exact time jump,
and cancellation. Hardware recovery of three points from `.tp7-cues.wav` was
confirmed by the user; `.cue` remains a separate extension experiment.

The Windows editor's `CueCarrier` emits the same v1 payload and FSK waveform.
Both implementations share a golden length/payload/CRC vector. Editor pair-export
tests compare the companion against the reopened WAV's filename, frame count,
sample rate, stored float32 ACID BPM and every sample offset, including duplicates,
EOF and empty lists. The final export name is embedded, not a source stem name.

## 2026-11-23: alternative FILE interface

### Primary source and independent device evidence

The [official EP Sample Tool](https://teenage.engineering/apps/ep-sample-tool)
served [index-mzHAnDsS.js](https://teenage.engineering/apps/ep-sample-tool/assets/index-mzHAnDsS.js)
when inspected on 2026-11-23. SHA-256:
`ad10f8c52b03f1a94bc341321c53719ef8894f5be3add3e9f8b73dd6d530f847`.
The source has `SysExFileInitRequest`, `SysExFileListRequest`,
`SysExGetFileInitRequest`, `SysExGetFileDataRequest` and `iterGet`.
They use outer TE command **5**, independently of the TP-7 companion command 127.
The existing seven-bit packing and request-ID envelope apply; this app keeps the
TP-7 device byte `0x19`.

This is a materially different lead from the companion audio transfer.
[An OP-XY owner's device log](https://github.com/NeoVand/op-xy-agent/blob/main/docs/research/90-device-probe.md)
records successful FILE INIT and root LIST despite rejected SETTINGS INIT.
That means a rejected settings reader does not imply that FILE is unavailable.
It does **not** establish that TP-7 implements the same commands or exposes its
recordings filesystem. EP and OP-XY differ in some FILE subcommands.

Read operations checked against TE's JavaScript (raw payloads before packed7):

| Operation | Payload | Expected successful response data |
| --- | --- | --- |
| INIT | `01 00 00 00 10 00` | one flags/version byte, uint32 BE advertised chunk size |
| LIST | `04`, uint16 BE page, uint16 BE directory ID | page echo, repeated node entries |
| GET open | `03 00`, uint16 BE file ID, uint32 BE byte offset | file ID, flags, uint32 BE full size, UTF-8 name + NUL |
| GET page | `03 01`, uint16 BE page | page echo followed by file bytes |

A node entry is uint16 BE ID, byte flags, uint32 BE size, name + NUL.
The low flag bits mean file (1) / directory (2), with read capability (4).
**INIT flag 0 means no subscription**; the official constant names flag 1
`TE_SYSEX_FILE_INIT_SUBSCRIBE`. It must not be described as a write-mode switch.
The official client uses the advertised chunk size for PUT payloads, not as a
mandatory GET response size; a large advertised capacity does not preclude LIST.

### What the experiment does

After actual TP-7 identification, **Test file access** sends INIT, then LIST for
root and the observed current track folder. It follows returned directory IDs,
never guesses IDs or tries write, delete, rename, audition, mode or DFU commands.
A successful INIT alone is not shown as successful file access. Unknown layouts,
rejection and timeout remain explicit results in report version 3.

After a successful listing, **Read selected file** can:

- Read the current WAV's RIFF headers, `fmt `, `cue ` and `acid` chunks. It skips
  `data` by byte offset. Before trusting a nonzero GET offset it compares an
  overlapping range at offset 12 with bytes already received at offset 0.
  Ignored/rejected offsets stop the operation; there is no full-audio fallback.
  Every GET must match the observed node ID, filename and full file size.
- Download a listed `.cue` or `.json` sidecar up to 64 KiB byte-for-byte. Its
  contents are saved on explicit request and are not assumed to be native TP-7
  marker metadata. The experiment does not create a sidecar on the device.

WAV cues use `sampleOffset` at record byte 20, not the record's `position` field
or ID. Sample rate and audio frame count must match the current companion track
event. Only after all chunks and markers validate are real cue jump buttons
shown. They use the same acknowledged time-jump mechanism already user-tested.
Markers and metadata are held in memory for the current connection/track.
Stored ACID BPM is displayed as metadata, without changing the existing tempo
matching inputs or claiming that it measures the audio's actual tempo.

The scan is bounded to 256 requests, approximately one minute, 256 KiB of reply
data, 32 pages per folder and four path components. The client asks for 4096-byte
responses and rejects an unexpectedly large decoded response. Operations serialize
with the existing remote controls. Cancellation, track change and disconnection
invalidate queued requests. Firmware debug frames stop FILE traffic and latch a
retry block until reconnection; the UI asks the user to restart the device first.
Raw BLE packets are omitted while the file task is active, and FILE data-page
replies record only page/count information, so incidental audio bytes are not
placed in the normal shareable report. No binary/source dumps are committed here.

### Verification and remaining hardware step

The tests simulate the documented FILE responses through the actual fragmented
BLE path, and separately validate parsers and byte-offset reads. A synthetic
9.6 MB WAV with trailing cues requires less than 2 KB of replies. Tests cover
small sidecar download, true-marker jumps, unsupported commands, ignored offsets,
truncation, wrong pages, mismatched tracks, cancellation and firmware debug frames.
These are **software tests**, not measurements from a TP-7.

No TP-7 is attached to the development computer. The user's subsequent Bluefy
report established rejection of FILE INIT; there is no need to repeat that test
on the same firmware/connection. The simulator still exercises the parser for
future research, without implying that real TP-7 file access works.

### Why the companion download does not preserve WAV markers

Additional static verification of Android companion 1.1.4 build 54:

- `EnterFileTransfer`, RVA `0xCAD560`: product command 127, opcode `0x43`,
  track byte, folder string, filename string.
- `RequestAudio`, RVA `0xCAD7C4`: opcode `0x46`, two uint32 arguments.
- `DownloadMenu.OnAudioDataComplete`, RVA `0xC986F0`: interprets the response
  as signed 16-bit samples via `WavHelper.ToFloatSamples`.
- `FileSystem.SaveTrackAudio`, RVA `0xC94D14`: constructs a new mono, 16 kHz,
  16-bit WaveFormat before saving the received samples. It does not preserve
  the original file's RIFF chunk table.

Thus the companion audio stream is not evidence of arbitrary raw-file access.
The prepared carrier requires an additional file containing WAV audio data. Its
end-to-end operation with the `.tp7-cues.wav` filename is user-confirmed; opening
the same content under `.cue` remains unverified.

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
  list or BPM field. The DJ grid can explicitly infer a labelled filename BPM,
  with provenance shown; this is not a device-provided BPM metadata field.

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

In the **2026-11-17 version-2 report**, Stop, Set Position (10,000 ms), and Play
receive successful replies. The Set Position acknowledgement has empty data;
actual positions arrive as unsolicited events. The user confirmed entering a
time and jumping works on TP-7 through Bluetooth / Bluefy. This establishes a
working time-seek mechanism, not native cue enumeration or sample-accurate audio
alignment. The reported 7,832,495 frames / 48,000 Hz give an exact duration of
163.176979166… seconds; the UI displays 2:43.177.

Additional searches of TE's guide/downloads and public source repositories on
2026-11-17 did not establish a new native cue-list command. The companion table
and file-event layout above remain the basis for the implementation; no guessed
opcodes are sent.

## Generated DJ grid arithmetic

For original BPM `n/d`, interval `s/t` quarter-note beats, and zero-based cue index
`i`, the ideal file position in milliseconds is `i × 60000 × d × s / (n × t)`.
All terms are BigInt integers. Each cue rounds its own ratio once to the nearest
millisecond (ties upward), so arithmetic error is at most 0.5 ms at every index,
including late in a long track. It never repeatedly adds a rounded interval.

The exact file endpoint is `numFrames × 1000 / sampleRate`; both the ideal and
rounded position must precede it. No button is created at EOF. The grid is lazy,
with 32 buttons per page, allowing fine subdivisions throughout long tracks
without creating thousands of DOM nodes. Displayed duration rounding does not
affect point generation or endpoint checks.

The user supplies original BPM, or the app recognizes an explicit `bpm`/`tempo`
filename convention. Ambiguous or invalid labels are not guessed. The grid
assumes constant tempo, quarter-note beats, and a first beat at file time zero.
Playback speed and target BPM never enter this calculation. It cannot detect
kick/snare transients, compensate for an inaccurate BPM, or follow tempo changes.

Buttons share the verified Stop → Set Position → Play path and preserve pitch.
Recording arm and cue recording are disabled first. Connection, track identity
(folder, name, sample rate, frame count, track count), and configuration revision
guard pending transmission. A failed or obsolete seek does not send Play.
Highlighted sections follow actual device position events. A successful command
acknowledgement alone does not move the position indicator.

This path interrupts playback and has Bluetooth/device latency. Nearest-ms
position arithmetic is **not** a guarantee of sample accuracy, immediate audible
response, quantization to a live beat, or phase sync with another deck. No native
cue markers are changed. Per-track manual BPM and grid settings are stored locally
for up to 100 tracks; storage failures do not prevent use.

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
  Unknown event payloads remain raw. There is no opcode sweep or firmware update
  operation. The regular companion controls do not transfer files; the separate FILE
  experiment above is explicitly started by the user. Nothing is sent automatically
  by these panels upon connection.
- Reports stay in the browser until the user copies them. They contain firmware,
  raw protocol replies and possibly device identifiers or track information.
  The report is reset when the connection changes.

## Hardware validation boundaries

On Bluefy: connect TP-7, press **Read TP-7**, then **Start remote session** if
identification succeeds. The unsupported settings-reader notice on 1.1.11 is
expected. Manual **Jump & play** is user-confirmed; generated grids use that same
operation. Fine audio alignment and live mixing latency still require listening
on hardware. To investigate native
cues, select two existing cues using the device's +/− buttons and trigger each
with **physical Play on TP-7**, not Resume in the web app. Copy the report.
This can supply evidence about available settings and events without requiring
the audio file. An unsupported-command response is an actual result, not a
reason to send speculative command numbers.

The pure protocol and simulated browser tests validate framing, fragmentation,
acknowledgement matching, error paths and controls. They do not establish native
cue support on real TP-7 hardware.
