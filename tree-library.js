import {
    DEFAULT_BATCH_SIZE,
    DEFAULT_STREAM_REPRESENTATIVE_BACKOFF_INTERVAL,
    DEFAULT_STREAM_REPRESENTATIVE_WARMUP_TREES,
    DEFAULT_TREE_SOURCE_URL,
    createDebugSnapshot,
    createPerfTracker,
} from './core-model.js';
import {
    computeTreeDepths,
    getGlobalMaxDepth,
    normalizeTreeXPositions,
    normalizeTreeXPositionsSegment,
    parseTreeRanges,
    parseAppendedTreeRanges,
} from './layout.js';
import { ProgressiveTreeParser, loadWasmModule, resolveTreeSourceUrl } from './parser.js';
import { appendOverlayNodes, createOverlayResources, initWebGPU, renderFrame, updateOverlayNodes, updateRenderParams } from './renderer.js';
import { createTreeViewerState, updateControlOutputs } from './state.js';
import { bindViewInteractions } from './tree-view.js';

export { DEFAULT_BATCH_SIZE, DEFAULT_TREE_SOURCE_URL, resolveTreeSourceUrl, updateControlOutputs };

export class TreeViewerController {
    constructor(options) {
        this.canvas = options.canvas;
        this.resetViewButton = options.resetViewButton;
        this.rehomeViewButton = options.rehomeViewButton;
        this.onStatus = options.onStatus;
        this.onDebug = options.onDebug;
        this.onLoadProgress = options.onLoadProgress;
        this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
        this.context = null;
        this.device = null;
        this.format = null;
        this.overlay = null;
        this.orderingOverlay = null;
        this.parser = null;
        this.state = createTreeViewerState(this.onStatus);
        this.rawNodeBytes = new Uint8Array();
        this.currentNodeBytes = new Uint8Array();
        this.rawOrderingNodeBytes = new Uint8Array();
        this.currentOrderingNodeBytes = new Uint8Array();
        this.orderingRanges = [];
        this.orderingNodeCount = 0;
        this.treeDepths = [];
        this.globalMaxDepth = 0;
        this.currentNodeCount = 0;
        this.currentLoadToken = 0;
        this.worker = null;
        this.renderQueued = false;
        this.viewInitialized = false;
    }

    async initialize() {
        const { context, device, format } = await initWebGPU(this.canvas);
        this.context = context;
        this.device = device;
        this.format = format;
        this.overlay = await createOverlayResources(device, format);
        this.orderingOverlay = await createOverlayResources(device, format, { wideLines: true });
        const wasmInstance = await loadWasmModule();
        this.parser = new ProgressiveTreeParser(wasmInstance);

        bindViewInteractions({
            canvas: this.canvas,
            state: this.state,
            resetViewButton: this.resetViewButton,
            rehomeViewButton: this.rehomeViewButton,
            getNodeBytes: () => this.currentNodeBytes,
            onViewChanged: () => this.updateView(),
        });

        this.updateView();
        return this;
    }

    updateView() {
        updateRenderParams(this.device, this.overlay, this.state, {
            viewportWidth: this.canvas.width,
            viewportHeight: this.canvas.height,
        });
        updateRenderParams(this.device, this.orderingOverlay, this.state, {
            color: this.state.orderingTopologyColour,
            alpha: this.state.orderingTopologyAlpha,
            thickness: this.state.orderingTopologyThickness,
            viewportWidth: this.canvas.width,
            viewportHeight: this.canvas.height,
        });
        this.requestRender();
    }

    buildRenderLayers() {
        const layers = [{
            overlay: this.overlay,
            ranges: this.state.renderRanges,
            beforeDraw: () => {
                updateRenderParams(this.device, this.overlay, this.state, {
                    viewportWidth: this.canvas.width,
                    viewportHeight: this.canvas.height,
                });
            },
        }];

        if (this.state.showOrderingTopology && this.orderingRanges.length > 0) {
            layers.push({
                overlay: this.orderingOverlay,
                ranges: this.orderingRanges,
                beforeDraw: () => {
                    updateRenderParams(this.device, this.orderingOverlay, this.state, {
                        color: this.state.orderingTopologyColour,
                        alpha: this.state.orderingTopologyAlpha,
                        thickness: this.state.orderingTopologyThickness,
                        viewportWidth: this.canvas.width,
                        viewportHeight: this.canvas.height,
                    });
                },
            });
        }

        return layers;
    }

