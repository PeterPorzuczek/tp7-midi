// Optional browser integration tests: requires Playwright and Chromium/Edge.
// No physical MIDI device is accessed; both transports are simulated.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');
const cueCarrier = require('../cue-carrier.js');
const carrierAudio = require('./helpers/carrier-audio.cjs');

let browser;
let server;
let url;
before(async () => {
    const root = path.join(__dirname, '..');
    const allowed = new Set(['/index.html', '/styles.css', '/tempo.js', '/wav-tempo.js', '/app.js', '/remote-protocol.js', '/remote-panel.js', '/dj-cues.js', '/dj-panel.js', '/file-access.js', '/file-panel.js', '/companion-ble.js', '/companion-panel.js', '/cue-carrier.js', '/carrier-panel.js']);
    server = http.createServer(async (request, response) => {
        const pathname = new URL(request.url, 'http://localhost').pathname;
        const name = pathname === '/' ? '/index.html' : pathname;
        if (!allowed.has(name)) { response.writeHead(404).end(); return; }
        try {
            const content = await fs.readFile(path.join(root, name));
            const type = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html';
            response.writeHead(200, { 'Content-Type': type }).end(content);
        } catch { response.writeHead(500).end(); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({
        headless: true,
        ...(process.env.TP7_BROWSER_PATH ? { executablePath: process.env.TP7_BROWSER_PATH } : {}),
    });
});
after(async () => {
    await browser?.close();
    await new Promise(resolve => server ? server.close(resolve) : resolve());
});

async function openApp(t, mode = 'usb') {
    const context = await browser.newContext();
    t.after(() => context.close());
    await context.addInitScript(mode => {
        window.sent = [];
        window.bleSent = [];
        window.failSend = false;
        window.writeInProgress = false;
        window.releaseWrite = null;
        window.remoteMode = 'ok';
        window.remoteRequests = [];
        window.fileMode = 'unsupported';
        window.companionMode = 'ok';
        window.companionRequests = [];
        let fileOffset = 0;
        let fileNode = 20;
        let fileBytes = null;
        const sidecarBytes = new TextEncoder().encode('FILE "example_cues_15_tempo_88.wav" WAVE\n  TRACK 01 AUDIO\n    INDEX 01 00:10:00\n');
        const be16 = n => [n >>> 8 & 255, n & 255];
        const be32 = n => [n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255];
        const fileEntry = (id, flags, size, name) => [...be16(id), flags, ...be32(size), ...new TextEncoder().encode(name), 0];
        function makeWave() {
            const bytes = new Uint8Array(44 + 9600000 + 60);
            const view = new DataView(bytes.buffer);
            const text = (at, value) => bytes.set(new TextEncoder().encode(value), at);
            text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVEfmt ');
            view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
            view.setUint32(24, 48000, true); view.setUint32(28, 96000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
            text(36, 'data'); view.setUint32(40, 9600000, true);
            const cue = 44 + 9600000;
            text(cue, 'cue '); view.setUint32(cue + 4, 52, true); view.setUint32(cue + 8, 2, true);
            for (let i = 0; i < 2; i++) {
                const at = cue + 12 + i * 24;
                view.setUint32(at, i + 3, true); text(at + 8, 'data'); view.setUint32(at + 20, i ? 480024 : 0, true);
            }
            return bytes;
        }
        const notificationListeners = new Set();
        let requestDecoder = null;
        const output = {
            id: 'tp7', name: 'TP-7', state: 'connected',
            send(bytes) {
                if (window.failSend) throw new Error('Test USB failure');
                window.sent.push([...bytes]);
            },
        };
        const access = { inputs: new Map(), outputs: new Map(mode === 'usb' ? [['tp7', output]] : []) };
        window.testDisconnect = () => {
            output.state = 'disconnected';
            access.outputs.clear();
            access.onstatechange({ port: output });
        };
        Object.defineProperty(navigator, 'requestMIDIAccess', { value: async () => access });
        const characteristic = {
            addEventListener(name, fn) { if (name === 'characteristicvaluechanged') notificationListeners.add(fn); },
            removeEventListener(name, fn) { notificationListeners.delete(fn); },
            async startNotifications() {
                if (window.failNotifications) throw new Error('Notifications unavailable');
                return this;
            },
            async writeValueWithoutResponse(packet) {
                if (window.writeInProgress) throw new Error('Concurrent BLE writes');
                window.writeInProgress = true;
                try {
                    await new Promise(resolve => setTimeout(resolve, 1));
                    if (window.holdWrite) {
                        window.holdWrite = false;
                        await new Promise(resolve => { window.releaseWrite = resolve; });
                    }
                    if (window.failSend) throw new Error('Test BLE failure');
                    window.bleSent.push([...packet]);
                    if (!requestDecoder) {
                        requestDecoder = new TP7RemoteProtocol.BleReceiver(bytes => {
                            const fakeReply = [...bytes];
                            fakeReply[6] &= ~0x40;
                            fakeReply.splice(9, 0, 0);
                            const request = TP7RemoteProtocol.parse(fakeReply);
                            window.remoteRequests.push(request);
                            if (window.remoteMode === 'silent') return;
                            let data = [];
                            let status = 0;
                            if (request.command === 5) {
                                if (window.fileMode === 'silent') return;
                                if (window.fileMode === 'debug') {
                                    const frame = [0xF0, 0, 0x20, 0x76, 0x19, 0x33, ...new TextEncoder().encode('test debug frame'), 0xF7];
                                    for (const packet of TP7RemoteProtocol.blePackets(frame, 247)) window.emitBle(packet);
                                    return;
                                }
                                if (window.fileMode === 'unsupported') status = 2;
                                else {
                                    fileBytes ||= makeWave();
                                    const d = request.data;
                                    const waveEntry = fileEntry(20, 5, fileBytes.length, 'example_cues_15_tempo_88.wav');
                                    const sidecarEntry = fileEntry(21, 5, sidecarBytes.length, 'example_cues_15_tempo_88.cue');
                                    if (d[0] === 1) data = [0, 0, 0, 2, 0];
                                    else if (d[0] === 4) {
                                        const page = d[1] * 256 + d[2];
                                        const node = d[3] * 256 + d[4];
                                        data = [...be16(page), ...(page ? [] : node ? [...waveEntry, ...sidecarEntry] : fileEntry(1, 6, 0, 'recordings'))];
                                    } else if (d[0] === 3 && d[1] === 0) {
                                        fileNode = d[2] * 256 + d[3];
                                        fileOffset = d[4] * 16777216 + d[5] * 65536 + d[6] * 256 + d[7];
                                        if (window.fileMode === 'ignore-offset') fileOffset = 0;
                                        if (window.fileMode === 'change-file') window.emitTrack('other.wav');
                                        data = fileNode === 20 ? waveEntry : sidecarEntry;
                                    } else if (d[0] === 3 && d[1] === 1) {
                                        const page = d[2] * 256 + d[3];
                                        const bytes = fileNode === 20 ? fileBytes : sidecarBytes;
                                        data = [...be16(page), ...bytes.slice(fileOffset + page * 128, fileOffset + (page + 1) * 128)];
                                    } else throw new Error('Unexpected FILE mutation in test');
                                }
                            }
                            if (request.command === 1) data = [...new TextEncoder().encode('product:TP-7;sw_version:1.1.11;mode:normal;serial:test')];
                            if (request.command === 6) {
                                if (window.remoteMode === 'reject-settings') status = 2;
                                else if (request.data[0] === 2) {
                                    const page = request.data[1] * 256 + request.data[2];
                                    data = [0, page, ...(page ? [] : new TextEncoder().encode(JSON.stringify({settings:[{id:7,name:'MIDI mode',value:'cue'}]}))), 0];
                                }
                            }
                            if (request.command === 127) {
                                if (request.data[0] === 64) data = [66, 1];
                                if (request.data[0] === 80) data = [78, 1];
                                if (request.data[0] === 81) data = [78, 0];
                                if (request.data[0] === 76) {
                                    if (window.remoteMode === 'reject-seek') status = 3;
                                    else data = window.emptySeekAck ? [] : [77, ...request.data.slice(1)];
                                }
                            }
                            const reply = TP7RemoteProtocol.encode(request.id, request.command, data);
                            reply[6] &= ~0x40;
                            reply.splice(9, 0, status);
                            for (const fragment of TP7RemoteProtocol.blePackets(reply, 247)) {
                                characteristic.value = new DataView(fragment.buffer);
                                for (const fn of notificationListeners) fn({target:characteristic});
                            }
                            if (request.command === 127 && request.data[0] === 76 && status === 0 && window.emptySeekAck) {
                                window.emitCompanion([77, ...request.data.slice(1)]);
                            }
                            if (request.command === 127 && request.data[0] === 64) {
                                window.emitCompanion([75, 128, 187, 0, 0, 0, 62, 73, 0, 5, 26, 11, 16, 22, 35, 0,
                                    ...new TextEncoder().encode('recordings\0example_cues_15_tempo_88.wav\0')]);
                                window.emitCompanion([77, 227, 134, 0, 0]);
                            }
                            if (request.command === 127 && request.data[0] === 81 && window.changeFileOnStop) {
                                window.changeFileOnStop = false;
                                window.emitCompanion([75, 128, 187, 0, 0, 0, 62, 73, 0, 5, 26, 11, 16, 22, 35, 0,
                                    ...new TextEncoder().encode('recordings\0other.wav\0')]);
                            }
                        });
                    }
                    requestDecoder.push(packet);
                } finally { window.writeInProgress = false; }
            },
        };
        window.emitBle = bytes => {
            const padded = new Uint8Array(bytes.length + 6);
            padded.set(bytes, 3);
            characteristic.value = new DataView(padded.buffer, 3, bytes.length);
            for (const fn of notificationListeners) fn({target:characteristic});
        };
        window.emitCompanion = data => {
            const frame = TP7RemoteProtocol.encode(1, 127, data);
            frame[6] = 64; frame[7] = 0;
            for (const fragment of TP7RemoteProtocol.blePackets(frame, 247)) window.emitBle(fragment);
        };
        window.emitTrack = (filename, numFrames = 7832495) => {
            const bytes = new Uint8Array(8);
            const view = new DataView(bytes.buffer);
            view.setUint32(0, 48000, true); view.setUint32(4, numFrames, true);
            window.emitCompanion([75, ...bytes, 5, 26, 11, 17, 12, 0, 0,
                ...new TextEncoder().encode(`recordings\0${filename}\0`)]);
        };
        const companionListeners = new Set();
        const companionEmit = bytes => {
            const padded = new Uint8Array(bytes.length + 4); padded.set(bytes, 2);
            companionCharacteristic.value = new DataView(padded.buffer, 2, bytes.length);
            for (const listener of companionListeners) listener({ target: companionCharacteristic });
        };
        const companionEvent = data => {
            const frame = TP7RemoteProtocol.encode(1, 127, data); frame[6] = 64; frame[7] = 0;
            for (const packet of TP7CompanionBLE.packets(frame)) companionEmit(packet);
        };
        let companionDecoder;
        const companionCharacteristic = {
            properties: { writeWithoutResponse: true },
            addEventListener: (_, fn) => companionListeners.add(fn), removeEventListener: (_, fn) => companionListeners.delete(fn),
            async startNotifications() {}, async stopNotifications() {},
            async writeValueWithoutResponse(packet) {
                companionDecoder ||= new TP7CompanionBLE.Receiver(frame => {
                    const reply = [...frame]; reply[6] &= ~64; reply.splice(9, 0, 0);
                    const request = TP7RemoteProtocol.parse(reply); window.companionRequests.push(request);
                    const data = request.command === 1 ? [...new TextEncoder().encode('product:TP-7;sw_version:1.1.11;')] : [];
                    if (request.data[0] === 67) companionEvent([69, 1]);
                    const response = TP7RemoteProtocol.encode(request.id, request.command, data); response[6] &= ~64; response.splice(9, 0, 0);
                    if (window.companionMode === 'cleanup-fail' && request.data[0] === 68) response[9] = 2;
                    for (const p of TP7CompanionBLE.packets(response)) companionEmit(p);
                    if (request.data[0] === 70 && window.companionMode !== 'silent') {
                        if (window.carrierBlocks) {
                            for (const block of window.carrierBlocks) {
                                companionEmit(Uint8Array.from([2, 0, 0, 0, 0, ...block.slice(0, 239)]));
                                for (let at = 239; at < block.length; at += 243) companionEmit(Uint8Array.from([3, ...block.slice(at, at + 243)]));
                            }
                        } else {
                            companionEmit(Uint8Array.from([2, 0, 0, 0, 0, 1, 0, 0, 0]));
                            companionEmit(Uint8Array.from([3, ...new Uint8Array(16)]));
                        }
                        companionEvent([73, 0]);
                    }
                }, () => {});
                companionDecoder.push(packet);
            },
        };
        const device = {
            name: 'TP-7', addEventListener() {},
            gatt: { connected: true, async connect() { return this; }, async getPrimaryService(uuid) {
                if (uuid === TP7CompanionBLE.SERVICE && window.companionMode === 'missing') throw new Error('Companion service unavailable');
                return { async getCharacteristic() { return uuid === TP7CompanionBLE.SERVICE ? companionCharacteristic : characteristic; } };
            } },
        };
        Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async options => { window.bluetoothOptions = options; return device; } } });
    }, mode);
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(() => assert.deepEqual(errors, []));
    await page.goto(url);
    if (mode === 'usb') await page.waitForFunction(() => window.sent.length >= 18);
    return page;
}

async function enterTempo(page, source = '120', target = '128') {
    await page.locator('#tempo-source').fill(source);
    await page.locator('#tempo-target').fill(target);
}

async function startRemote(page) {
    await page.locator('.conn-tab[data-tab="ble"]').click();
    await page.locator('#ble-connect-btn').click();
    await page.waitForFunction(() => window.bleSent.length >= 18 && !window.writeInProgress);
    await page.locator('#remote-inspect').click();
    await page.waitForFunction(() => !document.getElementById('remote-session').disabled);
    await page.locator('#remote-session').click();
    await page.waitForFunction(() => !document.getElementById('remote-play').disabled);
}

test('carrier preparation downloads a .cue; Bluetooth decoding restores the session and enables exact jumps', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    await page.locator('#section-carrier summary').click();
    await page.locator('#carrier-test').click();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#carrier-download').click();
    const download = await downloadPromise;
    assert.equal(download.suggestedFilename(), 'example_cues_15_tempo_88.cue');
    const downloaded = new Uint8Array(await fs.readFile(await download.path()));
    const source = { filename: 'example_cues_15_tempo_88.wav', sampleRate: 48000, numFrames: 4800000 };
    const blocks = carrierAudio.encode(carrierAudio.resample(downloaded, 17, 500)).map(block => [...block]);
    await page.evaluate(blocks => { window.carrierBlocks = blocks; window.remoteRequests = []; }, blocks);
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.querySelectorAll('#carrier-cues button').length === 3 && !document.querySelector('#carrier-cues button').disabled);
    assert.match(await page.locator('#carrier-source').innerText(), /TEST points/);
    assert.equal(await page.locator('#carrier-cues button').nth(1).getAttribute('data-position'), '10000');
    const request = await page.evaluate(() => window.companionRequests.find(r => r.data[0] === 67).data);
    assert.deepEqual(request, [67, 0, ...new TextEncoder().encode('recordings\0example_cues_15_tempo_88.cue\0')]);
    assert.deepEqual(await page.evaluate(() => window.remoteRequests.map(r => r.data)), [[64]]); // Restore session, never auto-play.
    await page.locator('#carrier-cues button').nth(1).click();
    await page.waitForFunction(() => document.getElementById('carrier-status').textContent.includes('playback acknowledged'));
    assert.deepEqual(await page.evaluate(() => window.remoteRequests.slice(-3).map(r => r.data)), [[81], [76, 16, 39, 0, 0], [80]]);
    await page.waitForFunction(() => JSON.parse(document.getElementById('remote-report').textContent).companionAccess?.result === 'cues-decoded');
    const report = await page.locator('#remote-report').textContent();
    assert.ok(!report.includes('carrierBlocks')); assert.ok(report.includes('cues-decoded'));
    assert.equal(cueCarrier.decode(carrierAudio.resample(downloaded), source).kind, 'test');
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.TP7_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.TP7_SCREENSHOT_DIR, 'carrier-mobile.png'), fullPage: true });
    await page.evaluate(() => window.emitTrack('other.wav'));
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
});

