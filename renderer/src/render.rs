//! The render worker's life: start the renderer, load the scene, then draw a
//! frame per display refresh from whatever the app has published.
//!
//! Everything here runs on one thread, entered in four ways:
//!
//! * a message from the page ([`init`], [`resize`], [`anti_alias`],
//!   [`attach`], [`detach`]);
//! * the asynchronous start-up that `init` kicks off ([`App::boot`]);
//! * the `requestAnimationFrame` callback ([`on_frame`]), once start-up is
//!   done;
//! * a [`Job`] ([`run_job`]): an anti-aliasing change or a scene reload,
//!   which are asynchronous too.
//!
//! The `AwsmRenderer` itself is only ever touched from the frame callback (and
//! from start-up, before the first frame, and while a job has it away from
//! the frame loop). A message from the page changes what surrounds it — the
//! canvas size, which app is attached, the anti-aliasing wanted — and
//! anything that needs the renderer, such as an `attach`, waits for the next
//! frame.

use std::cell::RefCell;
use std::collections::VecDeque;

use awsm_renderer::anti_alias::AntiAliasing;
use awsm_renderer::core::renderer::{AwsmRendererWebGpuBuilder, DeviceRequestLimits};
use awsm_renderer::debug::{AwsmRendererLogging, TimingTier};
use awsm_renderer::web_global;
use awsm_renderer::{AwsmRenderer, AwsmRendererBuilder, RendererLoadingPhase};
use awsm_renderer_scene_loader::basis::{configure, BasisWorkerConfig};
use js_sys::SharedArrayBuffer;
use wasm_bindgen::prelude::*;
use web_sys::{DedicatedWorkerGlobalScope, GpuAdapter, OffscreenCanvas};

use crate::bridge::{Bridge, Command, Record};
use crate::camera;
use crate::page;
use crate::profile::{Phase, Profile};
use crate::scene::{self, SceneIndex};
use crate::slots::Slots;

/// The anti-aliasing the page's Settings ask for. The page offers Off, SMAA
/// and 4× MSAA, never both at once: on top of an MSAA resolve SMAA gains
/// little, and it costs a full-screen pass of its own. It is the cheap option
/// for when MSAA is too expensive.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AntiAliasMode {
    pub msaa: bool,
    pub smaa: bool,
}

impl AntiAliasMode {
    /// The renderer's configuration for this mode. 4 is the only MSAA sample
    /// count the renderer supports; mipmapping is always on.
    fn config(self) -> AntiAliasing {
        AntiAliasing {
            msaa_sample_count: self.msaa.then_some(4),
            smaa: self.smaa,
            mipmap: true,
        }
    }
}

/// WebGPU guarantees every device at least this largest 2D texture size. It is
/// what the page is told when the adapter cannot be asked.
const MIN_MAX_TEXTURE_DIMENSION_2D: u32 = 8192;

/// The awsm-renderer release the vendored Basis transcoder files came with.
/// It is appended to their URLs as `?v=…`: those files keep their names from
/// one release to the next, so after a deployed upgrade a browser could
/// otherwise pair a cached old transcoder with the new worker script. Bump it
/// together with the awsm-renderer version in Cargo.toml.
const BASIS_VERSION: &str = "0.45.0";

/// Frames drawn before the page is told the scene is on screen. The very
/// first frames after a load still have uploads settling; this is when the
/// picture is actually there, and the loading overlay can go.
const FRAMES_BEFORE_READY: u32 = 3;

/// What the page's messages have asked for, and the running renderer.
#[derive(Default)]
struct State {
    /// The canvas handed over by `init`. Kept here so `resize` works at any
    /// time, including while the scene is still loading.
    canvas: Option<OffscreenCanvas>,
    /// The latest `attach` that has not been acted on yet.
    pending_attach: Option<AttachRequest>,
    /// The latest anti-aliasing change that has not been applied yet.
    pending_anti_alias: Option<AntiAliasMode>,
    /// Set while a [`Job`] runs. `app` is `None` for that time: the job owns
    /// the renderer across its awaits.
    busy: bool,
    /// A `detach` that arrived while `busy`, to be acted on when the job hands
    /// the renderer back.
    detach_while_busy: bool,
    /// `None` until start-up has finished, and while `busy`.
    app: Option<App>,
}