    requestRender() {
        if (this.renderQueued) return;
        this.renderQueued = true;

        requestAnimationFrame(() => {
            this.renderQueued = false;
            renderFrame(this.context, this.device, this.buildRenderLayers(), {
                backgroundColor: this.state.backgroundColour,
            });
        });
    }

    resetDataset({ sourceUrl = '', totalTrees = 0 } = {}) {
        this.state.sourceUrl = sourceUrl;
        this.state.totalTrees = totalTrees;
        this.state.parsedTrees = 0;
        this.state.allTreeRanges = [];
        this.state.recompute();
        this.rawNodeBytes = new Uint8Array();
        this.currentNodeBytes = new Uint8Array();
        this.rawOrderingNodeBytes = new Uint8Array();
        this.currentOrderingNodeBytes = new Uint8Array();
        this.orderingRanges = [];
        this.orderingNodeCount = 0;
        this.treeDepths = [];
        this.globalMaxDepth = 0;
        this.currentNodeCount = 0;
        this.viewInitialized = false;
        updateOverlayNodes(this.device, this.overlay, this.currentNodeBytes);
        updateOverlayNodes(this.device, this.orderingOverlay, this.currentOrderingNodeBytes);
        this.updateView();
    }

    updateOrderingTopology() {
        if (this.rawOrderingNodeBytes.byteLength === 0 || this.orderingNodeCount === 0) {
            this.currentOrderingNodeBytes = new Uint8Array();
            this.orderingRanges = [];
            updateOverlayNodes(this.device, this.orderingOverlay, this.currentOrderingNodeBytes);
            return;
        }

        const orderingRanges = parseTreeRanges(this.rawOrderingNodeBytes, this.orderingNodeCount);
        const orderingDepths = computeTreeDepths(this.rawOrderingNodeBytes, orderingRanges);
        const normalizationDepth = this.globalMaxDepth > 0
            ? this.globalMaxDepth
            : getGlobalMaxDepth(orderingDepths);

        this.orderingRanges = orderingRanges;
        this.currentOrderingNodeBytes = normalizeTreeXPositions(
            this.rawOrderingNodeBytes,
            orderingRanges,
            orderingDepths,
            normalizationDepth,
        );
        updateOverlayNodes(this.device, this.orderingOverlay, this.currentOrderingNodeBytes);
    }

    setOrderingTopologyNodeBytes(orderingTopology) {
        this.rawOrderingNodeBytes = orderingTopology?.nodeBytes instanceof Uint8Array
            ? orderingTopology.nodeBytes
            : new Uint8Array();
        this.orderingNodeCount = orderingTopology?.nodeCount ?? 0;
        this.updateOrderingTopology();
    }

    ensureWorker() {
        if (this.worker) return this.worker;
        this.worker = new Worker(new URL('./tree-worker.js', import.meta.url), { type: 'module' });
        return this.worker;
    }

    terminateWorker() {
        this.worker?.terminate();
        this.worker = null;
    }

    applyDatasetUpdate(dataset, appendedNodeBytes, previousNodeCount, previousByteLength, addedTreeCount) {
        const previousRanges = this.state.allTreeRanges;
        const safeAppendedNodeBytes = appendedNodeBytes instanceof Uint8Array ? appendedNodeBytes : new Uint8Array();
        const nextRawNodeBytes = this.rawNodeBytes.length === 0
            ? safeAppendedNodeBytes
            : appendUint8Arrays(this.rawNodeBytes, safeAppendedNodeBytes);
        const appendedRanges = parseAppendedTreeRanges(nextRawNodeBytes, previousNodeCount, dataset.nodeCount);

        if (addedTreeCount > 0 && appendedRanges.length !== addedTreeCount) {
            this.reconcileFullDataset(dataset);
            return this.finishDatasetUpdate(dataset);
        }

        this.rawNodeBytes = nextRawNodeBytes;

        const allTreeRanges = previousRanges.concat(appendedRanges);
        const appendedDepths = computeTreeDepths(this.rawNodeBytes, appendedRanges);
        const nextTreeDepths = this.treeDepths.concat(appendedDepths);
        const nextGlobalMaxDepth = Math.max(this.globalMaxDepth, getGlobalMaxDepth(appendedDepths));
        const needsFullRenormalize = previousByteLength === 0 || nextGlobalMaxDepth > this.globalMaxDepth;

        dataset.allTreeRanges = allTreeRanges;
        this.treeDepths = nextTreeDepths;
        this.globalMaxDepth = nextGlobalMaxDepth;
        this.currentNodeCount = dataset.nodeCount;

        if (needsFullRenormalize) {
            this.currentNodeBytes = normalizeTreeXPositions(this.rawNodeBytes, allTreeRanges, this.treeDepths, this.globalMaxDepth);
            updateOverlayNodes(this.device, this.overlay, this.currentNodeBytes);
        } else {
            const appendedDisplayBytes = normalizeTreeXPositionsSegment(this.rawNodeBytes, appendedRanges, appendedDepths, this.globalMaxDepth);
            this.currentNodeBytes = this.currentNodeBytes.length === 0
                ? appendedDisplayBytes
                : appendUint8Arrays(this.currentNodeBytes, appendedDisplayBytes);
            appendOverlayNodes(this.device, this.overlay, appendedDisplayBytes, previousByteLength);
        }

        if (needsFullRenormalize || this.currentOrderingNodeBytes.byteLength > 0) {
            this.updateOrderingTopology();
        }

        return this.finishDatasetUpdate(dataset);
    }

