---
name: Live preview start recovery
description: Browser proxy requests can end before a preview sandbox finishes starting.
---

Workspace clients must confirm live-preview status after a failed start request before reporting failure.

**Why:** A browser-facing proxy can close a long-running start request even though the API completes sandbox startup. Treating that disconnect as a definite failure leaves the workspace offline while the server is actually running.

**How to apply:** When a served-preview start call fails at the client, briefly poll the authenticated serve-status endpoint, obtain a fresh owner preview capability from the running server URL, and only show an error if the server never becomes active.