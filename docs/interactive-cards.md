# Interactive cards

Interactive cards are a separate card type beside Markdown cards. They retain the normal immutable card ID, bidirectional links, tags, Card Library membership, saved/temporary views, Unfiled behavior, and Agent Canvas placement. Their default placement is 560×420 with the existing 240×240 Canvas minimum; aspect ratio is not fixed.

## Data and authoring

Only the semantic API creates or changes executable source. There is no human HTML/CSS/JavaScript editor. An interactive card has:

- required `title` (1–120 characters)
- `html` (at most 250 KiB UTF-8)
- `css` (at most 100 KiB UTF-8)
- `javascript` (at most 2 MiB UTF-8)
- tags and reciprocal links
- zero or more private image/audio/video assets

Human UI can edit title, tags and links, flip metadata, navigate tags/links, manage view membership, move/resize/remove placement, and permanently delete the card. Card type and ID are immutable. HTML cannot contain `<script>`, `<style>`, nested browsing/plugin/navigation metadata, or forms; executable code belongs in `javascript` and stylesheet rules belong in `css`. HTML `src`/`href`/`poster` URLs must be `card-asset://…`, `data:…`, or a local `#fragment`. Audio/video autoplay attributes are rejected.

The Card Library shows the title and an interactive-type marker without mounting a runtime. Search covers title, tags and ID but intentionally excludes executable source.

## Runtime and lifecycle

The browser renders content in an iframe with `sandbox="allow-scripts"`, an opaque origin, and a restrictive CSP. It has no Canvas API, parent DOM, cookies, storage, forms, popups, downloads, external network, workers, camera, microphone, location, clipboard or top-level navigation. Content can use HTML/CSS, inline SVG, Canvas 2D, WebGL, JavaScript, Web Audio after activation, and imported image/audio/video blobs. WebGPU, WebAssembly, workers, custom web fonts, external libraries and CDNs are outside the first-version contract.

Pure HTML/CSS/SVG renders immediately. JavaScript or detected CSS animation remains behind Play; Restart creates a fresh runtime. Leaving the viewport or view destroys the iframe and runtime state. Returning starts from the static pre-Play state. Source or asset changes increment an interactive revision, destroy the old runtime and require activation again. Ordinary runtime errors are bounded, shown inside the card and offer Restart without corrupting parent state. The iframe is a capability boundary, not a CPU/memory quota: deliberately hostile or accidental infinite-loop JavaScript can still freeze the browser tab. Play is therefore a human trust boundary; inspect or regenerate questionable agent-authored source before running it.

The iframe always fills the card's remaining content rectangle. SVG should use `viewBox`; HTML/CSS should use percentage sizing. Canvas code owns bitmap resolution and redraw and should listen for the normal `resize` event.

## Private assets

Agents import from fixed read-only source folders:

```text
~/Documents/agent-canvas/media/images/
~/Documents/agent-canvas/media/audio/
~/Documents/agent-canvas/media/video/
```

The source is a safe relative path. Imports reject absolute paths, `..`, symbolic-link escape, unsupported/mismatched file signatures, files over 25 MiB, duplicate logical names and cards over 100 MiB total. Accepted first-version formats are JPEG, PNG, WebP, GIF, MP3, M4A, WAV, OGG/Opus, MP4, WebM and MOV. Files are copied into card-owned storage and referenced in HTML, CSS or JavaScript as `card-asset://<name>`. The runtime substitutes only the card's opaque asset URLs into its CSP; the sandbox can load/fetch those exact files but has no unrestricted network source. For origin-clean Canvas drawing, fetch the `card-asset://name` URL from JavaScript and create an in-frame blob URL, or set `crossorigin="anonymous"` before assigning it to an image. Removing an asset or permanently deleting its card removes the private copy.

## API examples

Create without Agent Canvas placement:

```http
POST /api/cards
Content-Type: application/json

{
  "type": "interactive",
  "title": "Orbit",
  "html": "<svg viewBox=\"0 0 100 100\"><circle id=\"planet\" cx=\"50\" cy=\"20\" r=\"5\"/></svg>",
  "css": "svg { width: 100%; height: 100%; }",
  "javascript": "document.querySelector('#planet').addEventListener('click', () => { /* ... */ });",
  "tags": ["demo"],
  "links": [],
  "place": false
}
```

Update source or editable metadata:

```http
PATCH /api/cards/2026-10-03-0001
Content-Type: application/json

{ "title": "New title", "javascript": "/* complete replacement */" }
```

Import and reference a local image:

```http
POST /api/cards/2026-10-03-0001/interactive-assets/import
Content-Type: application/json

{ "kind": "image", "source": "charts/background.png", "name": "background" }
```

```html
<img src="card-asset://background" alt="Background">
```

Remove it:

```http
DELETE /api/cards/2026-10-03-0001/interactive-assets/background
Content-Type: application/json

{}
```