    finishDatasetUpdate(dataset) {
        this.state.setDataset(dataset);

        if (!this.viewInitialized && this.state.drawRanges.length > 0) {
            this.state.resetView();
            this.state.rehome(this.currentNodeBytes);
            this.viewInitialized = true;
            return true;
        }

        this.updateView();
        return false;
    }

    reconcileFullDataset(dataset = this.parser.dataset, snapshotOverride = null) {
        const snapshot = snapshotOverride
            ?? (this.rawNodeBytes.byteLength > 0
                ? {
                    dataset,
                    nodeBytes: this.rawNodeBytes,
                    nodeCount: this.currentNodeCount,
                }
                : this.parser.readFullDatasetSnapshot());
        const allTreeRanges = parseTreeRanges(snapshot.nodeBytes, snapshot.nodeCount);
        const treeDepths = computeTreeDepths(snapshot.nodeBytes, allTreeRanges);
        const globalMaxDepth = getGlobalMaxDepth(treeDepths);

        this.rawNodeBytes = snapshot.nodeBytes;
        this.treeDepths = treeDepths;
        this.globalMaxDepth = globalMaxDepth;
        this.currentNodeCount = snapshot.nodeCount;
        this.currentNodeBytes = normalizeTreeXPositions(snapshot.nodeBytes, allTreeRanges, treeDepths, globalMaxDepth);
        updateOverlayNodes(this.device, this.overlay, this.currentNodeBytes);
        this.updateOrderingTopology();

        dataset.allTreeRanges = allTreeRanges;
        dataset.nodeCount = snapshot.nodeCount;
        dataset.nodeByteLength = snapshot.nodeBytes.byteLength;
    }

    setBurnin(percent) {
        this.state.burninPercent = percent;
        this.state.recompute();
        this.updateView();
    }

    setVisibleTreeCount(count) {
        this.state.treeLimit = count;
        this.state.recompute();
        this.updateView();
    }

    setVisibleTreeMode(mode) {
        this.state.visibleTreeMode = mode === 'first' || mode === 'last' ? mode : 'even';
        this.state.recompute();
        this.updateView();
    }

    setColor(color) {
        this.state.colour = color;
        this.updateView();
    }

    setBackgroundColor(color) {
        this.state.backgroundColour = color;
        this.updateView();
    }

    setAlpha(alpha) {
        this.state.alpha = alpha;
        this.updateView();
    }

    setShowOrderingTopology(show) {
        this.state.showOrderingTopology = Boolean(show);
        this.updateView();
    }

    setOrderingTopologyColor(color) {
        this.state.orderingTopologyColour = color;
        this.updateView();
    }

    setOrderingTopologyAlpha(alpha) {
        this.state.orderingTopologyAlpha = alpha;
        this.updateView();
    }

    setOrderingTopologyThickness(thickness) {
        this.state.orderingTopologyThickness = Math.max(1, thickness);
        this.updateView();
    }

    resetView() {
        this.state.resetView();
        this.updateView();
    }

    rehome() {
        this.state.rehome(this.currentNodeBytes);
        this.updateView();
    }

