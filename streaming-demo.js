import {
    DEFAULT_STREAM_REPRESENTATIVE_BACKOFF_INTERVAL,
    DEFAULT_STREAM_REPRESENTATIVE_WARMUP_TREES,
    DEFAULT_TREE_SOURCE_URL,
} from './core-model.js';
import { createTreeViewer, resolveTreeSourceUrl } from './tree-library.js';

const canvas = document.getElementById('canvas');
const statusElement = document.getElementById('status');
const streamMetaElement = document.getElementById('stream-meta');
const treeSourceUrlInput = document.getElementById('tree-source-url');
const prepareSourceButton = document.getElementById('prepare-source');
const treesPerTickInput = document.getElementById('trees-per-tick');
const treesPerTickValue = document.getElementById('trees-per-tick-value');
const tickIntervalInput = document.getElementById('tick-interval');
const tickIntervalValue = document.getElementById('tick-interval-value');
const streamWarmupInput = document.getElementById('stream-warmup');
const streamWarmupValue = document.getElementById('stream-warmup-value');
const streamIntervalInput = document.getElementById('stream-interval');
const streamIntervalValue = document.getElementById('stream-interval-value');
const burninInput = document.getElementById('burnin');
const burninValue = document.getElementById('burnin-value');
const treeLimitInput = document.getElementById('tree-limit');
const treeLimitValue = document.getElementById('tree-limit-value');
const visibleTreeModeInput = document.getElementById('visible-tree-mode');
const showOrderingTopologyInput = document.getElementById('show-ordering-topology');
const startStreamButton = document.getElementById('start-stream');
const pauseStreamButton = document.getElementById('pause-stream');
const stepStreamButton = document.getElementById('step-stream');
const resetStreamButton = document.getElementById('reset-stream');
const resetViewButton = document.getElementById('reset-view');
const rehomeViewButton = document.getElementById('rehome-view');

if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('Missing streaming demo canvas.');
}

const streamState = {
    preparedSourceUrl: '',
    headerText: '',
    treeEntries: [],
    nextTreeIndex: 0,
    timerId: null,
    running: false,
};

let viewer;

function setStatus(text) {
    if (statusElement) {
        statusElement.textContent = text;
    }
}

function setMeta(text) {
    if (streamMetaElement) {
        streamMetaElement.textContent = text;
    }
}

function updateControlOutputs() {
    if (treesPerTickInput && treesPerTickValue) treesPerTickValue.textContent = treesPerTickInput.value;
    if (tickIntervalInput && tickIntervalValue) tickIntervalValue.textContent = `${tickIntervalInput.value} ms`;
    if (streamWarmupInput && streamWarmupValue) streamWarmupValue.textContent = streamWarmupInput.value;
    if (streamIntervalInput && streamIntervalValue) streamIntervalValue.textContent = streamIntervalInput.value;
    if (burninInput && burninValue) burninValue.textContent = `${burninInput.value}%`;
    if (treeLimitInput && treeLimitValue) treeLimitValue.textContent = treeLimitInput.value;
}

function updateViewerControls() {
    viewer.setBurnin(Number.parseInt(burninInput?.value ?? '10', 10));
    viewer.setVisibleTreeCount(Number.parseInt(treeLimitInput?.value ?? '1000', 10));
    viewer.setVisibleTreeMode(visibleTreeModeInput?.value ?? 'even');
    viewer.setShowOrderingTopology(showOrderingTopologyInput instanceof HTMLInputElement ? showOrderingTopologyInput.checked : false);
}

function stopTimer() {
    if (streamState.timerId != null) {
        clearTimeout(streamState.timerId);
        streamState.timerId = null;
    }
    streamState.running = false;
}

function scheduleNextStreamStep(delayMs) {
    if (!streamState.running) return;

    streamState.timerId = setTimeout(() => {
        streamState.timerId = null;
        if (!streamState.running) return;

        const keepRunning = streamStep();
        if (!keepRunning) {
            streamState.running = false;
            return;
        }

        const intervalMs = Number.parseInt(tickIntervalInput?.value ?? '250', 10);
        scheduleNextStreamStep(intervalMs);
    }, Math.max(0, delayMs));
}

function updateProgressText() {
    const loaded = streamState.nextTreeIndex;
    const total = streamState.treeEntries.length;
    const percent = total > 0 ? Math.round((loaded / total) * 100) : 0;
    setMeta(`Prepared ${total} trees. Streamed ${loaded}/${total} (${percent}%). Visible mode ${visibleTreeModeInput?.value ?? 'even'}. Representative warmup ${streamWarmupInput?.value ?? DEFAULT_STREAM_REPRESENTATIVE_WARMUP_TREES}, backoff ${streamIntervalInput?.value ?? DEFAULT_STREAM_REPRESENTATIVE_BACKOFF_INTERVAL}.`);
}

