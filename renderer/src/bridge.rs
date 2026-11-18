//! The renderer's view of the bridge block: the mirror of `app/src/runtime/bridge.h`.
//!
//! The block is a region of the APP module's linear memory. This module is a
//! different wasm instance with its own memory, so it cannot dereference a
//! pointer into the block. What it gets instead is the app memory's
//! `SharedArrayBuffer` plus the block's byte offset inside it, and it reads and
//! writes through JS typed-array views.
//!
//! This file is the only place in the renderer that knows the layout. Two
//! rules from the header shape it:
//!
//! * Where a section sits, how big its elements are and how many there are all
//!   come from the SECTION TABLE in the block's header, read at attach time.
//!   Only offsets INSIDE a fixed struct are constants here.
//! * Fields the header marks `_Atomic` are only touched with `Atomics.*`.
//!
//! Nothing on the per-frame path creates a JS object: every view is built once
//! in [`Bridge::attach`] and reused.

use std::collections::HashMap;
use std::mem::offset_of;

use bytemuck::{Pod, Zeroable};
use js_sys::{Atomics, Int32Array, SharedArrayBuffer, Uint8Array};
use wasm_bindgen::JsValue;

// Every number below is copied from bridge.h. `task test` compares them with
// what the C compiler says, so keep them in this one region, as plain
// literals, and use them by name everywhere else.

// ── bridge.h mirror: begin (checked by tools/check-bridge.mjs) ──

/// `BRIDGE_MAGIC` ('AWSB' as a little-endian word) and `BRIDGE_VERSION`.
mod handshake {
    pub const MAGIC: u32 = 0x4253_5741;
    pub const VERSION: u32 = 1;
}

/// Byte offsets in `bridge_header`.
mod header {
    pub const MAGIC: u32 = 0;
    pub const VERSION: u32 = 4;
    pub const TOTAL_SIZE: u32 = 8;
    pub const HEADER_SIZE: u32 = 12;
    pub const STEP_HZ: u32 = 16;
    pub const FRAME_TICK: u32 = 20;
    pub const FRAME_TIME_US: u32 = 24;
    pub const LATEST_STEP: u32 = 28;
    pub const STATS_OFFSET: u32 = 32;
    pub const STATS_SIZE: u32 = 36;
    pub const SNAPSHOT_OFFSET: u32 = 40;
    pub const SNAPSHOT_COUNT: u32 = 44;
    pub const SNAPSHOT_STRIDE: u32 = 48;
    pub const SNAPSHOT_HEADER_SIZE: u32 = 52;
    pub const POSE_CAPACITY: u32 = 56;
    pub const POSE_STRIDE: u32 = 60;
    /// The first of the ring offsets; ring `i` is at `RING_OFFSET + 4 * i`.
    pub const RING_OFFSET: u32 = 64;
    pub const RING_HEADER_SIZE: u32 = 80;
    pub const RECORD_SIZE: u32 = 84;
    pub const TIMING_OFFSET: u32 = 88;
    pub const TIMING_CAPACITY: u32 = 92;
    pub const TIMING_STRIDE: u32 = 96;
}

/// Byte offsets in `bridge_stats` of the counters the renderer owns.
mod stats {
    pub const FRAME_COUNT: u32 = 4;
    pub const FRAME_WORK_US: u32 = 8;
    pub const FRAME_SPAN_US: u32 = 12;
    pub const GPU_FRAME_US: u32 = 16;
    pub const GPU_FRAME_COUNT: u32 = 20;
    pub const APP_LATE: u32 = 24;
    /// Written by the page: the `detail` bits below.
    pub const DETAIL: u32 = 28;
}

/// `BRIDGE_DETAIL_*`: the breakdowns the page's stats panel is showing.
mod detail {
    pub const RENDERER: u32 = 0x2;
    pub const GPU: u32 = 0x4;
}

/// Byte offsets in `bridge_timing`, the size of its name, and how many
/// entries at the start of the table belong to the app.
mod timing {
    pub const KIND: u32 = 0;
    pub const TOTAL_NS: u32 = 4;
    pub const COUNT: u32 = 8;
    pub const NAME: u32 = 12;
    pub const NAME_SIZE: u32 = 52;
    pub const APP_SLOTS: u32 = 8;
}

/// `BRIDGE_TIMING_*`: what an entry of the timing table measures.
mod timing_kind {
    pub const RENDERER_PHASE: u32 = 2;
    pub const RENDERER_PASS: u32 = 3;
    pub const GPU_PASS: u32 = 4;
    pub const RENDERER_PREP: u32 = 8;
    pub const RENDERER_SUBMIT: u32 = 9;
    pub const RENDERER_HOOK: u32 = 10;
}

/// Byte offsets in `bridge_snapshot_header`.
mod snapshot {
    pub const VERSION: u32 = 0;
    pub const STEP: u32 = 4;
    pub const POSE_COUNT: u32 = 8;
    pub const TIME_US: u32 = 12;
}