    async load({
        sourceUrl = DEFAULT_TREE_SOURCE_URL,
        onStreamProgress,
        onMetrics,
        topologyMode = 'full',
        topologySampleTrees = 1000,
        burninPercent = 0,
    } = {}) {

        if (topologyMode === 'background-refine' && typeof Worker !== 'undefined') {
            await this.loadWithWorkerPass({
                sourceUrl,
                onStreamProgress,
                topologyMode: 'fast',
                topologySampleTrees,
                burninPercent,
                progressStage: 'parse',
                preserveUntilFirstBatch: false,
            });

            if (this.currentLoadToken === 0) return;

            const refineMode = topologySampleTrees > 0 ? 'sampled' : 'full';
            this.onStatus?.('Refining tree ordering in background…');
            this.onLoadProgress?.({
                stage: 'refine',
                progress: 0,
                parsedTrees: 0,
                totalTrees: this.state.totalTrees,
                sourceUrl: resolveTreeSourceUrl(sourceUrl),
            });

            return this.loadWithWorkerPass({
                sourceUrl,
                onStreamProgress: null,
                onMetrics,
                topologyMode: refineMode,
                topologySampleTrees,
                burninPercent,
                progressStage: 'refine',
                preserveUntilFirstBatch: true,
            });
        }

        if (typeof Worker !== 'undefined') {
            return this.loadWithWorkerPass({
                sourceUrl,
                onStreamProgress,
                onMetrics,
                topologyMode,
                topologySampleTrees,
                burninPercent,
                progressStage: 'parse',
                preserveUntilFirstBatch: false,
            });
        }

        const loadToken = Date.now();
        this.currentLoadToken = loadToken;
        const metrics = createPerfTracker();
        const normalizedUrl = resolveTreeSourceUrl(sourceUrl);

        this.onStatus?.(`Streaming tree source from ${normalizedUrl}…`);
        const { sourceUrl: resolvedSourceUrl, totalTrees, orderingTopology } = await this.parser.initializeFromUrl(normalizedUrl, onStreamProgress, {
            topologyMode,
            sampleTreeCount: topologySampleTrees,
            burninPercent,
        });
        if (this.currentLoadToken !== loadToken) return;

        metrics.updateScan();
        this.resetDataset({
            sourceUrl: resolvedSourceUrl,
            totalTrees,
        });
        this.setOrderingTopologyNodeBytes(orderingTopology);

        while (this.currentLoadToken === loadToken) {
            const { added, dataset, appendedNodeBytes, previousNodeCount, previousByteLength } = this.parser.parseNextBatch(this.batchSize);
            if (added === 0) break;

            const initializedView = this.applyDatasetUpdate(dataset, appendedNodeBytes, previousNodeCount, previousByteLength, added);
            if (initializedView) {
                metrics.updateFirstDraw();
            }

            this.onDebug?.(formatDebugSnapshot(createDebugSnapshot(this.currentNodeBytes, this.currentNodeCount, metrics)));
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }

        metrics.updateTotal();
        if (this.currentLoadToken === loadToken) {
            this.reconcileFullDataset();
            this.finishDatasetUpdate(this.parser.dataset);
        }
        this.onDebug?.(formatDebugSnapshot(createDebugSnapshot(this.currentNodeBytes, this.currentNodeCount, metrics)));
        onMetrics?.(metrics);
        if (this.currentLoadToken === loadToken) {
            this.onStatus?.(`Parsed ${this.state.parsedTrees}/${this.state.totalTrees} trees from ${resolvedSourceUrl}.`);
        }
    }

