export function parseTreeRanges(nodeBytes, nodeCount) {
    const view = new DataView(nodeBytes.buffer, nodeBytes.byteOffset, nodeBytes.byteLength);
    const starts = [];

    for (let i = 0; i < nodeCount; i += 1) {
        const offset = i * 16;
        const parentIdx = view.getUint32(offset, true);
        if (parentIdx === i) {
            starts.push(i);
        }
    }

    return starts.map((start, index) => {
        const end = index + 1 < starts.length ? starts[index + 1] : nodeCount;
        return {
            startNode: start,
            endNode: end,
            nodeCount: end - start,
        };
    });
}

export function parseAppendedTreeRanges(nodeBytes, startNode, nodeCount) {
    if (!(nodeBytes instanceof Uint8Array) || startNode >= nodeCount || nodeBytes.byteLength === 0) {
        return [];
    }

    const view = new DataView(nodeBytes.buffer, nodeBytes.byteOffset, nodeBytes.byteLength);
    const starts = [];

    for (let i = startNode; i < nodeCount; i += 1) {
        const offset = i * 16;
        const parentIdx = view.getUint32(offset, true);
        if (parentIdx === i) {
            starts.push(i);
        }
    }

    return starts.map((start, index) => {
        const end = index + 1 < starts.length ? starts[index + 1] : nodeCount;
        return {
            startNode: start,
            endNode: end,
            nodeCount: end - start,
        };
    });
}

export function computeTreeDepths(nodeBytes, ranges) {
    if (!(nodeBytes instanceof Uint8Array) || nodeBytes.byteLength === 0 || ranges.length === 0) {
        return [];
    }

    const view = new DataView(nodeBytes.buffer, nodeBytes.byteOffset, nodeBytes.byteLength);
    return ranges.map((range) => getTreeMaxDepth(view, range));
}

export function getGlobalMaxDepth(treeDepths) {
    return treeDepths.reduce((max, depth) => Math.max(max, depth), 0);
}

export function normalizeTreeXPositions(nodeBytes, allTreeRanges, treeDepths = computeTreeDepths(nodeBytes, allTreeRanges), globalMaxDepth = getGlobalMaxDepth(treeDepths)) {
    if (!(nodeBytes instanceof Uint8Array) || nodeBytes.byteLength === 0) {
        return new Uint8Array();
    }

    const inputView = new DataView(nodeBytes.buffer, nodeBytes.byteOffset, nodeBytes.byteLength);
    const outputBytes = nodeBytes.slice();
    const outputView = new DataView(outputBytes.buffer, outputBytes.byteOffset, outputBytes.byteLength);

    for (let rangeIndex = 0; rangeIndex < allTreeRanges.length; rangeIndex += 1) {
        const range = allTreeRanges[rangeIndex];
        const treeDepth = treeDepths[rangeIndex];
        const depthOffset = Math.max(0, globalMaxDepth - treeDepth);

        for (let nodeIndex = range.startNode; nodeIndex < range.endNode; nodeIndex += 1) {
            const offset = nodeIndex * 16;
            const rawX = inputView.getFloat32(offset + 4, true);
            const normalizedX = globalMaxDepth > 0
                ? -0.92 + (((rawX + depthOffset) / globalMaxDepth) * 1.84)
                : 0;
            outputView.setFloat32(offset + 4, normalizedX, true);
        }
    }

    return outputBytes;
}

export function normalizeTreeXPositionsSegment(nodeBytes, ranges, treeDepths, globalMaxDepth) {
    if (!(nodeBytes instanceof Uint8Array) || ranges.length === 0 || nodeBytes.byteLength === 0) {
        return new Uint8Array();
    }

    const startNode = ranges[0].startNode;
    const endNode = ranges[ranges.length - 1].endNode;
    const startByte = startNode * 16;
    const endByte = endNode * 16;
    const inputView = new DataView(nodeBytes.buffer, nodeBytes.byteOffset, nodeBytes.byteLength);
    const outputBytes = nodeBytes.slice(startByte, endByte);
    const outputView = new DataView(outputBytes.buffer, outputBytes.byteOffset, outputBytes.byteLength);

    for (let rangeIndex = 0; rangeIndex < ranges.length; rangeIndex += 1) {
        const range = ranges[rangeIndex];
        const treeDepth = treeDepths[rangeIndex];
        const depthOffset = Math.max(0, globalMaxDepth - treeDepth);

        for (let nodeIndex = range.startNode; nodeIndex < range.endNode; nodeIndex += 1) {
            const offset = nodeIndex * 16;
            const rawX = inputView.getFloat32(offset + 4, true);
            const normalizedX = globalMaxDepth > 0
                ? -0.92 + (((rawX + depthOffset) / globalMaxDepth) * 1.84)
                : 0;
            outputView.setFloat32(((nodeIndex - startNode) * 16) + 4, normalizedX, true);
        }
    }

    return outputBytes;
}

