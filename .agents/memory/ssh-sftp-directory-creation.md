---
name: SSH SFTP directory creation
description: SFTP compatibility rule for idempotent remote workspace directory setup.
---

Do not rely on an SFTP server returning an `EEXIST`-style error when creating an already-existing directory. After a failed `mkdir`, stat the requested path and accept the operation only if the directory is present.

**Why:** OpenSSH's SFTP server can report an existing directory as a generic `Failure`, which would otherwise make repeat remote runs fail during workspace setup.

**How to apply:** Use the verify-after-failure pattern for idempotent remote directory creation, including concurrent setup paths.