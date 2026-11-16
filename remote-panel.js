// Read-only discovery and explicitly requested, evidenced transport commands.
// Native cue selection is NOT implemented: no validated opcode or cue schema
// has been found. Keep that distinction visible until hardware evidence exists.
document.addEventListener('DOMContentLoaded', () => {
    const protocol = TP7RemoteProtocol;
    const element = id => document.getElementById(id);
    const report = { version: 1, transport: null, metadata: null, settings: null, bluetooth: null, events: [] };
    const pending = new Map();
    const receiver = new protocol.BleReceiver(receive);
    let nextId = 0;
    let generation = 0;
    let activeEndpoint = null;
    let notificationEndpoint = null;
    let inputEndpoint = null;
    let busy = false;
    let identified = false;
    let sessionConfirmed = false;
    let renderTimer = null;

    function renderReport() {
        if (renderTimer !== null) return;
        renderTimer = setTimeout(() => {
            renderTimer = null;
            element('remote-report').textContent = JSON.stringify(report, null, 2);
        }, 150);
    }

    function addEvent(kind, value) {
        report.events.push({ time: new Date().toISOString(), kind, ...value });
        if (report.events.length > 200) report.events.shift();
        renderReport();
    }

    function status(text, error = false) {
        element('remote-status').textContent = text;
        element('remote-status').dataset.status = error ? 'error' : '';
    }

    function buttons() {
        const connected = !!isMidiConnected();
        element('remote-inspect').disabled = busy || !connected;
        element('remote-session').disabled = busy || !connected || !identified;
        element('remote-play').disabled = busy || !connected || !sessionConfirmed;
        element('remote-stop').disabled = busy || !connected || !sessionConfirmed;
    }

    function connectionChanged() {
        const endpoint = isMidiConnected() ? (connectionType === 'ble' ? bleMidiCharacteristic : midiOutput) : null;
        if (endpoint !== activeEndpoint) {
            generation++;
            for (const request of pending.values()) request.reject(new Error('Connection changed. Read TP-7 again.'));
            if (notificationEndpoint) notificationEndpoint.removeEventListener('characteristicvaluechanged', onNotification);
            if (inputEndpoint) inputEndpoint.onmidimessage = null;
            notificationEndpoint = null;
            inputEndpoint = null;
            receiver.reset();
            activeEndpoint = endpoint;
            identified = false;
            sessionConfirmed = false;
            report.transport = connectionType;
            report.metadata = null;
            report.settings = null;
            report.bluetooth = connectionType === 'ble' ? { notifications: 0, ignoredClockPackets: 0, recentPackets: [] } : null;
            report.events = [];
            clearTimeout(renderTimer);
            renderTimer = null;
            element('remote-device').textContent = 'Device information has not been read.';
            element('remote-report').textContent = 'No device replies yet.';
            status(endpoint ? 'Connected. Press Read TP-7 to check device replies.' : 'Connect TP-7 first.');
        }
        buttons();
    }

    function receive(bytes) {
        const reply = protocol.parse(bytes);
        // Bound unknown events too. Never log MIDI clock or audio payloads.
        if (!reply) {
            if (bytes[0] === 0xF0) addEvent('unrecognized-sysex', { bytes: Array.from(bytes).slice(0, 512) });
            return;
        }
        addEvent('reply', { ...reply, data: reply.data.slice(0, 2048) });
        const request = pending.get(reply.id);
        if (!request || reply.command !== request.command) return;
        if (reply.status === 0) request.resolve(reply);
        else if (reply.status !== 64) request.reject(new Error(`TP-7 rejected command ${reply.command} (status ${reply.status}).`));
        // Status 64 is progress, not confirmation. The original timeout remains.
    }

    function onNotification(event) {
        if (event.target !== notificationEndpoint || activeEndpoint !== notificationEndpoint) return;
        const view = event.target.value;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
        const bluetooth = report.bluetooth;
        bluetooth.notifications++;
        // Retain raw input as evidence even when its message type is unknown.
        // Omit packets containing only clock/active-sensing pairs so they do
        // not push physical button events out of the bounded history.
        const clockOnly = bytes.length >= 3 && (bytes.length - 1) % 2 === 0 &&
            (bytes[0] & 0xC0) === 0x80 && bytes.slice(1).every((byte, index) =>
                index % 2 === 0 ? byte >= 128 : byte === 0xF8 || byte === 0xFE);
        if (clockOnly) bluetooth.ignoredClockPackets++;
        else {
            bluetooth.recentPackets.push({ time: new Date().toISOString(), bytes: Array.from(bytes).slice(0, 512) });
            if (bluetooth.recentPackets.length > 64) bluetooth.recentPackets.shift();
            renderReport();
        }
        receiver.push(bytes);
    }

    async function listen(token) {
        if (connectionType === 'ble') {
            const endpoint = bleMidiCharacteristic;
            if (notificationEndpoint === endpoint) return;
            if (!endpoint?.startNotifications) throw new Error('This browser connection cannot receive Bluetooth replies.');
            endpoint.addEventListener('characteristicvaluechanged', onNotification);
            notificationEndpoint = endpoint;
            try {
                await endpoint.startNotifications();
                if (token !== generation) throw new Error('Connection changed.');
            } catch (error) {
                endpoint.removeEventListener('characteristicvaluechanged', onNotification);
                if (notificationEndpoint === endpoint) notificationEndpoint = null;
                throw error;
            }
        } else {
            const access = await navigator.requestMIDIAccess({ sysex: true });
            if (token !== generation) throw new Error('Connection changed.');
            if (!access.sysexEnabled) throw new Error('Allow MIDI SysEx access in the browser, then try again.');
            const output = access.outputs.get(midiOutput.id);
            if (!output) throw new Error('The selected USB output is unavailable with SysEx access. Reconnect it.');
            const matches = [...access.inputs.values()].filter(port => port.state !== 'disconnected' && port.name === output.name);
            if (matches.length !== 1) throw new Error('Could not identify one matching TP-7 MIDI input.');
            if (inputEndpoint) inputEndpoint.onmidimessage = null;
            inputEndpoint = matches[0];
            inputEndpoint.onmidimessage = event => {
                if (token === generation && connectionType === 'usb') receive(Array.from(event.data));
            };
            await inputEndpoint.open();
            if (token !== generation) throw new Error('Connection changed.');
            // Use the output from the access object with SysEx permission.
            midiOutput = output;
            activeEndpoint = output;
        }
    }

    function send(bytes, token, isPending) {
        const check = () => {
            if (token !== generation || !isMidiConnected()) throw new Error('Connection changed. Read TP-7 again.');
            if (!isPending()) throw new Error('Request expired before transmission.');
        };
        check();
        if (connectionType === 'usb') {
            midiOutput.send(bytes);
            return Promise.resolve();
        }
        const endpoint = bleMidiCharacteristic;
        const write = bleWriteQueue.then(async () => {
            check();
            for (const packet of protocol.blePackets(bytes, performance.now())) {
                check();
                if (endpoint !== bleMidiCharacteristic) throw new Error('Bluetooth connection changed.');
                await endpoint.writeValueWithoutResponse(packet);
            }
        });
        bleWriteQueue = write.catch(() => {});
        return write;
    }

    function request(command, data, token) {
        nextId = nextId % 4095 + 1;
        const id = nextId;
        return new Promise((resolve, reject) => {
            const finish = (callback, value) => {
                clearTimeout(timer);
                pending.delete(id);
                callback(value);
            };
            const timer = setTimeout(() => finish(reject, new Error('No TP-7 reply within 5 seconds. The command is not confirmed.')), 5000);
            pending.set(id, {
                command,
                resolve: value => finish(resolve, value),
                reject: error => finish(reject, error),
            });
            addEvent('request', { id, command, data });
            try { Promise.resolve(send(protocol.encode(id, command, data), token, () => pending.has(id))).catch(error => finish(reject, error)); }
            catch (error) { finish(reject, error); }
        });
    }

    async function run(operation) {
        if (busy) return;
        connectionChanged();
        const token = generation;
        busy = true;
        buttons();
        try {
            if (!isMidiConnected()) throw new Error('Connect TP-7 first.');
            await listen(token);
            await operation(token);
        } catch (error) {
            if (token === generation) { addEvent('error', { message: error.message }); status(error.message, true); }
        } finally { busy = false; buttons(); }
    }

    element('remote-inspect').addEventListener('click', () => run(async token => {
        identified = false;
        sessionConfirmed = false;
        report.metadata = null;
        report.settings = null;
        status('Waiting for TP-7 identification…');
        const greeting = await request(1, [], token);
        const text = new TextDecoder().decode(new Uint8Array(greeting.data));
        const fields = Object.fromEntries(text.replace(/\0/g, '').split(';').map(pair => {
            const colon = pair.indexOf(':');
            return [pair.slice(0, colon), pair.slice(colon + 1)];
        }));
        if (fields.product !== 'TP-7') throw new Error('The reply did not identify a TP-7.');
        identified = true;
        // Do not include the serial number in the report metadata.
        report.metadata = { product: fields.product, firmware: fields.sw_version || fields.os_version, mode: fields.mode };
        element('remote-device').textContent = `TP-7 · firmware ${report.metadata.firmware || 'unknown'} · ${connectionType.toUpperCase()}`;
        status('TP-7 replied. Checking its settings catalogue…');
        await request(6, [1, 3, 232], token); // Official INIT, 1000 ms.
        const all = [];
        for (let page = 0; page < 128; page++) {
            const reply = await request(6, [2, page >> 8, page & 255], token);
            const chunk = protocol.settingsChunk(reply.data);
            if (!chunk.length) {
                const catalogue = JSON.parse(new TextDecoder().decode(new Uint8Array(all)));
                report.settings = catalogue;
                const settings = protocol.flattenSettings(catalogue);
                const cueRelated = settings.filter(setting => /cue|marker/i.test(JSON.stringify(setting)));
                addEvent('settings-read', { count: settings.length, cueRelated });
                status(`Read ${settings.length} device settings; ${cueRelated.length} mention cue/marker. Native cue selection is not yet validated. Copy the report for analysis.`);
                return;
            }
            all.push(...chunk);
            if (all.length > 262144) throw new Error('Settings catalogue exceeded the read limit.');
        }
        throw new Error('Settings catalogue did not end within 128 pages.');
    }));

    element('remote-session').addEventListener('click', () => run(async token => {
        sessionConfirmed = false;
        status('Requesting companion session…');
        await request(127, [0x40], token);
        sessionConfirmed = true;
        status('TP-7 acknowledged the session. Select cues with +/− on the device to capture any events.');
    }));

    async function transport(opcode) {
        await run(async token => {
            if (!sessionConfirmed) throw new Error('Start and confirm a remote session first.');
            if (opcode === 0x50) {
                await transmitMidiBatch([[0xB0, TP7.CC_REC_ARM, 0], [0xB0, TP7.CC_CUE_REC, 0]], () => token === generation);
                state.cueRecMode = false;
                element('cue-rec-off').classList.add('active');
                element('cue-rec-on').classList.remove('active', 'rec-active');
            }
            status('Waiting for transport acknowledgement…');
            await request(127, [opcode], token);
            status(`TP-7 acknowledged Native ${opcode === 0x50 ? 'Play' : 'Stop'}. Check playback on the device; this is not a cue-selection acknowledgement.`);
        });
    }
    element('remote-play').addEventListener('click', () => transport(0x50));
    element('remote-stop').addEventListener('click', () => transport(0x51));
    element('remote-copy').addEventListener('click', async () => {
        const text = JSON.stringify(report, null, 2);
        try { await navigator.clipboard.writeText(text); status('Report copied.'); }
        catch {
            const area = element('remote-copy-text');
            area.value = text;
            area.hidden = false;
            area.focus();
            area.select();
            status('Select and copy the report below.');
        }
    });

    window.tp7RemotePanel = { connectionChanged };
    connectionChanged();
});
