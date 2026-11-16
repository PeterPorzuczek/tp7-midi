// Optional browser integration tests: requires Playwright and Chromium/Edge.
// No physical MIDI device is accessed; both transports are simulated.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

let browser;
let server;
let url;
before(async () => {
    const root = path.join(__dirname, '..');
    const allowed = new Set(['/index.html', '/styles.css', '/tempo.js', '/wav-tempo.js', '/app.js', '/remote-protocol.js', '/remote-panel.js', '/dj-cues.js', '/dj-panel.js']);
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
        const notificationListeners = new Set();
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
                    if (packet.includes(0xF0)) {
                        const decoder = new TP7RemoteProtocol.BleReceiver(bytes => {
                            const fakeReply = [...bytes];
                            fakeReply[6] &= ~0x40;
                            fakeReply.splice(9, 0, 0);
                            const request = TP7RemoteProtocol.parse(fakeReply);
                            window.remoteRequests.push(request);
                            if (window.remoteMode === 'silent') return;
                            let data = [];
                            let status = 0;
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
                        decoder.push(packet);
                    }
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
        const device = {
            name: 'TP-7', addEventListener() {},
            gatt: { connected: true, async connect() {
                return { async getPrimaryService() {
                    return { async getCharacteristic() { return characteristic; } };
                } };
            } },
        };
        Object.defineProperty(navigator, 'bluetooth', { value: { requestDevice: async () => device } });
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