    async loadWithWorkerPass({
        sourceUrl = DEFAULT_TREE_SOURCE_URL,
        onStreamProgress,
        onMetrics,
        topologyMode = 'full',
        topologySampleTrees = 1000,
        burninPercent = 0,
        progressStage = 'parse',
        preserveUntilFirstBatch = false,
    } = {}) {
        const loadToken = Date.now();
        this.currentLoadToken = loadToken;
        this.terminateWorker();

        const worker = this.ensureWorker();
        const metrics = createPerfTracker();
        const normalizedUrl = resolveTreeSourceUrl(sourceUrl);

        this.onStatus?.(`Streaming tree source from ${normalizedUrl}…`);
        this.onLoadProgress?.({
            stage: 'download',
            progress: 0,
            sourceUrl: normalizedUrl,
        });

        await new Promise((resolve, reject) => {
            const handleMessage = (event) => {
                const message = event.data ?? {};
                if (message.token !== loadToken) return;

                switch (message.type) {
                    case 'download-progress': {
                        onStreamProgress?.({ received: message.received, total: message.total });
                        this.onLoadProgress?.({
                            stage: 'download',
                            progress: message.total > 0 ? message.received / message.total : 0,
                            received: message.received,
                            total: message.total,
                            sourceUrl: message.sourceUrl,
                        });
                        break;
                    }
                    case 'scan-complete': {
                        metrics.updateScan();
                        if (!preserveUntilFirstBatch) {
                            this.resetDataset({
                                sourceUrl: message.sourceUrl,
                                totalTrees: message.totalTrees,
                            });
                        }
                        this.setOrderingTopologyNodeBytes({
                            nodeCount: message.orderingNodeCount ?? 0,
                            nodeBytes: new Uint8Array(message.orderingNodeBytes ?? 0),
                        });
                        this.onLoadProgress?.({
                            stage: progressStage,
                            progress: message.fileSize > 0 ? message.headerBytes / message.fileSize : 0,
                            parsedTrees: 0,
                            totalTrees: message.totalTrees,
                            estimatedProcessedBytes: message.headerBytes,
                            fileSize: message.fileSize,
                            remainingMs: null,
                            sourceUrl: message.sourceUrl,
                        });
                        break;
                    }
                    case 'batch': {
                        const dataset = {
                            sourceUrl: message.sourceUrl,
                            totalTrees: message.totalTrees,
                            parsedTrees: message.parsedTrees,
                            nodeCount: message.nodeCount,
                            nodeByteLength: message.nodeByteLength,
                        };
                        if (preserveUntilFirstBatch && message.parsedTrees === message.added) {
                            this.resetDataset({
                                sourceUrl: message.sourceUrl,
                                totalTrees: message.totalTrees,
                            });
                        }
                        const appendedNodeBytes = new Uint8Array(message.appendedNodeBytes ?? 0);
                        const initializedView = this.applyDatasetUpdate(
                            dataset,
                            appendedNodeBytes,
                            message.previousNodeCount,
                            message.previousByteLength,
                            message.added,
                        );
                        if (initializedView) {
                            metrics.updateFirstDraw();
                        }

                        this.onDebug?.(formatDebugSnapshot(createDebugSnapshot(this.currentNodeBytes, this.currentNodeCount, metrics)));
                        this.onLoadProgress?.({
                            stage: progressStage,
                            progress: message.fileSize > 0 ? message.estimatedProcessedBytes / message.fileSize : 0,
                            parsedTrees: message.parsedTrees,
                            totalTrees: message.totalTrees,
                            estimatedProcessedBytes: message.estimatedProcessedBytes,
                            fileSize: message.fileSize,
                            remainingMs: message.remainingMs,
                            sourceUrl: message.sourceUrl,
                        });
                        break;
                    }
                    case 'complete': {
                        metrics.updateTotal();
                        this.reconcileFullDataset({
                            sourceUrl: message.sourceUrl,
                            totalTrees: message.totalTrees,
                            parsedTrees: message.parsedTrees,
                            nodeCount: this.currentNodeCount,
                            nodeByteLength: this.rawNodeBytes.byteLength,
                        });
                        this.finishDatasetUpdate({
                            sourceUrl: message.sourceUrl,
                            totalTrees: message.totalTrees,
                            parsedTrees: message.parsedTrees,
                            allTreeRanges: this.state.allTreeRanges,
                            nodeCount: this.currentNodeCount,
                            nodeByteLength: this.rawNodeBytes.byteLength,
                        });
                        this.onDebug?.(formatDebugSnapshot(createDebugSnapshot(this.currentNodeBytes, this.currentNodeCount, metrics)));
                        this.onLoadProgress?.({
                            stage: 'complete',
                            progress: 1,
                            parsedTrees: message.parsedTrees,
                            totalTrees: message.totalTrees,
                            estimatedProcessedBytes: message.fileSize,
                            fileSize: message.fileSize,
                            remainingMs: 0,
                            sourceUrl: message.sourceUrl,
                        });
                        onMetrics?.(metrics);
                        this.onStatus?.(`Parsed ${this.state.parsedTrees}/${this.state.totalTrees} trees from ${message.sourceUrl}.`);
                        worker.removeEventListener('message', handleMessage);
                        resolve();
                        break;
                    }
                    case 'error': {
                        worker.removeEventListener('message', handleMessage);
                        reject(new Error(message.message || 'Worker parsing failed.'));
                        break;
                    }
                    default:
                        break;
                }
            };

            worker.addEventListener('message', handleMessage);
            worker.postMessage({
                type: 'load',
                token: loadToken,
                sourceUrl: normalizedUrl,
                batchSize: this.batchSize,
                topologyMode,
                sampleTreeCount: topologySampleTrees,
                burninPercent,
            });
        });
    }

