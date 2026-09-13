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