/// Work that needs the renderer to itself across awaits. The `App` is taken
/// out of [`STATE`] while it runs, so no frame is drawn, and the app thread,
/// which is woken by frames, simply sleeps. Page messages that arrive
/// meanwhile wait in `State` (see [`run_job`]).
enum Job {
    /// The page's Settings changed the anti-aliasing.
    AntiAlias(AntiAliasMode),
    /// The app sent `BRIDGE_CMD_RELOAD_SCENE`.
    ReloadScene,
}

struct AttachRequest {
    memory: SharedArrayBuffer,
    bridge_ptr: u32,
}

thread_local! {
    static STATE: RefCell<State> = RefCell::new(State::default());

    /// The one `requestAnimationFrame` callback, created on first use and
    /// handed to the browser again after every frame.
    static FRAME_CALLBACK: Closure<dyn FnMut(f64)> = Closure::new(on_frame);

    /// This worker's global object, looked up once. (The renderer's own
    /// `request_animation_frame` helper works out whether it is on a page or
    /// in a worker on every call, which costs a caught exception per frame
    /// here. This module always runs in a dedicated worker.)
    static WORKER_SCOPE: DedicatedWorkerGlobalScope = js_sys::global().unchecked_into();
}

/// `{type: 'init'}`: start rendering to `canvas`. `base_url` is the absolute
/// URL of the site root; a worker cannot rely on relative URLs resolving
/// against the page.
pub fn init(
    canvas: OffscreenCanvas,
    base_url: String,
    width: u32,
    height: u32,
    anti_alias: AntiAliasMode,
) {
    let first = STATE.with(|state| {
        let mut state = state.borrow_mut();
        if state.canvas.is_some() {
            return false;
        }
        state.canvas = Some(canvas.clone());
        true
    });
    if !first {
        page::post_error("the renderer was sent `init` more than once");
        return;
    }
    resize(width, height);

    let base_url = if base_url.ends_with('/') {
        base_url
    } else {
        format!("{base_url}/")
    };
    wasm_bindgen_futures::spawn_local(async move {
        match App::boot(canvas, &base_url, anti_alias).await {
            Ok(app) => {
                STATE.with(|state| state.borrow_mut().app = Some(app));
                request_frame();
            }
            Err(message) => page::post_error(&message),
        }
    });
}

/// `{type: 'resize'}`: the canvas's backing store should be `width` × `height`
/// device pixels. The renderer reads the surface size back every frame, so
/// resizing the canvas is all there is to do.
pub fn resize(width: u32, height: u32) {
    // A canvas with a zero side has no surface to draw to. Keep the last good
    // size until the page reports a real one.
    if width == 0 || height == 0 {
        return;
    }
    STATE.with(|state| {
        if let Some(canvas) = &state.borrow().canvas {
            // Assigning a dimension discards the current drawing buffer even
            // when the value is unchanged, so only assign on a real change.
            if canvas.width() != width {
                canvas.set_width(width);
            }
            if canvas.height() != height {
                canvas.set_height(height);
            }
        }
    });
}

/// `{type: 'anti-alias'}`: the page's Settings changed the anti-aliasing. It
/// is applied by the next frame (or once start-up has finished); a newer
/// change replaces one that has not been applied yet.
pub fn anti_alias(mode: AntiAliasMode) {
    STATE.with(|state| state.borrow_mut().pending_anti_alias = Some(mode));
}

/// `{type: 'attach'}`: an app instance is running; its bridge block is at
/// byte offset `bridge_ptr` of `memory`. May arrive before the scene has
/// loaded, and again whenever the app is replaced.
pub fn attach(memory: JsValue, bridge_ptr: u32) {
    match memory.dyn_into::<SharedArrayBuffer>() {
        Ok(memory) => STATE.with(|state| {
            state.borrow_mut().pending_attach = Some(AttachRequest { memory, bridge_ptr });
        }),
        Err(_) => page::post_error(
            "attach: `memory` is not a SharedArrayBuffer (is the page cross-origin isolated?)",
        ),
    }
}