    beginStream({
        sourceUrl = 'stream://memory',
        totalTrees = 0,
        representativeWarmupTrees = DEFAULT_STREAM_REPRESENTATIVE_WARMUP_TREES,
        representativeBackoffInterval = DEFAULT_STREAM_REPRESENTATIVE_BACKOFF_INTERVAL,
    } = {}) {
        this.currentLoadToken = Date.now();
        this.parser.initializeStream({
            sourceUrl,
            totalTrees,
            representativeWarmupTrees,
            representativeBackoffInterval,
        });
        this.resetDataset({ sourceUrl, totalTrees });
        this.onStatus?.(`Ready to stream trees into ${sourceUrl}. Representative refresh: warmup ${representativeWarmupTrees}, backoff ${representativeBackoffInterval}.`);
    }

    appendTrees(trees, { totalTrees } = {}) {
        const sourceText = normalizeTreeStreamInput(trees);
        if (!sourceText) {
            return {
                added: 0,
                state: this.getState(),
            };
        }

        const {
            added,
            dataset,
            appendedNodeBytes,
            previousNodeCount,
            previousByteLength,
            fullRefresh,
            orderingRefresh,
            orderingTopology,
        } = this.parser.appendStreamSource(sourceText, { totalTrees });
        if (added === 0) {
            return {
                added: 0,
                state: this.getState(),
            };
        }

        if (fullRefresh) {
            this.reconcileFullDataset(dataset, {
                dataset,
                nodeBytes: appendedNodeBytes,
                nodeCount: dataset.nodeCount,
            });
            if (orderingTopology) {
                this.setOrderingTopologyNodeBytes(orderingTopology);
            }
            this.finishDatasetUpdate(dataset);
        } else {
            this.applyDatasetUpdate(dataset, appendedNodeBytes, previousNodeCount, previousByteLength, added);
            if (orderingRefresh && orderingTopology) {
                this.setOrderingTopologyNodeBytes(orderingTopology);
                this.updateView();
            }
        }

        this.onStatus?.(`Streamed ${this.state.parsedTrees}/${this.state.totalTrees || this.state.parsedTrees} trees.`);
        return {
            added,
            state: this.getState(),
        };
    }

    appendTree(tree, options) {
        return this.appendTrees(tree, options);
    }

    getState() {
        return {
            ...this.state,
            currentNodeCount: this.currentNodeCount,
        };
    }
}

function formatDebugSnapshot(snapshot) {
    return [
        `scan_ms: ${snapshot.scanMs.toFixed(1)}`,
        `first_draw_ms: ${snapshot.firstDrawMs == null ? 'pending' : snapshot.firstDrawMs.toFixed(1)}`,
        `total_load_ms: ${snapshot.totalMs === 0 ? 'loading' : snapshot.totalMs.toFixed(1)}`,
        `node_preview: ${JSON.stringify(snapshot.preview, null, 2)}`,
    ].join('\n');
}

export async function createTreeViewer(options) {
    const viewer = new TreeViewerController(options);
    return viewer.initialize();
}

function normalizeTreeStreamInput(trees) {
    if (typeof trees === 'string') {
        return trees;
    }

    if (Array.isArray(trees)) {
        return trees.map(normalizeStreamChunkEntry).join('\n');
    }

    if (trees && typeof trees[Symbol.iterator] === 'function') {
        return Array.from(trees, (tree) => normalizeStreamChunkEntry(String(tree))).join('\n');
    }

    return '';
}

function normalizeStreamChunkEntry(tree) {
    const trimmed = tree.trimEnd();
    if (!trimmed || trimmed.endsWith(';')) {
        return tree;
    }

    return `${trimmed};`;
}

function appendUint8Arrays(left, right) {
    if (left.byteLength === 0) return right.slice();
    if (right.byteLength === 0) return left.slice();

    const combined = new Uint8Array(left.byteLength + right.byteLength);
    combined.set(left, 0);
    combined.set(right, left.byteLength);
    return combined;
}