test('legacy companion paths remain available; endpoint and empty marker lists cannot send stale jumps', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    await page.locator('#carrier-format').selectOption('legacy-wav');
    const source = { filename: 'example_cues_15_tempo_88.wav', sampleRate: 48000, numFrames: 4800000, kind: 'wav', bpm: 128, cues: [0, 4799999, 4800000] };
    const blocks = carrierAudio.encode(carrierAudio.resample(cueCarrier.makeWave(source).bytes)).map(b => [...b]);
    await page.evaluate(blocks => { window.carrierBlocks = blocks; }, blocks);
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.getElementById('carrier-source').textContent.includes('3 points'));
    assert.equal(await page.locator('#carrier-cues button').nth(0).isDisabled(), false);
    assert.equal(await page.locator('#carrier-cues button').nth(1).isDisabled(), true);
    assert.equal(await page.locator('#carrier-cues button').nth(2).isDisabled(), true);
    const request = await page.evaluate(() => window.companionRequests.find(r => r.data[0] === 67).data);
    assert.deepEqual(request, [67, 0, ...new TextEncoder().encode('recordings\0example_cues_15_tempo_88.tp7-cues.wav\0')]);
    await page.locator('#carrier-format').selectOption('cue');
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
    const empty = carrierAudio.encode(carrierAudio.resample(cueCarrier.makeWave({ ...source, cues: [] }).bytes)).map(b => [...b]);
    await page.evaluate(blocks => { window.carrierBlocks = blocks; }, empty);
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.getElementById('carrier-source').textContent.includes('0 points'));
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
    assert.equal(await page.locator('#remote-play').isDisabled(), false);
});

