document.addEventListener('DOMContentLoaded', () => {
    const el = id => document.getElementById(id), api = window.tp7RemotePanel, codec = TP7CueCarrier;
    let controller = null, decoded = null, identity = null, revision = 0, page = 0;
    let prepared = null, preparing = false, preparationRevision = 0;
    const status = (text, error = false) => { el('carrier-status').textContent = text; el('carrier-status').dataset.status = error ? 'error' : ''; };
    function controls() {
        const remote = api.getState();
        const next = `${remote.connection}:${TP7DJCues.trackKey(remote.file)}`;
        if (next !== identity) {
            identity = next; revision++; decoded = null; page = 0; renderCues();
            status('Select the original track on TP-7, then read its prepared cue carrier.');
        }
        let helper = '';
        try { if (remote.file) helper = codec.helperName(remote.file.filename); } catch { /* Invalid names cannot be read. */ }
        el('carrier-track').textContent = remote.file ? `${remote.file.folder}/${remote.file.filename}` : 'Waiting for the current track…';
        el('carrier-target').textContent = helper ? `Expected helper: ${remote.file.folder}/${helper}` : '';
        el('carrier-read').disabled = !!controller || remote.busy || !remote.ready || !helper || connectionType !== 'ble';
        el('carrier-cancel').disabled = !controller || controller.signal.aborted;
        el('carrier-test').disabled = preparing || !helper;
        el('carrier-prepare').disabled = preparing;
        el('carrier-download').disabled = !prepared || preparing;
        for (const button of el('carrier-cues').children) button.disabled = !remote.ready || remote.busy || !!controller;
    }
    function renderCues() {
        el('carrier-cues').replaceChildren();
        const cues = decoded?.cues || [], pages = Math.ceil(cues.length / 32);
        page = Math.max(0, Math.min(page, pages - 1));
        el('carrier-paging').hidden = pages <= 1;
        el('carrier-page').textContent = `${page + 1} / ${pages}`;
        el('carrier-prev').disabled = page === 0;
        el('carrier-next').disabled = page >= pages - 1;
        el('carrier-source').textContent = decoded ? `${decoded.kind === 'test' ? 'TEST points — not original WAV cues' : 'Prepared WAV cue markers'} · ${cues.length} points${decoded.bpm ? ` · stored BPM ${decoded.bpm}` : ''} · CRC ${decoded.checksum}` : '';
        for (let index = page * 32; index < Math.min(cues.length, (page + 1) * 32); index++) {
            const cue = cues[index], button = document.createElement('button');
            button.type = 'button'; button.className = 'dj-cue'; button.dataset.position = cue.positionMs;
            const title = document.createElement('strong'); title.textContent = `${decoded.kind === 'test' ? 'Test' : 'Cue'} ${index + 1}`;
            const time = document.createElement('span'); time.textContent = TP7DJCues.formatTime(cue.positionMs);
            const sample = document.createElement('small'); sample.textContent = `Sample ${cue.sampleOffset}`;
            button.append(title, time, sample);
            button.addEventListener('click', async () => {
                const selected = revision;
                const ok = await api.jumpTo(cue.positionMs, () => selected === revision);
                if (selected === revision) status(ok ? `Cue ${index + 1}: jump and playback acknowledged.` : el('remote-status').textContent, !ok);
            });
            el('carrier-cues').append(button);
        }
    }
    el('carrier-read').addEventListener('click', async () => {
        if (controller) return;
        controller = new AbortController(); decoded = null; page = 0; renderCues(); controls();
        const selected = revision;
        let result;
        const stages = { service: 'Opening companion Bluetooth…', identify: 'Identifying TP-7…', session: 'Stopping playback…',
            'enter-transfer': 'Opening the helper WAV…', audio: 'Receiving cue carrier…', decode: 'Checking signal, checksum and track identity…',
            cleanup: 'Closing transfer and restoring remote session…' };
        const ok = await api.runCompanionTask(async (device, file, check, publish) => {
            result = await TP7CompanionBLE.readCarrier({ device, file, check, protocol: TP7RemoteProtocol, signal: controller.signal,
                update(summary) { publish(summary); if (stages[summary.stage]) status(`${stages[summary.stage]} ${summary.audioBytes} bytes.`); } }, codec);
            return result.cleanupErrors.length === 0;
        }, { restart: true });
        controller = null;
        if (selected !== revision) { controls(); return; }
        if (result?.result === 'cues-decoded' && !result.cleanupErrors.length) {
            decoded = result.carrier; renderCues();
            status(`${decoded.cues.length} ${decoded.kind === 'test' ? 'test points' : 'prepared WAV cues'} received and validated.${ok ? ' Tap a point to jump and play.' : ' Press Start remote session before jumping.'}`, !ok);
        } else {
            const message = result?.cleanupErrors.length ? result.cleanupErrors.join(' ') : result?.error || el('remote-status').textContent;
            const cleanup = result?.cleanupErrors.length ? ' Transfer cleanup was not confirmed; disconnect and reconnect before playback.' : '';
            status(`${message} No cue buttons accepted. Check that the helper WAV is in the same TP-7 folder with the exact name shown above.${cleanup}`, true);
        }
        controls();
    });
    el('carrier-cancel').addEventListener('click', () => { controller?.abort(); controls(); });
    el('carrier-copy').addEventListener('click', () => el('remote-copy').click());
    el('carrier-prev').addEventListener('click', () => { page--; renderCues(); controls(); });
    el('carrier-next').addEventListener('click', () => { page++; renderCues(); controls(); });

    function prepare(source) {
        prepared = codec.makeWave(source);
        el('carrier-preparation').textContent = `${prepared.filename} · ${prepared.cueCount} ${source.kind === 'test' ? 'TEST points (0 / 10 / 20 s when inside the track)' : 'original WAV markers'} · ${prepared.seconds.toFixed(2)} s · ${Math.ceil(prepared.bytes.length / 1024)} KiB. Save and copy it next to ${source.filename} on TP-7. Select the original track when reading cues.`;
    }
    el('carrier-test').addEventListener('click', () => {
        prepared = null;
        try {
            const file = api.getState().file;
            if (!file) throw new Error('Read the current track first.');
            prepare({ ...file, kind: 'test', bpm: null, cues: [0, 10, 20].map(seconds => seconds * file.sampleRate).filter(sample => sample < file.numFrames) });
        } catch (error) { el('carrier-preparation').textContent = error.message; }
        controls();
    });
    el('carrier-prepare').addEventListener('click', () => el('carrier-file').click());
    el('carrier-file').addEventListener('change', async event => {
        const file = event.target.files[0]; event.target.value = '';
        if (!file) return;
        const selected = ++preparationRevision;
        prepared = null; preparing = true; controls();
        el('carrier-preparation').textContent = `Reading cue metadata from ${file.name} locally…`;
        try {
            let received = 0;
            const reader = { read: async (offset, length) => {
                received += length;
                if (received > 262144 || offset < 0 || offset + length > file.size) throw new Error('WAV metadata exceeded the preparation read limit.');
                return new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
            } };
            const metadata = await TP7FileAccess.readWave(reader, file.size, null);
            if (selected === preparationRevision) prepare({ ...metadata, filename: file.name, kind: 'wav' });
        } catch (error) { if (selected === preparationRevision) el('carrier-preparation').textContent = error.message; }
        finally { if (selected === preparationRevision) { preparing = false; controls(); } }
    });
    el('carrier-download').addEventListener('click', () => {
        if (!prepared) return;
        const url = URL.createObjectURL(new Blob([prepared.bytes], { type: 'audio/wav' }));
        const link = document.createElement('a'); link.href = url; link.download = prepared.filename; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
    document.addEventListener('tp7-remote-state', controls);
    controls();
});
