export const DEFAULT_TREE_SOURCE_URL = '../data/primate-mtDNA_long.trees';
export const DEFAULT_BATCH_SIZE = 1000;
export const DEFAULT_STREAM_REPRESENTATIVE_WARMUP_TREES = 8;
export const DEFAULT_STREAM_REPRESENTATIVE_BACKOFF_INTERVAL = 16;

export function createPerfTracker() {
    const start = performance.now();
    return {
        scanMs: 0,
        firstDrawMs: null,
        totalMs: 0,
        updateScan(end = performance.now()) {
            this.scanMs = end - start;
        },
        updateFirstDraw(time = performance.now()) {
            if (this.firstDrawMs == null) {
                this.firstDrawMs = time - start;
            }
        },
        updateTotal(end = performance.now()) {
            this.totalMs = end - start;
        },
    };
}

export function createTreeDataset() {
    return {
        sourceUrl: '',
        nodeBytes: new Uint8Array(),
        nodeCount: 0,
        allTreeRanges: [],
        parsedTrees: 0,
        totalTrees: 0,
    };
}

export function createDebugSnapshot(nodeBytes, nodeCount, metrics) {
    const previewView = new DataView(nodeBytes.buffer, nodeBytes.byteOffset, Math.min(nodeBytes.byteLength, 16 * 4));
    const preview = [];
    for (let i = 0; i < Math.min(nodeCount, 4); i += 1) {
        const offset = i * 16;
        preview.push({
            parent_idx: previewView.getUint32(offset, true),
            x: previewView.getFloat32(offset + 4, true),
            y: previewView.getFloat32(offset + 8, true),
        });
    }

    return {
        scanMs: metrics.scanMs,
        firstDrawMs: metrics.firstDrawMs,
        totalMs: metrics.totalMs,
        preview,
    };
}