/// Byte offsets in `bridge_pose`.
mod pose {
    pub const POSITION: u32 = 0;
    pub const ROTATION: u32 = 12;
    pub const FLAGS: u32 = 28;
}

/// Byte offsets in `bridge_ring`.
mod ring {
    pub const HEAD: u32 = 0;
    pub const TAIL: u32 = 4;
    pub const CAPACITY: u32 = 8;
}

/// Byte offsets in `bridge_record`.
mod record {
    pub const TYPE: u32 = 0;
    pub const STEP: u32 = 4;
    pub const PAYLOAD: u32 = 8;
}

/// `sizeof` of the structs, in bytes.
mod size {
    pub const HEADER: u32 = 128;
    pub const STATS: u32 = 64;
    pub const SNAPSHOT_HEADER: u32 = 16;
    pub const POSE: u32 = 32;
    pub const RING: u32 = 64;
    pub const RECORD: u32 = 64;
    pub const TIMING: u32 = 64;
}

/// `BRIDGE_RING_*`: indices into the header's ring offsets.
mod ring_index {
    pub const RENDERER_TO_APP: u32 = 1;
    pub const APP_TO_RENDERER: u32 = 2;
}

/// `bridge_record.type` values the renderer writes (`SCENE_*`) or reads
/// (`CMD_*`).
mod record_type {
    pub const SCENE_BEGIN: u32 = 16;
    pub const SCENE_NODE: u32 = 17;
    pub const SCENE_READY: u32 = 18;
    pub const CMD_BIND: u32 = 32;
    pub const CMD_RELOAD_SCENE: u32 = 33;
}

/// `BRIDGE_POSE_*` flags.
mod pose_flag {
    pub const ACTIVE: u32 = 0x1;
    pub const TELEPORT: u32 = 0x2;
}

/// What `bridge_hash("foobar")` gives in C: a test vector for the copy below.
mod hash {
    pub const FOOBAR: u32 = 0xbf9c_f968;
}

// ── bridge.h mirror: end ──

/// `bridge_hash()`: 32-bit FNV-1a of the UTF-8 name. Scene nodes are named
/// across the bridge by this hash, so it must produce exactly what the C and
/// JS versions produce. (A `const fn`, hence the plain loop, so that the
/// assert below can hold it to the C test vector at compile time.)
pub const fn bridge_hash(name: &str) -> u32 {
    let bytes = name.as_bytes();
    let mut hash: u32 = 2_166_136_261;
    let mut i = 0;
    while i < bytes.len() {
        hash ^= bytes[i] as u32;
        hash = hash.wrapping_mul(16_777_619);
        i += 1;
    }
    hash
}
const _: () = assert!(bridge_hash("foobar") == hash::FOOBAR);

/// `bridge_pose`: where one object is, in world space.
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
#[repr(C)]
pub struct Pose {
    pub position: [f32; 3],
    /// Quaternion x, y, z, w.
    pub rotation: [f32; 4],
    flags: u32,
}

impl Pose {
    /// The object jumped this step: do not glide into this pose.
    pub fn is_teleport(&self) -> bool {
        self.flags & pose_flag::TELEPORT != 0
    }
}

/// `bridge_snapshot_header`, decoded from a private copy. Every field is
/// listed so the struct has the C layout; `version` and `time_us` are only
/// ever read in place, atomically, so this copy never reads them by name.
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
#[repr(C)]
#[allow(dead_code)]
struct SnapshotHeader {
    version: u32,
    step: u32,
    pose_count: u32,
    time_us: u32,
}

/// The 32-bit words of a record's payload (the header's `u` / `f` union).
const PAYLOAD_WORDS: usize = ((size::RECORD - record::PAYLOAD) / 4) as usize;

/// `bridge_record`: one event in a ring. Which payload word means what
/// depends on `kind` and is spelled out next to the record types in bridge.h;
/// the constructors and [`Record::command`] are the only code that knows it.
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
#[repr(C)]
pub struct Record {
    kind: u32,
    /// The app step a record was written in. The renderer has no use for it,
    /// and writes 0 in its own records.
    #[allow(dead_code)]
    step: u32,
    payload: [u32; PAYLOAD_WORDS],
}

/// A decoded app-to-renderer record.
#[derive(Clone, Copy, Debug)]
pub enum Command {
    /// `BRIDGE_CMD_BIND`: the scene node whose name hashes to `node` follows
    /// pose `slot` from now on.
    Bind { slot: u32, node: u32 },
    /// `BRIDGE_CMD_RELOAD_SCENE`: throw the scene away and load it again.
    ReloadScene,
    /// A record type this build does not know. Records are fixed-size and
    /// tagged precisely so that such a record can simply be skipped.
    Unknown { kind: u32 },
}

