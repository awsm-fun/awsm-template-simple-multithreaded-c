//! The view to draw with, taken from the scene's camera node.
//!
//! The camera is an ordinary scene node: it sits where the scene puts it, and
//! the app may bind it to a pose slot to move it like any other node. Either
//! way, its WORLD matrix after `update_transforms()` is where it is. The
//! renderer adds what only it knows (the surface's aspect ratio and depth
//! convention) inside `AwsmRenderer::set_camera`.

use awsm_renderer::camera::{view_from_world, CameraParams};
use awsm_renderer::AwsmRenderer;
use glam::{Mat4, Vec3};

use crate::scene::SceneCamera;

/// The view matrix and lens to pass to `set_camera`. Call it after
/// `update_transforms()`, so a camera moved this frame is seen where it is.
pub fn view_and_params(
    renderer: &AwsmRenderer,
    camera: Option<&SceneCamera>,
) -> (Mat4, CameraParams) {
    let Some(camera) = camera else {
        return fallback();
    };
    // Prefer the live lens in the renderer's camera store (it is what an
    // animation would change), then the lens as authored.
    let params = camera
        .key
        .and_then(|key| renderer.cameras.get(key))
        .copied()
        .or(camera.authored);
    // The transform exists for as long as the scene does; the fallback only
    // keeps a bug elsewhere from showing as a blank canvas.
    let world = renderer.transforms.get_world(camera.transform).ok();
    match (world, params) {
        (Some(world), Some(params)) => (view_from_world(*world), params),
        _ => fallback(),
    }
}

/// A view for a scene without a camera: from above and in front of the
/// origin, looking at it, so the page still shows something.
fn fallback() -> (Mat4, CameraParams) {
    let eye = Vec3::new(0.0, 5.0, 9.0);
    let view = Mat4::look_at_rh(eye, Vec3::ZERO, Vec3::Y);
    (
        view,
        CameraParams::perspective(55f32.to_radians(), 0.1, 200.0),
    )
}
