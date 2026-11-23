const { test } = require('node:test');
const assert = require('node:assert/strict');
const carrier = require('../cue-carrier.js');
const files = require('../file-access.js');
const { encode, resample } = require('./helpers/carrier-audio.cjs');
const source = { filename: 'prepared_128bpm.wav', sampleRate: 48000, numFrames: 16000000, kind: 'wav', bpm: 128,
    cues: [0, 480024, 1600000, 15999000] };
function collect(blocks) {
    const collector = new carrier.Collector();
    for (const block of blocks) {
        collector.push(2, block.slice(0, 239));
        for (let at = 239; at < block.length; at += 243) collector.push(3, block.slice(at, at + 243));
    }
    return collector.finish();
}
test('TP-7 ADPCM uses BE predictor, three header bytes and high nibble first', () => {
    assert.deepEqual([...carrier.decodeBlock(Uint8Array.from([0, 0, 0, 0x77]))], [11, 41]);
    assert.deepEqual([...carrier.decodeBlock(Uint8Array.from([3, 232, 0, 0xF0]))], [989, 991]);
    assert.deepEqual([...carrier.decodeBlock(Uint8Array.from([255, 255, 0, 0x11]))], [0, 1]);
    assert.deepEqual([...carrier.decodeBlock(Uint8Array.from([127, 255, 88, 0x77]))], [32767, 32767]);
    assert.throws(() => carrier.decodeBlock(Uint8Array.from([0, 0, 89, 0])), /header/);
});
test('WAV carrier survives downsampling, lossy ADPCM, gain, noise and all symbol phases', () => {
    const wave = carrier.makeWave(source);
    assert.equal(wave.filename, 'prepared_128bpm.cue');
    assert.equal(carrier.helperName(source.filename, 'legacy-wav'), 'prepared_128bpm.tp7-cues.wav');
    for (let phase = 0; phase < 40; phase++) {
        const pcm = collect(encode(resample(wave.bytes, phase, 800)));
        const decoded = carrier.decode(pcm, source);
        assert.deepEqual(decoded.cues.map(c => c.sampleOffset), source.cues, `phase ${phase}`);
        assert.equal(decoded.cues[1].positionMs, 10001);
        assert.equal(decoded.bpm, 128); assert.equal(decoded.kind, 'wav');
    }
});
test('maximum list and UTF-8 filename preserve sample offsets without cumulative rounding', () => {
    const full = { ...source, filename: 'żółć_音楽.wav', sampleRate: 44100, cues: Array.from({ length: 256 }, (_, i) => i * 62001) };
    const wave = carrier.makeWave(full);
    assert.ok(wave.seconds < 40);
    const decoded = carrier.decode(collect(encode(resample(wave.bytes, 17, 400))), full);
    assert.deepEqual(decoded.cues.map(c => c.sampleOffset), full.cues);
    assert.equal(decoded.filename, full.filename);
    assert.equal(decoded.cues[255].positionMs, Math.round(full.cues[255] * 1000 / 44100));
});

test('empty cue lists clear old markers and endpoint markers are preserved without a seek', () => {
    const empty = { ...source, cues: [], bpm: 0.5 };
    assert.deepEqual(carrier.decode(collect(encode(resample(carrier.makeWave(empty).bytes))), empty).cues, []);
    const end = { ...source, numFrames: 4800000, cues: [0, 4799999, 4800000] };
    const decoded = carrier.decode(collect(encode(resample(carrier.makeWave(end).bytes))), end);
    assert.deepEqual(decoded.cues.map(c => c.sampleOffset), end.cues);
    assert.deepEqual(decoded.cues.map(c => c.seekable), [true, false, false]);
});

test('v1 payload and CRC match the Windows editor golden vector', () => {
    const data = carrier.payload({ filename: 'fixture_音.wav', sampleRate: 96000, numFrames: 192001,
        bpm: Math.fround(127.12345), kind: 'wav', cues: [0, 96001, 192001] });
    const framed = Buffer.alloc(2 + data.length + 4);
    framed.writeUInt16LE(data.length); framed.set(data, 2);
    framed.writeUInt32LE(carrier.crc32(framed.subarray(0, -4)), framed.length - 4);
    assert.equal(framed.toString('hex'), '330001000077010001ee0200000000a0e6c75f400f0003000000666978747572655fe99fb32e776176000000000177010001ee020011f14d12');
});
test('CRC, malformed metadata, wrong track and truncated audio never produce markers', () => {
    assert.equal(carrier.crc32(new TextEncoder().encode('123456789')), 0xCBF43926);
    const wave = carrier.makeWave(source), pcm = resample(wave.bytes);
    for (const key of ['filename', 'numFrames', 'sampleRate']) {
        assert.throws(() => carrier.decode(pcm, { ...source, [key]: key === 'filename' ? 'other.wav' : source[key] + 1 }), /different track/);
    }
    // Flip a clear payload bit, keeping a valid tone: rejection must be CRC.
    const corrupt = pcm.slice(), start = 2400 + 18 * 8 * 40;
    for (let i = 0; i < 40; i++) corrupt[start + i] = Math.round(14000 * Math.sin(2 * Math.PI * 6 * i / 40));
    assert.throws(() => carrier.decode(corrupt, source), /checksum/);
    assert.throws(() => carrier.decode(pcm.slice(0, 9000), source), /Truncated/);
    assert.throws(() => carrier.decode(new Int16Array(16000), source), /No cue carrier/);
    assert.throws(() => carrier.makeWave({ ...source, cues: [source.numFrames + 1] }), /offset/);
    assert.throws(() => carrier.makeWave({ ...source, cues: Array(257).fill(0) }), /256/);
    assert.throws(() => carrier.makeWave({ ...source, kind: 'invented' }), /source/);
    const collector = new carrier.Collector();
    assert.throws(() => collector.push(3, new Uint8Array(4)), /Missing/);
});
test('local preparation reads WAV headers and real cue records while skipping the audio', async () => {
    const bytes = new Uint8Array(44 + 960000 + 36), v = new DataView(bytes.buffer);
    const text = (at, value) => bytes.set(new TextEncoder().encode(value), at);
    text(0, 'RIFF'); v.setUint32(4, bytes.length - 8, true); text(8, 'WAVEfmt ');
    v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 48000, true); v.setUint16(32, 2, true);
    text(36, 'data'); v.setUint32(40, 960000, true);
    const at = 960044; text(at, 'cue '); v.setUint32(at + 4, 28, true); v.setUint32(at + 8, 1, true);
    v.setUint32(at + 12, 9, true); text(at + 20, 'data'); v.setUint32(at + 32, 240001, true);
    let read = 0;
    const metadata = await files.readWave({ read: async (at, n) => { read += n; return bytes.slice(at, at + n); } }, bytes.length, null);
    assert.ok(read < 128); assert.equal(metadata.cues[0].sampleOffset, 240001); assert.equal(metadata.numFrames, 480000);
});