// Tie the decoding structs to the checked constants: if bridge.h changes and
// the mirror above is updated, these fail until the structs follow.
const _: () = assert!(size_of::<Pose>() == size::POSE as usize);
const _: () = assert!(offset_of!(Pose, position) == pose::POSITION as usize);
const _: () = assert!(offset_of!(Pose, rotation) == pose::ROTATION as usize);
const _: () = assert!(offset_of!(Pose, flags) == pose::FLAGS as usize);
const _: () = assert!(size_of::<SnapshotHeader>() == size::SNAPSHOT_HEADER as usize);
const _: () = assert!(offset_of!(SnapshotHeader, version) == snapshot::VERSION as usize);
const _: () = assert!(offset_of!(SnapshotHeader, step) == snapshot::STEP as usize);
const _: () = assert!(offset_of!(SnapshotHeader, pose_count) == snapshot::POSE_COUNT as usize);
const _: () = assert!(offset_of!(SnapshotHeader, time_us) == snapshot::TIME_US as usize);
const _: () = assert!(size_of::<Record>() == size::RECORD as usize);
const _: () = assert!(offset_of!(Record, kind) == record::TYPE as usize);
const _: () = assert!(offset_of!(Record, step) == record::STEP as usize);
const _: () = assert!(offset_of!(Record, payload) == record::PAYLOAD as usize);

/// A record seen as the 32-bit words that cross the bridge.
type RecordWords = [u32; size_of::<Record>() / 4];

impl Record {
    fn new(kind: u32) -> Self {
        Self {
            kind,
            ..Self::zeroed()
        }
    }

    /// `BRIDGE_SCENE_BEGIN`: a scene description follows. `used`: an earlier
    /// app instance was attached to this scene (the app was hot-swapped), so
    /// it is not quite as loaded any more.
    pub fn scene_begin(used: bool) -> Self {
        let mut record = Self::new(record_type::SCENE_BEGIN);
        record.payload[0] = u32::from(used);
        record
    }

    /// `BRIDGE_SCENE_NODE`: one named scene node, as authored, in world space.
    pub fn scene_node(
        name_hash: u32,
        translation: [f32; 3],
        rotation: [f32; 4],
        scale: [f32; 3],
    ) -> Self {
        let mut record = Self::new(record_type::SCENE_NODE);
        record.payload[0] = name_hash;
        record.set_floats(1, &translation);
        record.set_floats(4, &rotation);
        record.set_floats(8, &scale);
        record
    }

    /// `BRIDGE_SCENE_READY`: the description is complete; `count` node
    /// records were sent.
    pub fn scene_ready(count: u32) -> Self {
        let mut record = Self::new(record_type::SCENE_READY);
        record.payload[0] = count;
        record
    }

    /// Decodes a record from the app-to-renderer ring.
    pub fn command(&self) -> Command {
        let [slot, node, ..] = self.payload;
        match self.kind {
            record_type::CMD_BIND => Command::Bind { slot, node },
            record_type::CMD_RELOAD_SCENE => Command::ReloadScene,
            kind => Command::Unknown { kind },
        }
    }

    /// Stores `values` as floats in consecutive payload words from `first`.
    fn set_floats(&mut self, first: usize, values: &[f32]) {
        for (word, value) in self.payload[first..].iter_mut().zip(values) {
            *word = value.to_bits();
        }
    }
}

/// How many times a snapshot copy is retried when the app turns out to be
/// writing that snapshot at the same moment. The renderer reads steps the app
/// finished a while ago, so in practice the first attempt succeeds.
const SEQLOCK_ATTEMPTS: u32 = 4;

/// An attached bridge block.
pub struct Bridge {
    /// The whole block as 32-bit words: element `i` is the word at byte offset
    /// `4 * i` from the start of the block. Every atomic field and every ring
    /// record is read and written through this one view. (`Atomics.notify`
    /// only accepts an `Int32Array`, hence the signed type; values are
    /// reinterpreted as `u32` on the way in and out.)
    words: Int32Array,
    step_hz: f32,
    /// Word index of the stats section.
    stats: u32,
    snapshots: SnapshotRing,
    to_app: Ring,
    from_app: Ring,
    timings: TimingTable,
}

/// What the page's stats panel is showing a breakdown of
/// (`bridge_stats.detail`).
#[derive(Clone, Copy, Default)]
pub struct Detail {
    /// The renderer's frame phases and its CPU time per pass.
    pub renderer: bool,
    /// GPU time per pass.
    pub gpu: bool,
}

/// What an entry of the timing table measures (`BRIDGE_TIMING_*`).
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum TimingKind {
    RendererPhase = timing_kind::RENDERER_PHASE as isize,
    RendererPass = timing_kind::RENDERER_PASS as isize,
    GpuPass = timing_kind::GPU_PASS as isize,
    /// The rest of `render()`, by awsm-renderer's own kinds of scope.
    RendererPrep = timing_kind::RENDERER_PREP as isize,
    RendererSubmit = timing_kind::RENDERER_SUBMIT as isize,
    RendererHook = timing_kind::RENDERER_HOOK as isize,
}

