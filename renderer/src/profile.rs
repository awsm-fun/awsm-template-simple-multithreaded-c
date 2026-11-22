//! The breakdowns the page's Stats panel can ask for, measured only while it
//! asks.
//!
//! A collapsed panel must cost nothing, so nothing here runs unless the page
//! has set a `BRIDGE_DETAIL_*` bit in the bridge block:
//!
//! * `RENDERER`: the phases of our own frame function are timed (a clock
//!   read between each), and awsm-renderer's CPU scopes are switched on
//!   (`logging.cpu`, which the renderer checks at every scope). They cover
//!   the whole of its `render()`: what it does before the first pass, each
//!   pass, and submitting the frame;
//! * `GPU`: the per-pass GPU times are passed on. Measuring those is already
//!   paid for: the frame total the panel always shows comes from the same
//!   timestamp queries.
//!
//! The numbers go into the bridge's timing table as running totals, a few
//! times a second.

use std::collections::HashMap;

use awsm_renderer::debug::TimingTier;
use awsm_renderer::profiling::{self, CpuScopeKind};
use awsm_renderer::AwsmRenderer;

use crate::bridge::{Bridge, Detail, TimingKind};

/// The phases of one frame, in order; the stats panel lists them by these
/// names.
#[derive(Clone, Copy)]
pub enum Phase {
    /// Everything up to the transforms being written: waking the app, the
    /// event rings, sampling and interpolating its snapshots.
    ReadApp,
    /// The scene's own motion: its clips, texture UV flows and particles.
    Animate,
    UpdateTransforms,
    SetCamera,
    /// `AwsmRenderer::render`: encoding every pass and submitting.
    Render,
}

const PHASE_NAMES: [&str; 5] = [
    "read app state + interpolate",
    "clips + particles",
    "update transforms",
    "set camera",
    "render (encode + submit)",
];

/// How often the totals are copied into the bridge block, in milliseconds.
const PUBLISH_EVERY_MS: f64 = 250.0;

#[derive(Default)]
pub struct Profile {
    /// What the page asked for at the start of the current frame.
    detail: Detail,
    published_at_ms: f64,

    /// Running totals of the phases, in milliseconds, and the frames they
    /// (and the renderer's scopes, which run on the same frames) cover.
    phase_ms: [f64; 5],
    frames: u64,
    /// Per renderer scope: the renderer's total as last read, and our own
    /// running total over the frames counted above.
    scopes: HashMap<&'static str, ScopeTotal>,
}

#[derive(Default)]
struct ScopeTotal {
    seen_ms: f64,
    total_ms: f64,
}

impl Profile {
    /// Starts a frame: picks up what the page asks for (`None` while no app
    /// is attached, which is nothing) and switches the renderer's CPU scopes
    /// to match.
    pub fn begin_frame(&mut self, renderer: &mut AwsmRenderer, bridge: Option<&Bridge>) {
        self.detail = bridge.map(Bridge::detail).unwrap_or_default();
        let tier = if self.detail.renderer {
            TimingTier::SubFrame
        } else {
            TimingTier::Off
        };
        if renderer.logging.cpu != tier {
            renderer.logging.cpu = tier;
            if self.detail.renderer {
                // The renderer's totals are global: whatever they hold from
                // before now is not ours to count.
                for (name, stat) in profiling::cpu_timing_stats() {
                    self.scopes.entry(name).or_default().seen_ms = stat.total_ms;
                }
            }
        }
    }

    /// While timing: charges the time since `since_ms` to `phase` and returns
    /// the time now, for the next phase to start from.
    pub fn lap(&mut self, phase: Phase, performance: &web_sys::Performance, since_ms: f64) -> f64 {
        if !self.detail.renderer {
            return since_ms;
        }
        let now = performance.now();
        self.phase_ms[phase as usize] += now - since_ms;
        now
    }

    /// Ends a frame: counts it, and every so often copies the totals into the
    /// bridge block for the page.
    pub fn end_frame(&mut self, bridge: &mut Bridge, frame_ms: f64) {
        if self.detail.renderer {
            self.frames += 1;
        }
        if !(self.detail.renderer || self.detail.gpu)
            || (frame_ms - self.published_at_ms).abs() < PUBLISH_EVERY_MS
        {
            return;
        }
        self.published_at_ms = frame_ms;

        if self.detail.renderer {
            for (name, total_ms) in PHASE_NAMES.into_iter().zip(self.phase_ms) {
                bridge.publish_timing(TimingKind::RendererPhase, name, total_ms, self.frames);
            }
            for (name, stat) in profiling::cpu_timing_stats() {
                let kind = match profiling::cpu_scope_kind(name) {
                    // The whole of render(): the same time as our render phase.
                    CpuScopeKind::Frame => continue,
                    CpuScopeKind::Prep => TimingKind::RendererPrep,
                    CpuScopeKind::Pass => TimingKind::RendererPass,
                    CpuScopeKind::Submit => TimingKind::RendererSubmit,
                    CpuScopeKind::Hook => TimingKind::RendererHook,
                };
                let scope = self.scopes.entry(name).or_default();
                scope.total_ms += stat.total_ms - scope.seen_ms;
                scope.seen_ms = stat.total_ms;
                bridge.publish_timing(kind, name, scope.total_ms, self.frames);
            }
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
}
