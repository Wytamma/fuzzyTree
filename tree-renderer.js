import { loadText } from './tree-data.js';

export function getWebGPUErrorMessage() {
    const reasons = [];

    if (!window.isSecureContext) {
        reasons.push('WebGPU requires a secure context. Use https:// or http://localhost instead of file:// or a non-local insecure origin.');
    }

    if (window.location.protocol === 'file:') {
        reasons.push('This page is being opened directly from the filesystem. Start a local web server and open it through localhost.');
    }

    if (window.location.hostname && !['localhost', '127.0.0.1'].includes(window.location.hostname) && window.location.protocol === 'http:') {
        reasons.push(`The current origin (${window.location.origin}) is not treated as secure by Chrome for WebGPU.`);
    }

    if (reasons.length === 0) {
        reasons.push('Chrome does not expose navigator.gpu in the current profile/session. Check chrome://gpu and verify WebGPU is enabled.');
    }

    return reasons.join(' ');
}

export function resizeCanvas(canvas) {
    const devicePixelRatio = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(canvas.clientWidth * devicePixelRatio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * devicePixelRatio));

    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
}

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

function hexToRgb(hex) {
    const normalized = hex.replace('#', '');
    const value = Number.parseInt(normalized, 16);
    return {
        r: ((value >> 16) & 0xff) / 255,
        g: ((value >> 8) & 0xff) / 255,
        b: (value & 0xff) / 255,
    };
}

function hexToClearValue(hex) {
    const rgb = hexToRgb(hex);
    return { r: rgb.r, g: rgb.g, b: rgb.b, a: 1 };
}

export async function createOverlayResources(device, format, options = {}) {
    const shaderUrl = new URL('./shader.wgsl', import.meta.url);
    const shaderCode = await loadText(shaderUrl);
    const shaderModule = device.createShaderModule({ code: shaderCode });
    const wideLines = options.wideLines === true;

    const nodeBuffer = device.createBuffer({
        label: 'densitree-wasm-nodes',
        size: 16,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    const uniformBuffer = device.createBuffer({
        label: 'densitree-render-params',
        size: 64,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    const pipeline = device.createRenderPipeline({
        label: wideLines ? 'densitree-wide-overlay-pipeline' : 'densitree-overlay-pipeline',
        layout: 'auto',
        vertex: {
            module: shaderModule,
            entryPoint: wideLines ? 'vs_wide_main' : 'vs_main',
        },
        fragment: {
            module: shaderModule,
            entryPoint: 'fs_main',
            targets: [{
                format,
                blend: {
                    color: {
                        operation: 'add',
                        srcFactor: 'src-alpha',
                        dstFactor: 'one',
                    },
                    alpha: {
                        operation: 'add',
                        srcFactor: 'one',
                        dstFactor: 'one',
                    },
                },
            }],
        },
        primitive: {
            topology: wideLines ? 'triangle-list' : 'line-list',
        },
    });

    const compilationInfo = await (shaderModule.getCompilationInfo?.() ?? Promise.resolve({ messages: [] }));
    const errors = (compilationInfo.messages ?? []).filter((message) => message.type === 'error');
    if (errors.length > 0) {
        throw new Error(`WGSL compilation failed: ${errors.map((message) => message.message).join('; ')}`);
    }

    const createBindGroup = (buffer) => device.createBindGroup({
        label: 'densitree-overlay-bind-group',
        layout: pipeline.getBindGroupLayout(0),
        entries: [{
            binding: 0,
            resource: { buffer },
        }, {
            binding: 1,
            resource: { buffer: uniformBuffer },
        }],
    });

    return {
        pipeline,
        bindGroup: createBindGroup(nodeBuffer),
        nodeBuffer,
        nodeBufferCapacity: 16,
        uniformBuffer,
        createBindGroup,
        wideLines,
        verticesPerNode: wideLines ? 6 : 2,
    };
}

function ensureOverlayCapacity(device, overlay, requiredSize) {
    if (requiredSize <= overlay.nodeBufferCapacity) return;

    overlay.nodeBuffer.destroy?.();
    overlay.nodeBufferCapacity = Math.max(requiredSize, overlay.nodeBufferCapacity * 2);
    overlay.nodeBuffer = device.createBuffer({
        label: 'densitree-wasm-nodes',
        size: overlay.nodeBufferCapacity,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    overlay.bindGroup = overlay.createBindGroup(overlay.nodeBuffer);
}

export function updateOverlayNodes(device, overlay, nodeBytes) {
    const requiredSize = Math.max(nodeBytes.byteLength, 16);
    ensureOverlayCapacity(device, overlay, requiredSize);
    if (nodeBytes.byteLength > 0) {
        device.queue.writeBuffer(overlay.nodeBuffer, 0, nodeBytes);
    }
}

export function appendOverlayNodes(device, overlay, nodeBytes, byteOffset) {
    const requiredSize = Math.max(byteOffset + nodeBytes.byteLength, 16);
    ensureOverlayCapacity(device, overlay, requiredSize);
    if (nodeBytes.byteLength > 0) {
        device.queue.writeBuffer(overlay.nodeBuffer, byteOffset, nodeBytes);
    }
}

export function updateRenderParams(device, overlay, state, options = {}) {
    const rgb = hexToRgb(options.color ?? state.colour);
    const alpha = options.alpha ?? state.alpha;
    const offsetX = options.offsetX ?? 0;
    const offsetY = options.offsetY ?? 0;
    const thickness = options.thickness ?? 1;
    const viewportWidth = options.viewportWidth ?? 1;
    const viewportHeight = options.viewportHeight ?? 1;
    const params = new Float32Array([
        rgb.r,
        rgb.g,
        rgb.b,
        alpha,
        state.viewScaleX,
        state.viewScaleY,
        state.viewOffsetX,
        state.viewOffsetY,
        offsetX,
        offsetY,
        0,
        0,
        thickness,
        viewportWidth,
        viewportHeight,
        0,
    ]);
    device.queue.writeBuffer(overlay.uniformBuffer, 0, params);
}

export async function initWebGPU(canvas) {
    if (!('gpu' in navigator)) {
        throw new Error(getWebGPUErrorMessage());
    }

    const context = canvas.getContext('webgpu');
    if (!context) {
        throw new Error('Failed to get a WebGPU canvas context.');
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
        throw new Error('No WebGPU adapter was found.');
    }

    const device = await adapter.requestDevice();
    const format = navigator.gpu.getPreferredCanvasFormat();

    const configure = () => {
        resizeCanvas(canvas);
        context.configure({
            device,
            format,
            alphaMode: 'opaque',
        });
    };

    configure();
    window.addEventListener('resize', configure);

    return { context, device, format };
}

export function renderFrame(context, device, layers, options = {}) {
    const textureView = context.getCurrentTexture().createView();
    const encoder = device.createCommandEncoder();
    const clearValue = hexToClearValue(options.backgroundColor ?? '#050816');
    const pass = encoder.beginRenderPass({
        colorAttachments: [{
            view: textureView,
            loadOp: 'clear',
            storeOp: 'store',
            clearValue,
        }],
    });

    for (const layer of layers) {
        if (!layer?.overlay || !layer.ranges?.length) continue;
        layer.beforeDraw?.();
        pass.setPipeline(layer.overlay.pipeline);
        pass.setBindGroup(0, layer.overlay.bindGroup);
        for (const range of layer.ranges) {
            pass.draw(
                range.nodeCount * layer.overlay.verticesPerNode,
                1,
                range.startNode * layer.overlay.verticesPerNode,
                0,
            );
        }
    }
    pass.end();
    device.queue.submit([encoder.finish()]);
}