/// The renderer's part of the timing table: every entry after the app's.
struct TimingTable {
    /// Word index of the table's first entry.
    first_word: u32,
    /// Words from one entry to the next.
    stride_words: u32,
    capacity: u32,
    /// The next entry not yet given a name.
    next: u32,
    /// Which entry each named total lives in.
    slots: HashMap<(TimingKind, &'static str), u32>,
}

/// Where the snapshot ring is and how a snapshot is laid out.
struct SnapshotRing {
    /// Word index of the first snapshot.
    first_word: u32,
    /// Words from one snapshot to the next.
    stride_words: u32,
    count: u32,
    layout: SnapshotLayout,
    /// One byte view per ring entry, over the app's memory. Created once so
    /// that copying a snapshot is a single `set()` call between two existing
    /// views.
    sources: Vec<Uint8Array>,
    /// The two snapshots a frame interpolates between, copied out of the
    /// shared memory.
    copies: [SnapshotCopy; 2],
}

#[derive(Clone, Copy)]
struct SnapshotLayout {
    header_size: usize,
    pose_stride: usize,
    pose_capacity: u32,
}

/// One event ring, seen from the single side (producer or consumer) that the
/// renderer plays on it.
struct Ring {
    /// Word indices of `head` and `tail`.
    head: u32,
    tail: u32,
    /// Word index of the first record.
    first_record: u32,
    /// Words from one record to the next.
    record_words: u32,
    capacity: u32,
    /// The counter this side owns: `head` on a ring the renderer produces
    /// into, `tail` on a ring it consumes from. Kept here so the shared copy
    /// only ever has to be written, never read back.
    own: u32,
}

/// A private copy of one snapshot, in this module's own memory.
struct SnapshotCopy {
    /// `snapshot_stride` bytes. Never resized, so its address is stable and
    /// `view` stays valid for as long as this module's memory does not grow.
    bytes: Vec<u8>,
    /// A JS view over `bytes`: the destination of the bulk copy.
    view: Uint8Array,
    /// The copied header, decoded once per copy.
    header: SnapshotHeader,
    /// Which step `bytes` holds a verified copy of, if any.
    step: Option<u32>,
}

/// A stable, private copy of one published snapshot.
#[derive(Clone, Copy)]
pub struct Snapshot<'a> {
    header: &'a SnapshotHeader,
    bytes: &'a [u8],
    layout: SnapshotLayout,
}

/// The snapshots around one display moment, ready to interpolate.
#[derive(Default)]
pub struct Sample<'a> {
    /// The snapshot at or just before the display moment. `None` only if
    /// nothing readable has been published.
    pub older: Option<Snapshot<'a>>,
    /// The snapshot one step after `older`, when it has been published.
    pub newer: Option<Snapshot<'a>>,
    /// How far the display moment is from `older` towards `newer`, 0..1.
    /// Zero when there is no `newer`.
    pub alpha: f32,
}

