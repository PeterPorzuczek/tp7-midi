const { test } = require('node:test');
const assert = require('node:assert/strict');
const files = require('../file-access.js');
const be16 = n => [n >>> 8 & 255, n & 255];
const be32 = n => [n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255];

function wave(frames = 4800000) {
    const bytes = Buffer.alloc(44 + frames * 2 + 8 + 52 + 8 + 24);
    bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
    bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
    bytes.writeUInt32LE(48000, 24); bytes.writeUInt32LE(96000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
    bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
    const cue = 44 + frames * 2;
    bytes.write('cue ', cue); bytes.writeUInt32LE(52, cue + 4); bytes.writeUInt32LE(2, cue + 8);
    for (let i = 0; i < 2; i++) {
        const at = cue + 12 + i * 24;
        bytes.writeUInt32LE(i + 3, at); bytes.write('data', at + 8); bytes.writeUInt32LE(i ? 480024 : 0, at + 20);
    }
    const acid = cue + 60;
    bytes.write('acid', acid); bytes.writeUInt32LE(24, acid + 4); bytes.writeFloatLE(127.5, acid + 28);
    return bytes;
}
function fakeDevice(bytes, { ignoreOffset = false, rejectOffset = false, wrongPage = false, truncated = false } = {}) {
    const calls = [];
    const node = { id: 20, flags: 5, size: bytes.length, name: 'song.wav' };
    const encodeNode = node => [...be16(node.id), node.flags, ...be32(node.size), ...Buffer.from(node.name), 0];
    let offset = 0;
    return { node, calls, client: new files.Client(async request => {
        calls.push(request);
        if (request[0] === 1) return [0, 0, 0, 2, 0];
        if (request[0] === 4) {
            const page = request[1] * 256 + request[2];
            const id = request[3] * 256 + request[4];
            return [...be16(page), ...(page ? [] : encodeNode(id ? node : { id: 1, flags: 6, size: 0, name: 'recordings' }))];
        }
        if (request[1] === 0) {
            offset = request[4] * 16777216 + request[5] * 65536 + request[6] * 256 + request[7];
            if (rejectOffset && offset) throw new Error('Offset rejected');
            if (ignoreOffset) offset = 0;
            return encodeNode(node);
        }
        const page = request[2] * 256 + request[3];
        return [...be16(wrongPage ? page + 1 : page), ...(truncated ? [] : bytes.subarray(offset + page * 128, offset + (page + 1) * 128))];
    }) };
}

test('FILE requests match TE source and the transport whitelist excludes writes/subscriptions', () => {
    for (const request of [[1, 0, 0, 0, 16, 0], [4, 0, 1, 0, 20], [3, 0, 0, 20, 0, 0, 0, 12], [3, 1, 0, 1]]) files.assertReadRequest(request);
    for (const request of [[1, 1, 0, 0, 16, 0], [2, 0], [6, 0, 20], [7, 1, 0, 20], [11, 0, 20], [3, 1, -1, 0]]) {
        assert.throws(() => files.assertReadRequest(request));
    }
});

test('device listing discovers only observed ids and reads true trailing WAV cues without downloading audio', async () => {
    const bytes = wave();
    const { client, calls, node } = fakeDevice(bytes);
    assert.deepEqual(await client.init(), { flags: 0, chunkSize: 512 });
    const found = await client.discover('recordings');
    assert.equal(found.folderFound, true); assert.deepEqual(found.nodes, [node]);
    assert.deepEqual(calls.slice(0, 5), [[1, 0, 0, 0, 16, 0], [4, 0, 0, 0, 0], [4, 0, 1, 0, 0], [4, 0, 0, 0, 1], [4, 0, 1, 0, 1]]);
    const result = await files.readWave(client.reader(node), node.size, { sampleRate: 48000, numFrames: 4800000 });
    assert.deepEqual(result.cues, [{ id: 3, sampleOffset: 0, positionMs: 0 }, { id: 4, sampleOffset: 480024, positionMs: 10001 }]);
    assert.equal(result.bpm, 127.5); assert.equal(result.offsetsVerified, true);
    assert.ok(client.bytes < 2000, `received ${client.bytes} of ${node.size} bytes`);
    assert.ok(calls.some(call => call[0] === 3 && call[1] === 0 && call.slice(4).some(n => n)), 'uses actual byte offsets');
});

test('offset rejection/ignoring, wrong pages and truncated reads never yield invented cues', async () => {
    for (const options of [{ ignoreOffset: true }, { rejectOffset: true }, { wrongPage: true }, { truncated: true }]) {
        const { client, node } = fakeDevice(wave(), options);
        await client.init();
        await assert.rejects(files.readWave(client.reader(node), node.size, { sampleRate: 48000, numFrames: 4800000 }));
        assert.ok(client.bytes < 2000);
    }
});

test('invalid WAV identity, out-of-range cues and chunk sizes fail closed', async () => {
    for (const change of ['identity', 'cue', 'chunk']) {
        const bytes = wave();
        if (change === 'cue') bytes.writeUInt32LE(4800000, 44 + 4800000 * 2 + 12 + 20);
        if (change === 'chunk') bytes.writeUInt32LE(0xFFFFFFFF, 40);
        const { client, node } = fakeDevice(bytes);
        await assert.rejects(files.readWave(client.reader(node), node.size, { sampleRate: change === 'identity' ? 44100 : 48000, numFrames: 4800000 }));
    }
});

test('unsupported FILE stops after INIT, repeated listings and changing selections are bounded', async () => {
    const largeAdvertisement = new files.Client(async () => [12, 0, 2, 0, 0]);
    assert.equal((await largeAdvertisement.init()).chunkSize, 131072, 'advertised PUT chunk capacity is not a GET response size');
    let calls = 0;
    const unsupported = new files.Client(async () => { calls++; throw Object.assign(new Error('unsupported'), { command: 5, status: 2 }); });
    await assert.rejects(unsupported.init(), { status: 2 }); assert.equal(calls, 1);
    const repeated = new files.Client(async request => [...request.slice(1, 3), 0, 1, 6, 0, 0, 0, 0, 97, 0]);
    await assert.rejects(repeated.list(0), /repeats/);
    let current = true;
    const cancelled = new files.Client(async () => { current = false; return [0, 0, 0, 2, 0]; }, () => { if (!current) throw new Error('changed'); });
    await assert.rejects(cancelled.init(), /changed/);
    assert.throws(() => files.parseList([0, 0, 0, 1, 5, 0, 0, 0, 9, 65], 0), /filename/);
});

test('a small sidecar is returned byte-for-byte through the same FILE GET reader', async () => {
    const payload = Buffer.from('FILE "song.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:10:00\n');
    const { client, node } = fakeDevice(payload);
    await client.init();
    assert.deepEqual(await client.reader(node).read(0, node.size), Uint8Array.from(payload));
});