/// `{type: 'detach'}`: the app is going away. Stop touching its memory; the
/// scene stays on screen as it last was.
pub fn detach() {
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        state.pending_attach = None;
        if let Some(app) = state.app.as_mut() {
            app.detach();
        } else if state.busy {
            state.detach_while_busy = true;
        }
    });
}

fn request_frame() {
    FRAME_CALLBACK.with(|callback| {
        let function = callback.as_ref().unchecked_ref();
        let requested = WORKER_SCOPE.with(|scope| scope.request_animation_frame(function));
        if let Err(err) = requested {
            page::post_error(&format!("requestAnimationFrame failed: {err:?}"));
        }
    });
}

/// The `requestAnimationFrame` callback. `frame_ms` is the browser's timestamp
/// for the frame being prepared.
fn on_frame(frame_ms: f64) {
    let job = STATE.with(|state| {
        let mut state = state.borrow_mut();
        let State {
            app,
            pending_attach,
            pending_anti_alias,
            busy,
            ..
        } = &mut *state;
        let running = app.as_mut()?;
        // An anti-aliasing change is applied instead of drawing a frame; a
        // scene reload is something the app asks for during one.
        let job = match pending_anti_alias.take() {
            Some(mode) => Job::AntiAlias(mode),
            None => running.frame(frame_ms, pending_attach)?,
        };
        *busy = true;
        app.take().map(|app| (app, job))
    });
    // Started only now that STATE is released: the job borrows it again
    // when it hands the `App` back.
    if let Some((app, job)) = job {
        wasm_bindgen_futures::spawn_local(run_job(app, job));
    }
    request_frame();
}

/// Runs a [`Job`], then hands the `App` back to the frame loop, whether the
/// job worked or not (a failure has posted an `error`), so the page is never
/// left frozen. A `detach` that arrived meanwhile is acted on now; an
/// `attach`, an anti-aliasing change or a `resize` needs nothing special: the
/// first two wait in `State` for the next frame, and the canvas is resized
/// directly.
async fn run_job(mut app: App, job: Job) {
    match job {
        Job::AntiAlias(mode) => app.apply_anti_aliasing(mode).await,
        Job::ReloadScene => app.reload_scene().await,
    }
    STATE.with(|state| {
        let mut state = state.borrow_mut();
        if std::mem::take(&mut state.detach_while_busy) {
            app.detach();
        }
        state.busy = false;
        state.app = Some(app);
    });
}

/// Asks the GPU the two things the page needs to size the canvas, and posts
/// them: whether the adapter is a software fallback, and its largest 2D
/// texture. This is a separate, lightweight adapter request, made before the
/// renderer builds its own device. If it fails, the page gets the safe
/// defaults (not a fallback, the minimum every WebGPU device supports).
async fn report_gpu_info(gpu: &web_sys::Gpu) {
    let adapter = gpu
        .request_adapter()
        .await
        .ok()
        .filter(|adapter| !adapter.is_null() && !adapter.is_undefined())
        .map(|adapter| adapter.unchecked_into::<GpuAdapter>());
    let (is_fallback, max_texture_dim) = match adapter {
        Some(adapter) => (
            adapter.info().is_fallback_adapter(),
            adapter.limits().max_texture_dimension_2d(),
        ),
        None => (false, MIN_MAX_TEXTURE_DIMENSION_2D),
    };
    tracing::info!("gpu: fallback adapter {is_fallback}, largest 2D texture {max_texture_dim}");
    page::post_gpu_info(is_fallback, max_texture_dim);
}

