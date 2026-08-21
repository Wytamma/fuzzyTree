import {
    createTreeViewer,
    DEFAULT_TREE_SOURCE_URL,
    resolveTreeSourceUrl,
    updateControlOutputs,
} from './tree-library.js';

const canvas = document.getElementById('canvas');
const statusElement = document.getElementById('status');
const debugElement = document.getElementById('debug');
const burninInput = document.getElementById('burnin');
const burninValue = document.getElementById('burnin-value');
const treeLimitInput = document.getElementById('tree-limit');
const treeLimitValue = document.getElementById('tree-limit-value');
const visibleTreeModeInput = document.getElementById('visible-tree-mode');
const treeColourInput = document.getElementById('tree-colour');
const treeColourValue = document.getElementById('tree-colour-value');
const backgroundColourInput = document.getElementById('background-colour');
const backgroundColourValue = document.getElementById('background-colour-value');
const treeAlphaInput = document.getElementById('tree-alpha');
const treeAlphaValue = document.getElementById('tree-alpha-value');
const orderingTopologyColourInput = document.getElementById('ordering-topology-colour');
const orderingTopologyColourValue = document.getElementById('ordering-topology-colour-value');
const orderingTopologyAlphaInput = document.getElementById('ordering-topology-alpha');
const orderingTopologyAlphaValue = document.getElementById('ordering-topology-alpha-value');
const orderingTopologyThicknessInput = document.getElementById('ordering-topology-thickness');
const orderingTopologyThicknessValue = document.getElementById('ordering-topology-thickness-value');
const topologyModeInput = document.getElementById('topology-mode');
const topologySampleCountInput = document.getElementById('topology-sample-count');
const topologySampleCountValue = document.getElementById('topology-sample-count-value');
const showOrderingTopologyInput = document.getElementById('show-ordering-topology');
const treeSourceUrlInput = document.getElementById('tree-source-url');
const loadSourceButton = document.getElementById('load-source');
const resetViewButton = document.getElementById('reset-view');
const rehomeViewButton = document.getElementById('rehome-view');
const loadingStageElement = document.getElementById('loading-stage');
const loadingPercentElement = document.getElementById('loading-percent');
const loadingProgressElement = document.getElementById('loading-progress');
const loadingMetaElement = document.getElementById('loading-meta');

if (!(canvas instanceof HTMLCanvasElement)) {
    throw new Error('Missing <canvas id="canvas"> element.');
}

function setStatus(text) {
    if (statusElement) {
        statusElement.textContent = text;
    }
}

function setDebug(text) {
    if (debugElement) {
        debugElement.textContent = text;
    }
}

function setErrorState(message) {
    setStatus(`Error: ${message}`);
    setDebug(message);
    updateLoadingProgress({ stage: 'error', progress: 1, meta: message });
}

function getInitialSourceUrl() {
    const url = new URL(window.location.href);
    return url.searchParams.get('src') || DEFAULT_TREE_SOURCE_URL;
}

function getInitialBurninPercent() {
    const url = new URL(window.location.href);
    return url.searchParams.get('burnin') || '10';
}

function getInitialTopologyMode() {
    const url = new URL(window.location.href);
    return url.searchParams.get('topologyMode') || 'full';
}

function getInitialTopologySampleTrees() {
    const url = new URL(window.location.href);
    return url.searchParams.get('topologySampleTrees') || '1000';
}

function getInitialShowOrderingTopology() {
    const url = new URL(window.location.href);
    return url.searchParams.get('showOrderingTopology') === '1';
}

function setSourceInputValue(sourceUrl) {
    if (treeSourceUrlInput instanceof HTMLInputElement) {
        treeSourceUrlInput.value = sourceUrl;
    }
}

function setTopologyInputValues(mode, sampleTrees) {
    if (topologyModeInput instanceof HTMLSelectElement) {
        topologyModeInput.value = mode;
    }
    if (topologySampleCountInput instanceof HTMLInputElement) {
        topologySampleCountInput.value = sampleTrees;
    }
    syncTopologyControls();
}