impl Bridge {
    /// Validates the block at byte offset `bridge_ptr` of `memory` and builds
    /// every view the renderer will use.
    ///
    /// The error is a message for the page: a mismatch here means the app and
    /// the renderer were built against different layouts, and drawing from
    /// memory that is not what we think it is would only show garbage.
    pub fn attach(memory: &SharedArrayBuffer, bridge_ptr: u32) -> Result<Self, String> {
        let buffer: &JsValue = memory.as_ref();
        let memory_size = u64::from(memory.byte_length());
        let block_start = u64::from(bridge_ptr);

        if !bridge_ptr.is_multiple_of(4) || block_start + u64::from(size::HEADER) > memory_size {
            return Err(format!(
                "the bridge pointer {bridge_ptr:#x} is misaligned or outside the app memory \
                 ({memory_size} bytes)"
            ));
        }

        // Look at the header alone first: nothing else in the block can be
        // trusted until the handshake has passed.
        let head =
            Int32Array::new_with_byte_offset_and_length(buffer, bridge_ptr, size::HEADER / 4);
        let field = |offset: u32| head.get_index(offset / 4) as u32;

        let magic = field(header::MAGIC);
        if magic != handshake::MAGIC {
            return Err(format!(
                "no bridge block at {bridge_ptr:#x}: expected magic {:#010x}, found {magic:#010x}",
                handshake::MAGIC
            ));
        }
        let version = field(header::VERSION);
        if version != handshake::VERSION {
            return Err(format!(
                "bridge version mismatch: the app speaks version {version}, this renderer \
                 speaks version {}. Rebuild the renderer against the app's bridge.h.",
                handshake::VERSION
            ));
        }

        let step_hz = f32::from_bits(field(header::STEP_HZ));
        if !(1.0..=10_000.0).contains(&step_hz) {
            return Err(format!(
                "the app reports an unusable step rate: {step_hz} Hz"
            ));
        }

        // The section table. Everything else is found through it, so it must
        // describe sections that lie inside the block (word-aligned, since
        // they are read through a 32-bit view) and are at least as big as the
        // structs this renderer reads from them.
        let total_size = field(header::TOTAL_SIZE);
        let stats_offset = field(header::STATS_OFFSET);
        let snapshot_offset = field(header::SNAPSHOT_OFFSET);
        let snapshot_count = field(header::SNAPSHOT_COUNT);
        let snapshot_stride = field(header::SNAPSHOT_STRIDE);
        let snapshot_header_size = field(header::SNAPSHOT_HEADER_SIZE);
        let pose_capacity = field(header::POSE_CAPACITY);
        let pose_stride = field(header::POSE_STRIDE);
        let ring_header_size = field(header::RING_HEADER_SIZE);
        let record_size = field(header::RECORD_SIZE);
        let timing_offset = field(header::TIMING_OFFSET);
        let timing_capacity = field(header::TIMING_CAPACITY);
        let timing_stride = field(header::TIMING_STRIDE);
        let inconsistent = || {
            format!(
                "the bridge block's section table is inconsistent ({total_size} bytes at \
                 {bridge_ptr:#x}, in an app memory of {memory_size} bytes)"
            )
        };
        let fits = |offset: u32, len: u64| {
            offset.is_multiple_of(4) && u64::from(offset) + len <= u64::from(total_size)
        };
        let poses_end =
            u64::from(snapshot_header_size) + u64::from(pose_capacity) * u64::from(pose_stride);
        let table_ok = field(header::HEADER_SIZE) >= size::HEADER
            && total_size.is_multiple_of(4)
            && block_start + u64::from(total_size) <= memory_size
            && field(header::STATS_SIZE) >= size::STATS
            && fits(stats_offset, u64::from(size::STATS))
            && snapshot_count.is_power_of_two()
            && snapshot_stride.is_multiple_of(4)
            && snapshot_header_size >= size::SNAPSHOT_HEADER
            && pose_stride >= size::POSE
            && poses_end <= u64::from(snapshot_stride)
            && fits(
                snapshot_offset,
                u64::from(snapshot_count) * u64::from(snapshot_stride),
            )
            && ring_header_size >= size::RING
            && ring_header_size.is_multiple_of(4)
            && record_size >= size::RECORD
            && record_size.is_multiple_of(4)
            && timing_stride >= size::TIMING
            && timing_stride.is_multiple_of(4)
            && timing_capacity >= timing::APP_SLOTS
            && fits(
                timing_offset,
                u64::from(timing_capacity) * u64::from(timing_stride),
            );
        if !table_ok {
            return Err(inconsistent());
        }

        // The block fits in the memory: view all of it.
        let words = Int32Array::new_with_byte_offset_and_length(buffer, bridge_ptr, total_size / 4);

        let open_ring = |which: u32| -> Result<Ring, String> {
            let offset = field(header::RING_OFFSET + 4 * which);
            if !fits(offset, u64::from(ring_header_size)) {
                return Err(inconsistent());
            }
            // A ring's capacity is in its own header, not in the table.
            let capacity = words.get_index((offset + ring::CAPACITY) / 4) as u32;
            let bytes = u64::from(ring_header_size) + u64::from(capacity) * u64::from(record_size);
            if !capacity.is_power_of_two() || !fits(offset, bytes) {
                return Err(inconsistent());
            }
            Ok(Ring {
                head: (offset + ring::HEAD) / 4,
                tail: (offset + ring::TAIL) / 4,
                first_record: (offset + ring_header_size) / 4,
                record_words: record_size / 4,
                capacity,
                own: 0,
            })
        };
        let mut to_app = open_ring(ring_index::RENDERER_TO_APP)?;
        let mut from_app = open_ring(ring_index::APP_TO_RENDERER)?;
        // Carry on from wherever each ring currently stands.
        to_app.own = load(&words, to_app.head);
        from_app.own = load(&words, from_app.tail);

        let sources = (0..snapshot_count)
            .map(|index| {
                Uint8Array::new_with_byte_offset_and_length(
                    buffer,
                    bridge_ptr + snapshot_offset + index * snapshot_stride,
                    snapshot_stride,
                )
            })
            .collect();
        let snapshots = SnapshotRing {
            first_word: snapshot_offset / 4,
            stride_words: snapshot_stride / 4,
            count: snapshot_count,
            layout: SnapshotLayout {
                header_size: snapshot_header_size as usize,
                pose_stride: pose_stride as usize,
                pose_capacity,
            },
            sources,
            copies: [
                SnapshotCopy::new(snapshot_stride as usize),
                SnapshotCopy::new(snapshot_stride as usize),
            ],
        };

        Ok(Self {
            words,
            step_hz,
            stats: stats_offset / 4,
            snapshots,
            to_app,
            from_app,
            timings: TimingTable {
                first_word: timing_offset / 4,
                stride_words: timing_stride / 4,
                capacity: timing_capacity,
                next: timing::APP_SLOTS,
                slots: HashMap::new(),
            },
        })
    }

    /// The app's fixed simulation rate, steps per second.
    pub fn step_hz(&self) -> f32 {
        self.step_hz
    }

    /// Number of pose slots in every snapshot.
    pub fn pose_capacity(&self) -> usize {
        self.snapshots.layout.pose_capacity as usize
    }

