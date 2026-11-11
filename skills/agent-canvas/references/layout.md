# Agent Canvas layout

Agents may directly position/resize **any** Agent Canvas Card, Note or Agent, regardless of creator, without extra human confirmation. This permission covers geometry only, not someone else's content, agent lifecycle or deletion. Card Box remains human-layout-only.

Use canvas_layout({offset?,limit?}) for paginated {objects:[{kind,id,x,y,width,height,busy}],total,offset,nextOffset,source,serverEpoch,sampledAt} in unzoomed canvas units (negative positions allowed). When creating via `POST /api/agents`, `/api/notes`, or `/api/cards`, optional top-level `x,y,width,height` specify the Agent Canvas rectangle. Cards require `place:true` or omitted; `place:false` plus geometry is rejected. Without explicit geometry, the server uses default placement. Explicitly positioned API agent launches do not steal focus or move the viewport.

Update one object via `PATCH /api/agents/:id`, `/api/notes/:id`, or `/api/card-placements/:id`. Omitted geometry is preserved. Minimum sizes: agent 320×240, note 160×160, Markdown card 240×240, interactive card 320×240. No batch operation or undo is provided. Existing-object API layout changes do not pan/zoom the human's view.

The complete resulting rectangle must not overlap other Agent Canvas objects; touching edges is allowed. This applies even to targets already overlapping because a human put them there. On overlap, return 409 with `code:"LAYOUT_CONFLICT"` and `conflicts:[{kind,id,x,y,width,height}]`. During a human drag/resize of the target, return 409 with `code:"LAYOUT_BUSY"` and `object:{kind,id}`; retry later. Rejections are atomic (including combined metadata changes); rejected creation creates no library/view entry or PTY. No implicit adjustment to a nearby slot occurs.

Human gestures may still overlap. The browser uses an explicit `X-Canvas-Layout: human` intent marker and temporary gesture leases. **Agents must not set that marker or call `/api/canvas/layout-interactions/...`**. These are cooperative transport rules, not authentication; this loopback API has no auth system.