function setCanvasBackgroundColour(colour) {
    document.documentElement.style.setProperty('--canvas-background', colour);
}

function navigateToLoadOptions(sourceUrl, burninPercent, topologyMode, topologySampleTrees, showOrderingTopology) {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set('src', sourceUrl);
    nextUrl.searchParams.set('burnin', burninPercent);
    nextUrl.searchParams.set('topologyMode', topologyMode);
    nextUrl.searchParams.set('topologySampleTrees', topologySampleTrees);
    if (showOrderingTopology) {
        nextUrl.searchParams.set('showOrderingTopology', '1');
    } else {
        nextUrl.searchParams.delete('showOrderingTopology');
    }
    window.location.href = nextUrl.toString();
}

function updateLoadingProgress({ stage = 'idle', progress = 0, meta = '' }) {
    if (loadingStageElement) {
        loadingStageElement.textContent = humanizeStage(stage);
    }
    if (loadingPercentElement) {
        loadingPercentElement.textContent = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
    }
    if (loadingProgressElement instanceof HTMLProgressElement) {
        loadingProgressElement.value = Math.max(0, Math.min(1, progress));
    }
    if (loadingMetaElement) {
        loadingMetaElement.textContent = meta || 'No active load.';
    }
}

function humanizeStage(stage) {
    switch (stage) {
        case 'download': return 'Downloading';
        case 'parse': return 'Parsing';
        case 'refine': return 'Refining';
        case 'complete': return 'Complete';
        case 'error': return 'Error';
        default: return 'Idle';
    }
}

function formatLoadingMeta(progress) {
    if (progress.stage === 'download') {
        const receivedMb = ((progress.received ?? 0) / (1024 * 1024)).toFixed(2);
        const totalText = progress.total > 0 ? `${(progress.total / (1024 * 1024)).toFixed(2)} MB` : 'unknown size';
        return `Downloading ${receivedMb} MB / ${totalText}`;
    }

    if (progress.stage === 'parse') {
        const parsedTrees = progress.parsedTrees ?? 0;
        const totalTrees = progress.totalTrees ?? 0;
        const processedMb = ((progress.estimatedProcessedBytes ?? 0) / (1024 * 1024)).toFixed(2);
        const totalText = progress.fileSize > 0 ? `${(progress.fileSize / (1024 * 1024)).toFixed(2)} MB` : 'unknown size';
        const remainingText = Number.isFinite(progress.remainingMs) && progress.remainingMs > 0
            ? `, ETA ${formatDuration(progress.remainingMs)}`
            : '';
        return `Parsed ${parsedTrees}/${totalTrees} trees, estimated ${processedMb} MB / ${totalText}${remainingText}`;
    }

    if (progress.stage === 'refine') {
        const parsedTrees = progress.parsedTrees ?? 0;
        const totalTrees = progress.totalTrees ?? 0;
        const remainingText = Number.isFinite(progress.remainingMs) && progress.remainingMs > 0
            ? `, ETA ${formatDuration(progress.remainingMs)}`
            : '';
        return `Refining ordering ${parsedTrees}/${totalTrees} trees${remainingText}`;
    }

    if (progress.stage === 'complete') {
        return `Loaded ${progress.parsedTrees ?? 0}/${progress.totalTrees ?? 0} trees.`;
    }

    return progress.meta ?? 'No active load.';
}

function formatDuration(milliseconds) {
    const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes === 0) return `${seconds}s`;
    return `${minutes}m ${seconds}s`;
}

function syncTopologyControls() {
    const topologyMode = topologyModeInput?.value ?? 'full';
    const sampleModeActive = topologyMode === 'sampled' || topologyMode === 'background-refine';

    if (topologySampleCountInput instanceof HTMLInputElement) {
        topologySampleCountInput.disabled = !sampleModeActive;
    }
    if (topologySampleCountValue) {
        topologySampleCountValue.style.opacity = sampleModeActive ? '1' : '0.55';
    }
}

