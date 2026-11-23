document.addEventListener('DOMContentLoaded', () => {
    const el = id => document.getElementById(id);
    const api = window.tp7RemotePanel;
    let remote = api.getState();
    let identity = '';
    let revision = 0;
    let discovery = null;
    let metadata = null;
    let page = 0;
    let download = null;
    let running = false;

    const status = (text, error = false) => {
        el('file-status').textContent = text;
        el('file-status').dataset.status = error ? 'error' : '';
    };
    function controls() {
        const idle = remote.connected && remote.identified && !remote.busy && !remote.fileBlocked && !running;
        el('file-probe').disabled = !idle;
        el('file-read').disabled = !idle || !discovery || !el('file-select').value;
        el('file-select').disabled = !idle || !discovery;
        el('file-cancel').disabled = !remote.fileActive;
        for (const button of el('file-cues').children) button.disabled = !remote.ready || remote.busy || running;
    }
    function renderCues() {
        el('file-cues').replaceChildren();
        const cues = metadata?.cues || [];
        const pages = Math.ceil(cues.length / 32);
        page = Math.max(0, Math.min(page, pages - 1));
        el('file-cue-paging').hidden = pages <= 1;
        el('file-cue-page').textContent = `${page + 1} / ${pages}`;
        el('file-cue-prev').disabled = page === 0;
        el('file-cue-next').disabled = page >= pages - 1;
        for (let index = page * 32; index < Math.min(cues.length, (page + 1) * 32); index++) {
            const cue = cues[index];
            const button = document.createElement('button');
            button.type = 'button'; button.className = 'dj-cue';
            button.dataset.position = cue.positionMs;
            const title = document.createElement('strong'); title.textContent = `Cue ${index + 1}`;
            const label = document.createElement('span'); label.textContent = `WAV marker ID ${cue.id}`;
            const time = document.createElement('small'); time.textContent = TP7DJCues.formatTime(cue.positionMs);
            button.append(title, label, time);
            button.addEventListener('click', async () => {
                const selected = revision;
                const ok = await api.jumpTo(cue.positionMs, () => selected === revision);
                if (selected === revision) status(ok ? `Cue ${index + 1}: jump and playback acknowledged.` : el('remote-status').textContent, !ok);
            });
            el('file-cues').append(button);
        }
        controls();
    }
    function reset() {
        revision++; discovery = null; metadata = null; download = null; page = 0;
        el('file-select').replaceChildren(); el('file-list').textContent = '';
        el('file-download').hidden = true;
        renderCues();
        status('Read TP-7 and start a remote session, then test file access while playback is stopped.');
    }
    async function task(label, operation) {
        if (running || remote.busy) return;
        running = true; controls();
        const selected = revision;
        const file = remote.file ? { ...remote.file } : null;
        const summary = { result: 'testing', stage: 'init', method: 'TE FILE 0x05', started: new Date().toISOString(), track: file,
            hardwareSupport: 'unconfirmed' };
        status(label);
        const success = await api.runFileTask(async (request, check, publish) => {
            const guard = () => { check(); if (selected !== revision) throw new Error('Selected file changed.'); };
            const client = new TP7FileAccess.Client(request, guard, progress => {
                summary.traffic = progress;
                status(`${label} ${progress.requests} requests · ${progress.bytes} bytes received.`);
            });
            publish(summary);
            try {
                summary.init = await client.init();
                summary.stage = 'read';
                summary.hardwareSupport = 'INIT acknowledged; capabilities still being tested';
                publish(summary);
                await operation(client, file, summary, guard);
                guard(); summary.result = 'success';
            } catch (error) {
                summary.result = error.command === 5 && error.status === 2 && summary.stage === 'init' ? 'unsupported' : 'failed';
                summary.error = error.message;
                if (summary.result === 'unsupported') summary.hardwareSupport = 'command 5 rejected as unsupported';
                throw error;
            } finally {
                summary.traffic = { bytes: client.bytes, requests: client.requests };
                try { publish(summary); } catch { /* Connection/track changes invalidate this report. */ }
            }
        });
        running = false; controls();
        if (selected !== revision) return;
        if (!success) {
            const message = summary.result === 'unsupported' ? 'TP-7 rejected FILE (command 5). This route is unavailable on this connection/firmware. Copy the file report.' :
                `${el('remote-status').textContent} Copy the file report for the exact response.`;
            status(message, true);
        }
    }

    el('file-probe').addEventListener('click', () => {
        discovery = null; metadata = null; download = null;
        el('file-select').replaceChildren(); el('file-list').textContent = ''; el('file-download').hidden = true; renderCues();
        task('Checking FILE access…', async (client, file, summary, check) => {
            discovery = await client.discover(file?.folder || '');
            check(); summary.listings = discovery.listings;
            summary.hardwareSupport = 'INIT and LIST acknowledged';
            const lines = [];
            for (const folder of discovery.listings) {
                lines.push(`${folder.path} (node ${folder.id})`);
                for (const node of folder.nodes) lines.push(`  ${node.flags & 2 ? '[folder]' : '[file]'} ${node.name} · ${node.size} bytes · id ${node.id}`);
            }
            el('file-list').textContent = lines.join('\n') || 'The device returned an empty listing.';
            const candidates = discovery.nodes.filter(node => (node.flags & 7) === 5 &&
                ((node.name === file?.filename && /\.wav$/i.test(node.name)) || (/\.(cue|json)$/i.test(node.name) && node.size > 0 && node.size <= 65536)));
            for (const node of candidates) el('file-select').add(new Option(node.name, String(node.id)));
            const current = candidates.find(node => node.name === file?.filename);
            if (current) el('file-select').value = String(current.id);
            status(candidates.length ? 'FILE listing works. Select the current WAV to read its cue metadata, or a small .cue/.json file to download.' :
                'FILE listing works, but the current WAV or a small .cue/.json file was not exposed. Copy the file report.');
        });
    });
    el('file-read').addEventListener('click', () => {
        const node = discovery?.nodes.find(entry => String(entry.id) === el('file-select').value);
        if (!node) return;
        metadata = null; download = null; el('file-download').hidden = true; renderCues();
        task('Reading file metadata…', async (client, file, summary, check) => {
            summary.node = node;
            const reader = client.reader(node);
            if (/\.wav$/i.test(node.name)) {
                if (!file || node.name !== file.filename) throw new Error('Only the current TP-7 WAV can supply jump markers.');
                const result = await TP7FileAccess.readWave(reader, node.size, file);
                check(); metadata = result; summary.metadata = result;
                summary.hardwareSupport = 'WAV bytes and track identity validated';
                renderCues();
                status(`Read ${result.cues.length} actual WAV cue markers${result.bpm ? ` · stored BPM ${result.bpm}` : ''}. Received ${client.bytes} bytes; audio blocks skipped by file offset.`);
            } else {
                if (!/\.(cue|json)$/i.test(node.name) || node.size > 65536) throw new Error('Only small .cue/.json sidecars may be downloaded.');
                const bytes = await reader.read(0, node.size);
                check(); download = { name: node.name, bytes };
                summary.download = { name: node.name, bytes: bytes.length };
                summary.hardwareSupport = 'sidecar bytes received; format not interpreted';
                el('file-download').hidden = false;
                status(`Received ${bytes.length} bytes from ${node.name}. Save the file to inspect its contents.`);
            }
        });
    });
    el('file-cancel').addEventListener('click', () => api.cancelFileTask());
    el('file-copy').addEventListener('click', () => el('remote-copy').click());
    el('file-select').addEventListener('change', controls);
    el('file-cue-prev').addEventListener('click', () => { page--; renderCues(); });
    el('file-cue-next').addEventListener('click', () => { page++; renderCues(); });
    el('file-download').addEventListener('click', () => {
        if (!download) return;
        const url = URL.createObjectURL(new Blob([download.bytes], { type: 'application/octet-stream' }));
        const link = document.createElement('a'); link.href = url; link.download = download.name; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    });
    document.addEventListener('tp7-remote-state', event => {
        remote = event.detail;
        const next = `${remote.connection}:${TP7DJCues.trackKey(remote.file)}`;
        if (next !== identity) { identity = next; reset(); }
        controls();
    });
    identity = `${remote.connection}:${TP7DJCues.trackKey(remote.file)}`;
    reset();
});