test('natural completion with an omitted tail reports truncation; padded txt helper validates all cues', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    const source = { filename: 'example_cues_15_tempo_88.wav', sampleRate: 48000, numFrames: 4800000,
        kind: 'wav', bpm: 95, cues: Array.from({ length: 17 }, (_, i) => i * 200001) };
    const padded = cueCarrier.makeWave(source, 'txt');
    const legacySamples = 14400 + (22 + cueCarrier.payload(source).length) * 960;
    const old = padded.bytes.slice(0, 44 + legacySamples * 2);
    new DataView(old.buffer).setUint32(4, old.length - 8, true);
    new DataView(old.buffer).setUint32(40, old.length - 44, true);
    const blocks = carrierAudio.encode(carrierAudio.resample(old), 4000).filter(b => b.length === 2003).slice(0, -1).map(b => [...b]);
    await page.evaluate(blocks => { window.carrierBlocks = blocks; }, blocks);
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.getElementById('carrier-status').textContent.includes('Regenerate'));
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
    await page.waitForFunction(() => JSON.parse(document.getElementById('remote-report').textContent).companionAccess?.stage === 'done');
    const report = JSON.parse(await page.locator('#remote-report').textContent());
    assert.equal(report.version, 6);
    assert.equal(report.companionAccess.audioComplete, true);
    assert.ok(report.companionAccess.decoder.missingSamples > 0);
    assert.ok(report.companionAccess.decoder.requiredSamples > report.companionAccess.decoder.receivedSamples);
    assert.deepEqual(report.companionAccess.cleanupErrors, []);
    await page.locator('#carrier-format').selectOption('txt');
    await page.waitForFunction(() => !document.getElementById('carrier-test').disabled);
    await page.locator('#section-carrier summary').click();
    await page.locator('#carrier-test').click();
    const downloadEvent = page.waitForEvent('download');
    await page.locator('#carrier-download').click();
    assert.equal((await downloadEvent).suggestedFilename(), 'example_cues_15_tempo_88.txt');
    const complete = carrierAudio.encode(carrierAudio.resample(padded.bytes), 4000).filter(b => b.length === 2003).slice(0, -1).map(b => [...b]);
    await page.evaluate(blocks => { window.carrierBlocks = blocks; window.companionRequests = []; }, complete);
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.querySelectorAll('#carrier-cues button').length === 17);
    assert.match(await page.locator('#carrier-source').innerText(), /17 points.*95/);
    const request = await page.evaluate(() => window.companionRequests.find(r => r.data[0] === 67).data);
    assert.deepEqual(request, [67, 0, ...new TextEncoder().encode('recordings\0example_cues_15_tempo_88.txt\0')]);
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.TP7_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.TP7_SCREENSHOT_DIR, 'padded-carrier-mobile.png'), fullPage: true });
});

