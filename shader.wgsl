struct Node {
    parent_idx: u32,
    x: f32,
    y: f32,
    _pad: u32,
};

@group(0) @binding(0) var<storage, read> nodes: array<Node>;

struct RenderParams {
    color: vec4f,
    view: vec4f,
    offset: vec4f,
    style: vec4f,
};

@group(0) @binding(1) var<uniform> params: RenderParams;

struct VertexOutput {
    @builtin(position) clip_pos: vec4f,
    @location(0) color: vec4f,
};

fn transform_pos(draw_pos: vec2f) -> vec2f {
    return vec2f(
        draw_pos.x * params.view.x + params.view.z + params.offset.x,
        draw_pos.y * params.view.y + params.view.w + params.offset.y,
    );
}

fn clip_to_pixel(clip_pos: vec2f, viewport: vec2f) -> vec2f {
    let uv = clip_pos * 0.5 + vec2f(0.5, 0.5);
    return vec2f(
        uv.x * viewport.x,
        (1.0 - uv.y) * viewport.y,
    );
}

fn pixel_to_clip(pixel_pos: vec2f, viewport: vec2f) -> vec2f {
    let uv = vec2f(
        pixel_pos.x / viewport.x,
        1.0 - (pixel_pos.y / viewport.y),
    );
    return uv * 2.0 - vec2f(1.0, 1.0);
}

const wide_line_corners = array<vec2f, 6>(
    vec2f(0.0, -1.0),
    vec2f(0.0, 1.0),
    vec2f(1.0, -1.0),
    vec2f(1.0, -1.0),
    vec2f(0.0, 1.0),
    vec2f(1.0, 1.0),
);

@vertex
fn vs_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
    let node_idx = idx / 2u;
    let is_parent = (idx % 2u) == 1u;
    
    let node = nodes[node_idx];
    let parent = nodes[node.parent_idx];
    let node_pos = vec2f(node.x, node.y);
    let parent_pos = vec2f(parent.x, parent.y);
    
    let draw_pos = select(node_pos, parent_pos, is_parent);
    let transformed_pos = transform_pos(draw_pos);
    
    var out: VertexOutput;
    out.clip_pos = vec4f(transformed_pos, 0.0, 1.0);
    out.color = params.color;
    return out;
}

@vertex
fn vs_wide_main(@builtin(vertex_index) idx: u32) -> VertexOutput {
    let node_idx = idx / 6u;
    let corner_idx = idx % 6u;
    let node = nodes[node_idx];
    let parent = nodes[node.parent_idx];
    let viewport = max(vec2f(params.style.y, params.style.z), vec2f(1.0, 1.0));

    let start_clip = transform_pos(vec2f(parent.x, parent.y));
    let end_clip = transform_pos(vec2f(node.x, node.y));
    let start_pixel = clip_to_pixel(start_clip, viewport);
    let end_pixel = clip_to_pixel(end_clip, viewport);

    let segment = end_pixel - start_pixel;
    let segment_length = length(segment);
    let direction = select(vec2f(1.0, 0.0), segment / segment_length, segment_length > 0.0001);
    let normal = vec2f(-direction.y, direction.x);
    let half_width = select(0.0, max(params.style.x * 0.5, 0.5), node.parent_idx != node_idx);
    let corner = wide_line_corners[corner_idx];
    let base_pixel = mix(start_pixel, end_pixel, corner.x);
    let final_pixel = base_pixel + normal * (corner.y * half_width);
    let final_clip = pixel_to_clip(final_pixel, viewport);

    var out: VertexOutput;
    out.clip_pos = vec4f(final_clip, 0.0, 1.0);
    out.color = params.color;
    return out;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4f {
    return in.color;
}