function getTreeMaxDepth(view, range) {
    let maxDepth = 0;
    for (let nodeIndex = range.startNode; nodeIndex < range.endNode; nodeIndex += 1) {
        const offset = nodeIndex * 16;
        maxDepth = Math.max(maxDepth, view.getFloat32(offset + 4, true));
    }
    return maxDepth;
}

export function computeVisibleRanges(allTreeRanges, burninPercent, treeLimit, visibleTreeMode = 'even') {
    const skipCount = Math.min(allTreeRanges.length, Math.floor((allTreeRanges.length * burninPercent) / 100));
    const remaining = allTreeRanges.slice(skipCount);
    return selectVisibleRanges(remaining, Math.max(1, treeLimit), visibleTreeMode);
}

function selectVisibleRanges(ranges, sampleCount, mode) {
    if (ranges.length <= sampleCount) {
        return ranges;
    }

    switch (mode) {
        case 'first':
            return ranges.slice(0, sampleCount);
        case 'last':
            return ranges.slice(-sampleCount);
        default:
            return sampleRangesEvenly(ranges, sampleCount);
    }
}

function sampleRangesEvenly(ranges, sampleCount) {
    if (ranges.length <= sampleCount) {
        return ranges;
    }

    if (sampleCount <= 1) {
        return [ranges[Math.floor((ranges.length - 1) / 2)]];
    }

    const sampled = [];
    const rangeCount = ranges.length;

    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        const rangeIndex = Math.min(
            rangeCount - 1,
            Math.floor(((sampleIndex + 0.5) * rangeCount) / sampleCount),
        );
        sampled.push(ranges[rangeIndex]);
    }

    return sampled;
}

export function mergeContiguousRanges(ranges) {
    if (ranges.length === 0) return [];

    const merged = [];
    let current = { ...ranges[0] };

    for (let index = 1; index < ranges.length; index += 1) {
        const next = ranges[index];
        if (current.endNode === next.startNode) {
            current.endNode = next.endNode;
            current.nodeCount += next.nodeCount;
            continue;
        }

        merged.push(current);
        current = { ...next };
    }

    merged.push(current);
    return merged;
}

function readNodePosition(nodeBytes, nodeIndex) {
    const view = new DataView(nodeBytes.buffer, nodeBytes.byteOffset, nodeBytes.byteLength);
    const offset = nodeIndex * 16;
    return {
        x: view.getFloat32(offset + 4, true),
        y: view.getFloat32(offset + 8, true),
    };
}

export function computeRehomeOffsets(viewState, nodeBytes, drawRanges) {
    if (drawRanges.length === 0 || nodeBytes.byteLength === 0) {
        return {
            viewOffsetX: 0,
            viewOffsetY: 0,
        };
    }

    let minRootX = Number.POSITIVE_INFINITY;
    let sumRootY = 0;
    for (const range of drawRanges) {
        const root = readNodePosition(nodeBytes, range.startNode);
        minRootX = Math.min(minRootX, root.x);
        sumRootY += root.y;
    }

    const averageRootY = sumRootY / drawRanges.length;
    return {
        viewOffsetX: -0.9 - (minRootX * viewState.viewScaleX),
        viewOffsetY: -(averageRootY * viewState.viewScaleY),
    };
}

export function createStatusText(state) {
    const skipped = Math.min(state.allTreeRanges.length, Math.floor((state.allTreeRanges.length * state.burninPercent) / 100));
    const eligible = Math.max(0, state.allTreeRanges.length - skipped);
    return `Parsed ${state.parsedTrees}/${state.totalTrees} trees. Eligible ${eligible} after ${state.burninPercent}% burn-in; showing ${state.drawRanges.length} using ${state.visibleTreeMode}. Render batches: ${state.renderRanges.length}. Wheel: zoom, Option+wheel: X expand, Shift+wheel: Y expand, drag: pan.`;
}