test('carrier rejects a valid payload for a different track and cancellation restores the session', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    const wrong = cueCarrier.makeWave({ filename: 'other.wav', sampleRate: 48000, numFrames: 4800000, kind: 'wav', bpm: null, cues: [0, 480000] });
    const blocks = carrierAudio.encode(carrierAudio.resample(wrong.bytes)).map(block => [...block]);
    await page.evaluate(blocks => { window.carrierBlocks = blocks; }, blocks);
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.getElementById('carrier-status').dataset.status === 'error');
    assert.match(await page.locator('#carrier-status').innerText(), /different track/);
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
    assert.equal(await page.locator('#remote-play').isDisabled(), false);
    await page.evaluate(() => { window.companionMode = 'silent'; window.companionRequests = []; });
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => window.companionRequests.some(r => r.data[0] === 70));
    await page.locator('#carrier-cancel').click();
    await page.waitForFunction(() => document.getElementById('carrier-status').textContent.includes('cancelled'));
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
    assert.equal(await page.locator('#remote-play').isDisabled(), false);
    const valid = cueCarrier.makeWave({ filename: 'example_cues_15_tempo_88.wav', sampleRate: 48000, numFrames: 4800000, kind: 'wav', bpm: null, cues: [0, 480000] });
    const validBlocks = carrierAudio.encode(carrierAudio.resample(valid.bytes)).map(block => [...block]);
    await page.evaluate(blocks => { window.carrierBlocks = blocks; window.companionMode = 'cleanup-fail'; }, validBlocks);
    await page.locator('#carrier-read').click();
    await page.waitForFunction(() => document.getElementById('carrier-status').textContent.includes('cleanup was not confirmed'));
    assert.equal(await page.locator('#carrier-cues button').count(), 0);
    assert.equal(await page.locator('#remote-play').isDisabled(), true);
});

test('companion audio uses its own service, reports receipt and releases remote controls after cleanup', async t => {
    const page = await openApp(t, 'ble');
    assert.equal(await page.locator('#companion-probe').isDisabled(), true);
    await startRemote(page);
    assert.ok(await page.evaluate(() => window.bluetoothOptions.optionalServices.includes(TP7CompanionBLE.SERVICE)));
    await page.locator('#companion-probe').click();
    await page.waitForFunction(() => document.getElementById('companion-status').textContent.startsWith('Companion audio received:'));
    assert.match(await page.locator('#companion-status').innerText(), /20 bytes in 1 blocks/);
    assert.equal(await page.locator('#remote-play').isDisabled(), true);
    assert.equal(await page.locator('#remote-session').isDisabled(), false);
    assert.deepEqual(await page.evaluate(() => window.companionRequests.slice(-2).map(r => r.data)), [[68], [65]]);
    await page.waitForFunction(() => JSON.parse(document.getElementById('remote-report').textContent).companionAccess?.result === 'audio-received');
    await page.locator('#remote-session').click();
    await page.waitForFunction(() => !document.getElementById('remote-play').disabled);
    await page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (process.env.TP7_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.TP7_SCREENSHOT_DIR, 'companion-mobile.png'), fullPage: true });
});

test('companion service failure and cancellation are visible; cancellation cleans up and blocks MIDI during transfer', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    await page.evaluate(() => { window.companionMode = 'missing'; });
    await page.locator('#companion-probe').click();
    await page.waitForFunction(() => document.getElementById('companion-status').dataset.status === 'error');
    assert.match(await page.locator('#companion-status').innerText(), /service unavailable/);
    assert.deepEqual(await page.evaluate(() => window.companionRequests), []);
    await page.locator('#remote-session').click();
    await page.waitForFunction(() => !document.getElementById('companion-probe').disabled);
    await page.evaluate(() => { window.companionMode = 'silent'; });
    await page.locator('#companion-probe').click();
    await page.waitForFunction(() => window.companionRequests.some(r => r.data[0] === 70));
    await page.evaluate(() => window.emitCompanion([71, 201, 202, 203, 204, 205, 206]));
    await page.waitForFunction(() => JSON.parse(document.getElementById('remote-report').textContent).events.some(e => e.opcode === 71 && e.payloadOmitted));
    assert.ok(!(await page.locator('#remote-report').innerText()).includes('201,'));
    assert.match(await page.evaluate(async () => { try { await transmitMidiBatch([[176, 14, 127]]); } catch (error) { return error.message; } }), /companion transfer/);
    await page.locator('#companion-cancel').click();
    await page.waitForFunction(() => document.getElementById('companion-status').textContent.startsWith('Companion test cancelled.'));
    assert.deepEqual(await page.evaluate(() => window.companionRequests.slice(-3).map(r => r.data)), [[72], [68], [65]]);
});

test('FILE rejection is reported honestly, with no fallback commands or transport changes', async t => {
    const page = await openApp(t, 'ble');
    assert.equal(await page.locator('#file-probe').isDisabled(), true);
    await startRemote(page);
    await page.evaluate(() => { window.remoteRequests = []; window.bleSent = []; });
    await page.locator('#file-probe').click();
    await page.waitForFunction(() => document.getElementById('file-status').dataset.status === 'error');
    assert.deepEqual(await page.evaluate(() => window.remoteRequests.map(r => [r.command, ...r.data])), [[5, 1, 0, 0, 0, 16, 0]]);
    assert.match(await page.locator('#file-status').innerText(), /rejected FILE/);
    assert.equal(await page.locator('#file-read').isDisabled(), true);
    assert.equal(await page.locator('#file-probe').isDisabled(), true);
    assert.equal(await page.locator('#file-cues button').count(), 0);
    await page.waitForFunction(() => JSON.parse(document.getElementById('remote-report').textContent).fileAccess?.result === 'unsupported');
    assert.equal(await page.locator('#remote-play').isDisabled(), false);
});