/// The running renderer and everything that feeds it.
struct App {
    renderer: AwsmRenderer,
    /// For measuring how long a frame's work takes.
    performance: web_sys::Performance,
    scene: SceneIndex,
    slots: Slots,
    /// The absolute URL of the site root, ending in `/`: where the scene is
    /// loaded from, again on a reload.
    base_url: String,
    /// The app's bridge block. `None` while no app is attached.
    bridge: Option<Bridge>,
    /// Whether an app has changed the scene since it was loaded: the `used`
    /// flag of the next SCENE_BEGIN. Set by the first command an app sends,
    /// cleared by a reload.
    scene_used: bool,
    /// The frame-clock time this renderer stored for the attached app at the
    /// start of the previous frame. This frame draws one step before it.
    /// `None` right after attaching.
    published_frame_us: Option<u32>,
    /// Scene records still to be handed to the app. They are queued here and
    /// moved into the ring as it has room, so a scene with more named nodes
    /// than the ring holds is still described completely.
    outbox: VecDeque<Record>,
    frames_drawn: u32,
    /// The renderer's GPU frame-time sample count last published to the
    /// bridge. Timestamp readbacks arrive a few frames late, so the totals are
    /// only written when a new sample has come in.
    gpu_samples_published: Option<u64>,
    /// The breakdowns the page's stats panel asks for (see [`Profile`]).
    profile: Profile,
    /// The previous frame's `requestAnimationFrame` timestamp, for the frame
    /// span the page's stats panel turns into missed frames.
    last_frame_ms: Option<f64>,
    /// Set while frames are failing, so a persistent failure is reported once
    /// rather than sixty times a second.
    render_failing: bool,
    /// The same for advancing the scene's clips.
    animation_failing: bool,
    warned_unknown_record: bool,
}

impl App {
    /// Creates the renderer on `canvas` and loads the scene into it.
    async fn boot(
        canvas: OffscreenCanvas,
        base_url: &str,
        anti_alias: AntiAliasMode,
    ) -> Result<Self, String> {
        let gpu = web_global::navigator_gpu()
            .ok_or("WebGPU is not available in this browser (the worker has no navigator.gpu)")?;
        let performance =
            web_global::performance().ok_or("the worker has no `performance` object")?;

        // Compressed (KTX2) textures are transcoded in a helper worker, and
        // the loader has to be told where the page serves that worker and its
        // transcoder module before the first load. The demo scene has no
        // textures, so nothing is ever fetched from these URLs; a scene
        // exported from the awsm editor with textures needs them.
        configure(BasisWorkerConfig::player(
            format!("{base_url}workers/basis-worker.js?v={BASIS_VERSION}"),
            format!("{base_url}vendor/basis/basis_transcoder.js?v={BASIS_VERSION}"),
        ));

        page::post_progress("render worker: requesting WebGPU device…");
        // First, so the page can settle the canvas size before the slow part.
        report_gpu_info(&gpu).await;
        let gpu_builder = AwsmRendererWebGpuBuilder::new_with_offscreen_canvas(gpu, canvas)
            .with_device_request_limits(DeviceRequestLimits::max_all());
        let mut renderer = AwsmRendererBuilder::new(gpu_builder)
            // Built with the page's anti-aliasing from the start, so start-up
            // compiles exactly the pipelines this session uses.
            .with_anti_aliasing(anti_alias.config())
            // GPU timestamp queries, folded into one whole-frame time for the
            // page's stats panel ("gpu time"). Cheap, and silently off on a
            // device without `timestamp-query`.
            .with_logging(AwsmRendererLogging {
                gpu: TimingTier::Frame,
                ..Default::default()
            })
            .with_phase_handler(|phase| {
                if matches!(phase, RendererLoadingPhase::Init) {
                    page::post_progress("renderer init: GPU device + core resources…");
                }
            })
            .build()
            .await
            .map_err(|err| format!("could not create the renderer: {err}"))?;
        page::post_progress(&format!(
            "render worker: WebGPU device + renderer ready (msaa {}, smaa {})",
            anti_alias.msaa, anti_alias.smaa
        ));

        let scene = scene::load(&mut renderer, base_url).await?;
        page::post_progress("starting render loop…");

        Ok(Self {
            renderer,
            performance,
            scene,
            slots: Slots::new(0),
            base_url: base_url.to_owned(),
            bridge: None,
            scene_used: false,
            published_frame_us: None,
            outbox: VecDeque::new(),
            frames_drawn: 0,
            gpu_samples_published: None,
            profile: Profile::default(),
            last_frame_ms: None,
            render_failing: false,
            animation_failing: false,
            warned_unknown_record: false,
        })
    }