async function prepareStreamSource() {
    stopTimer();
    const sourceUrl = resolveTreeSourceUrl(treeSourceUrlInput?.value ?? DEFAULT_TREE_SOURCE_URL);
    setStatus(`Preparing stream from ${sourceUrl}…`);
    const response = await fetch(sourceUrl);
    if (!response.ok) {
        throw new Error(`Failed to load ${sourceUrl}: ${response.status} ${response.statusText}`);
    }

    const sourceText = await response.text();
    const { headerText, treeEntries } = splitTreeSource(sourceText);
    streamState.preparedSourceUrl = sourceUrl;
    streamState.headerText = headerText;
    streamState.treeEntries = treeEntries;
    streamState.nextTreeIndex = 0;

    const totalTrees = treeEntries.length;
    const treeLimit = Math.max(1, Math.min(1000, totalTrees || 1));
    if (treeLimitInput instanceof HTMLInputElement) {
        treeLimitInput.max = String(Math.max(totalTrees, 1));
        treeLimitInput.value = String(treeLimit);
    }

    viewer.beginStream({
        sourceUrl,
        totalTrees,
        representativeWarmupTrees: Number.parseInt(streamWarmupInput?.value ?? String(DEFAULT_STREAM_REPRESENTATIVE_WARMUP_TREES), 10),
        representativeBackoffInterval: Number.parseInt(streamIntervalInput?.value ?? String(DEFAULT_STREAM_REPRESENTATIVE_BACKOFF_INTERVAL), 10),
    });
    updateViewerControls();
    updateControlOutputs();
    updateProgressText();
    setStatus(`Prepared ${totalTrees} trees from ${sourceUrl}. Ready to stream.`);
}

function buildNextChunk(chunkSize) {
    if (streamState.nextTreeIndex >= streamState.treeEntries.length) return '';

    const endIndex = Math.min(streamState.nextTreeIndex + chunkSize, streamState.treeEntries.length);
    const trees = streamState.treeEntries.slice(streamState.nextTreeIndex, endIndex).join('\n');
    const prefix = streamState.nextTreeIndex === 0 ? `${streamState.headerText}\n` : '';
    streamState.nextTreeIndex = endIndex;
    return `${prefix}${trees}`.trim();
}

function streamStep() {
    if (streamState.treeEntries.length === 0) {
        setStatus('Prepare a stream source first.');
        return false;
    }

    if (streamState.nextTreeIndex >= streamState.treeEntries.length) {
        stopTimer();
        updateProgressText();
        setStatus('Streaming complete.');
        return false;
    }

    const chunkSize = Number.parseInt(treesPerTickInput?.value ?? '25', 10);
    const chunkText = buildNextChunk(chunkSize);
    if (!chunkText) {
        stopTimer();
        setStatus('Streaming complete.');
        return false;
    }

    const result = viewer.appendTrees(chunkText, { totalTrees: streamState.treeEntries.length });
    updateProgressText();
    setStatus(`Streamed ${result.state.parsedTrees}/${result.state.totalTrees || streamState.treeEntries.length} trees.`);

    if (streamState.nextTreeIndex >= streamState.treeEntries.length) {
        stopTimer();
        setStatus(`Streaming complete: ${result.state.parsedTrees} trees.`);
    }

    return true;
}

function startStreaming() {
    if (streamState.treeEntries.length === 0) {
        setStatus('Prepare a stream source first.');
        return;
    }

    stopTimer();
    streamState.running = true;
    scheduleNextStreamStep(0);
    setStatus('Streaming…');
}

function resetStream() {
    stopTimer();
    if (!streamState.preparedSourceUrl) {
        setStatus('Nothing to reset yet.');
        return;
    }

    streamState.nextTreeIndex = 0;
    viewer.beginStream({
        sourceUrl: streamState.preparedSourceUrl,
        totalTrees: streamState.treeEntries.length,
        representativeWarmupTrees: Number.parseInt(streamWarmupInput?.value ?? String(DEFAULT_STREAM_REPRESENTATIVE_WARMUP_TREES), 10),
        representativeBackoffInterval: Number.parseInt(streamIntervalInput?.value ?? String(DEFAULT_STREAM_REPRESENTATIVE_BACKOFF_INTERVAL), 10),
    });
    updateViewerControls();
    updateProgressText();
    setStatus('Stream reset. Ready to stream again.');
}

