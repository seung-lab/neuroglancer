# Browser inference design

Browser inference turns source data into demand-driven prediction layers within
Neuroglancer. Model execution stays in the browser; no inference server is
required. Models and source data may still need network access.

## Separation of responsibilities

- **Setup and viewer state** capture the source, model identity, execution choices,
  and confirmed geometry. Loading is lazy, triggered by explicit use or restoration
  of a saved inference layer.
- **Input preparation** reads native dataset voxels independently of display
  shaders. It validates source metadata, coordinate mappings, and complete model
  context, then packs data according to the input contract.
- **The runtime worker** owns model inspection, supported model preparation, and
  execution. Keeping this work outside the viewer thread separates runtime
  lifetime and failures from rendering.
- **The controller** coordinates input reads, model execution, output geometry,
  and patch assembly while bounding outstanding work and retained predictions.
- **The derived datasource** exposes completed predictions as ordinary image
  chunks. Rendering, navigation, and displayed-chunk caching remain viewer
  responsibilities.

## Geometry and prediction assembly

Inference uses a confirmed native source grid, not rendered pixels. Physical
coordinates connect source context, model output, and displayed predictions.
Changing the viewport changes demand rather than the model's sampling grid.
Unsupported mappings are rejected instead of silently resampled or guessed.

Model patches and display chunks are separate units. Patches follow a globally
source-anchored lattice so neighboring chunks use consistent context. Output
cropping retains interior patch regions; optional weighted blending combines
contributions where patches overlap. Only source-valid context contributes, and
missing predictions are not fabricated to fill the display domain. Output channels
keep their model-defined meaning; rendering adds no task-specific postprocessing.

## Demand, caching, and lifetime

Visible views drive computation through the normal chunk scheduler. Requests for
the same chunk share work, and each session serializes model execution. Abandoned
demand is cancelled. Reusable patch predictions are cached separately from
displayed chunks. Cache validity depends on source, model, execution, and geometry
identity rather than viewport position. Work and memory are bounded rather than
allocated for the entire source volume.

Only complete, still-current chunks are published. Configuration changes, source
invalidation, cancellation, and disposal prevent stale work from updating a
replacement layer. Cancellation can terminate the runtime worker; later demand
may require initialization again. Closing the setup dialog is distinct from
stopping an inference layer.

## Execution policy and failures

Execution policy separates requested behavior from the provider and precision
actually used. Automatic selection can recover from supported startup failures;
strict selection reports failure rather than silently changing providers.
Fallback is restricted to defined startup boundaries, not mixed into already
successful execution. Status exposes the effective execution mode and any
fallback reason.

Invalid geometry, unsupported model contracts, failed source reads, and malformed
or non-finite results fail visibly. Model inspection and successful runtime
initialization are compatibility checks, not proof of execution support or
prediction quality. Reduced precision and other preparation require independent
validation for the intended use.

## Sharing and restoration

Saved viewer state contains a recipe describing the source, model identity, and
confirmed execution and geometry choices. Restoration reconstructs the source,
checks model integrity, and recomputes predictions locally. It does not serialize
model weights, prediction volumes, workers, or transient caches.

Recipients still need access to the source data and model. Hardware and runtime
capabilities may differ, so sharing a recipe does not guarantee identical
execution or numerical results. Restored layers own their runtime lifetime
independently of the setup dialog.

## Security and validation boundaries

Runtime assets must match the browser execution backend. Parallel CPU execution
depends on browser isolation capabilities; authentication crosses that boundary
through a constrained helper rather than weakening isolation for the viewer.
Credential messages are scoped to a sign-in attempt and validated before use.

Validation separates geometry and numeric correctness from scheduling, lifecycle,
and browser integration. It should exercise real execution, cancellation and
replacement, navigation recovery, cache validity, and fresh-state restoration.
Finite output and successful display do not establish scientific accuracy,
training compatibility, or application-level quality.
