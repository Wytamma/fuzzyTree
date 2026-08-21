import { computeRehomeOffsets, computeVisibleRanges, createStatusText, mergeContiguousRanges } from './layout.js';

export function updateControlOutputs(elements) {
    const {
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
        topologySampleCountInput,
        topologySampleCountValue,
    } = elements;

    if (burninInput && burninValue) burninValue.textContent = `${burninInput.value}%`;
    if (treeLimitInput && treeLimitValue) treeLimitValue.textContent = treeLimitInput.value;
    if (treeColourInput && treeColourValue) treeColourValue.textContent = treeColourInput.value;
    if (backgroundColourInput && backgroundColourValue) backgroundColourValue.textContent = backgroundColourInput.value;
    if (treeAlphaInput && treeAlphaValue) treeAlphaValue.textContent = Number.parseFloat(treeAlphaInput.value).toFixed(2);
    if (orderingTopologyColourInput && orderingTopologyColourValue) orderingTopologyColourValue.textContent = orderingTopologyColourInput.value;
    if (orderingTopologyAlphaInput && orderingTopologyAlphaValue) orderingTopologyAlphaValue.textContent = Number.parseFloat(orderingTopologyAlphaInput.value).toFixed(2);
    if (orderingTopologyThicknessInput && orderingTopologyThicknessValue) orderingTopologyThicknessValue.textContent = orderingTopologyThicknessInput.value;
    if (topologySampleCountInput && topologySampleCountValue) topologySampleCountValue.textContent = topologySampleCountInput.value;
}

export function createTreeViewerState(onStatus) {
    const state = {
        sourceUrl: '',
        allTreeRanges: [],
        burninPercent: 10,
        treeLimit: 1000,
        visibleTreeMode: 'even',
        colour: '#59d8ff',
        backgroundColour: '#050816',
        alpha: 0.08,
        showOrderingTopology: false,
        orderingTopologyColour: '#ffd166',
        orderingTopologyAlpha: 0.9,
        orderingTopologyThickness: 4,
        drawRanges: [],
        renderRanges: [],
        parsedTrees: 0,
        totalTrees: 0,
        viewScaleX: 1,
        viewScaleY: 1,
        viewOffsetX: 0,
        viewOffsetY: 0,
        resetView() {
            state.viewScaleX = 1;
            state.viewScaleY = 1;
            state.viewOffsetX = 0;
            state.viewOffsetY = 0;
        },
        rehome(nodeBytes) {
            const offsets = computeRehomeOffsets(state, nodeBytes, state.drawRanges);
            state.viewOffsetX = offsets.viewOffsetX;
            state.viewOffsetY = offsets.viewOffsetY;
        },
        setDataset(dataset) {
            state.sourceUrl = dataset.sourceUrl ?? state.sourceUrl;
            state.allTreeRanges = dataset.allTreeRanges ?? state.allTreeRanges;
            state.parsedTrees = dataset.parsedTrees ?? state.parsedTrees;
            state.totalTrees = dataset.totalTrees ?? state.totalTrees;
            state.recompute();
        },
        recompute() {
            state.drawRanges = computeVisibleRanges(state.allTreeRanges, state.burninPercent, state.treeLimit, state.visibleTreeMode);
            state.renderRanges = mergeContiguousRanges(state.drawRanges);
            onStatus?.(createStatusText(state));
        },
    };

    state.recompute();
    return state;
}
