//! Loading the scene bundle, and indexing what the app can address in it.
//!
//! The scene is `bundle/scene.toml` (plus `bundle/assets/…`, if it has any).
//! After loading it, the renderer knows every NAMED node of the scene by the
//! hash of its name (strings never cross the bridge), together with its
//! authored transform. That list is what the app is told on attach, and what
//! a `BIND` command picks from. What a node MEANS (the ball, the floor…) is
//! not decided here: the renderer reports names; the app gives them meaning.
//!
//! The scene's camera is found here too (see [`SceneCamera`]).

use std::collections::HashMap;

use awsm_renderer::camera::{CameraKey, CameraParams};
use awsm_renderer::transforms::{Transform, TransformKey};
use awsm_renderer::AwsmRenderer;
use awsm_renderer_scene::{EditorNode, NodeId, NodeKind, Scene};
use awsm_renderer_scene_loader::assets::HttpAssets;
use awsm_renderer_scene_loader::camera::camera_params_from_config;
use awsm_renderer_scene_loader::{load_scene_for_player, LoadedScene, ParticleDriver};
use awsm_renderer_settings::scene_anti_aliasing;

use crate::bridge::bridge_hash;
use crate::page;

/// Everything about the loaded scene that the rest of the renderer uses. The
/// default is an empty scene: no nodes and no camera.
#[derive(Default)]
pub struct SceneIndex {
    /// Every addressable node, in document order.
    nodes: Vec<SceneNode>,
    /// Name hash → index into `nodes`.
    by_name: HashMap<u32, usize>,
    /// The camera to view the scene through; `None` if the scene has none.
    pub camera: Option<SceneCamera>,
    /// The scene's particle emitters. The loader builds them; they only move
    /// when ticked, once per frame.
    pub particles: ParticleDriver,
}

/// A named scene node, with everything needed to put it back the way it was
/// authored after the app has driven it.
pub struct SceneNode {
    pub name_hash: u32,
    pub transform: TransformKey,
    /// The transform's authored parent.
    pub parent: Option<TransformKey>,
    /// Its authored transform relative to that parent.
    pub local: Transform,
    /// Its authored transform in world space.
    pub world: Transform,
}

/// The scene's camera node.
pub struct SceneCamera {
    /// The node's transform: the view is taken from its world matrix.
    pub transform: TransformKey,
    /// The camera's slot in the renderer's camera store, which holds its live
    /// lens (projection, near, far).
    pub key: Option<CameraKey>,
    /// The lens as authored, for when there is no store slot.
    pub authored: Option<CameraParams>,
}

impl SceneIndex {
    pub fn nodes(&self) -> &[SceneNode] {
        &self.nodes
    }

    /// The index of the node whose name hashes to `name_hash`.
    pub fn find(&self, name_hash: u32) -> Option<usize> {
        self.by_name.get(&name_hash).copied()
    }
}

/// Fetches the bundle under `base_url` (the absolute URL of the site root,
/// ending in `/`), loads it into the renderer, and indexes it.
pub async fn load(renderer: &mut AwsmRenderer, base_url: &str) -> Result<SceneIndex, String> {
    let bundle_url = format!("{base_url}bundle");
    let scene_url = format!("{bundle_url}/scene.toml");

    // The renderer built no pipelines yet, it only reserved them. Compiling
    // them is GPU-driver work and fetching the scene is network work, so the
    // two run side by side instead of one after the other.
    page::post_progress(
        "compiling core render pipelines + fetching scene… \
         (first visit can take a while — cached after)",
    );
    let (compiled, scene) =
        futures::join!(renderer.ensure_config_pipelines(), fetch_scene(&scene_url));
    let compiled =
        compiled.map_err(|err| format!("could not compile the render pipelines: {err}"))?;
    let mut scene = scene?;
    page::post_progress(&format!(
        "core pipelines ready ({compiled}) · scene parsed ({} nodes)",
        scene.nodes.len()
    ));

    // The anti-aliasing is the page's choice (its Settings), and the renderer
    // already runs it. The loader applies the scene's authored anti-aliasing,
    // so the scene is given the renderer's: the loader then changes nothing,
    // and nothing is compiled for a mode this session does not use.
    scene.post_process.anti_aliasing = scene_anti_aliasing(&renderer.anti_aliasing);

    // The loader asks for bundle-relative paths (`assets/<id>.png`, …) and
    // this fetches them from next to `scene.toml`.
    let assets = HttpAssets::new(bundle_url);
    // Several load phases report the same counts back to back; only pass on
    // lines that changed, and skip empty phases.
    let mut last_line = String::new();
    let loaded = load_scene_for_player(renderer, &scene, &assets, |phase| {
        let line = phase.label();
        if line != last_line && !line.contains("0/0") {
            page::post_progress(&line);
            last_line = line;
        }
    })
    .await
    .map_err(|err| format!("could not load the scene: {err:#}"))?;

    // The loader only stores each node's transform relative to its parent.
    // This resolves the hierarchy, so that world transforms can be read below.
    renderer.update_transforms();

    let mut index = SceneIndex::default();
    let mut cameras = Vec::new();
    index_nodes(&scene.nodes, renderer, &loaded, &mut index, &mut cameras);
    index.camera = pick_camera(&scene, &cameras, &loaded);
    index.particles = ParticleDriver::new(&loaded);
    tracing::info!(
        "scene loaded: {} named nodes, {} particle emitters, {}",
        index.nodes.len(),
        index.particles.len(),
        if index.camera.is_some() {
            "viewed through its camera"
        } else {
            "no camera"
        }
    );
    Ok(index)
}