function splitTreeSource(sourceText) {
    const firstTreePos = findNextTreeKeyword(sourceText, 0);
    if (firstTreePos === -1) {
        return {
            headerText: '',
            treeEntries: splitBareTrees(sourceText),
        };
    }

    const headerText = sourceText.slice(0, firstTreePos).trimEnd();
    const treeEntries = [];
    let searchFrom = 0;

    while (true) {
        const treePos = findNextTreeKeyword(sourceText, searchFrom);
        if (treePos === -1) break;
        const equalsPos = findEqualsSign(sourceText, treePos);
        if (equalsPos === -1) break;
        let treeStart = equalsPos + 1;
        treeStart = skipIgnored(sourceText, treeStart);
        const treeEnd = findTreeTerminator(sourceText, treeStart);
        if (treeEnd === -1) break;
        treeEntries.push(sourceText.slice(treePos, treeEnd + 1));
        searchFrom = treeEnd + 1;
    }

    return { headerText, treeEntries };
}

function splitBareTrees(sourceText) {
    const treeEntries = [];
    let searchFrom = 0;

    while (searchFrom < sourceText.length) {
        searchFrom = skipIgnored(sourceText, searchFrom);
        if (searchFrom >= sourceText.length) break;
        const treeEnd = findTreeTerminator(sourceText, searchFrom);
        if (treeEnd === -1) break;
        treeEntries.push(sourceText.slice(searchFrom, treeEnd + 1));
        searchFrom = treeEnd + 1;
    }

    return treeEntries;
}

function skipIgnored(source, index) {
    let nextIndex = index;
    while (nextIndex < source.length) {
        const ch = source[nextIndex];
        if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t') {
            nextIndex += 1;
            continue;
        }
        if (ch === '[') {
            let depth = 0;
            while (nextIndex < source.length) {
                const nested = source[nextIndex];
                nextIndex += 1;
                if (nested === '[') depth += 1;
                if (nested === ']') {
                    depth -= 1;
                    if (depth === 0) break;
                }
            }
            continue;
        }
        break;
    }
    return nextIndex;
}

function findNextTreeKeyword(source, start) {
    for (let index = start; index + 5 <= source.length; index += 1) {
        if (source.slice(index, index + 5).toLowerCase() === 'tree ') {
            return index;
        }
    }
    return -1;
}

function findEqualsSign(source, start) {
    let bracketDepth = 0;
    for (let index = start; index < source.length; index += 1) {
        const ch = source[index];
        if (ch === '[') {
            bracketDepth += 1;
            continue;
        }
        if (ch === ']') {
            bracketDepth = Math.max(0, bracketDepth - 1);
            continue;
        }
        if (ch === '=' && bracketDepth === 0) return index;
        if (ch === ';' && bracketDepth === 0) return -1;
    }
    return -1;
}

function findTreeTerminator(source, start) {
    let bracketDepth = 0;
    for (let index = start; index < source.length; index += 1) {
        const ch = source[index];
        if (ch === '[') {
            bracketDepth += 1;
            continue;
        }
        if (ch === ']') {
            bracketDepth = Math.max(0, bracketDepth - 1);
            continue;
        }
        if (ch === ';' && bracketDepth === 0) return index;
    }
    return -1;
}

async function main() {
    updateControlOutputs();
    viewer = await createTreeViewer({
        canvas,
        resetViewButton,
        rehomeViewButton,
        onStatus: setStatus,
        onDebug: () => {},
    });

    updateViewerControls();
    setStatus('Prepare a source to start the streaming simulation.');
    setMeta('No source prepared.');

    prepareSourceButton?.addEventListener('click', async () => {
        try {
            await prepareStreamSource();
        } catch (error) {
            setStatus(error instanceof Error ? error.message : String(error));
        }
    });

    startStreamButton?.addEventListener('click', startStreaming);
    pauseStreamButton?.addEventListener('click', () => {
        stopTimer();
        setStatus('Streaming paused.');
    });
    stepStreamButton?.addEventListener('click', () => {
        stopTimer();
        streamStep();
    });
    resetStreamButton?.addEventListener('click', resetStream);

    for (const input of [treesPerTickInput, tickIntervalInput, streamWarmupInput, streamIntervalInput, burninInput, treeLimitInput]) {
        input?.addEventListener('input', () => {
            updateControlOutputs();
            updateViewerControls();
        });
    }
    visibleTreeModeInput?.addEventListener('change', () => {
        updateProgressText();
        updateViewerControls();
    });
    showOrderingTopologyInput?.addEventListener('change', updateViewerControls);
}

main().catch((error) => {
    console.error(error);
    setStatus(error instanceof Error ? error.message : String(error));
});