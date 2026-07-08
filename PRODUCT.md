# Product

## Register

product

## Users

Connectomics and neuroimaging annotators working inside the Zetta AI portal.
The audience is mixed: experienced proofreaders who live in the tool for hours,
alongside occasional and newer users who open it intermittently. They work in a
3D segmentation/painting task — selecting layers and resolutions, painting and
erasing voxels, flood-filling regions, and masking strokes against a reference
image — embedded in neuroglancer's own dark viewer chrome.

Because the audience spans both ends, the editing UI optimizes for **clarity
over raw density**: legible labels and help text, comfortably sized targets, and
visible affordances, without slowing down a power user who already knows the
flow.

## Product Purpose

`zettaai-neuroglancer` is a fork of Google's Neuroglancer that adds an
edit-session layer: a topbar of session controls and a set of per-tool side
panels for the tool groups listed below. It lets users make and save voxel
edits to segmentation layers and run alignment workflows directly in the
viewer. Success is when an annotator can configure a tool and edit confidently
without guessing what a control does or losing input to a silent failure.

## Tools

Tool groups below are either already implemented or arriving in the near term.

- **Painting tools — Brush, Erase, Fill.** Paint segmentation directly in the
  viewer. All three use mask settings (threshold, binary closing, etc.) and
  will be extended with preprocessors with flexible configuration.
- **Alignment tools — Affine, Correspondence.** Produce a displacement field
  and a warped image from source and target images. Correspondence
  additionally supports defect/tissue masks for the source and target images.
- **Z-extrapolation.** Runs propagate mask over a bounding box in one
  direction (forward or backward) along an axis.
- **Mask selected segments.** Writes the selected segments from one layer
  into another layer, with the option to change the segment value.

## Brand Personality

Precise, calm, and trustworthy. The editing UI should feel like a native part
of the scientific viewer it lives in — an instrument, not a consumer app. Three
words: **exact, quiet, dependable.** The tool should disappear into the task.

## Anti-references

- Consumer-app flourish: gradients, glassmorphism, bouncy motion, oversized
  rounded cards. None of it belongs in a precision editing instrument.
- Stock-Neuroglancer rawness: undersized hit targets, generic default `sans`,
  inconsistent ad-hoc colors. Production polish is the differentiator.
- Strangeness without purpose: invented controls for standard tasks, mismatched
  form widgets, decorative motion that conveys no state.

## Design Principles

1. **One source of truth for style.** Every color, space, radius, and control
   dimension is a token (`editing_theme.css`). No hardcoded values, no drifting
   "almost the same" blues.
2. **Native, not foreign.** Match neuroglancer's dark chrome; earn familiarity
   rather than imposing a separate visual identity.
3. **Never lose the user's input.** Invalid entries surface a visible state and
   keep what was typed; they are never silently reverted.
4. **Consistent component vocabulary.** One slider language, one focus
   treatment, one toggle, one input — the same everywhere in the editing UI.
5. **Clarity for the occasional user, speed for the expert.** Readable copy and
   comfortable targets that never get in a power user's way.
6. **Static in place.** Nothing moves, grows, or pushes neighbors on a state
   change unless the movement itself is the message. Spinners, badges, and
   status icons render into space reserved for them.

## Accessibility & Inclusion

- Keyboard operable: every control is focusable with a single visible
  focus-ring treatment (accent ring) across inputs, sliders, and toggles.
- Semantics: switches use `role="switch"`; validation errors use `role="alert"`
  and `aria-invalid`.
- Contrast: body/label/help text targets WCAG AA (≥4.5:1) on the dark panel;
  the previous faint greys were lifted to meet it.
- Reduced motion: all transitions have a `prefers-reduced-motion` fallback.
