---
name: Portable preview isolation
description: The deployment decision for running untrusted local browser previews safely on Replit and Ubuntu hosts.
---

Local browser previews must run in real Docker containers rather than as host child processes. Each container has no network, a read-only root filesystem, an unprivileged user, dropped capabilities, and resource limits. The API reaches it through a host-owned reverse Unix-socket broker: the container may connect to the endpoint, but the endpoint's parent directory is mounted read-only and the host never follows a container-writable socket path.

**Why:** The product needs the same real, production-grade boundary on Replit and an Ubuntu 20.04 server. Browser iframe sandboxing alone does not protect host secrets, files, services, or resources. A relay socket in a writable shared mount lets hostile preview code replace it with a symlink to a host-local service, so a private Unix socket alone is not enough.

**How to apply:** Preserve these container boundaries for every local preview runtime. Do not fall back to a host TCP port, host process execution, or a simulated preview path when Docker setup fails; surface a clear server-side error instead. Include an adversarial check that preview code cannot unlink or redirect the broker endpoint.