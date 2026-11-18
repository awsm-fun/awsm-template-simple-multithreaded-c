//! Pose slots: which scene node each slot of a snapshot moves.
//!
//! The app publishes a pose per slot per step. A slot means nothing until the
//! app sends `BIND`, naming the scene node that follows it. Any kind of node
//! can be bound (a mesh, a group, a light, the camera); its children follow it
//! through the hierarchy. [`Slots::reset`] puts every bound node back where it
//! was authored, which is how a freshly attached app finds the scene exactly
//! as loaded.
//!
//! # World poses in a transform hierarchy
//!
//! A pose is a WORLD position and rotation, but a node's transform is relative
//! to its parent. Rather than convert every pose through the inverse of the
//! parent's world matrix every frame, `BIND` takes the node out of the
//! hierarchy for as long as it is driven: directly under the root, "relative
//! to the parent" and "world" are the same thing. That makes each frame a
//! plain `set_local` (no matrix inverse), and it is exact even under a rotated,
//! non-uniformly scaled parent, whose shear a translation / rotation / scale
//! transform could not hold.

use awsm_renderer::transforms::{Transform, TransformKey};
use awsm_renderer::AwsmRenderer;
use glam::{Quat, Vec3};

use crate::bridge::{Sample, Snapshot};
use crate::scene::SceneIndex;

/// A world position and rotation.
type Placement = (Vec3, Quat);

pub struct Slots {
    /// One entry per pose slot of the attached bridge; `None` while the app
    /// has not bound the slot.
    entries: Vec<Option<Slot>>,
}

struct Slot {
    /// Index of the bound node in the scene index.
    node: usize,
    /// The node's transform. It sits directly under the root while bound, so
    /// its local transform is its world transform.
    transform: TransformKey,
    /// The authored world scale, kept while position and rotation are driven.
    scale: Vec3,
    /// The placement last written, so an object at rest costs nothing.
    written: Option<Placement>,
}

impl Slots {
    /// `capacity` slots, none bound.
    pub fn new(capacity: usize) -> Self {
        let mut entries = Vec::new();
        entries.resize_with(capacity, || None);
        Self { entries }
    }

    /// Puts every bound node back in its authored place, and makes room for
    /// `capacity` slots.
    pub fn reset(&mut self, renderer: &mut AwsmRenderer, scene: &SceneIndex, capacity: usize) {
        for index in 0..self.entries.len() {
            self.release(renderer, scene, index);
        }
        self.entries.clear();
        self.entries.resize_with(capacity, || None);
    }

    /// `BRIDGE_CMD_BIND`: the scene node named `node_hash` follows `slot`.
    ///
    /// It takes effect as soon as it is read. The node's authored place and
    /// the app's first pose for it are the same place, so nothing visibly
    /// jumps while the display catches up with the app.
    pub fn bind(
        &mut self,
        renderer: &mut AwsmRenderer,
        scene: &SceneIndex,
        slot: u32,
        node_hash: u32,
    ) {
        let Some(node_index) = scene.find(node_hash) else {
            tracing::warn!("BIND: no scene node has the name hash {node_hash:#010x}");
            return;
        };
        let index = slot as usize;
        if index >= self.entries.len() {
            tracing::warn!(
                "BIND: slot {slot} is out of range (the bridge has {} slots)",
                self.entries.len()
            );
            return;
        }
        // Rebinding a slot retargets it: let go of its old node first.
        self.release(renderer, scene, index);
        // A node can only be in one place, so it can only follow one slot.
        let elsewhere = self
            .entries
            .iter()
            .position(|entry| entry.as_ref().is_some_and(|bound| bound.node == node_index));
        if let Some(other) = elsewhere {
            tracing::warn!("BIND: the node followed slot {other}; it now follows slot {slot}");
            self.release(renderer, scene, other);
        }

        // Out of the hierarchy (see the module docs), staying exactly where it
        // was authored until the slot delivers a pose.
        let node = &scene.nodes()[node_index];
        renderer.transforms.set_parent(node.transform, None);
        if let Err(err) = renderer
            .transforms
            .set_local(node.transform, node.world.clone())
        {
            tracing::warn!("BIND: moving the node under the root failed: {err}");
            return;
        }
        self.entries[index] = Some(Slot {
            node: node_index,
            transform: node.transform,
            scale: node.world.scale,
            written: None,
        });
    }

    /// Moves every bound node to where `sample` says it is.
    pub fn apply(&mut self, renderer: &mut AwsmRenderer, sample: &Sample<'_>) {
        let pose_count = |snapshot: Option<Snapshot<'_>>| snapshot.map_or(0, |s| s.pose_count());
        let in_use = pose_count(sample.older).max(pose_count(sample.newer));

        for (index, entry) in self.entries.iter_mut().enumerate().take(in_use) {
            let Some(slot) = entry else {
                continue;
            };
            let older = placement_in(sample.older, index);
            let newer = placement_in(sample.newer, index);
            let placement = match (older, newer) {
                // The normal case: somewhere between two consecutive steps.
                (Some((from, _)), Some((to, false))) => (
                    from.0.lerp(to.0, sample.alpha),
                    from.1.slerp(to.1, sample.alpha),
                ),
                // The next step is a teleport or has no pose for this slot:
                // stay at the older pose rather than sweep towards it.
                (Some((held, _)), _) => held,
                // The slot came alive in the newer step: nothing to come from.
                (None, Some((arrived, _))) => arrived,
                // Not active in either step. Leave the node as it is.
                (None, None) => continue,
            };
            if slot.written == Some(placement) {
                continue;
            }
            let transform = Transform {
                translation: placement.0,
                rotation: placement.1,
                scale: slot.scale,
            };
            if let Err(err) = renderer.transforms.set_local(slot.transform, transform) {
                // The transform no longer exists, which only a bug elsewhere
                // could cause. Forget the slot instead of failing every frame.
                tracing::warn!("slot {index} lost its transform ({err}); the slot is dropped");
                *entry = None;
                continue;
            }
            slot.written = Some(placement);
        }
    }

    /// Empties one slot, giving its node back its authored parent and place.
    fn release(&mut self, renderer: &mut AwsmRenderer, scene: &SceneIndex, index: usize) {
        let Some(slot) = self.entries[index].take() else {
            return;
        };
        let node = &scene.nodes()[slot.node];
        renderer.transforms.set_parent(node.transform, node.parent);
        if let Err(err) = renderer
            .transforms
            .set_local(node.transform, node.local.clone())
        {
            tracing::warn!("restoring a node's authored transform failed: {err}");
        }
    }
}

/// Where one snapshot puts slot `index`, and whether the pose is a teleport.
///
/// `None` when there is no snapshot, the slot is inactive in it, or the pose
/// is not usable (a non-finite position or a zero quaternion would poison the
/// renderer's bounds).
fn placement_in(snapshot: Option<Snapshot<'_>>, index: usize) -> Option<(Placement, bool)> {
    let pose = snapshot?.pose(index)?;
    let position = Vec3::from_array(pose.position);
    let rotation = Quat::from_array(pose.rotation);
    let length_squared = rotation.length_squared();
    if !position.is_finite() || !length_squared.is_finite() || length_squared < 1e-12 {
        return None;
    }
    Some(((position, rotation.normalize()), pose.is_teleport()))
}