    /// The newest step the app has finished publishing (0: none yet).
    fn latest_step(&self) -> u32 {
        load(&self.words, header::LATEST_STEP / 4)
    }

    /// Starts a frame for the app: stores the frame's time on the frame clock,
    /// then bumps the frame tick and wakes the app, which sleeps on that word
    /// between frames. In that order, so an app that sees the new tick also
    /// sees the new time.
    pub fn begin_frame(&self, frame_time_us: u32) {
        store(&self.words, header::FRAME_TIME_US / 4, frame_time_us);
        let _ = Atomics::add(&self.words, header::FRAME_TICK / 4, 1);
        let _ = Atomics::notify(&self.words, header::FRAME_TICK / 4);
    }

    /// Copies out the snapshots to draw for the moment `display_us` on the
    /// frame clock (bridge.h, "Frame pacing"): the two consecutive steps whose
    /// times are around it, and how far between them it lies. Also says
    /// whether the app was late, i.e. had not yet published a step past that
    /// moment.
    ///
    /// The newest snapshot is returned on its own (alpha 0) when there is no
    /// pair to interpolate: the app is late (it is held until the app catches
    /// up), `display_us` is `None` (the first frame after attaching), or the
    /// steps wanted were already overwritten after a long stall.
    pub fn sample_at(&mut self, display_us: Option<u32>) -> (Sample<'_>, bool) {
        let latest = self.latest_step();
        if latest == 0 {
            return (Sample::default(), false);
        }
        let (older, newer, alpha, late) = match display_us {
            Some(display_us) => self.bracket(latest, display_us),
            None => (latest, None, 0.0, false),
        };

        let mut older_copy = self.fetch(older, None);
        let mut newer_copy = match (older_copy, newer) {
            (Some(held), Some(step)) => self.fetch(step, Some(held)),
            _ => None,
        };
        if older_copy.is_none() || (newer.is_some() && newer_copy.is_none()) {
            // The pair could not be read: hold the newest step instead.
            older_copy = self.fetch(latest, None);
            newer_copy = None;
        }

        let snapshots = &self.snapshots;
        (
            Sample {
                older: older_copy.map(|index| snapshots.view(index)),
                newer: newer_copy.map(|index| snapshots.view(index)),
                alpha: if newer_copy.is_some() { alpha } else { 0.0 },
            },
            late,
        )
    }

