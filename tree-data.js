export const DEFAULT_TREE_SOURCE_URL = '../data/primate-mtDNA_long.trees';

export async function loadText(url) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
    }

    return response.text();
}

export function getWasmMemory(instance) {
    const { memory } = instance.exports;

    if (!(memory instanceof WebAssembly.Memory)) {
        throw new Error('The WASM module does not export linear memory.');
    }

    return memory;
}

export function readWasmString(instance, ptr, len) {
    if (!ptr || !len) return '';
    const bytes = new Uint8Array(getWasmMemory(instance).buffer, ptr, len);
    return new TextDecoder().decode(bytes);
}

export function getLastWasmError(instance) {
    const ptr = instance.exports.getLastErrorPtr?.() ?? 0;
    const len = instance.exports.getLastErrorLen?.() ?? 0;
    return readWasmString(instance, ptr, len);
}

const textEncoder = new TextEncoder();

function joinChunks(chunks, totalLength) {
    const bytes = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

async function readResponseBytes(response, onProgress) {
    const total = Number.parseInt(response.headers.get('content-length') ?? '0', 10) || 0;
    if (!response.body) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        onProgress?.({ received: bytes.byteLength, total });
        return bytes;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
            chunks.push(value);
            received += value.byteLength;
            onProgress?.({ received, total });
        }
    }

    return joinChunks(chunks, received);
}

export function resolveTreeSourceUrl(inputUrl) {
    const url = inputUrl?.trim() || DEFAULT_TREE_SOURCE_URL;
    return new URL(url, globalThis.location.href).toString();
}

export async function loadTreeSource(instance, inputUrl = DEFAULT_TREE_SOURCE_URL, onProgress) {
    const sourceUrl = resolveTreeSourceUrl(inputUrl);
    const response = await fetch(sourceUrl);

    if (!response.ok) {
        throw new Error(`Failed to load ${sourceUrl}: ${response.status} ${response.statusText}`);
    }

    const inputBytes = await readResponseBytes(response, onProgress);
    const { inputPtr } = writeBytesToWasm(instance, inputBytes);

    return { inputPtr, inputBytes, sourceUrl };
}

export function writeBytesToWasm(instance, inputBytes) {
    const inputPtr = instance.exports.allocBytes?.(inputBytes.byteLength) ?? 0;

    if (!inputPtr) {
        throw new Error(getLastWasmError(instance) || 'Failed to allocate WASM input buffer.');
    }

    new Uint8Array(getWasmMemory(instance).buffer, inputPtr, inputBytes.byteLength).set(inputBytes);
    return { inputPtr, inputBytes };
}

export function writeTextToWasm(instance, text) {
    return writeBytesToWasm(instance, textEncoder.encode(text));
}

export function freeWasmBytes(instance, ptr, len) {
    instance.exports.freeBytes?.(ptr, len);
}

export function readCurrentNodeBytes(instance) {
    const outputPtr = instance.exports.getBufferPtr?.() ?? 0;
    const outputSize = instance.exports.getBufferSize?.() ?? 0;
    const nodeCount = instance.exports.getNodeCount?.() ?? 0;

    if (!outputPtr || !outputSize || !nodeCount) {
        return {
            nodeBytes: new Uint8Array(),
            nodeCount: 0,
        };
    }

    return {
        nodeBytes: new Uint8Array(getWasmMemory(instance).buffer, outputPtr, outputSize).slice(),
        nodeCount,
    };
}

export function readOrderingNodeBytes(instance) {
    const outputPtr = instance.exports.getOrderingBufferPtr?.() ?? 0;
    const outputSize = instance.exports.getOrderingBufferSize?.() ?? 0;
    const nodeCount = instance.exports.getOrderingNodeCount?.() ?? 0;

    if (!outputPtr || !outputSize || !nodeCount) {
        return {
            nodeBytes: new Uint8Array(),
            nodeCount: 0,
        };
    }

    return {
        nodeBytes: new Uint8Array(getWasmMemory(instance).buffer, outputPtr, outputSize).slice(),
        nodeCount,
    };
}

export function readStreamLayoutVersion(instance) {
    return instance.exports.getStreamLayoutVersion?.() ?? 0;
}

export function readStreamOrderingVersion(instance) {
    return instance.exports.getStreamOrderingVersion?.() ?? 0;
}

export function readCurrentNodeBytesSlice(instance, byteOffset = 0) {
    const outputPtr = instance.exports.getBufferPtr?.() ?? 0;
    const outputSize = instance.exports.getBufferSize?.() ?? 0;
    const nodeCount = instance.exports.getNodeCount?.() ?? 0;

    if (!outputPtr || !outputSize || !nodeCount || byteOffset >= outputSize) {
        return {
            nodeBytes: new Uint8Array(),
            nodeCount,
            totalByteLength: outputSize,
        };
    }

    return {
        nodeBytes: new Uint8Array(getWasmMemory(instance).buffer, outputPtr + byteOffset, outputSize - byteOffset).slice(),
        nodeCount,
        totalByteLength: outputSize,
    };
}

export async function beginProgressiveLoad(instance, inputPtr, inputLength, options = {}) {
    return beginProgressiveLoadWithOptions(instance, inputPtr, inputLength, options);
}

export async function beginProgressiveLoadWithOptions(instance, inputPtr, inputLength, { topologyMode = 'full', sampleTreeCount = 0, burninPercent = 0 } = {}) {
    const modeValue = topologyModeToValue(topologyMode);
    const started = instance.exports.beginProgressiveParseWithOptions
        ? instance.exports.beginProgressiveParseWithOptions(inputPtr, inputLength, modeValue, sampleTreeCount, burninPercent)
        : instance.exports.beginProgressiveParse?.(inputPtr, inputLength);

    if (!started) {
        throw new Error(getLastWasmError(instance) || 'The WASM parser failed to initialize progressive parsing.');
    }

    return instance.exports.getTotalTreeCount?.() ?? 0;
}

export function beginTreeStream(instance, options = {}) {
    const representativeWarmupTrees = options.representativeWarmupTrees ?? options.recomputeWarmupTrees ?? 8;
    const representativeBackoffInterval = options.representativeBackoffInterval ?? options.recomputeInterval ?? 16;
    const started = instance.exports.beginTreeStreamWithOptions
        ? instance.exports.beginTreeStreamWithOptions(representativeWarmupTrees, representativeBackoffInterval)
        : instance.exports.beginTreeStream?.();
    if (!started) {
        throw new Error(getLastWasmError(instance) || 'The WASM parser failed to initialize tree streaming.');
    }
}

export function appendTreeSourceToStream(instance, sourceText) {
    if (!sourceText) return 0;

    const { inputPtr, inputBytes } = writeTextToWasm(instance, sourceText);
    try {
        const added = instance.exports.appendStreamTrees?.(inputPtr, inputBytes.byteLength) ?? 0;
        const error = getLastWasmError(instance);
        if (error) {
            throw new Error(error);
        }
        return added;
    } finally {
        freeWasmBytes(instance, inputPtr, inputBytes.byteLength);
    }
}

function topologyModeToValue(mode) {
    switch (mode) {
        case 'fast': return 1;
        case 'sampled': return 2;
        default: return 0;
    }
}
