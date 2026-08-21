import { loadWasmModule } from './parser.js';
import { beginProgressiveLoad, loadTreeSource, readCurrentNodeBytesSlice, readOrderingNodeBytes } from './tree-data.js';

let currentJobToken = 0;

self.addEventListener('message', (event) => {
    const { type } = event.data ?? {};
    if (type === 'load') {
        void handleLoad(event.data);
    }
});

async function handleLoad({ token, sourceUrl, batchSize, topologyMode = 'full', sampleTreeCount = 0, burninPercent = 0 }) {
    currentJobToken = token;

    try {
        const instance = await loadWasmModule();
        if (currentJobToken !== token) return;

        const { inputPtr, inputBytes, sourceUrl: resolvedSourceUrl } = await loadTreeSource(instance, sourceUrl, ({ received, total }) => {
            if (currentJobToken !== token) return;
            self.postMessage({
                type: 'download-progress',
                token,
                received,
                total,
                sourceUrl,
            });
        });
        if (currentJobToken !== token) return;

        const totalTrees = await beginProgressiveLoad(instance, inputPtr, inputBytes.byteLength, {
            topologyMode,
            sampleTreeCount,
            burninPercent,
        });
        if (currentJobToken !== token) return;

        const orderingTopology = readOrderingNodeBytes(instance);

        const headerBytes = estimateHeaderBytes(inputBytes);
        const averageTreeBytes = totalTrees > 0
            ? Math.max(1, (inputBytes.byteLength - headerBytes) / totalTrees)
            : 0;
        const parseStart = performance.now();

        self.postMessage({
            type: 'scan-complete',
            token,
            sourceUrl: resolvedSourceUrl,
            totalTrees,
            fileSize: inputBytes.byteLength,
            headerBytes,
            averageTreeBytes,
            orderingNodeCount: orderingTopology.nodeCount,
            orderingNodeBytes: orderingTopology.nodeBytes.buffer,
        }, [orderingTopology.nodeBytes.buffer]);

        let previousNodeCount = 0;
        let previousByteLength = 0;

        while (currentJobToken === token) {
            const added = instance.exports.parseNextTrees?.(batchSize) ?? 0;
            if (added === 0) break;

            const snapshot = readCurrentNodeBytesSlice(instance, previousByteLength);
            const parsedTrees = instance.exports.getParsedTreeCount?.() ?? 0;
            const elapsedMs = performance.now() - parseStart;
            const estimatedProcessedBytes = Math.min(
                inputBytes.byteLength,
                Math.round(headerBytes + (averageTreeBytes * parsedTrees)),
            );
            const remainingMs = parsedTrees > 0 && totalTrees > parsedTrees
                ? (elapsedMs / parsedTrees) * (totalTrees - parsedTrees)
                : 0;

            self.postMessage({
                type: 'batch',
                token,
                sourceUrl: resolvedSourceUrl,
                totalTrees,
                parsedTrees,
                fileSize: inputBytes.byteLength,
                headerBytes,
                averageTreeBytes,
                estimatedProcessedBytes,
                remainingMs,
                added,
                previousNodeCount,
                previousByteLength,
                nodeCount: snapshot.nodeCount,
                nodeByteLength: snapshot.totalByteLength,
                appendedNodeBytes: snapshot.nodeBytes.buffer,
            }, [snapshot.nodeBytes.buffer]);

            previousNodeCount = snapshot.nodeCount;
            previousByteLength = snapshot.totalByteLength;
        }

        if (currentJobToken !== token) return;

        self.postMessage({
            type: 'complete',
            token,
            sourceUrl: resolvedSourceUrl,
            totalTrees,
            fileSize: inputBytes.byteLength,
            parsedTrees: instance.exports.getParsedTreeCount?.() ?? 0,
        });
    } catch (error) {
        if (currentJobToken !== token) return;

        self.postMessage({
            type: 'error',
            token,
            message: error instanceof Error ? error.message : String(error),
        });
    }
}

function estimateHeaderBytes(inputBytes) {
    const keyword = [116, 114, 101, 101, 32];
    for (let index = 0; index + keyword.length <= inputBytes.length; index += 1) {
        let matches = true;
        for (let offset = 0; offset < keyword.length; offset += 1) {
            if (toLowerAscii(inputBytes[index + offset]) !== keyword[offset]) {
                matches = false;
                break;
            }
        }
        if (matches) return index;
    }

    return 0;
}

function toLowerAscii(value) {
    return value >= 65 && value <= 90 ? value + 32 : value;
}
