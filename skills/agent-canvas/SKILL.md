---
name: agent-canvas
description: Use the local Agent Canvas API when asked to inspect the shared canvas, delegate work to another Pi agent, message a running agent, record a real delegation, update your own progress note, or work with card-box notes. Only Canvas-launched Pi agents receive this skill.
---

# Agent Canvas API

Canvas launches you with `AGENT_CANVAS_URL` (the local server) and `AGENT_CANVAS_ID` (your node ID). Use your bash tool with `curl` to interact with the server. Before making Canvas API changes, read the **current, complete guide** from the running server:

```sh
curl -fsS "$AGENT_CANVAS_URL/api/docs"
```

This guide is the source of truth for endpoints, request shapes, and safety boundaries. For example, `curl -fsS "$AGENT_CANVAS_URL/api/state"` reads agents, edges, sticky notes, card-box cards and placements. Never guess agent IDs; get them from state. If the server cannot be reached, do not guess or improvise API calls.

Only create delegation edges for work actually delegated; edges do not send messages. Use the explicit messages endpoint to contact a running agent. Do not modify canvas layout coordinates. Only update your own progress note, and do not stop, remove, resume or rename another agent, change a user's notes, or reset the canvas unless asked. Card-box cards are separate from sticky notes; fetch the guide for content limits, tags, and library-versus-placement lifecycle. Only create, modify or delete the user's cards when asked. This localhost API has no authentication; these rules are guidance, not an authorization boundary.
