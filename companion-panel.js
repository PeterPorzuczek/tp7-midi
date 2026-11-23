document.addEventListener('DOMContentLoaded', () => {
    const el = id => document.getElementById(id);
    const api = window.tp7RemotePanel;
    let controller = null;
    const status = (text, error = false) => {
        el('companion-status').textContent = text;
        el('companion-status').dataset.status = error ? 'error' : '';
    };
    function controls() {
        const remote = api.getState();
        el('companion-probe').disabled = !!controller || remote.busy || !remote.ready || !remote.file || connectionType !== 'ble';
        el('companion-cancel').disabled = !controller || controller.signal.aborted;
    }
    el('companion-probe').addEventListener('click', async () => {
        if (controller) return;
        controller = new AbortController(); controls();
        let result;
        const stages = { service: 'Opening the companion Bluetooth service…', identify: 'Identifying TP-7 on the companion channel…',
            session: 'Opening companion session and stopping playback…', 'enter-transfer': 'Opening the current track for audio transfer…',
            audio: 'Receiving a short audio sample…', cleanup: 'Stopping transfer and closing the companion session…' };
        const ok = await api.runCompanionTask(async (device, file, check, publish) => {
            result = await TP7CompanionBLE.probe({ device, file, check, protocol: TP7RemoteProtocol, signal: controller.signal,
                update(summary) {
                    publish(summary);
                    if (stages[summary.stage]) status(`${stages[summary.stage]} ${summary.audioBytes} audio bytes received.`);
                } });
        });
        controller = null; controls();
        if (!ok || !result) { status(el('remote-status').textContent, true); return; }
        const cleanup = result.cleanupErrors.length ? ' Transfer cleanup was not fully acknowledged. Disconnect and reconnect TP-7 before using playback.' :
            ' Press Start remote session to use playback again.';
        if (result.result === 'audio-received') status(`Companion audio received: ${result.audioBytes} bytes in ${result.firstPackets} blocks. This confirms the audio channel, not access to native WAV cues. Copy the report.${cleanup}`, !!result.cleanupErrors.length);
        else status(`${result.error} No cue markers were read. If the service was unavailable, disconnect, reload this page and reconnect Bluetooth once. Copy the report.${cleanup}`, true);
    });
    el('companion-cancel').addEventListener('click', () => { controller?.abort(); controls(); });
    el('companion-copy').addEventListener('click', () => el('remote-copy').click());
    document.addEventListener('tp7-remote-state', controls);
    controls();
});
