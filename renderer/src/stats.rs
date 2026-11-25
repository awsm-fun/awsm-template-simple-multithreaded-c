//! What this renderer tells the page's stats panel.
//!
//! awsm-renderer-stats does the measuring and the formatting: frame windows,
//! smoothing, the frame budget, the renderer's CPU scopes and GPU passes
//! (see its `StatsCollector`). The page only shows the report this worker
//! posts about once a second (`dom/runtime/kit/stats.js`), and sends back
//! which groups are open and what it measured itself (its refresh rate, its
//! own work).
//!
//! This file adds what is particular to this project: the names of the
//! frame's phases, and the C app's group, read from the bridge block's
//! running totals (the app's step time and its phases, which it times only
//! while that group is open: `BRIDGE_DETAIL_APP`).

use std::collections::HashMap;

use awsm_renderer_stats::{
    duration_row, step_headline, AppSection, NamedMeans, SectionSpec, StatRow, StatsCollector,
    StatsConfig, Window,
};

use crate::bridge::Bridge;

/// The phases of one frame, in order; the stats panel lists them by these
/// names (`PHASE_NAMES`).
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

/// The C app's group: its id (the page stores whether it is open under it).
pub const APP: &str = "app";
const APP_LABEL: &str = "app (C, app worker)";

pub fn config() -> StatsConfig {
    StatsConfig {
        phases: PHASE_NAMES.map(String::from).to_vec(),
        render_phase: Some(Phase::Render as usize),
        sections: vec![SectionSpec::new(APP, APP_LABEL, Some("sim"))],
        ..StatsConfig::default()
    }
}

/// The app group's baseline: the bridge totals at the last report.
#[derive(Default)]
pub struct AppStats {
    baseline: Option<(u32, u32)>,
    timings: HashMap<u32, (u32, u32)>,
    phases: NamedMeans,
}

impl AppStats {
    /// A new app instance: its counters start from zero.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// The app's group for one window: its CPU time per fixed step, its
    /// steps per second, the frames it was late for, and (while open) the
    /// phases of a step. Without an app attached, just a dash.
    pub fn section(
        &mut self,
        stats: &mut StatsCollector,
        window: &Window,
        bridge: Option<&Bridge>,
    ) -> AppSection {
        let spec = SectionSpec::new(APP, APP_LABEL, Some("sim"));
        let Some(bridge) = bridge else {
            return spec.group().headline("—");
        };
        let now = (bridge.step_work_us(), bridge.latest_step());
        let previous = self.baseline.replace(now);
        let timings: HashMap<u32, (String, u32, u32)> = bridge
            .app_timings()
            .into_iter()
            .map(|t| (t.slot, (t.name, t.total_ns, t.count)))
            .collect();
        let previous_timings = std::mem::replace(
            &mut self.timings,
            timings
                .iter()
                .map(|(slot, t)| (*slot, (t.1, t.2)))
                .collect(),
        );
        let Some((work_us, step)) = previous else {
            return spec.group().headline("—");
        };

        // Wrapping totals: the change since the last report.
        let steps = now.1.wrapping_sub(step);
        let work_ms = f64::from(now.0.wrapping_sub(work_us)) / 1000.0;
        let steps_per_s = stats.smooth("steps", f64::from(steps) / window.seconds);
        let per_step = (steps > 0).then(|| stats.smooth("step", work_ms / f64::from(steps)));
        let per_step = per_step.or(stats.smoothed("step"));
        // The same time per frame drawn (time per step × steps per frame):
        // what the app's thread uses of a frame's budget.
        let per_frame = (window.frames > 0)
            .then(|| stats.smooth("frame", work_ms / f64::from(window.frames)))
            .or(stats.smoothed("frame"));

        let mut rows = vec![
            StatRow::new("steps", format!("{steps_per_s:.0} steps/s")),
            window.late.row("late frames"),
        ];
        if stats.is_open(APP) {
            // The phases: each entry's mean per step over the window. An
            // entry that did not advance is not being measured (the group
            // was just opened) and drops out.
            let mut slots: Vec<_> = timings.iter().collect();
            slots.sort_by_key(|(slot, _)| **slot);
            let means = slots
                .into_iter()
                .filter_map(|(slot, (name, total, count))| {
                    let (total0, count0) = previous_timings.get(slot)?;
                    let count = count.wrapping_sub(*count0);
                    (count > 0).then(|| {
                        let ms = f64::from(total.wrapping_sub(*total0)) / f64::from(count) / 1e6;
                        (name.clone(), ms)
                    })
                });
            self.phases.update(means.collect::<Vec<_>>());
            rows.extend(
                self.phases
                    .entries()
                    .iter()
                    .map(|(name, ms)| duration_row(name.clone(), *ms, "step")),
            );
        } else {
            self.phases.clear();
        }

        spec.group()
            .headline(step_headline(per_step))
            .bad(window.late.bad)
            .budget_ms(per_frame)
            .rows(rows)
    }
}