    /// One display frame. Returns the job the app asked for during it, if
    /// any: a scene reload.
    fn frame(&mut self, frame_ms: f64, pending_attach: &mut Option<AttachRequest>) -> Option<Job> {
        let work_start = self.performance.now();

        // The app is told about the scene only once the scene is on screen.
        if self.frames_drawn >= FRAMES_BEFORE_READY {
            if let Some(request) = pending_attach.take() {
                self.attach(request);
            }
        }

        // Phase timing for the stats panel, only while it asks (profile.rs).
        self.profile
            .begin_frame(&mut self.renderer, self.bridge.as_ref());
        let mut lap_ms = work_start;

        let mut late = false;
        let mut job = None;
        let mut display_us = None;
        if let Some(bridge) = self.bridge.as_ref() {
            // The moment this frame shows: one step before the frame time
            // stored at the start of the previous frame. The app's burst for
            // that frame time ended on a step at or after it, so the two steps
            // around it are published by now unless the app is late. Fixed
            // before the app is woken below, so its next burst cannot move it.
            let step_us = (1e6 / f64::from(bridge.step_hz())).round() as u32;
            display_us = self
                .published_frame_us
                .map(|frame_us| frame_us.wrapping_sub(step_us));

            // Then start the app on this frame's steps right away, so its
            // burst has the whole frame to run in. The frame clock is this
            // frame's timestamp in microseconds, wrapped to 32 bits.
            let frame_us = (frame_ms * 1000.0).round() as u64 as u32;
            bridge.begin_frame(frame_us);
            self.published_frame_us = Some(frame_us);
        }

        // The scene's own motion, by the real time since the previous frame.
        // Before the app's commands and poses below, so on a node the app
        // drives, the app's pose is the one drawn.
        lap_ms = self.profile.lap(Phase::ReadApp, &self.performance, lap_ms);
        let dt_ms = self
            .last_frame_ms
            .map_or(0.0, |last| (frame_ms - last).max(0.0));
        self.animate(dt_ms);
        lap_ms = self.profile.lap(Phase::Animate, &self.performance, lap_ms);

        if let Some(bridge) = self.bridge.as_mut() {
            // Hand over as much of the scene description as the ring takes.
            while let Some(record) = self.outbox.front() {
                if !bridge.try_send(record) {
                    break;
                }
                self.outbox.pop_front();
            }

            // Act on what the app asked for since the last frame.
            while let Some(record) = bridge.receive() {
                match record.command() {
                    Command::Bind { slot, node } => {
                        self.scene_used = true;
                        self.slots.bind(&mut self.renderer, &self.scene, slot, node)
                    }
                    Command::ReloadScene => {
                        // Anything the app sent after this is meant for the
                        // reloaded scene, so it stays in the ring until then.
                        job = Some(Job::ReloadScene);
                        break;
                    }
                    Command::Unknown { kind } => {
                        if !self.warned_unknown_record {
                            self.warned_unknown_record = true;
                            tracing::warn!(
                                "skipping app-to-renderer records of unknown type {kind} \
                                 (is the renderer older than the app?)"
                            );
                        }
                    }
                }
            }

            // Move every bound node to that moment: poses interpolated between
            // the two steps around it.
            let (sample, held) = bridge.sample_at(display_us);
            late = held;
            self.slots.apply(&mut self.renderer, &sample);
        }

        lap_ms = self.profile.lap(Phase::ReadApp, &self.performance, lap_ms);

        // Resolve the transforms written above into world matrices and refresh
        // everything derived from them (bounds, culling, lights, shadows).
        // Before the camera, which is read off its node's world matrix.
        self.renderer.update_transforms();
        lap_ms = self
            .profile
            .lap(Phase::UpdateTransforms, &self.performance, lap_ms);
        // The camera is set every frame, even when it has not moved: this is
        // where the renderer picks up the surface's current aspect ratio.
        let (view, params) = camera::view_and_params(&self.renderer, self.scene.camera.as_ref());
        let camera_set = self
            .renderer
            .set_camera(view, params)
            .map_err(|err| err.to_string());
        lap_ms = self
            .profile
            .lap(Phase::SetCamera, &self.performance, lap_ms);
        let drawn =
            camera_set.and_then(|()| self.renderer.render(None).map_err(|err| err.to_string()));
        self.profile.lap(Phase::Render, &self.performance, lap_ms);
        match drawn {
            Ok(()) => {
                self.render_failing = false;
                self.frames_drawn = self.frames_drawn.saturating_add(1);
                if self.frames_drawn == FRAMES_BEFORE_READY {
                    page::post_ready();
                }
            }
            Err(message) => {
                if !self.render_failing {
                    self.render_failing = true;
                    page::post_error(&format!("drawing a frame failed: {message}"));
                }
            }
        }

        // The frame's stats. (The app was already woken at the start of the
        // frame, whether or not the frame could be drawn: a rendering problem
        // should not also freeze the app.)
        if let Some(bridge) = self.bridge.as_mut() {
            self.profile.end_frame(bridge, frame_ms);
            if let Some(gpu) = awsm_renderer::profiling::gpu_frame_timing() {
                if self.gpu_samples_published != Some(gpu.count) {
                    self.gpu_samples_published = Some(gpu.count);
                    // Both wrap at 2^32, like every counter in the stats.
                    bridge.set_gpu_totals((gpu.total_ms * 1000.0) as u64 as u32, gpu.count as u32);
                }
            }
            let work_us = (self.performance.now() - work_start) * 1000.0;
            // Rounded per frame; the page divides whole seconds of these by a
            // refresh period, so sub-microsecond loss does not matter.
            let span_us = self
                .last_frame_ms
                .map_or(0.0, |last| ((frame_ms - last) * 1000.0).round());
            bridge.frame_presented(
                work_us.max(0.0) as u32,
                span_us.clamp(0.0, u32::MAX as f64) as u32,
                late,
            );
        }
        self.last_frame_ms = Some(frame_ms);
        job
    }