test('FILE BLE path lists a track, reads trailing markers by offset, jumps and downloads a sidecar', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    await page.evaluate(() => { window.fileMode = 'ok'; window.remoteRequests = []; });
    await page.locator('#file-probe').click();
    await page.waitForFunction(() => !document.getElementById('file-read').disabled);
    assert.match(await page.locator('#file-list').textContent(), /example_cues_15_tempo_88.cue/);
    await page.locator('#file-read').click();
    await page.waitForFunction(() => document.getElementById('file-status').textContent.startsWith('Read 2 actual WAV cue'));
    assert.equal(await page.locator('#file-cues button').count(), 2);
    assert.equal(await page.locator('#file-cues button').nth(1).getAttribute('data-position'), '10001');
    await page.waitForFunction(() => JSON.parse(document.getElementById('remote-report').textContent).fileAccess?.metadata?.cues.length === 2);
    const report = JSON.parse(await page.locator('#remote-report').textContent());
    assert.ok(report.fileAccess.traffic.bytes < 2000);
    assert.equal(report.fileAccess.metadata.offsetsVerified, true);
    assert.ok(report.events.filter(e => e.kind === 'reply' && e.command === 5 && e.payloadOmitted).every(e => e.data.length === 2));
    const dataRequests = report.events.filter(e => e.kind === 'request' && e.command === 5 && e.data[0] === 3 && e.data[1] === 1);
    assert.ok(dataRequests.length >= 3);
    for (const width of [320, 375, 768]) {
        await page.setViewportSize({ width, height: 1100 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    if (process.env.TP7_SCREENSHOT_DIR) {
        await page.setViewportSize({ width: 375, height: 1100 });
        await page.locator('#section-file-access details').evaluate(el => { el.open = true; });
        await page.locator('#section-file-access').screenshot({ path: path.join(process.env.TP7_SCREENSHOT_DIR, 'file-access-mobile.png') });
    }
    await page.evaluate(() => { window.remoteRequests = []; });
    await page.locator('#file-cues button').nth(1).click();
    await page.waitForFunction(() => document.getElementById('file-status').textContent.includes('jump and playback acknowledged'));
    assert.deepEqual(await page.evaluate(() => window.remoteRequests.map(r => r.data)), [[81], [76, 17, 39, 0, 0], [80]]);
    await page.locator('#file-select').selectOption('21');
    await page.locator('#file-read').click();
    await page.waitForFunction(() => !document.getElementById('file-download').hidden);
    const saved = page.waitForEvent('download');
    await page.locator('#file-download').click();
    const download = await saved;
    assert.equal(download.suggestedFilename(), 'example_cues_15_tempo_88.cue');
    assert.match(await fs.readFile(await download.path(), 'utf8'), /INDEX 01 00:10:00/);
});

test('FILE offset and track mismatch cannot expose cue buttons, cancellation stops requests', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    await page.evaluate(() => { window.fileMode = 'ignore-offset'; });
    await page.locator('#file-probe').click();
    await page.waitForFunction(() => !document.getElementById('file-read').disabled);
    await page.locator('#file-read').click();
    await page.waitForFunction(() => document.getElementById('file-status').dataset.status === 'error');
    assert.match(await page.locator('#file-status').innerText(), /offset is ignored/);
    assert.equal(await page.locator('#file-cues button').count(), 0);
    await page.evaluate(() => { window.fileMode = 'change-file'; });
    await page.locator('#file-read').click();
    await page.waitForFunction(() => !window.tp7RemotePanel.getState().busy);
    assert.equal(await page.locator('#file-cues button').count(), 0);
    assert.equal(await page.locator('#file-read').isDisabled(), true);
    await page.evaluate(() => { window.fileMode = 'silent'; window.remoteRequests = []; });
    await page.locator('#file-probe').click();
    await page.waitForFunction(() => window.remoteRequests.length === 1);
    await page.locator('#file-cancel').click();
    await page.waitForFunction(() => !window.tp7RemotePanel.getState().busy);
    assert.match(await page.locator('#file-status').innerText(), /cancelled/);
    assert.equal(await page.evaluate(() => window.remoteRequests.length), 1);
});

test('FILE firmware debug frames stop the session and prevent retries until reconnection', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    await page.evaluate(() => { window.fileMode = 'debug'; window.remoteRequests = []; });
    await page.locator('#file-probe').click();
    await page.waitForFunction(() => document.getElementById('file-status').dataset.status === 'error');
    assert.match(await page.locator('#file-status').innerText(), /firmware debug/);
    assert.equal(await page.locator('#file-probe').isDisabled(), true);
    assert.equal(await page.evaluate(() => window.remoteRequests.length), 1);
});

test('DJ grid reads duration and filename BPM, then sends the exact selected position without changing speed', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    await page.evaluate(() => {
        window.emitTrack('Multitrack_48k_5stems_tempo_88_cues_15.wav');
        window.emptySeekAck = true;
        window.remoteRequests = []; window.bleSent = [];
    });
    assert.equal(await page.locator('#dj-bpm').inputValue(), '88');
    assert.equal(await page.locator('#dj-grid button').count(), 15);
    assert.match(await page.locator('#dj-summary').innerText(), /2:43.177 · 88 BPM · 15 jumps/);
    assert.match(await page.locator('#remote-file-info').innerText(), /2:43.177 · 48000 Hz · 5 tracks/);
    assert.equal(await page.locator('#dj-grid button').last().getAttribute('data-position'), '152727');
    assert.equal(await page.locator('#tempo-source').inputValue(), '');
    assert.equal(await page.locator('#cue-count').inputValue(), '8');
    assert.deepEqual(await page.evaluate(() => window.remoteRequests), [], 'building the grid sends nothing');
    await page.locator('#dj-grid button').nth(1).click();
    await page.waitForFunction(() => document.getElementById('dj-action-status').dataset.status === 'sent');
    assert.deepEqual(await page.evaluate(() => window.remoteRequests.map(r => r.data)), [[81], [76, 157, 42, 0, 0], [80]]);
    assert.equal(await page.locator('#remote-position').innerText(), '0:10.909');
    assert.equal(await page.locator('#dj-grid [aria-current="step"]').getAttribute('data-index'), '1');
    const controls = await page.evaluate(() => window.bleSent.filter(packet => !packet.includes(0xF0)).map(packet => [packet.slice(2, 5), packet.slice(6, 9)]));
    assert.deepEqual(controls, [[[0xB0, 14, 0], [0xB0, 16, 0]]], 'no pitch, rocker or record-on commands');
});

