import {
    DEFAULT_STREAM_REPRESENTATIVE_BACKOFF_INTERVAL,
    DEFAULT_STREAM_REPRESENTATIVE_WARMUP_TREES,
    DEFAULT_TREE_SOURCE_URL,
    createTreeDataset,
} from './core-model.js';
import {
    appendTreeSourceToStream,
    beginTreeStream,
    beginProgressiveLoadWithOptions,
    getLastWasmError,
    loadTreeSource,
    readCurrentNodeBytes,
    readCurrentNodeBytesSlice,
    readOrderingNodeBytes,
    readStreamLayoutVersion,
    readStreamOrderingVersion,
    resolveTreeSourceUrl,
} from './tree-data.js';

export { DEFAULT_TREE_SOURCE_URL, resolveTreeSourceUrl, getLastWasmError };

export async function loadWasmModule() {
    const wasmUrl = new URL('./densitree.wasm', import.meta.url);
    const response = await fetch(wasmUrl);

    if (!response.ok) {
        throw new Error(`Failed to load WASM: ${response.status} ${response.statusText}`);
    }

    const imports = {};
    let result;
    if ('instantiateStreaming' in WebAssembly) {
        const streamingResponse = response.clone();
        try {
            result = await WebAssembly.instantiateStreaming(streamingResponse, imports);
        } catch {
            const bytes = await response.arrayBuffer();
            result = await WebAssembly.instantiate(bytes, imports);
        }
    } else {
        const bytes = await response.arrayBuffer();
        result = await WebAssembly.instantiate(bytes, imports);
    }

    return result.instance;
}

export class ProgressiveTreeParser {
    constructor(instance) {
        this.instance = instance;
        this.dataset = createTreeDataset();
        this.streamLayoutVersion = 0;
        this.streamOrderingVersion = 0;
    }

    async initializeFromUrl(sourceUrl = DEFAULT_TREE_SOURCE_URL, onStreamProgress, options = {}) {
        const { inputPtr, inputBytes, sourceUrl: resolvedSourceUrl } = await loadTreeSource(this.instance, sourceUrl, onStreamProgress);
        const totalTrees = await beginProgressiveLoadWithOptions(this.instance, inputPtr, inputBytes.byteLength, options);
        this.dataset = {
            ...createTreeDataset(),
            sourceUrl: resolvedSourceUrl,
            totalTrees,
            nodeByteLength: 0,
        };
        return {
            sourceUrl: resolvedSourceUrl,
            totalTrees,
            byteLength: inputBytes.byteLength,
            orderingTopology: readOrderingNodeBytes(this.instance),
        };
    }

    initializeStream({
        sourceUrl = 'stream://memory',
        totalTrees = 0,
        representativeWarmupTrees = DEFAULT_STREAM_REPRESENTATIVE_WARMUP_TREES,
        representativeBackoffInterval = DEFAULT_STREAM_REPRESENTATIVE_BACKOFF_INTERVAL,
    } = {}) {
        beginTreeStream(this.instance, {
            representativeWarmupTrees,
            representativeBackoffInterval,
        });
        this.streamLayoutVersion = readStreamLayoutVersion(this.instance);
        this.streamOrderingVersion = readStreamOrderingVersion(this.instance);
        this.dataset = {
            ...createTreeDataset(),
            sourceUrl,
            totalTrees,
            nodeByteLength: 0,
        };
        return this.dataset;
    }

    parseNextBatch(batchSize) {
        const previousNodeCount = this.dataset.nodeCount;
        const previousByteLength = this.dataset.nodeByteLength ?? 0;
        const added = this.instance.exports.parseNextTrees?.(batchSize) ?? 0;
        if (added === 0) {
            return {
                added: 0,
                dataset: this.dataset,
                appendedNodeBytes: new Uint8Array(),
                previousNodeCount,
                previousByteLength,
            };
        }

        const snapshot = readCurrentNodeBytesSlice(this.instance, previousByteLength);
        this.dataset = {
            ...this.dataset,
            nodeCount: snapshot.nodeCount,
            nodeByteLength: snapshot.totalByteLength,
            parsedTrees: this.instance.exports.getParsedTreeCount?.() ?? this.dataset.parsedTrees,
        };

        return {
            added,
            dataset: this.dataset,
            appendedNodeBytes: snapshot.nodeBytes,
            previousNodeCount,
            previousByteLength,
        };
    }

    appendStreamSource(sourceText, { totalTrees } = {}) {
        const previousNodeCount = this.dataset.nodeCount;
        const previousByteLength = this.dataset.nodeByteLength ?? 0;
        const previousLayoutVersion = this.streamLayoutVersion;
        const previousOrderingVersion = this.streamOrderingVersion;
        const added = appendTreeSourceToStream(this.instance, sourceText);
        if (added === 0) {
            return {
                added: 0,
                dataset: this.dataset,
                appendedNodeBytes: new Uint8Array(),
                previousNodeCount,
                previousByteLength,
            };
        }

        this.streamLayoutVersion = readStreamLayoutVersion(this.instance);
        this.streamOrderingVersion = readStreamOrderingVersion(this.instance);
        const fullRefresh = this.streamLayoutVersion !== previousLayoutVersion;
        const orderingRefresh = fullRefresh || this.streamOrderingVersion !== previousOrderingVersion;
        const snapshot = fullRefresh
            ? (() => {
                const fullSnapshot = readCurrentNodeBytes(this.instance);
                return {
                    nodeBytes: fullSnapshot.nodeBytes,
                    nodeCount: fullSnapshot.nodeCount,
                    totalByteLength: fullSnapshot.nodeBytes.byteLength,
                };
            })()
            : readCurrentNodeBytesSlice(this.instance, previousByteLength);
        const parsedTrees = this.instance.exports.getStreamParsedTreeCount?.() ?? (this.dataset.parsedTrees + added);
        const nextTotalTrees = Number.isFinite(totalTrees)
            ? Math.max(totalTrees, parsedTrees)
            : Math.max(this.dataset.totalTrees, parsedTrees);

        this.dataset = {
            ...this.dataset,
            nodeCount: snapshot.nodeCount,
            nodeByteLength: snapshot.totalByteLength,
            parsedTrees,
            totalTrees: nextTotalTrees,
        };

        return {
            added,
            dataset: this.dataset,
            appendedNodeBytes: snapshot.nodeBytes,
            previousNodeCount,
            previousByteLength,
            fullRefresh,
            orderingRefresh,
            orderingTopology: orderingRefresh ? readOrderingNodeBytes(this.instance) : null,
        };
    }

    readFullDatasetSnapshot() {
        const snapshot = readCurrentNodeBytes(this.instance);
        this.dataset = {
            ...this.dataset,
            nodeCount: snapshot.nodeCount,
            nodeByteLength: snapshot.nodeBytes.byteLength,
        };

        return {
            dataset: this.dataset,
            nodeBytes: snapshot.nodeBytes,
            nodeCount: snapshot.nodeCount,
        };
    }

    readOrderingTopologySnapshot() {
        return readOrderingNodeBytes(this.instance);
    }
}
