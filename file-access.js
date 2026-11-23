// Read-only TE FILE dialect, decoded from the official EP Sample Tool.
// Availability on TP-7 is a hypothesis until the device acknowledges command 5.
const TP7FileAccess = (() => {
    const MAX_BYTES = 262144;
    const MAX_REQUESTS = 256;
    const u16 = (bytes, at = 0) => bytes[at] * 256 + bytes[at + 1];
    const u32 = (bytes, at = 0) => bytes[at] * 16777216 + bytes[at + 1] * 65536 + bytes[at + 2] * 256 + bytes[at + 3];
    const be16 = n => [n >>> 8 & 255, n & 255];
    const be32 = n => [n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255];
    const integer = (n, max) => Number.isInteger(n) && n >= 0 && n <= max;
    function assertReadRequest(data) {
        if (!Array.isArray(data) || !data.every(n => integer(n, 255))) throw new Error('Invalid FILE request.');
        const valid = (data.length === 6 && data[0] === 1 && data[1] === 0 && u32(data, 2) === 4096) ||
            (data.length === 5 && data[0] === 4) ||
            (data.length === 8 && data[0] === 3 && data[1] === 0) ||
            (data.length === 4 && data[0] === 3 && data[1] === 1);
        if (!valid) throw new Error('Only FILE INIT without subscription, LIST and GET are allowed.');
    }
    function parseNode(bytes, offset) {
        if (offset + 8 > bytes.length) throw new Error('Truncated FILE node.');
        const end = bytes.indexOf(0, offset + 7);
        if (end < 0 || end - offset > 1031) throw new Error('Invalid FILE filename.');
        const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.slice(offset + 7, end));
        if (/[\u0000-\u001f\u007f/\\]/.test(name) || name === '.' || name === '..') throw new Error('Invalid FILE name.');
        return { node: { id: u16(bytes, offset), flags: bytes[offset + 2], size: u32(bytes, offset + 3), name }, end: end + 1 };
    }
    function parseList(data, page) {
        const bytes = Uint8Array.from(data);
        if (bytes.length < 2 || u16(bytes) !== page) throw new Error('FILE list page mismatch.');
        const nodes = [];
        const ids = new Set();
        let offset = 2;
        while (offset < bytes.length) {
            const parsed = parseNode(bytes, offset);
            if (!parsed.node.name || ids.has(parsed.node.id)) throw new Error('Duplicate or unnamed FILE node.');
            ids.add(parsed.node.id); nodes.push(parsed.node); offset = parsed.end;
        }
        return nodes;
    }

    class Client {
        constructor(request, check = () => {}, progress = () => {}) {
            this.request = request; this.check = check; this.progress = progress;
            this.bytes = 0; this.requests = 0; this.started = Date.now(); this.chunkSize = null;
        }
        async ask(data) {
            assertReadRequest(data); this.check();
            if (++this.requests > MAX_REQUESTS || Date.now() - this.started > 60000) throw new Error('FILE read limit reached. Copy the report.');
            const reply = Uint8Array.from(await this.request(data));
            this.check();
            this.bytes += reply.length;
            if (this.bytes > MAX_BYTES || reply.length > 32768) throw new Error('FILE response exceeded the read limit.');
            this.progress({ bytes: this.bytes, requests: this.requests });
            return reply;
        }
        async init() {
            // Byte 1 is subscription flags, NOT a read/write selector.
            const data = await this.ask([1, 0, 0, 0, 16, 0]);
            if (data.length !== 5) throw new Error('FILE INIT replied in an unknown format. Copy the report.');
            const chunkSize = u32(data, 1);
            // TE's client uses this advertised size to bound PUT requests;
            // it does not use it as the length of each GET response. An OP-XY
            // advertises 128 KiB, so do not reject that before trying LIST.
            if (chunkSize < 16) throw new Error('FILE INIT returned an invalid chunk size. Copy the report.');
            this.chunkSize = chunkSize;
            return { flags: data[0], chunkSize };
        }
        async list(id) {
            if (!integer(id, 65535)) throw new Error('Invalid folder id.');
            const nodes = [];
            const seen = new Set();
            for (let page = 0; page < 32; page++) {
                const entries = parseList(await this.ask([4, ...be16(page), ...be16(id)]), page);
                if (!entries.length) return nodes;
                for (const node of entries) {
                    if (seen.has(node.id) || nodes.length >= 1024) throw new Error('FILE listing repeats entries or exceeds its limit.');
                    seen.add(node.id); nodes.push(node);
                }
            }
            throw new Error('FILE folder listing did not end. Copy the report.');
        }
        async discover(folder = '') {
            const parts = folder.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
            if (parts.length > 4 || parts.some(part => part === '..' || part === '.')) throw new Error('Unsupported track folder.');
            const listings = [];
            let id = 0;
            let path = '';
            let nodes = await this.list(id);
            listings.push({ path: '/', id, nodes });
            for (const part of parts) {
                const next = nodes.find(node => (node.flags & 3) === 2 && node.name === part);
                if (!next) return { listings, nodes: [], path, folderFound: false };
                id = next.id; path += `/${part}`;
                nodes = await this.list(id);
                listings.push({ path, id, nodes });
            }
            return { listings, nodes, path, folderFound: true };
        }
        async open(node, offset) {
            if (!integer(node.id, 65535) || !integer(node.size, 0xFFFFFFFF) ||
                !integer(offset, 0xFFFFFFFF) || offset >= node.size) throw new Error('Invalid FILE read range.');
            const reply = await this.ask([3, 0, ...be16(node.id), ...be32(offset)]);
            const parsed = parseNode(reply, 0);
            if (parsed.end !== reply.length || parsed.node.id !== node.id || parsed.node.size !== node.size || parsed.node.name !== node.name) {
                throw new Error('FILE identity changed or GET response format is different.');
            }
        }
        async page(page) {
            if (!integer(page, 65535)) throw new Error('FILE page limit reached.');
            const reply = await this.ask([3, 1, ...be16(page)]);
            if (reply.length < 2 || u16(reply) !== page) throw new Error('FILE data page mismatch.');
            return reply.slice(2);
        }
        reader(node) {
            let cache = null;
            let cacheOffset = 0;
            let offsetsVerified = false;
            const readRange = async (offset, length, force = false) => {
                if (!integer(offset, node.size) || !integer(length, 65536) || offset + length > node.size) throw new Error('FILE range outside file.');
                if (!length) return new Uint8Array();
                if (!force && cache && offset >= cacheOffset && offset + length <= cacheOffset + cache.length) {
                    this.check(); return cache.slice(offset - cacheOffset, offset - cacheOffset + length);
                }
                await this.open(node, offset);
                const chunks = [];
                let received = 0;
                for (let page = 0; received < length; page++) {
                    const data = await this.page(page);
                    if (!data.length || offset + received + data.length > node.size) throw new Error('FILE data ended early or exceeded EOF.');
                    chunks.push(data); received += data.length;
                }
                cache = new Uint8Array(received); cacheOffset = offset;
                let at = 0;
                for (const chunk of chunks) { cache.set(chunk, at); at += chunk.length; }
                return cache.slice(0, length);
            };
            return {
                read: async (offset, length) => {
                    // Validate offset semantics against overlapping bytes before
                    // trusting a seek over the potentially huge audio data chunk.
                    if (offset > 0 && !offsetsVerified && !(cache && offset >= cacheOffset && offset + length <= cacheOffset + cache.length)) {
                        const expected = await readRange(0, 24);
                        const actual = await readRange(12, 12, true);
                        if (!actual.every((byte, i) => byte === expected[i + 12])) throw new Error('FILE GET offset is ignored or unsupported; stopped before downloading audio.');
                        offsetsVerified = true;
                    }
                    return readRange(offset, length);
                },
                get offsetsVerified() { return offsetsVerified; },
            };
        }
    }

    async function readWave(reader, size, expected) {
        const read = async (offset, length) => {
            const data = await reader.read(offset, length);
            if (data.length !== length) throw new Error('Truncated WAV metadata.');
            return data;
        };
        const ascii = bytes => String.fromCharCode(...bytes);
        const view = bytes => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const header = await read(0, 12);
        if (ascii(header.slice(0, 4)) !== 'RIFF' || ascii(header.slice(8, 12)) !== 'WAVE') throw new Error('FILE GET did not return a RIFF WAV. Copy the report.');
        const end = view(header).getUint32(4, true) + 8;
        if (end !== size) throw new Error('WAV RIFF length differs from the listed file size.');
        let offset = 12;
        let format = null;
        let dataSize = null;
        let cueRecords = null;
        let bpm = null;
        const chunks = [];
        while (offset < end) {
            if (chunks.length >= 128 || offset + 8 > end) throw new Error('Invalid WAV chunk table.');
            const chunk = await read(offset, 8);
            const name = ascii(chunk.slice(0, 4));
            const length = view(chunk).getUint32(4, true);
            const body = offset + 8;
            const next = body + length + (length & 1);
            if (next > end) throw new Error('WAV chunk exceeds the file.');
            chunks.push({ name, offset, size: length });
            if (name === 'fmt ') {
                if (format || length < 16) throw new Error('Invalid WAV format chunk.');
                const data = view(await read(body, 16));
                format = { code: data.getUint16(0, true), channels: data.getUint16(2, true), sampleRate: data.getUint32(4, true), blockAlign: data.getUint16(12, true) };
            } else if (name === 'data') {
                if (dataSize !== null) throw new Error('Multiple WAV audio chunks are not supported.');
                dataSize = length; // Skip its bytes by file offset.
            } else if (name === 'cue ') {
                if (cueRecords || length < 4 || length > 4 + 24 * 2048) throw new Error('Invalid or oversized WAV cue chunk.');
                const data = view(await read(body, length));
                const count = data.getUint32(0, true);
                if (length !== 4 + count * 24) throw new Error('WAV cue count does not match its chunk.');
                cueRecords = [];
                for (let i = 0; i < count; i++) {
                    const start = 4 + i * 24;
                    const target = ascii(new Uint8Array(data.buffer, data.byteOffset + start + 8, 4));
                    if (target !== 'data' || data.getUint32(start + 12, true) || data.getUint32(start + 16, true)) throw new Error('Unsupported WAV cue addressing.');
                    cueRecords.push({ id: data.getUint32(start, true), sampleOffset: data.getUint32(start + 20, true) });
                }
            } else if (name === 'acid' && length >= 24) {
                const data = view(await read(body, 24));
                const tempo = data.getFloat32(20, true);
                if (Number.isFinite(tempo) && tempo >= 1 && tempo <= 1000) bpm = tempo;
            }
            offset = next;
        }
        if (!format || ![1, 3, 0xFFFE].includes(format.code) || !format.sampleRate || !format.channels || !format.blockAlign || dataSize === null || dataSize % format.blockAlign) throw new Error('Unsupported WAV audio format.');
        const numFrames = dataSize / format.blockAlign;
        // Explicit null is used only by the local carrier-preparation reader.
        if (expected !== null && (format.sampleRate !== expected.sampleRate || numFrames !== expected.numFrames)) throw new Error('WAV sample rate or length does not match the current TP-7 track.');
        const ids = new Set();
        const cues = (cueRecords || []).map(cue => {
            if (ids.has(cue.id) || cue.sampleOffset > numFrames || (expected !== null && cue.sampleOffset === numFrames)) throw new Error('Duplicate or out-of-track WAV cue.');
            ids.add(cue.id);
            const positionMs = Number((2n * BigInt(cue.sampleOffset) * 1000n + BigInt(format.sampleRate)) / (2n * BigInt(format.sampleRate)));
            if (expected !== null && positionMs * format.sampleRate >= numFrames * 1000) throw new Error('WAV cue rounds to the file endpoint.');
            return { ...cue, positionMs };
        }).sort((a, b) => a.sampleOffset - b.sampleOffset || a.id - b.id);
        return { sampleRate: format.sampleRate, numFrames, bpm, cues, chunks, offsetsVerified: reader.offsetsVerified };
    }
    return { Client, readWave, parseList, assertReadRequest, MAX_BYTES, MAX_REQUESTS };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = TP7FileAccess;
