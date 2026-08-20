---
name: SSH process-group cancellation
description: Why SSH-run cancellation must wait briefly for the remote process-group marker before closing its exec channel.
---

When a remote command reports its process-group ID through its SSH exec channel, cancellation must preserve that channel until the marker is received (with a short bounded fallback). Closing it first can prevent delivery of the only ID capable of terminating a detached `setsid` process group.

**Why:** SSH channel closure is not a reliable way to stop descendants, and an early cancellation can otherwise orphan remote work.

**How to apply:** Keep the cancellation request separate from the eventual group kill; stop the group immediately once the marker is known, and close the channel after that or after the grace timeout.