test('DJ grid pages reach the end, fit mobile screens and preserve settings for each exact track', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    await page.locator('#dj-bpm').fill('127,125');
    await page.locator('#dj-interval').selectOption('beat-quarter');
    await page.locator('#dj-meter').selectOption('3');
    const expected = require('../dj-cues.js').createGrid({ bpm: '127.125', interval: 'beat-quarter', beatsPerBar: 3, sampleRate: 48000, numFrames: 4800000 });
    assert.equal(await page.locator('#dj-grid button').count(), 32);
    await page.locator('#dj-page').fill(String(Math.ceil(expected.count / 32)));
    await page.locator('#dj-page').press('Enter');
    await page.locator('#dj-bpm').focus();
    assert.equal(await page.locator('#dj-grid button').last().getAttribute('data-position'), String(expected.pointAt(expected.count - 1).positionMs));
    assert.equal(await page.locator('#dj-next').isDisabled(), true);
    await page.locator('#dj-prev').click();
    assert.equal(await page.locator('#dj-grid button').count(), 32);
    // A different file, even with identical length, gets its own BPM.
    await page.evaluate(() => window.emitTrack('other.wav', 4800000));
    assert.equal(await page.locator('#dj-bpm').inputValue(), '');
    assert.equal(await page.locator('#dj-grid button').count(), 0);
    await page.locator('#dj-bpm').fill('95');
    await page.evaluate(() => window.emitTrack('example_cues_15_tempo_88.wav', 4800000));
    assert.equal(await page.locator('#dj-bpm').inputValue(), '127,125');
    assert.equal(await page.locator('#dj-meter').inputValue(), '3');
    assert.equal(await page.locator('#dj-interval').inputValue(), 'beat-quarter');
    // A reload keeps manual settings and still requires a new device session.
    await page.reload();
    assert.equal(await page.locator('#dj-grid button').count(), 0);
    await startRemote(page);
    assert.equal(await page.locator('#dj-bpm').inputValue(), '127,125');
    await page.locator('#dj-interval').selectOption('bar-4');
    for (const width of [320, 375, 768, 1280]) {
        await page.setViewportSize({ width, height: 1000 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `overflow at ${width}`);
        assert.ok((await page.locator('#dj-grid button').first().boundingBox()).height >= 44);
    }
    if (process.env.TP7_SCREENSHOT_DIR) {
        await page.evaluate(() => window.emitTrack('Multitrack_48k_5stems_tempo_88_cues_15.wav'));
        await page.locator('#section-dj').screenshot({ path: path.join(process.env.TP7_SCREENSHOT_DIR, 'dj-desktop.png') });
        await page.setViewportSize({ width: 375, height: 1100 });
        await page.locator('#section-dj').screenshot({ path: path.join(process.env.TP7_SCREENSHOT_DIR, 'dj-mobile.png') });
    }
    await page.evaluate(() => { bleDevice.gatt.connected = false; onBLEDisconnected(); });
    assert.equal(await page.locator('#dj-grid button').count(), 0);
    assert.equal(await page.locator('#dj-bpm').isDisabled(), true);
});

test('DJ changes cancel queued jumps; file changes and rejected seeks never resume', async t => {
    const page = await openApp(t, 'ble');
    await startRemote(page);
    await page.evaluate(() => { window.remoteRequests = []; window.holdWrite = true; });
    await page.locator('#cue-rec-off').click();
    await page.waitForFunction(() => window.releaseWrite !== null);
    await page.locator('#dj-grid button').nth(1).click();
    await page.locator('#dj-bpm').fill('90');
    await page.evaluate(async () => { window.releaseWrite(); await bleWriteQueue; });
    await page.waitForFunction(() => !window.tp7RemotePanel.getState().busy);
    assert.deepEqual(await page.evaluate(() => window.remoteRequests), []);
    await page.evaluate(() => { window.changeFileOnStop = true; });
    await page.locator('#dj-grid button').nth(1).click();
    await page.waitForFunction(() => !window.tp7RemotePanel.getState().busy);
    assert.deepEqual(await page.evaluate(() => window.remoteRequests.map(r => r.data)), [[81]]);
    assert.equal(await page.locator('#dj-grid button').count(), 0);
    await page.locator('#dj-bpm').fill('120');
    await page.evaluate(() => { window.remoteRequests = []; window.remoteMode = 'reject-seek'; });
    await page.locator('#dj-grid button').nth(1).click();
    await page.waitForFunction(() => document.getElementById('dj-action-status').dataset.status === 'error');
    assert.deepEqual(await page.evaluate(() => window.remoteRequests.map(r => r.data)), [[81], [76, 64, 31, 0, 0]]);
    assert.equal(await page.locator('#remote-playback').innerText(), 'Stopped');
});

test('USB Apply sends the optimum pitch once, is idempotent and survives reload', async t => {
    const page = await openApp(t);
    await enterTempo(page);
    assert.match(await page.locator('#tempo-result').innerText(), /127\.99804688 BPM/);
    await page.evaluate(() => { window.sent = []; });
    await page.locator('#tempo-apply').click();
    await page.waitForFunction(() => document.getElementById('tempo-result').dataset.status === 'sent');
    assert.deepEqual(await page.evaluate(() => window.sent), [[0xB0, 18, 64, 0xE0, 34, 68]]);
    assert.equal(await page.locator('#pitch-bend').inputValue(), '546');
    assert.equal(await page.locator('#pitch-manual').inputValue(), '546');
    assert.equal(await page.locator('#playmode-comp').isChecked(), true);
    await page.locator('#tempo-apply').click();
    assert.deepEqual(await page.evaluate(() => window.sent), [
        [0xB0, 18, 64, 0xE0, 34, 68], [0xB0, 18, 64, 0xE0, 34, 68],
    ]);
    await page.reload();
    await page.waitForFunction(() => window.sent.length >= 18);
    assert.equal(await page.locator('#pitch-bend').inputValue(), '546');
    assert.equal(await page.locator('#pitch-manual').inputValue(), '546');
    assert.ok((await page.evaluate(() => window.sent)).some(bytes => bytes.join() === '224,34,68'));
    assert.equal(await page.locator('#tempo-source').inputValue(), '', 'do not restore BPM for an unknown track');
});

test('invalid, disconnected and failed sends do not claim success', async t => {
    const page = await openApp(t);
    for (const value of ['0', '-1', '240', '120x']) {
        await enterTempo(page, '120', value);
        assert.equal(await page.locator('#tempo-apply').isDisabled(), true);
    }
    await enterTempo(page, '128', '120');
    await page.evaluate(() => { window.failSend = true; window.sent = []; });
    await page.locator('#tempo-apply').click();
    assert.match(await page.locator('#tempo-result').innerText(), /not confirmed sent.*USB failure/);
    assert.equal(await page.locator('#pitch-bend').inputValue(), '0');
    assert.deepEqual(await page.evaluate(() => window.sent), []);
    await page.evaluate(() => { window.failSend = false; });
    await page.locator('#tempo-apply').click();
    assert.equal(await page.locator('#pitch-bend').inputValue(), '-683');
    await page.locator('.pitch-preset[data-pitch="0"]').click();
    assert.match(await page.locator('#tempo-result').innerText(), /^Preview/);
    await page.evaluate(() => window.testDisconnect());
    assert.equal(await page.locator('#tempo-apply').isDisabled(), true);
});

