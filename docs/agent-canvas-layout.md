# Agent-controlled Agent Canvas layout

Agents may place and resize **any Agent Canvas agent, sticky note or card placement**, including objects created by humans or other agents. No ownership restriction or per-operation confirmation is required for layout alone. This does not authorize changing someone else's text, agent name/process/session, deleting objects, or resetting Canvas. Card Box layouts/viewports and its docked agent remain human-controlled.

## Read geometry

`GET /api/canvas/layout` returns `{objects:[{kind,id,x,y,width,height,busy}]}`. Kinds are `agent`, `note`, and `card`; card IDs identify the Agent Canvas placement, not a Card Box view placement. The Card Box agent is excluded. Geometry is in unzoomed **canvas units**, not screen pixels. Negative positions are valid. Use this endpoint instead of inferring coordinates from screenshots or reading persistence files.

## Create with optional geometry

The existing endpoints accept top-level `x`, `y`, `width`, and `height`:

- `POST /api/agents`: ordinary fields (`name`, `workdir`, optional `task`/`parentId`/`mode`) plus geometry.
- `POST /api/notes`: optional `text`/`title` plus geometry.
- `POST /api/cards`: ordinary card fields plus geometry; requires `place` omitted or `true`. The card still joins the current Card Box view under the existing rule, but these geometry fields affect **only its Agent Canvas placement**.
- `POST /api/cards/:id/placement`: `{}` retains the existing idempotent default; geometry can be supplied when placing a library-only card. If already placed, supplying geometry returns 409; use PATCH instead.

Supplying **any** geometry field checks the resulting complete rectangle, including defaults for omitted fields. Creation without geometry keeps all existing default placement behavior, even if those defaults overlap. Supplying geometry together with `place:false` is invalid (400).

Example (choose coordinates using current geometry, not these illustrative values):

```http
POST /api/notes
Content-Type: application/json

{"text":"Review next","x":1200,"y":100,"width":280,"height":220}
```

Explicitly positioned API agent launches do not steal focus or change the viewport. Human launches retain their current focus behavior; no-geometry launches retain existing behavior.

## Adjust one existing object

- `PATCH /api/agents/:id`
- `PATCH /api/notes/:id`
- `PATCH /api/card-placements/:id`

Supply one or more geometry fields. Omitted fields retain their current value. Changes persist and synchronize over SSE without changing the human's current viewport. There is no batch/multi-object endpoint and no undo feature in this version. To exchange occupied positions, use an unoccupied temporary location across separate operations; do not expect simultaneous swaps.

Minimum dimensions:

| Object | Width | Height |
| --- | ---: | ---: |
| Agent | 320 | 240 |
| Sticky note | 160 | 160 |
| Markdown card | 240 | 240 |
| Interactive card | 320 | 240 |

All values must be finite numbers; invalid geometry returns 400. Rectangles include their entire saved bounds, even if the node is currently maximized. Maximization and viewport scale do not change saved geometry. Agent layout operations do not maximize objects or pan/zoom the human view.

## Rejection and retry

The complete result must not overlap **any other Agent Canvas object**. Touching edges is allowed, with no required gap. Existing overlaps are not grandfathered: every API adjustment must leave its target completely non-overlapping. Notes, cards, running and stopped agents all count as obstacles; delegation edges and Card Box objects do not.

A collision returns 409:

```json
{"error":"Layout overlaps existing Agent Canvas objects","code":"LAYOUT_CONFLICT","conflicts":[{"kind":"note","id":"…","x":100,"y":100,"width":280,"height":220}]}
```

An ongoing human drag or resize of the target returns 409:

```json
{"error":"A human is moving or resizing this object; retry later","code":"LAYOUT_BUSY","object":{"kind":"note","id":"…"}}
```

Read fresh geometry and choose a different position or retry after the gesture ends. Rejections leave geometry and any combined metadata unchanged. Rejected card creation does not create a library card/view membership, and rejected agent creation does not spawn a PTY or create a delegation edge. No automatic retry, movement to a nearby slot, or confirmation UI is added.

## Human browser transport

Humans remain free to overlap objects. Browser requests explicitly send `X-Canvas-Layout: human`; ordinary API requests without this marker use the checks above. **This header is an intent distinction, not authentication.** The existing loopback API has no identity/authorization boundary. Agents must not spoof the human marker or call the browser gesture endpoints to bypass these rules.

During an Agent Canvas drag/resize, the browser calls `POST /api/canvas/layout-interactions/:kind/:id` with the human header and `{owner,action:"start"|"renew"|"end"}`. Each gesture has a random owner, renews every 3 seconds, and holds its lease until the final geometry write completes. Separate tabs' owners coexist; one tab cannot accidentally release another's gesture. Abandoned leases expire after 10 seconds and are never persisted. Protection begins when the server receives the start notification; it cannot protect against requests arriving before that notification or during a network outage. Card Box gestures do not take these leases.

No persistence-schema migration is required. Restart the backend after updating it; newly launched/resumed Pi processes receive the updated layout instructions. Do not automatically stop or restart existing agents just to refresh their instructions.
