const { test } = require('node:test');
const assert = require('node:assert/strict');
const { read } = require('../wav-tempo.js');

function chunk(id, data) {
    const header = Buffer.alloc(8);
    header.write(id);
    header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data, Buffer.alloc(data.length % 2)]);
}

function acid(bpm) {
    const data = Buffer.alloc(24);
    data.writeFloatLE(bpm, 20);
    return chunk('acid', data);
}

function wav(...chunks) {
    const contents = Buffer.concat(chunks);
    const header = Buffer.alloc(12);
    header.write('RIFF');
    header.writeUInt32LE(contents.length + 4, 4);
    header.write('WAVE', 8);
    return new Blob([header, contents]);
}

test('reads stored BPM, skips audio and respects odd-sized chunk padding', async () => {
    assert.equal(await read(wav(chunk('JUNK', Buffer.alloc(3)), chunk('data', Buffer.alloc(200)), acid(127.125))), 127.125);
    assert.equal(await read(wav(acid(123.456))), Math.fround(123.456));
    assert.equal(await read(wav(acid(120), acid(120))), 120);
});

test('missing, zero or nonfinite metadata falls back to manual entry', async () => {
    for (const file of [wav(), wav(chunk('data', Buffer.alloc(10))), wav(acid(0)), wav(acid(-1)), wav(acid(NaN)), wav(acid(Infinity))]) {
        assert.equal(await read(file), null);
    }
});

test('rejects conflicting tempo and truncated or invalid files', async () => {
    await assert.rejects(read(wav(acid(120), acid(121))), /Conflicting/);
    await assert.rejects(read(wav(chunk('acid', Buffer.alloc(20)))), /Incomplete/);
    await assert.rejects(read(new Blob(['not a WAV file'])), /RIFF/);
    await assert.rejects(read(new Blob(['RIFF'])), /Incomplete/);
    const valid = wav(acid(120));
    await assert.rejects(read(valid.slice(0, valid.size - 1)), /Incomplete/);
    const buffer = Buffer.from(await valid.arrayBuffer());
    buffer.writeUInt32LE(0xFFFFFFFF, 16);
    await assert.rejects(read(new Blob([buffer])), /chunk length/);
});

test('large recordings read only headers and the four-byte tempo value', async () => {
    const audioSize = 2 ** 31;
    const header = Buffer.alloc(20);
    header.write('RIFF');
    header.writeUInt32LE(12 + audioSize + 32, 4);
    header.write('WAVEdata', 8);
    header.writeUInt32LE(audioSize, 16);
    const metadata = acid(128);
    let bytesRead = 0;
    const file = {
        size: 20 + audioSize + metadata.length,
        slice(start, end) {
            bytesRead += end - start;
            if (start < 20) return new Blob([header.subarray(start, end)]);
            assert.ok(start >= 20 + audioSize, 'must not read the audio payload');
            return new Blob([metadata.subarray(start - 20 - audioSize, end - 20 - audioSize)]);
        },
    };
    assert.equal(await read(file), 128);
    assert.equal(bytesRead, 32);
});
