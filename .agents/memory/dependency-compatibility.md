---
name: Dependency compatibility
description: Constraints behind security updates in the legacy mobile and backend dependency trees.
---

Use a patched CommonJS-capable UUID release for the legacy Expo and scheduler consumers rather than blindly overriding to the newest major.

**Why:** Their callers use `require('uuid')`; UUID releases after 11 dropped CommonJS support. Upgrading Expo or the scheduler solely to remove UUID would also change SDK or Node runtime requirements.

**How to apply:** Check the parent packages' import style and runtime requirements before changing UUID overrides or Yarn resolutions.

Preserve the mobile project's existing Yarn-based install path when doing npm-based security maintenance.

**Why:** Adding a root npm lockfile can make EAS select npm, which uses the publishing-specific tar override instead of the tar version expected by SDK 51 prebuild.

**How to apply:** Do not introduce a root npm lockfile as an incidental result of updating transitive dependencies; treat switching the mobile package manager as a separate build migration.