test('BLE writes serialize, Apply is one packet, and failures can be retried', async t => {
    const page = await openApp(t, 'ble');
    await page.locator('.conn-tab[data-tab="ble"]').click();
    await page.locator('#ble-connect-btn').click();
    await page.waitForFunction(() => window.bleSent.length === 18 && !window.writeInProgress);
    await enterTempo(page);
    await page.locator('#tempo-apply').click();
    await page.waitForFunction(() => document.getElementById('tempo-result').dataset.status === 'sent');
    const packet = await page.evaluate(() => window.bleSent.at(-1));
    assert.equal(packet.length, 9);
    assert.ok(packet[0] >= 0x80 && packet[1] >= 0x80 && packet[5] >= 0x80);
    assert.deepEqual([...packet.slice(2, 5), ...packet.slice(6)], [0xB0, 18, 64, 0xE0, 34, 68]);
    await enterTempo(page, '128', '120');
    await page.evaluate(() => { window.failSend = true; });
    await page.locator('#tempo-apply').click();
    await page.waitForFunction(() => document.getElementById('tempo-result').dataset.status === 'error');
    assert.equal(await page.locator('#pitch-bend').inputValue(), '546');
    await page.evaluate(() => { window.failSend = false; });
    await page.locator('#tempo-apply').click();
    await page.waitForFunction(() => document.getElementById('tempo-result').dataset.status === 'sent');
    assert.equal(await page.locator('#pitch-bend').inputValue(), '-683');
});

test('editing BPM cancels a queued BLE Apply before it is transmitted', async t => {
    const page = await openApp(t, 'ble');
    await page.locator('.conn-tab[data-tab="ble"]').click();
    await page.locator('#ble-connect-btn').click();
    await page.waitForFunction(() => window.bleSent.length === 18 && !window.writeInProgress);
    await enterTempo(page);
    await page.evaluate(() => { window.holdWrite = true; window.bleSent = []; });
    await page.locator('.pitch-preset[data-pitch="0"]').click();
    await page.waitForFunction(() => !!window.releaseWrite);
    await page.locator('#tempo-apply').click();
    await page.locator('#tempo-target').fill('130');
    await page.evaluate(() => window.releaseWrite());
    await page.waitForFunction(() => !document.getElementById('tempo-apply').disabled);
    assert.equal(await page.evaluate(() => window.bleSent.length), 1);
    assert.equal(await page.locator('#pitch-bend').inputValue(), '0');
    assert.match(await page.locator('#tempo-result').innerText(), /^Preview/);
});