    /// Advances what the scene animates by itself: its clips and texture UV
    /// flows (`update_animations`, which writes the transforms, morphs and
    /// material values they target) and its particle emitters. A clip may move
    /// the camera node too: the view is read off its world matrix below.
    ///
    /// A clip is best kept off the nodes the app binds: a slot writes its pose
    /// only when the pose changes, so on a node at rest the clip would show.
    fn animate(&mut self, dt_ms: f64) {
        match self.renderer.update_animations(dt_ms) {
            Ok(()) => self.animation_failing = false,
            Err(err) => {
                if !self.animation_failing {
                    self.animation_failing = true;
                    tracing::warn!("advancing the scene's clips failed: {err}");
                }
            }
        }
        self.scene
            .particles
            .tick(&mut self.renderer, (dt_ms / 1000.0) as f32);
    }

    /// Connects to an app instance's bridge block, replacing any previous one.
    fn attach(&mut self, request: AttachRequest) {
        // Whatever happens next, the previous app's memory is not read again.
        self.detach();

        let bridge = match Bridge::attach(&request.memory, request.bridge_ptr) {
            Ok(bridge) => bridge,
            Err(message) => {
                page::post_error(&format!("cannot attach to the app: {message}"));
                return;
            }
        };

        // A new app instance knows nothing of what the previous one set up, so
        // it gets the scene exactly as it was loaded.
        self.slots
            .reset(&mut self.renderer, &self.scene, bridge.pose_capacity());
        // The new app has published nothing for any earlier frame time.
        self.published_frame_us = None;
        // The new block's GPU totals start at zero; publish ours on the next
        // frame rather than waiting for the next sample.
        self.gpu_samples_published = None;

        self.describe_scene();
        self.bridge = Some(bridge);
    }

    /// Queues the scene description for the app: BEGIN, every named node,
    /// READY.
    fn describe_scene(&mut self) {
        let nodes = self.scene.nodes();
        self.outbox.push_back(Record::scene_begin(self.scene_used));
        self.outbox.extend(nodes.iter().map(|node| {
            Record::scene_node(
                node.name_hash,
                node.world.translation.to_array(),
                node.world.rotation.to_array(),
                node.world.scale.to_array(),
            )
        }));
        self.outbox
            .push_back(Record::scene_ready(nodes.len() as u32));
    }

