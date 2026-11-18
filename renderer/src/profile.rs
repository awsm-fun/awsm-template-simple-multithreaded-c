//! The breakdowns the page's Stats panel can ask for, measured only while it
//! asks.
//!
//! A collapsed panel must cost nothing, so nothing here runs unless the page
//! has set a `BRIDGE_DETAIL_*` bit in the bridge block:
//!
//! * `RENDERER`: the phases of our own frame function are timed (a clock
//!   read between each), and awsm-renderer's per-pass CPU scopes are switched
//!   on for some frames (`logging.cpu`, which the renderer checks at every
//!   scope);
//! * `GPU`: the per-pass GPU times are passed on. Measuring those is already
//!   paid for: the frame total the panel always shows comes from the same
//!   timestamp queries.
//!
//! The numbers go into the bridge's timing table as running totals, a few
//! times a second.
//!
//! # The per-pass scopes are costly, so they are sampled
//!
//! Each awsm-renderer scope looks the clock up through the global object at
//! both ends, which in a worker takes far longer than the pass being timed
//! (about 80 µs a lookup where this was written: a dozen scopes cost four
//! times the frame). So that looking does not change what is looked at:
//!
//! * the scopes are on for one frame in [`PASS_TIMING_EVERY`] only, and the
//!   phases are taken from the other frames, which are undisturbed;
//! * what the scopes cost is measured, as the difference between the render
//!   phase with and without them, and published as a figure of its own;
//! * each pass has the scope's share of its reading taken out. A scope's
//!   reading runs from the end of its first lookup to the end of its second,
//!   so it contains one of the two: half of what the scope costs.

use std::collections::HashMap;

use awsm_renderer::debug::TimingTier;
use awsm_renderer::{profiling, AwsmRenderer};

use crate::bridge::{Bridge, Detail, TimingKind};

/// The phases of one frame, in order; the stats panel lists them by these
/// names.
#[derive(Clone, Copy)]
pub enum Phase {
    /// Everything up to the transforms being written: waking the app, the
    /// event rings, sampling and interpolating its snapshots.
    ReadApp,
    UpdateTransforms,
    SetCamera,
    /// `AwsmRenderer::render`: encoding every pass and submitting.
    Render,
}

const PHASE_NAMES: [&str; 4] = [
    "read app state + interpolate",
    "update transforms",
    "set camera",
    "render (encode + submit)",
];

/// awsm-renderer's own scope around the whole of `render()`: the same time
/// as our render phase, so it is not listed among the passes.
const WHOLE_RENDER_SCOPE: &str = "Render";
/// The name the cost of the scopes is published under.
const OVERHEAD_NAME: &str = "timing the passes";

/// The per-pass scopes are on for one frame in this many.
const PASS_TIMING_EVERY: u64 = 16;
/// How often the totals are copied into the bridge block, in milliseconds.
const PUBLISH_EVERY_MS: f64 = 250.0;

#[derive(Default)]
pub struct Profile {
    /// What the page asked for at the start of the current frame, and
    /// whether the per-pass scopes are on for it.
    detail: Detail,
    timing_passes: bool,
    published_at_ms: f64,

    /// Running totals, in milliseconds, over the frames WITHOUT the scopes:
    /// each phase, and the frames counted.
    phase_ms: [f64; 4],
    plain_frames: u64,
    /// The same for the render phase over the frames WITH them.
    timed_render_ms: f64,
    timed_frames: u64,

    /// Per scope: the renderer's totals at the last publish, and our running
    /// total with the scope's own share taken out.
    passes: HashMap<&'static str, PassTotal>,
    /// Scope runs counted so far, and the running total of what they cost.
    scope_runs: u64,
    overhead_ms: f64,
}

#[derive(Default)]
struct PassTotal {
    seen_ms: f64,
    seen_count: u64,
    net_ms: f64,
}

