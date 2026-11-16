// Read ACID tempo metadata used by TP-7 WAV tooling. Only small headers are
// loaded, so multi-gigabyte recordings do not need to fit in browser memory.
const TP7WavTempo = (() => {
    const fourCC = (view, offset) => String.fromCharCode(
        ...new Uint8Array(view.buffer, view.byteOffset + offset, 4)
    );

    async function read(file) {
        async function viewAt(offset, length) {
            const buffer = await file.slice(offset, offset + length).arrayBuffer();
            if (buffer.byteLength !== length) throw new Error('Incomplete WAV file.');
            return new DataView(buffer);
        }

        const header = await viewAt(0, 12);
        if (fourCC(header, 0) !== 'RIFF' || fourCC(header, 8) !== 'WAVE') {
            throw new Error('Choose a RIFF WAV file. Other audio formats need manual BPM entry.');
        }
        const end = header.getUint32(4, true) + 8;
        if (end < 12 || end > file.size) throw new Error('Incomplete or invalid WAV file.');
        let offset = 12;
        let bpm = null;
        while (offset < end) {
            if (end - offset < 8) throw new Error('Invalid WAV chunk header.');
            const chunk = await viewAt(offset, 8);
            const length = chunk.getUint32(4, true);
            const next = offset + 8 + length + (length % 2);
            if (next > end) throw new Error('Invalid WAV chunk length.');
            if (fourCC(chunk, 0) === 'acid') {
                if (length < 24) throw new Error('Incomplete WAV tempo metadata.');
                const tempo = (await viewAt(offset + 8 + 20, 4)).getFloat32(0, true);
                if (Number.isFinite(tempo) && tempo > 0) {
                    if (bpm !== null && bpm !== tempo) {
                        throw new Error('Conflicting BPM metadata. Enter the track BPM manually.');
                    }
                    bpm = tempo;
                }
            }
            offset = next;
        }
        return bpm;
    }

    return { read };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = TP7WavTempo;