    /// [`Job::AntiAlias`]: applies an anti-aliasing change. Only the first
    /// switch to a given mode really compiles anything; the renderer keeps the
    /// pipelines of modes it has used, so switching back is quick.
    async fn apply_anti_aliasing(&mut self, mode: AntiAliasMode) {
        page::post_aa_compile_start(mode.msaa, mode.smaa);
        let applied = match self.renderer.set_anti_aliasing(mode.config()).await {
            // Changing the configuration only marks what has to be rebuilt;
            // the compiling happens in `commit_load`, whose progress the page
            // shows.
            Ok(()) => {
                let mut last_line = String::new();
                self.renderer
                    .commit_load(|stats| {
                        let Some(line) = stats.phase_label() else {
                            return;
                        };
                        if line != last_line {
                            page::post_aa_compile_progress(&line);
                            last_line = line;
                        }
                    })
                    .await
                    .map(|_| ())
                    .map_err(|err| format!("anti-aliasing pipelines: {err}"))
            }
            Err(err) => Err(format!("anti-aliasing change: {err}")),
        };
        match applied {
            Ok(()) => tracing::info!(
                "anti-aliasing applied (msaa {}, smaa {})",
                mode.msaa,
                mode.smaa
            ),
            Err(message) => page::post_error(&message),
        }
        // Always, even after a failure: the page lowers its overlay on this.
        page::post_aa_compile_done();
    }

    /// [`Job::ReloadScene`]: throws the whole scene away and loads it again
    /// from scene.toml, on the same GPU device, then starts over exactly as
    /// after the first load: the page shows its loading screen until `ready`,
    /// and the app gets a fresh description (BEGIN with `used` false).
    async fn reload_scene(&mut self) {
        page::post_loading();
        page::post_progress("reloading the scene…");
        if let Err(message) = self.replace_scene().await {
            page::post_error(&format!("reloading the scene failed: {message}"));
        }

        // Nothing measured or queued before the reload carries over.
        self.outbox.clear();
        // `ready` is posted again once the new scene is on screen.
        self.frames_drawn = 0;
        self.render_failing = false;
        // The first frame after the pause draws the newest step rather than a
        // moment from before it, and the pause is not reported as a frame.
        self.published_frame_us = None;
        self.last_frame_ms = None;
        self.gpu_samples_published = None;
        self.scene_used = false;
        if self.bridge.is_some() {
            self.describe_scene();
        }
    }

    /// The renderer half of [`App::reload_scene`]. On an error the renderer
    /// holds either the old scene, as loaded (the wipe failed), or no scene
    /// at all (loading failed); `scene` and `slots` match it either way.
    async fn replace_scene(&mut self) -> Result<(), String> {
        let capacity = self.bridge.as_ref().map_or(0, Bridge::pose_capacity);
        // Put bound nodes back where they were authored while the renderer
        // they belong to still exists: if the wipe below fails, the old scene
        // is what stays, and it has to be as loaded.
        self.slots.reset(&mut self.renderer, &self.scene, capacity);

        // `remove_all` rebuilds the renderer on the same device from the
        // settings it was BUILT with (logging and GPU timing included). The
        // anti-aliasing may have changed since, through the page's Settings,
        // so the current mode is put back afterwards.
        let anti_aliasing = self.renderer.anti_aliasing.clone();
        self.renderer
            .remove_all()
            .await
            .map_err(|err| format!("could not clear the renderer: {err}"))?;

        // Everything derived from the old scene names renderer objects that
        // no longer exist. It is dropped, never released against the new
        // renderer.
        self.scene = SceneIndex::default();
        self.slots = Slots::new(capacity);

        // Before the load, so its pipeline compile includes this mode.
        if let Err(err) = self.renderer.set_anti_aliasing(anti_aliasing).await {
            page::post_error(&format!("restoring the anti-aliasing: {err}"));
        }
        self.scene = scene::load(&mut self.renderer, &self.base_url).await?;
        Ok(())
    }

    /// Forgets the attached app. Everything it was driving stays where it is.
    fn detach(&mut self) {
        self.bridge = None;
        self.outbox.clear();
    }
}