    /// Finds the steps around `display_us`, reading only the times in the
    /// snapshot headers (no copies). Returns (older step, newer step, alpha,
    /// late).
    fn bracket(&self, latest: u32, display_us: u32) -> (u32, Option<u32>, f32, bool) {
        let hold = (latest, None, 0.0, false);
        let Some(latest_time) = self.step_time(latest) else {
            return hold;
        };
        // Compared by signed difference, because the frame clock wraps.
        let after = |time: u32| time.wrapping_sub(display_us) as i32 > 0;
        if !after(latest_time) {
            // The app has not published past that moment yet: hold its newest
            // step. (Exactly AT the moment, the newest step is the right
            // picture and the app is not late.)
            return (latest, None, 0.0, latest_time != display_us);
        }
        // Walk back to the newest step at or before the moment. While this
        // runs the app may be writing its next burst, which only ever adds
        // steps after `latest`; the ring holds enough that the steps wanted
        // here are not overwritten (fixed_step.c).
        let mut newer = latest;
        let mut newer_time = latest_time;
        for _ in 1..self.snapshots.count {
            let step = newer.wrapping_sub(1);
            if step == 0 {
                break; // steps count from 1: there is nothing before step 1
            }
            let Some(time) = self.step_time(step) else {
                break;
            };
            if !after(time) {
                let span = newer_time.wrapping_sub(time) as f32;
                let into = display_us.wrapping_sub(time) as f32;
                let alpha = if span > 0.0 {
                    (into / span).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                return (step, Some(newer), alpha, false);
            }
            newer = step;
            newer_time = time;
        }
        hold
    }

    /// The `time_us` of the snapshot holding `step`, read in place under its
    /// seqlock. `None` if that entry is being written or holds another step.
    fn step_time(&self, step: u32) -> Option<u32> {
        let ring = &self.snapshots;
        let first = ring.first_word + (step & (ring.count - 1)) * ring.stride_words;
        let before = load(&self.words, first + snapshot::VERSION / 4);
        if before & 1 != 0 {
            return None;
        }
        let held = load(&self.words, first + snapshot::STEP / 4);
        let time = load(&self.words, first + snapshot::TIME_US / 4);
        if load(&self.words, first + snapshot::VERSION / 4) != before || held != step {
            return None;
        }
        Some(time)
    }

    /// Makes sure one of the two private copies holds a verified copy of
    /// `step` and returns which. `keep` names a copy that must not be
    /// overwritten (it holds the other half of the pair being assembled).
    ///
    /// A published step never changes, so a copy that already holds `step` is
    /// reused as is: when the display advances by less than one step per
    /// frame, most frames copy nothing at all.
    fn fetch(&mut self, step: u32, keep: Option<usize>) -> Option<usize> {
        let ring = &mut self.snapshots;
        if let Some(found) = ring.copies.iter().position(|copy| copy.step == Some(step)) {
            return Some(found);
        }

        let target = if keep == Some(0) { 1 } else { 0 };
        // Step N lives in ring entry `N & (count - 1)`.
        let entry = step & (ring.count - 1);
        let version = ring.first_word + entry * ring.stride_words + snapshot::VERSION / 4;
        let source = &ring.sources[entry as usize];
        let copy = &mut ring.copies[target];
        copy.step = None;

        // Seqlock read: the copy only counts if the snapshot's version word
        // was even (not being written) before it and unchanged after it.
        for _ in 0..SEQLOCK_ATTEMPTS {
            let before = load(&self.words, version);
            if before & 1 != 0 {
                continue;
            }
            copy.fill_from(source);
            if load(&self.words, version) != before {
                continue;
            }
            // A clean copy, but the ring overwrites in place: this entry may
            // hold a different step by now (or not hold `step` yet).
            if copy.header.step != step {
                return None;
            }
            copy.step = Some(step);
            return Some(target);
        }
        None
    }

    /// Queues `record` for the app. Returns `false`, leaving the ring
    /// untouched, when the ring is full; the caller keeps the record and tries
    /// again next frame, so nothing is ever dropped on this ring.
    pub fn try_send(&mut self, record: &Record) -> bool {
        let ring = &mut self.to_app;
        let tail = load(&self.words, ring.tail);
        if ring.own.wrapping_sub(tail) >= ring.capacity {
            return false;
        }
        let first = ring.first_record + (ring.own & (ring.capacity - 1)) * ring.record_words;
        let words: &RecordWords = bytemuck::cast_ref(record);
        for (offset, word) in (0u32..).zip(words) {
            self.words.set_index(first + offset, *word as i32);
        }
        // Publishing the new head is what hands the record over, so it comes
        // last and is atomic.
        ring.own = ring.own.wrapping_add(1);
        store(&self.words, ring.head, ring.own);
        true
    }

    /// Takes the next record the app has queued, if there is one.
    pub fn receive(&mut self) -> Option<Record> {
        let ring = &mut self.from_app;
        let head = load(&self.words, ring.head);
        let pending = head.wrapping_sub(ring.own);
        if pending == 0 {
            return None;
        }
        if pending > ring.capacity {
            // More records "pending" than the ring can hold: the counters are
            // not what a well-behaved producer writes. Skip to the producer's
            // position rather than replaying stale slots as commands.
            tracing::warn!("the app-to-renderer ring is inconsistent; discarding its contents");
            ring.own = head;
            store(&self.words, ring.tail, ring.own);
            return None;
        }

        let first = ring.first_record + (ring.own & (ring.capacity - 1)) * ring.record_words;
        let mut words: RecordWords = [0; size_of::<Record>() / 4];
        for (offset, word) in (0u32..).zip(&mut words) {
            *word = self.words.get_index(first + offset) as u32;
        }
        // Advancing the tail frees the slot for the producer, so the record is
        // read out first.
        ring.own = ring.own.wrapping_add(1);
        store(&self.words, ring.tail, ring.own);
        Some(bytemuck::cast(words))
    }

    /// Updates the renderer's stats once a frame is done. `span_us` is the
    /// time since the previous frame by the browser's frame timestamps (0 for
    /// the first); it is added before the frame is counted, so a page that
    /// sees the new count also sees it. `late`: the frame held the newest
    /// step because the app had not published the moment it wanted.
    pub fn frame_presented(&self, work_us: u32, span_us: u32, late: bool) {
        let stat = |offset: u32| self.stats + offset / 4;
        if late {
            let _ = Atomics::add(&self.words, stat(stats::APP_LATE), 1);
        }
        let _ = Atomics::add(&self.words, stat(stats::FRAME_SPAN_US), span_us as i32);
        let _ = Atomics::add(&self.words, stat(stats::FRAME_COUNT), 1);
        let _ = Atomics::add(&self.words, stat(stats::FRAME_WORK_US), work_us as i32);
    }

    /// Publishes the renderer's GPU frame time for the page's stats panel:
    /// the running total in microseconds and how many frames it sums, both
    /// wrapping. The page divides the change in one by the change in the
    /// other.
    pub fn set_gpu_totals(&self, total_us: u32, frames: u32) {
        store(&self.words, self.stats + stats::GPU_FRAME_US / 4, total_us);
        store(&self.words, self.stats + stats::GPU_FRAME_COUNT / 4, frames);
    }

    /// Which breakdowns the page's stats panel is showing right now.
    pub fn detail(&self) -> Detail {
        let bits = load(&self.words, self.stats + stats::DETAIL / 4);
        Detail {
            renderer: bits & detail::RENDERER != 0,
            gpu: bits & detail::GPU != 0,
        }
    }

    /// Publishes one named running total in the timing table: `total_ms` of
    /// time over `count` frames, both since whenever the caller started
    /// counting. The first call for a name claims an entry for it; once the
    /// table is full, further names are left out.
    pub fn publish_timing(
        &mut self,
        kind: TimingKind,
        name: &'static str,
        total_ms: f64,
        count: u64,
    ) {
        let table = &mut self.timings;
        let slot = match table.slots.get(&(kind, name)) {
            Some(slot) => *slot,
            None if table.next < table.capacity => {
                let slot = table.next;
                table.next += 1;
                table.slots.insert((kind, name), slot);
                // The name first, the kind last: a page that sees the kind
                // sees the whole name. Cut to leave a final zero byte.
                let entry = table.first_word + slot * table.stride_words;
                let mut bytes = [0u8; timing::NAME_SIZE as usize];
                let length = name.len().min(bytes.len() - 1);
                bytes[..length].copy_from_slice(&name.as_bytes()[..length]);
                for (index, word) in (0u32..).zip(bytes.as_chunks::<4>().0) {
                    let word = u32::from_le_bytes(*word);
                    self.words
                        .set_index(entry + timing::NAME / 4 + index, word as i32);
                }
                store(&self.words, entry + timing::KIND / 4, kind as u32);
                slot
            }
            None => return,
        };
        let entry = table.first_word + slot * table.stride_words;
        // Nanoseconds, wrapping like every running total in the block.
        let total_ns = (total_ms * 1e6) as u64 as u32;
        store(&self.words, entry + timing::TOTAL_NS / 4, total_ns);
        store(&self.words, entry + timing::COUNT / 4, count as u32);
    }
}

impl SnapshotRing {
    fn view(&self, index: usize) -> Snapshot<'_> {
        let copy = &self.copies[index];
        Snapshot {
            header: &copy.header,
            bytes: &copy.bytes,
            layout: self.layout,
        }
    }
}

