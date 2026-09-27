# 3D model assets

## Avocado.glb

Test fixture for the HUD diagram card (Item 1c-C). Temporary — it will be
replaced by text-to-3D generation once the backend (Item 4) is in place.

- Source: Khronos glTF-Sample-Assets — <https://github.com/KhronosGroup/glTF-Sample-Assets/tree/main/Models/Avocado>
- © 2017, Microsoft. Released to the public domain under
  [Creative Commons Zero v1.0 Universal (CC0)](https://creativecommons.org/publicdomain/zero/1.0/legalcode).
- No attribution required; included here only to develop and test the
  rotate / zoom / pan / tap-to-isolate interaction.

## officeWorker.glb

Rigged humanoid base body + shared animation set for THE OFFICE (the 3D
persona desks scene, replacing the old orb galaxy). One shared skeleton
across every persona — persona.color tint + an optional face photo
(`assets/persona-faces/<id>.jpg`) is what differentiates them.

- Source: Quaternius — "Universal Animation Library" (`UAL1_Standard.fbx`),
  <https://quaternius.com/packs/universalanimationlibrary.html>, mirrored at
  <https://github.com/IAFahim/quaternius.universalAnimationLibrary.standard>.
- Released to the public domain under
  [Creative Commons Zero v1.0 Universal (CC0)](https://creativecommons.org/publicdomain/zero/1.0/legalcode).
  No attribution required.
- Converted from the source FBX to GLB with `FBX2glTF` (Oculus VR, LLC) —
  a one-time asset-prep step, not a runtime dependency. No native module or
  new npm dependency was added to the app itself; `three`, `expo-three` and
  `expo-gl` already parse GLTFLoader the same way `Avocado.glb` does (see
  `src/screens/hud/DiagramPanel.js`).
- The mesh itself ("Mannequin") is a stylized, jointed placeholder figure —
  not a photorealistic clothed human — with 44 baked animation clips
  (`Idle_Loop`, `Sitting_Idle_Loop`, `Sitting_Talking_Loop`, `Sitting_Enter`/
  `Sitting_Exit`, `Walk_Loop`, `Walk_Formal_Loop`, and more) covering every
  behavior THE OFFICE needs (idle-at-desk, talking, standing, walking).

## personaBodyMale.glb / personaBodyFemale.glb

Optional per-persona body upgrade — real textured PBR humans (skin, hair,
eyes) instead of the flat-tinted Mannequin, for personas listed in
`assets/persona-faces/body-models.json` as `quaterniusMale` / `quaterniusFemale`
(everyone else stays on the Mannequin). Selected via `bodyModel` in
`officeCharacter.js`'s `createOfficeCharacter`.

- Source: Quaternius — "Universal Base Characters" ("Superhero" build, male
  and female), <https://quaternius.com/packs/universalbasecharacters.html>
  (mirrored at <https://quaternius.itch.io/universal-base-characters>).
- Released to the public domain under
  [Creative Commons Zero v1.0 Universal (CC0)](https://creativecommons.org/publicdomain/zero/1.0/legalcode).
  No attribution required.
- Ships from Quaternius as a loose `.gltf` + `.bin` + seven PNG textures per
  body (2048×2048 skin/hair normal + base color + roughness maps) — merged
  into one self-contained `.glb` with `gltf-pipeline` (`--binary`), the same
  kind of one-time asset-prep step as `officeWorker.glb`'s FBX→GLB conversion.
  Two texture filenames the pack ships (`T_Hair_1_Normal_png.png`,
  `T_Eye_Normal_png.png`) didn't match what the `.gltf` actually references
  after upload — duplicated from the sibling file without the `_png` before
  merging; check that against the pack's own files again if this is ever
  re-generated from a fresh download instead of the `_source/` copy here.
  The original loose files are kept in `_source/quaternius-universal-base-
  characters/` (not loaded at runtime) in case a re-export is ever needed;
  `Hair_*.fbx` / `Eyebrows_*.fbx` in there are unused modular hair/eyebrow
  attachments from the same pack — each body's own hair (`MI_Hair_1`) and
  eyes (`MI_Eyes`) are already part of the merged FullBody mesh.
- No animations of its own — it is explicitly published by Quaternius to
  pair with the Universal Animation Library above. Verified directly rather
  than taken on faith: both files carry the identical 65 bone names, so
  `officeWorker.glb`'s 44 clips play on this skeleton with zero retargeting.
  One thing that does NOT carry over: the Mannequin's `Armature` node has its
  own (100,100,100) scale, so anything parented to one of its bones (the
  jacket block, the face plate) is authored 100x small and relies on that
  parent scale to read right; this pack's `Armature` has no scale override
  (glTF default of 1), so `officeCharacter.js` uses `BONE_LOCAL_SCALE=1` for
  it instead of 100 — get that wrong and bone-parented decoration is either
  invisible (divided by 100 when it shouldn't be) or room-sized (not divided
  when it should be).
- A second thing that also does NOT carry over, checked the same way (forward
  kinematics on `foot_l`/`ball_l`, not just node translations, which are in
  each bone's own local space and don't tell you the rest pose's world
  direction): the Mannequin's rest pose faces -Z; this pack's rest pose faces
  +Z — the opposite — on both the male and female body, despite the identical
  skeleton. `officeCharacter.js` resolves a per-bodyModel `forwardOffset` (0
  here, `MODEL_FORWARD_OFFSET` = π for the Mannequin) and hands it back on the
  character object; every caller of `worldForward` / `yawToRotation` for a
  character that might be on an alt body must pass that character's own
  `forwardOffset`, never assume the Mannequin's.
