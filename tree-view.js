export function updateControlOutputs(elements) {
    const {
        burninInput,
        burninValue,
        treeLimitInput,
        treeLimitValue,
        treeColourInput,
        treeColourValue,
        treeAlphaInput,
        treeAlphaValue,
    } = elements;

    if (burninInput && burninValue) burninValue.textContent = `${burninInput.value}%`;
    if (treeLimitInput && treeLimitValue) treeLimitValue.textContent = treeLimitInput.value;
    if (treeColourInput && treeColourValue) treeColourValue.textContent = treeColourInput.value;
    if (treeAlphaInput && treeAlphaValue) treeAlphaValue.textContent = Number.parseFloat(treeAlphaInput.value).toFixed(2);
}

export function createRenderState(initialTreeRanges, onStatus) {
    const state = {
        allTreeRanges: initialTreeRanges,
        burninPercent: 10,
        treeLimit: Math.max(initialTreeRanges.length, 1),
        colour: '#59d8ff',
        alpha: 0.08,
        drawRanges: [],
        parsedTrees: initialTreeRanges.length,
        totalTrees: initialTreeRanges.length,
        viewScaleX: 1,
        viewScaleY: 1,
        viewOffsetX: 0,
        viewOffsetY: 0,
    };

    state.recompute = () => {
        const skipCount = Math.min(state.allTreeRanges.length, Math.floor((state.allTreeRanges.length * state.burninPercent) / 100));
        const remaining = state.allTreeRanges.slice(skipCount);
        state.drawRanges = remaining.slice(0, Math.max(1, state.treeLimit));
        onStatus?.(`Parsed ${state.parsedTrees}/${state.totalTrees} trees. Showing ${state.drawRanges.length} after ${state.burninPercent}% burn-in. Wheel: zoom, Option+wheel: X expand, Shift+wheel: Y expand, drag: pan.`);
    };

    state.resetView = () => {
        state.viewScaleX = 1;
        state.viewScaleY = 1;
        state.viewOffsetX = 0;
        state.viewOffsetY = 0;
    };

    state.recompute();
    return state;
}

function getClipPosition(canvas, event) {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    const y = 1 - (((event.clientY - rect.top) / rect.height) * 2);
    return { x, y };
}

function clampScale(value) {
    return Math.min(40, Math.max(0.25, value));
}

function getWheelZoomStep(event) {
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY)
        ? event.deltaX
        : event.deltaY;

    return delta < 0 ? 1.12 : 1 / 1.12;
}

function zoomAxisAroundClip(state, clipX, clipY, factorX, factorY) {
    const oldScaleX = state.viewScaleX;
    const oldScaleY = state.viewScaleY;
    const worldX = (clipX - state.viewOffsetX) / oldScaleX;
    const worldY = (clipY - state.viewOffsetY) / oldScaleY;

    state.viewScaleX = clampScale(oldScaleX * factorX);
    state.viewScaleY = clampScale(oldScaleY * factorY);
    state.viewOffsetX = clipX - (worldX * state.viewScaleX);
    state.viewOffsetY = clipY - (worldY * state.viewScaleY);
}

function panView(state, deltaClipX, deltaClipY) {
    state.viewOffsetX += deltaClipX;
    state.viewOffsetY += deltaClipY;
}

function readNodePosition(nodeBytes, nodeIndex) {
    const view = new DataView(nodeBytes.buffer, nodeBytes.byteOffset, nodeBytes.byteLength);
    const offset = nodeIndex * 16;
    return {
        x: view.getFloat32(offset + 4, true),
        y: view.getFloat32(offset + 8, true),
    };
}

export function rehomeView(state, nodeBytes, drawRanges) {
    if (drawRanges.length === 0 || nodeBytes.byteLength === 0) {
        state.resetView();
        return;
    }

    let minRootX = Number.POSITIVE_INFINITY;
    let sumRootY = 0;
    for (const range of drawRanges) {
        const root = readNodePosition(nodeBytes, range.startNode);
        minRootX = Math.min(minRootX, root.x);
        sumRootY += root.y;
    }

    const averageRootY = sumRootY / drawRanges.length;
    state.viewOffsetX = -0.9 - (minRootX * state.viewScaleX);
    state.viewOffsetY = -(averageRootY * state.viewScaleY);
}

export function bindViewInteractions({
    canvas,
    state,
    resetViewButton,
    rehomeViewButton,
    getNodeBytes,
    onViewChanged,
}) {
    resetViewButton?.addEventListener('click', () => {
        state.resetView();
        onViewChanged();
    });

    rehomeViewButton?.addEventListener('click', () => {
        rehomeView(state, getNodeBytes(), state.drawRanges);
        onViewChanged();
    });

    canvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        const { x, y } = getClipPosition(canvas, event);
        const step = getWheelZoomStep(event);

        if (event.altKey) {
            zoomAxisAroundClip(state, x, y, step, 1);
        } else if (event.shiftKey) {
            zoomAxisAroundClip(state, x, y, 1, step);
        } else {
            zoomAxisAroundClip(state, x, y, step, step);
        }

        onViewChanged();
    }, { passive: false });

    let dragState = null;

    canvas.addEventListener('pointerdown', (event) => {
        canvas.setPointerCapture(event.pointerId);
        dragState = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
    });

    canvas.addEventListener('pointermove', (event) => {
        if (!dragState || dragState.pointerId !== event.pointerId) return;
        const rect = canvas.getBoundingClientRect();
        const deltaClipX = ((event.clientX - dragState.x) / rect.width) * 2;
        const deltaClipY = -((event.clientY - dragState.y) / rect.height) * 2;
        dragState.x = event.clientX;
        dragState.y = event.clientY;
        panView(state, deltaClipX, deltaClipY);
        onViewChanged();
    });

    canvas.addEventListener('pointerup', (event) => {
        if (dragState?.pointerId === event.pointerId) {
            dragState = null;
        }
    });

    canvas.addEventListener('pointercancel', (event) => {
        if (dragState?.pointerId === event.pointerId) {
            dragState = null;
        }
    });

    canvas.addEventListener('dblclick', (event) => {
        const { x, y } = getClipPosition(canvas, event);
        zoomAxisAroundClip(state, x, y, 1.35, 1.35);
        onViewChanged();
    });
}