test('WAV metadata and missing metadata, decimal comma, keyboard Apply and mobile layout', async t => {
    const page = await openApp(t);
    const file = Buffer.alloc(44);
    file.write('RIFF'); file.writeUInt32LE(36, 4); file.write('WAVEacid', 8);
    file.writeUInt32LE(24, 16); file.writeFloatLE(127.125, 40);
    await page.locator('#tempo-file').setInputFiles({ name: 'track.wav', mimeType: 'audio/wav', buffer: file });
    await page.waitForFunction(() => document.getElementById('tempo-source').value === '127.125');
    await page.locator('#tempo-target').fill('127,125');
    await page.locator('#tempo-target').press('Enter');
    await page.waitForFunction(() => document.getElementById('tempo-result').dataset.status === 'sent');
    assert.equal(await page.locator('#pitch-bend').inputValue(), '0');
    await page.evaluate(() => { window.sent = []; });
    await page.locator('#tempo-apply').focus();
    await page.locator('#tempo-apply').press('Space');
    assert.deepEqual(await page.evaluate(() => window.sent), [[0xB0, 18, 64, 0xE0, 0, 64]]);
    file.writeFloatLE(0, 40);
    await page.locator('#tempo-file').setInputFiles({ name: 'without-bpm.wav', mimeType: 'audio/wav', buffer: file });
    await page.waitForFunction(() => document.getElementById('tempo-source-info').textContent.includes('no saved BPM'));
    assert.equal(await page.locator('#tempo-source').inputValue(), '');
    assert.equal(await page.locator('#tempo-apply').isDisabled(), true);
    await enterTempo(page);
    for (const width of [320, 375, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}px`);
        const source = await page.locator('#tempo-source').boundingBox();
        const target = await page.locator('#tempo-target').boundingBox();
        assert.equal(source.y, target.y);
        assert.ok(target.x >= source.x + source.width);
    }
    if (process.env.TP7_SCREENSHOT_DIR) {
        await fs.mkdir(process.env.TP7_SCREENSHOT_DIR, { recursive: true });
        await page.locator('#section-pitch').screenshot({ path: path.join(process.env.TP7_SCREENSHOT_DIR, 'tempo-desktop.png') });
        await page.setViewportSize({ width: 375, height: 1100 });
        await page.locator('#section-pitch').screenshot({ path: path.join(process.env.TP7_SCREENSHOT_DIR, 'tempo-mobile.png') });
    }
});

test('device panel receives fragmented BLE replies and gates transport on a real acknowledgement', async t => {
    const page = await openApp(t, 'ble');
    await page.locator('.conn-tab[data-tab="ble"]').click();
    await page.locator('#ble-connect-btn').click();
    await page.waitForFunction(() => window.bleSent.length === 18 && !window.writeInProgress);
    assert.deepEqual(await page.evaluate(() => window.remoteRequests), [], 'no automatic vendor commands');
    assert.equal(await page.locator('#remote-play').isDisabled(), true);
    await page.locator('#remote-inspect').click();
    await page.waitForFunction(() => document.getElementById('remote-status').textContent.startsWith('Read 1 device settings'));
    assert.match(await page.locator('#remote-device').innerText(), /firmware 1\.1\.11/);
    assert.match(await page.locator('#remote-status').innerText(), /Native cue selection is not yet validated/);
    await page.evaluate(() => {
        window.emitBle([128, 128, 0xB0, 20, 127]);
        window.emitBle([128, 128, 0xF8, 129, 0xFE]);
    });
    await page.waitForFunction(() => {
        const text = document.getElementById('remote-report').textContent;
        return text.startsWith('{') && JSON.parse(text).bluetooth.ignoredClockPackets === 1;
    });
    const inputReport = JSON.parse(await page.locator('#remote-report').textContent());
    assert.deepEqual(inputReport.bluetooth.recentPackets.at(-1).bytes, [128, 128, 0xB0, 20, 127]);
    assert.equal(await page.locator('#remote-play').isDisabled(), true);
    await page.locator('#remote-session').click();
    await page.waitForFunction(() => !document.getElementById('remote-play').disabled);
    await page.locator('#cue-rec-on').click();
    await page.locator('#remote-play').click();
    await page.waitForFunction(() => document.getElementById('remote-status').textContent.includes('acknowledged Resume'));
    assert.equal(await page.locator('#cue-rec-off').evaluate(el => el.classList.contains('active')), true);
    await page.locator('#remote-stop').click();
    await page.waitForFunction(() => document.getElementById('remote-status').textContent.includes('acknowledged Stop'));
    const requests = await page.evaluate(() => window.remoteRequests.map(r => [r.command, ...r.data]));
    assert.deepEqual(requests, [[1], [6, 1, 3, 232], [6, 2, 0, 0], [6, 2, 0, 1], [127, 64], [127, 80], [127, 81]]);
    await page.setViewportSize({width:375,height:1000});
    await page.locator('#section-device-cues summary').click();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    if (process.env.TP7_SCREENSHOT_DIR) await page.locator('#section-device-cues').screenshot({path:path.join(process.env.TP7_SCREENSHOT_DIR, 'device-panel-mobile.png')});
    await page.evaluate(() => { bleDevice.gatt.connected = false; onBLEDisconnected(); });
    assert.equal(await page.locator('#remote-play').isDisabled(), true);
    assert.equal(await page.locator('#remote-inspect').isDisabled(), true);
    assert.equal(await page.locator('#remote-report').innerText(), 'No device replies yet.');
});

test('unsupported settings and absent session acknowledgements never become cue support', async t => {
    const page = await openApp(t, 'ble');
    await page.locator('.conn-tab[data-tab="ble"]').click();
    await page.locator('#ble-connect-btn').click();
    await page.waitForFunction(() => window.bleSent.length === 18 && !window.writeInProgress);
    await page.evaluate(() => { window.remoteMode = 'reject-settings'; });
    await page.locator('#remote-inspect').click();
    await page.waitForFunction(() => document.getElementById('remote-status').textContent.includes('does not support the settings reader'));
    assert.equal(await page.locator('#remote-status').getAttribute('data-status'), '');
    assert.equal(await page.locator('#remote-session').isDisabled(), false);
    await page.evaluate(() => { window.remoteMode = 'silent'; });
    await page.locator('#remote-session').click();
    await page.waitForFunction(() => document.getElementById('remote-status').dataset.status === 'error');
    assert.match(await page.locator('#remote-status').innerText(), /not confirmed/);
    assert.equal(await page.locator('#remote-play').isDisabled(), true);
});

test('notification failure sends no vendor command and preserves the original controls', async t => {
    const page = await openApp(t, 'ble');
    await page.locator('.conn-tab[data-tab="ble"]').click();
    await page.locator('#ble-connect-btn').click();
    await page.waitForFunction(() => window.bleSent.length === 18 && !window.writeInProgress);
    await page.evaluate(() => { window.failNotifications = true; });
    await page.locator('#remote-inspect').click();
    await page.waitForFunction(() => document.getElementById('remote-status').dataset.status === 'error');
    assert.deepEqual(await page.evaluate(() => window.remoteRequests), []);
    await enterTempo(page);
    await page.locator('#tempo-apply').click();
    await page.waitForFunction(() => document.getElementById('tempo-result').dataset.status === 'sent');
});

test('an expired device request is not sent after a stalled BLE queue resumes', async t => {
    const page = await openApp(t, 'ble');
    await page.locator('.conn-tab[data-tab="ble"]').click();
    await page.locator('#ble-connect-btn').click();
    await page.waitForFunction(() => window.bleSent.length === 18 && !window.writeInProgress);
    await page.evaluate(() => { window.holdWrite = true; });
    await page.locator('#cue-rec-off').click();
    await page.waitForFunction(() => window.releaseWrite !== null);
    await page.locator('#remote-inspect').click();
    await page.waitForFunction(() => document.getElementById('remote-status').dataset.status === 'error');
    await page.evaluate(async () => { window.releaseWrite(); await bleWriteQueue; });
    assert.deepEqual(await page.evaluate(() => window.remoteRequests), []);
    assert.equal(await page.locator('#remote-session').isDisabled(), true);
});

test('live companion data and Jump & play use device positions; rejected seeks never resume', async t => {
    const page = await openApp(t, 'ble');
    await page.locator('.conn-tab[data-tab="ble"]').click();
    await page.locator('#ble-connect-btn').click();
    await page.waitForFunction(() => window.bleSent.length === 18 && !window.writeInProgress);
    await page.locator('#remote-inspect').click();
    await page.waitForFunction(() => !document.getElementById('remote-session').disabled);
    await page.locator('#remote-session').click();
    await page.waitForFunction(() => !document.getElementById('remote-play').disabled);
    assert.match(await page.locator('#remote-file').innerText(), /example_cues_15_tempo_88.wav/);
    assert.equal(await page.locator('#remote-position').innerText(), '0:34.531');
    assert.equal(await page.locator('#cue-count').inputValue(), '8');
    assert.equal(await page.locator('#tempo-source').inputValue(), '');
    for (const text of ['-1', '1.0001', '100', '999']) {
        await page.locator('#remote-seek-time').fill(text);
        assert.equal(await page.locator('#remote-seek').isDisabled(), true);
    }
    await page.locator('#remote-seek-time').fill('10.001');
    await page.evaluate(() => { window.remoteRequests = []; });
    await page.locator('#remote-seek').click();
    await page.waitForFunction(() => document.getElementById('remote-status').textContent.includes('jump to 10.001'));
    assert.deepEqual(await page.evaluate(() => window.remoteRequests.map(r => r.data)), [[81], [76, 17, 39, 0, 0], [80]]);
    assert.equal(await page.locator('#remote-position').innerText(), '0:10.001');
    assert.equal(await page.locator('#remote-playback').innerText(), 'Playing');
    await page.evaluate(() => {
        for (let ms = 0; ms < 700; ms++) window.emitCompanion([77, ms & 255, ms >> 8, 0, 0]);
        window.remoteMode = 'reject-seek'; window.remoteRequests = [];
    });
    await page.locator('#remote-seek').click();
    await page.waitForFunction(() => document.getElementById('remote-status').dataset.status === 'error');
    assert.deepEqual(await page.evaluate(() => window.remoteRequests.map(r => r.data)), [[81], [76, 17, 39, 0, 0]]);
    assert.equal(await page.locator('#remote-playback').innerText(), 'Stopped');
    await page.waitForFunction(() => JSON.parse(document.getElementById('remote-report').textContent).positionSamples.length === 600);
    const report = JSON.parse(await page.locator('#remote-report').textContent());
    assert.ok(report.events.some(event => event.kind === 'companion-event' && event.decoded?.type === 'file'));
    assert.equal(report.live.file.filename, 'example_cues_15_tempo_88.wav');
    assert.equal(report.events.some(event => event.kind === 'unrecognized-sysex'), false);
    await page.evaluate(() => { window.remoteMode = 'ok'; window.changeFileOnStop = true; window.remoteRequests = []; });
    await page.locator('#remote-seek').click();
    await page.waitForFunction(() => document.getElementById('remote-status').dataset.status === 'error');
    assert.deepEqual(await page.evaluate(() => window.remoteRequests.map(r => r.data)), [[81]], 'do not seek or resume a newly selected file');
    assert.equal(await page.locator('#remote-file').innerText(), 'recordings/other.wav');
});