async function main() {
    const initialSourceUrl = getInitialSourceUrl();
    const initialBurninPercent = getInitialBurninPercent();
    const initialTopologyMode = getInitialTopologyMode();
    const initialTopologySampleTrees = getInitialTopologySampleTrees();
    const initialShowOrderingTopology = getInitialShowOrderingTopology();
    setSourceInputValue(initialSourceUrl);
    if (burninInput instanceof HTMLInputElement) {
        burninInput.value = initialBurninPercent;
    }
    setTopologyInputValues(initialTopologyMode, initialTopologySampleTrees);
    if (showOrderingTopologyInput instanceof HTMLInputElement) {
        showOrderingTopologyInput.checked = initialShowOrderingTopology;
    }

    setStatus('Initializing reusable tree viewer…');
    const viewer = await createTreeViewer({
        canvas,
        resetViewButton,
        rehomeViewButton,
        onStatus: setStatus,
        onDebug: setDebug,
        onLoadProgress: (progress) => {
            updateLoadingProgress({
                stage: progress.stage,
                progress: progress.progress ?? 0,
                meta: formatLoadingMeta(progress),
            });
        },
    });

    loadSourceButton?.addEventListener('click', () => {
        const nextSource = resolveTreeSourceUrl(treeSourceUrlInput?.value ?? DEFAULT_TREE_SOURCE_URL);
        const nextBurninPercent = burninInput?.value ?? '10';
        const nextTopologyMode = topologyModeInput?.value ?? 'full';
        const nextTopologySampleTrees = topologySampleCountInput?.value ?? '1000';
        const nextShowOrderingTopology = showOrderingTopologyInput instanceof HTMLInputElement ? showOrderingTopologyInput.checked : false;
        setStatus(`Reloading from ${nextSource}…`);
        navigateToLoadOptions(nextSource, nextBurninPercent, nextTopologyMode, nextTopologySampleTrees, nextShowOrderingTopology);
    });

    treeSourceUrlInput?.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const nextSource = resolveTreeSourceUrl(treeSourceUrlInput.value);
        const nextBurninPercent = burninInput?.value ?? '10';
        const nextTopologyMode = topologyModeInput?.value ?? 'full';
        const nextTopologySampleTrees = topologySampleCountInput?.value ?? '1000';
        const nextShowOrderingTopology = showOrderingTopologyInput instanceof HTMLInputElement ? showOrderingTopologyInput.checked : false;
        setStatus(`Reloading from ${nextSource}…`);
        navigateToLoadOptions(nextSource, nextBurninPercent, nextTopologyMode, nextTopologySampleTrees, nextShowOrderingTopology);
    });

    await viewer.load({
        sourceUrl: initialSourceUrl,
        burninPercent: Number.parseInt(initialBurninPercent, 10),
        topologyMode: initialTopologyMode,
        topologySampleTrees: Number.parseInt(initialTopologySampleTrees, 10),
        onStreamProgress: ({ received, total }) => {
            const receivedMb = (received / (1024 * 1024)).toFixed(2);
            const totalText = total > 0 ? `${(total / (1024 * 1024)).toFixed(2)} MB` : 'unknown size';
            setStatus(`Streaming tree source from ${initialSourceUrl}… ${receivedMb} MB / ${totalText}`);
        },
    });

    if (treeLimitInput) {
        const currentState = viewer.getState();
        const totalTrees = Math.max(currentState.totalTrees, 1);
        treeLimitInput.max = String(totalTrees);
        treeLimitInput.value = String(Math.min(1000, totalTrees));
    }

    updateControlOutputs({
        burninInput,
        burninValue,
        treeLimitInput,
        treeLimitValue,
        treeColourInput,
        treeColourValue,
        backgroundColourInput,
        backgroundColourValue,
        treeAlphaInput,
        treeAlphaValue,
        orderingTopologyColourInput,
        orderingTopologyColourValue,
        orderingTopologyAlphaInput,
        orderingTopologyAlphaValue,
        orderingTopologyThicknessInput,
        orderingTopologyThicknessValue,
        showOrderingTopologyInput,
        topologySampleCountInput,
        topologySampleCountValue,
    });
    syncTopologyControls();

    viewer.setBurnin(Number.parseInt(burninInput?.value ?? '10', 10));
    viewer.setVisibleTreeCount(Number.parseInt(treeLimitInput?.value ?? '1000', 10));
    viewer.setVisibleTreeMode(visibleTreeModeInput?.value ?? 'even');
    viewer.setColor(treeColourInput?.value ?? '#59d8ff');
    viewer.setBackgroundColor(backgroundColourInput?.value ?? '#050816');
    setCanvasBackgroundColour(backgroundColourInput?.value ?? '#050816');
    viewer.setAlpha(Number.parseFloat(treeAlphaInput?.value ?? '0.08'));
    viewer.setShowOrderingTopology(showOrderingTopologyInput instanceof HTMLInputElement ? showOrderingTopologyInput.checked : false);
    viewer.setOrderingTopologyColor(orderingTopologyColourInput?.value ?? '#ffd166');
    viewer.setOrderingTopologyAlpha(Number.parseFloat(orderingTopologyAlphaInput?.value ?? '0.9'));
    viewer.setOrderingTopologyThickness(Number.parseInt(orderingTopologyThicknessInput?.value ?? '4', 10));

    const handleControlsChanged = () => {
        updateControlOutputs({
            burninInput,
            burninValue,
            treeLimitInput,
            treeLimitValue,
            treeColourInput,
            treeColourValue,
            backgroundColourInput,
            backgroundColourValue,
            treeAlphaInput,
            treeAlphaValue,
            orderingTopologyColourInput,
            orderingTopologyColourValue,
            orderingTopologyAlphaInput,
            orderingTopologyAlphaValue,
            orderingTopologyThicknessInput,
            orderingTopologyThicknessValue,
            showOrderingTopologyInput,
            topologySampleCountInput,
            topologySampleCountValue,
        });
        viewer.setBurnin(Number.parseInt(burninInput?.value ?? '0', 10));
        viewer.setVisibleTreeCount(Number.parseInt(treeLimitInput?.value ?? '1', 10));
        viewer.setVisibleTreeMode(visibleTreeModeInput?.value ?? 'even');
        viewer.setColor(treeColourInput?.value ?? '#59d8ff');
        viewer.setBackgroundColor(backgroundColourInput?.value ?? '#050816');
        setCanvasBackgroundColour(backgroundColourInput?.value ?? '#050816');
        viewer.setAlpha(Number.parseFloat(treeAlphaInput?.value ?? '0.08'));
        viewer.setShowOrderingTopology(showOrderingTopologyInput instanceof HTMLInputElement ? showOrderingTopologyInput.checked : false);
        viewer.setOrderingTopologyColor(orderingTopologyColourInput?.value ?? '#ffd166');
        viewer.setOrderingTopologyAlpha(Number.parseFloat(orderingTopologyAlphaInput?.value ?? '0.9'));
        viewer.setOrderingTopologyThickness(Number.parseInt(orderingTopologyThicknessInput?.value ?? '4', 10));
    };

    topologyModeInput?.addEventListener('change', () => {
        syncTopologyControls();
    });

    for (const input of [
        burninInput,
        treeLimitInput,
        treeColourInput,
        backgroundColourInput,
        treeAlphaInput,
        orderingTopologyColourInput,
        orderingTopologyAlphaInput,
        orderingTopologyThicknessInput,
        topologySampleCountInput,
        visibleTreeModeInput,
    ]) {
        input?.addEventListener('input', handleControlsChanged);
    }
    visibleTreeModeInput?.addEventListener('change', handleControlsChanged);
    showOrderingTopologyInput?.addEventListener('change', handleControlsChanged);
}

main().catch((error) => {
    console.error(error);
    const message = error instanceof Error ? error.message : String(error);
    setErrorState(message);
    const details = document.createElement('pre');
    details.textContent = message;
    details.style.whiteSpace = 'pre-wrap';
    details.style.color = '#c00';
    document.body.append(details);
});