impl SnapshotCopy {
    fn new(size: usize) -> Self {
        let mut bytes = vec![0u8; size];
        let view = view_over(&mut bytes);
        Self {
            bytes,
            view,
            header: SnapshotHeader::zeroed(),
            step: None,
        }
    }

    /// Bulk-copies one whole snapshot out of the app's memory.
    fn fill_from(&mut self, source: &Uint8Array) {
        // A view over this module's memory goes dead (zero length) when that
        // memory grows, because growing replaces the underlying buffer. That
        // is the only time a new JS object is made on this path.
        if self.view.length() as usize != self.bytes.len() {
            self.view = view_over(&mut self.bytes);
        }
        self.view.set(source.as_ref(), 0);
        self.header = bytemuck::pod_read_unaligned(&self.bytes[..size_of::<SnapshotHeader>()]);
    }
}

/// A JS byte view over a buffer in this module's own memory.
///
/// Takes the `Vec` itself rather than a slice on purpose: `Vec::as_mut_ptr`
/// returns the allocation's pointer without creating a reference to the
/// contents, so reading the buffer through the `Vec` later does not invalidate
/// the pointer the view was built from.
#[allow(clippy::ptr_arg)]
fn view_over(bytes: &mut Vec<u8>) -> Uint8Array {
    // SAFETY: the view aliases the Vec's heap allocation, so two things must
    // hold. The allocation must outlive the view and never move: the Vec is
    // stored next to the view in `SnapshotCopy` and is never resized. And JS
    // must not write through the view while Rust holds a reference into the
    // buffer: the only write is the `set()` call in `fill_from`, during which
    // no such reference exists.
    unsafe { Uint8Array::view_mut_raw(bytes.as_mut_ptr(), bytes.len()) }
}

impl Snapshot<'_> {
    /// Slots at or beyond this index are not in use in this snapshot.
    pub fn pose_count(&self) -> usize {
        self.header.pose_count.min(self.layout.pose_capacity) as usize
    }

    /// The pose in `slot`, or `None` if the slot is not active in this
    /// snapshot (inactive slots are to be ignored).
    pub fn pose(&self, slot: usize) -> Option<Pose> {
        if slot >= self.pose_count() {
            return None;
        }
        // `attach` checked that every pose of a full snapshot fits inside the
        // snapshot, and the copy is a whole snapshot, so this range exists.
        // The pose is copied out byte-wise, which makes its alignment in the
        // buffer irrelevant.
        let start = self.layout.header_size + slot * self.layout.pose_stride;
        let pose: Pose =
            bytemuck::pod_read_unaligned(&self.bytes[start..start + size_of::<Pose>()]);
        (pose.flags & pose_flag::ACTIVE != 0).then_some(pose)
    }
}

// `Atomics.*` only throws for an index outside the view or a view of the wrong
// kind. `attach` rules both out, so a failure is treated as "no value" rather
// than surfaced on every call.

fn load(words: &Int32Array, word: u32) -> u32 {
    Atomics::load(words, word).unwrap_or(0) as u32
}

fn store(words: &Int32Array, word: u32, value: u32) {
    let _ = Atomics::store(words, word, value as i32);
}
