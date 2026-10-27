# cover-forge — operator notes

The README covers the renderer and its API. This file documents the backfill modes in more depth.

## Folder covers (`bin/backfill-folder.mjs`)

The Jellyfin backfill (`bin/backfill-jellyfin.mjs`) uploads placeholders into Jellyfin only. Players that read
artwork straight from the file system (for example a music server's local-files provider, which looks for
`folder.*` / `cover.*` as jpg/jpeg/png/gif) never see them. The folder backfill closes that gap: for every
**album** in the Jellyfin ledger (`/data/ledger.json`) it writes the same cover as `folder.jpg` into the album's
folder.

### How it works

1. Reads the Jellyfin ledger (`LEDGER`, default `/data/ledger.json`; `--jf-ledger` overrides) and asks Jellyfin
   for those items with their `Path`.
2. Rebuilds the cover metadata exactly as the Jellyfin backfill does (same title normaliser, `--size`/`--seed`),
   so the hash, layout and pixels are the same; the image is fetched from the renderer as a JPEG
   (`format=jpeg`, quality `JPEG_QUALITY`, default 90, 1000 px). Albums whose metadata changed since the
   Jellyfin upload are listed as `meta-drift`; run `backfill-jellyfin.mjs --refresh` first if Jellyfin and
   the folder must match exactly.
3. Maps the path: the `JELLYFIN_MUSIC_PREFIX` Jellyfin reports (default `/music`) is replaced by `MUSIC_ROOT`
   (where the tree is mounted inside the cover-forge container, default `/music`). A path outside the prefix,
   containing `..`, or resolving (after symlinks) outside `MUSIC_ROOT` is refused (`unmapped-path`); a folder
   that does not exist is `missing-dir`.
4. Never overwrites: a folder that already contains any `folder.*`, `cover.*`, `front.*` or `album.*` image
   (case-insensitive) is skipped and listed. With `--apply` the file is written to a temp file in the folder and
   hard-linked to `folder.jpg`, which fails instead of replacing a file that appeared in the meantime.
5. Records every write in the folder ledger (`LEDGER_FOLDER`, default `/data/ledger-folder.json`, written
   atomically): `{items: {<itemId>: {path, sha256, hash, layout, writtenAt}}}`. Ledger items are skipped on later
   runs; `--refresh` rewrites them only while the file on disk still has the recorded sha256 (still ours).

### Setup

```yaml
# docker-compose.yml (already present) — host side comes from MUSIC_DIR in .env
volumes:
  - ${MUSIC_DIR:-./music}:/music
```

```bash
# .env
MUSIC_DIR=/path/to/your/music          # read-write: the container uid (PUID) must be able to write the album folders
JELLYFIN_MUSIC_PREFIX=/media/music     # the same tree as it appears in Jellyfin's item paths
#MUSIC_ROOT=/music                     # only if you mount it elsewhere
```

Then `docker compose up -d` to add the mount.

### Running

```bash
docker compose exec cover-forge node bin/backfill-folder.mjs --dry-run --limit 10   # plan + JPEGs in /data/backfill-folder-dry/
docker compose exec cover-forge node bin/backfill-folder.mjs --apply                # write folder.jpg files
docker compose exec cover-forge node bin/backfill-folder.mjs --revert               # what would be removed
docker compose exec cover-forge node bin/backfill-folder.mjs --revert --apply       # remove our unchanged folder.jpg files
```

The dry run also renders the `missing-dir` albums, so the plan and the images can be checked before the music
tree is mounted. `--apply` never renders them.

Plan categories: `planned`, `skipped-existing-cover`, `skipped-in-ledger`, `skipped-changed` (our `folder.jpg`
was replaced; `--refresh` only), `unmapped-path`, `missing-dir`, `gone-from-jellyfin`.

Keep `/data` (both ledgers) in your backups: the folder ledger's sha256 values are what allow a safe `--revert`.
