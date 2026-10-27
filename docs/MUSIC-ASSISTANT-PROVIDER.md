# Handoff: cover-forge as a Music Assistant metadata provider

Goal: let [Music Assistant](https://github.com/music-assistant/server) (MA) fall back to a cover-forge
placeholder for any album or artist that still has no artwork after its real metadata sources
(fanart.tv, Cover Art Archive, iTunes artwork, TheAudioDB, MusicBrainz) have been asked. Nothing is
written into the music folders; MA stores and caches the image like any other provider image.

Two deliverables, in this order.

## 1. MA provider `placeholder_artwork` (generic, upstream-able)

A **metadata** provider for the MA server, written so it is not tied to any one deployment:
the renderer base URL and an optional bearer token are config entries. cover-forge is the reference
renderer; any HTTP service implementing the contract in section 3 works.

Facts about MA that the implementation must match (verified against MA server **2.10.6**, Python 3.14):

- Providers live in `music_assistant/providers/<domain>/` with `manifest.json`, `__init__.py`,
  `strings.json`, `icon.svg`. MA scans that directory (`mass.py`, `PROVIDERS_PATH`); there is no
  external plugin path, so for local testing the directory is bind-mounted into the container at
  `/app/venv/lib/python3.14/site-packages/music_assistant/providers/placeholder_artwork` (read-only).
- `manifest.json` for a metadata provider (copy the shape of `providers/itunes_artwork/manifest.json`):
  `type: "metadata"`, `domain`, `stage`, `name`, `description`, `codeowners`, `requirements: []`,
  `multi_instance: false`.
- `__init__.py` exposes `async def setup(mass, manifest, config) -> ProviderInstanceType` returning
  a subclass of `music_assistant.models.metadata_provider.MetadataProvider` with
  `SUPPORTED_FEATURES = {ProviderFeature.ALBUM_METADATA, ProviderFeature.ARTIST_METADATA}`.
- Interface to implement: `get_config_entries()` (base URL, token, "albums" and "artists" toggles,
  size), `priority` (property, int; base class returns 50, iTunes returns 30; see
  `controllers/metadata/controller.py` around the `sorted(..., key=lambda p: p.priority)` call for the
  direction and pick the value that makes this provider run **last**), `get_album_metadata(album)`,
  `get_artist_metadata(artist)`, and `resolve_image(path) -> bytes`.
- Fallback rule: enrichment (`controllers/metadata/enrichment.py`, `_update_album_metadata`) mutates
  the same `album` object as each provider's result is merged, so `if album.metadata.images: return None`
  at the top of `get_album_metadata` makes this a true last-resort provider. Same for artists.
- Return `MediaItemMetadata(images=UniqueList([MediaItemImage(type=ImageType.THUMB, path=<opaque key>,
  provider=self.domain, remotely_accessible=False)]))`. With `remotely_accessible=False` MA calls this
  provider's `resolve_image(path)` to get the bytes, so the token never leaves the provider and the
  renderer can stay on loopback. Encode title/artist/year/kind in `path` (e.g. a URL-safe JSON or query
  string) and have `resolve_image` call the renderer with the bearer header via `self.mass.http_session`.
- Enrichment only runs when MA's "enable online metadata" setting is on, and per item at most once per
  refresh interval, in the background metadata pass; covers appear over time, not instantly.
- Development: `https://developers.music-assistant.io`, repo `music-assistant/server`, run `scripts/setup.sh`,
  add the provider, add tests under `tests/providers/`, run `pre-commit` (ruff, mypy) and `pytest`.
  Upstream PR: title "Add placeholder_artwork metadata provider (last-resort generated covers)", describe
  the contract and that the renderer is self-hosted and optional.

## 2. cover-forge side

- Branch `folder-covers` already adds `format=jpeg` (`/cover.jpg`, `/sheet.jpg`, `JPEG_QUALITY`).
  Merge or rebase onto it.
- Publish a container image (GitHub Actions → GHCR, tag per release) so an MA user can run the renderer
  with one compose service. Keep the bearer token optional: `TOKEN` unset = open on whatever interface
  the operator binds.
- Document the contract below in the README as "API contract (v1)" and keep it stable.

## 3. Renderer contract (v1) the provider relies on

- `GET /cover.jpg?title=<str>&artist=<str>[&year=<int>][&size=<px>][&layout=1a|1b|1c|1d]` → `image/jpeg`
  (`/cover.png` → `image/png`). Deterministic: same inputs → same image.
- `GET /healthz` → 200 JSON.
- `Authorization: Bearer <token>` when the server has a token configured; 401 otherwise.
- Response headers `x-cover-layout`, `x-cover-ink`, `x-cover-cat` (informational).
- Artist placeholders: same endpoint with `kind=artist` (to add: a layout without a title band).

## Acceptance

- Throwaway MA container (`ghcr.io/music-assistant/server:2.10.6`, fresh `/data`) with the provider
  mounted, a filesystem provider on a small test folder of untagged files, and cover-forge reachable:
  after enabling the provider and running "update metadata", albums without art show placeholders;
  albums with embedded or online art are untouched. Provider errors (renderer down) are logged once and
  do not break enrichment.
- Unit tests for the fallback rule, the path encoding and `resolve_image`.
- `ruff`, `mypy` and `pytest` clean in the MA repo; `node --test` clean in cover-forge.

## Update 2026-10-27: scope is placeholders only

Real covers are no longer the provider's problem. The reference deployment keeps every cover it already had
(exported from the previous media server as `folder.jpg` / `artist.jpg` in a side store that mirrors the
music tree) and presents that store to MA through a read-only overlay mount on top of the music folder, so
MA's own filesystem provider reads them natively. The provider therefore only has to cover the albums and
artists that still have **no image after every other metadata provider ran** (local files, MusicBrainz /
Cover Art Archive, TheAudioDB, fanart.tv, iTunes). Keep the "run last, return nothing when an image already
exists" rule from section 1; nothing else changes. `kind=artist` in the renderer contract (section 3) is still
wanted so artist tiles get a placeholder too.