async fn fetch_scene(url: &str) -> Result<Scene, String> {
    // `NoCache` still uses the HTTP cache but revalidates first, so an edited
    // scene is picked up by a plain page reload.
    let response = gloo_net::http::Request::get(url)
        .cache(web_sys::RequestCache::NoCache)
        .send()
        .await
        .map_err(|err| format!("could not fetch {url}: {err}"))?;
    if !response.ok() {
        return Err(format!("could not fetch {url}: HTTP {}", response.status()));
    }
    let text = response
        .text()
        .await
        .map_err(|err| format!("could not read {url}: {err}"))?;
    awsm_renderer_scene::scene_from_toml(&text)
        .map_err(|err| format!("could not parse {url}: {err}"))
}

/// Walks `nodes` depth first, in document order: records every named node in
/// `index` and every camera node's id in `cameras`. Must run while the scene
/// is still exactly as loaded.
fn index_nodes(
    nodes: &[EditorNode],
    renderer: &AwsmRenderer,
    loaded: &LoadedScene,
    index: &mut SceneIndex,
    cameras: &mut Vec<NodeId>,
) {
    for node in nodes {
        // A prefab subtree is a template for copies, not part of the world;
        // the loader keeps it out of `loaded.nodes`.
        if node.prefab {
            continue;
        }
        if matches!(node.kind, NodeKind::Camera(_)) {
            cameras.push(node.id);
        }
        // 0 means "no node" on the bridge, and the first node with a name wins.
        let name_hash = bridge_hash(&node.name);
        if !node.name.is_empty() && name_hash != 0 {
            if index.by_name.contains_key(&name_hash) {
                tracing::warn!(
                    "two scene nodes are named '{}'; the app can only address the first",
                    node.name
                );
            } else if let Some(captured) = capture(node, name_hash, renderer, loaded) {
                index.by_name.insert(name_hash, index.nodes.len());
                index.nodes.push(captured);
            }
        }
        index_nodes(&node.children, renderer, loaded, index, cameras);
    }
}

/// Records a node's transform and its authored state.
fn capture(
    node: &EditorNode,
    name_hash: u32,
    renderer: &AwsmRenderer,
    loaded: &LoadedScene,
) -> Option<SceneNode> {
    let transform = loaded.nodes.get(&node.id)?.transform;
    let transforms = &renderer.transforms;
    Some(SceneNode {
        name_hash,
        transform,
        parent: transforms.get_parent(transform).ok(),
        local: transforms.get_local(transform).ok()?.clone(),
        world: Transform::from(*transforms.get_world(transform).ok()?),
    })
}

/// The camera to view the scene through: the one the scene names as active,
/// if it was loaded, else the first camera in document order.
fn pick_camera(scene: &Scene, cameras: &[NodeId], loaded: &LoadedScene) -> Option<SceneCamera> {
    let active = scene.active_camera.filter(|id| cameras.contains(id));
    if scene.active_camera.is_some() && active.is_none() {
        tracing::warn!("the scene's active camera is not a loaded camera node; using the first");
    }
    let Some(id) = active.or_else(|| cameras.first().copied()) else {
        tracing::warn!("the scene has no camera node; using a fixed view");
        return None;
    };
    let handles = loaded.nodes.get(&id)?;
    Some(SceneCamera {
        transform: handles.transform,
        key: handles.camera,
        authored: handles
            .camera_config
            .as_ref()
            .map(camera_params_from_config),
    })
}