impl Profile {
    /// Starts a frame: picks up what the page asks for (`None` while no app
    /// is attached, which is nothing) and switches the renderer's per-pass
    /// CPU scopes on or off for it.
    pub fn begin_frame(&mut self, renderer: &mut AwsmRenderer, bridge: Option<&Bridge>) {
        self.detail = bridge.map(Bridge::detail).unwrap_or_default();
        let frames = self.plain_frames + self.timed_frames;
        self.timing_passes = self.detail.renderer && frames.is_multiple_of(PASS_TIMING_EVERY);
        renderer.logging.cpu = if self.timing_passes {
            TimingTier::SubFrame
        } else {
            TimingTier::Off
        };
    }

    /// While timing: charges the time since `since_ms` to `phase` and returns
    /// the time now, for the next phase to start from.
    pub fn lap(&mut self, phase: Phase, performance: &web_sys::Performance, since_ms: f64) -> f64 {
        if !self.detail.renderer {
            return since_ms;
        }
        let now = performance.now();
        if !self.timing_passes {
            self.phase_ms[phase as usize] += now - since_ms;
        } else if matches!(phase, Phase::Render) {
            self.timed_render_ms += now - since_ms;
        }
        now
    }

    /// Ends a frame: counts it, and every so often copies the totals into the
    /// bridge block for the page.
    pub fn end_frame(&mut self, bridge: &mut Bridge, frame_ms: f64) {
        if self.timing_passes {
            self.timed_frames += 1;
        } else if self.detail.renderer {
            self.plain_frames += 1;
        }
        if !(self.detail.renderer || self.detail.gpu)
            || (frame_ms - self.published_at_ms).abs() < PUBLISH_EVERY_MS
        {
            return;
        }
        self.published_at_ms = frame_ms;

        if self.detail.renderer {
            self.publish_renderer(bridge);
        }
        if self.detail.gpu {
            // Timestamps are read back for some frames only; the whole-frame
            // entry counts exactly those.
            let sampled_frames = profiling::gpu_frame_timing().map_or(0, |frame| frame.count);
            for (name, stat) in profiling::gpu_timing_stats() {
                if name != profiling::GPU_FRAME_SCOPE {
                    bridge.publish_timing(TimingKind::GpuPass, name, stat.total_ms, sampled_frames);
                }
            }
        }
    }

    fn publish_renderer(&mut self, bridge: &mut Bridge) {
        for (name, total_ms) in PHASE_NAMES.into_iter().zip(self.phase_ms) {
            bridge.publish_timing(TimingKind::RendererPhase, name, total_ms, self.plain_frames);
        }

        // What the scopes ran and read since the last publish.
        let stats = profiling::cpu_timing_stats();
        let mut window = Vec::with_capacity(stats.len());
        for (name, stat) in stats {
            let pass = self.passes.entry(name).or_default();
            let runs = stat.count.saturating_sub(pass.seen_count);
            let read_ms = stat.total_ms - pass.seen_ms;
            pass.seen_count = stat.count;
            pass.seen_ms = stat.total_ms;
            self.scope_runs += runs;
            window.push((name, runs as f64, read_ms));
        }

        // What one scope costs: what a frame with the scopes takes over one
        // without, shared among the scopes it ran. Taken over everything
        // measured so far, since it is a property of the clock lookup and
        // not of the scene.
        let scope_ms = if self.plain_frames == 0 || self.timed_frames == 0 || self.scope_runs == 0 {
            0.0
        } else {
            let plain_ms = self.phase_ms[Phase::Render as usize] / self.plain_frames as f64;
            let timed_ms = self.timed_render_ms / self.timed_frames as f64;
            (timed_ms - plain_ms).max(0.0) * self.timed_frames as f64 / self.scope_runs as f64
        };

        for (name, runs, read_ms) in window {
            self.overhead_ms += runs * scope_ms;
            let pass = self.passes.entry(name).or_default();
            pass.net_ms += (read_ms - runs * scope_ms / 2.0).max(0.0);
            if name != WHOLE_RENDER_SCOPE {
                bridge.publish_timing(
                    TimingKind::RendererPass,
                    name,
                    pass.net_ms,
                    self.timed_frames,
                );
            }
        }
        // Averaged over every frame: this is what looking adds to the
        // renderer's time per frame.
        bridge.publish_timing(
            TimingKind::RendererOverhead,
            OVERHEAD_NAME,
            self.overhead_ms,
            self.plain_frames + self.timed_frames,
        );
    }
}
