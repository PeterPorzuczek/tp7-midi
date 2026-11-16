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
    const allowed = new Set(['/index.html', '/styles.css', '/tempo.js', '/wav-tempo.js', '/app.js']);
    server = http.createServer(async (request, response) => {
        const name = request.url === '/' ? '/index.html' : request.url;
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
                } finally { window.writeInProgress = false; }
            },
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
