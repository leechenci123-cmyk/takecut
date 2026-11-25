# Takecut local API (v4)

The server listens on `127.0.0.1` only (default port 8769). The browser UI in `web/` is its only client.

- Requests must carry a `Host` of `127.0.0.1:<port>` or `localhost:<port>`. Anything else gets 403, which blocks DNS-rebinding pages.
- `POST`, `PUT`, `PATCH` and `DELETE` must also send the header `X-Takecut: 1`. A cross-site form can't set that header, so this blocks cross-site writes.
- Errors are JSON: `{"error": "<code>", "message": "<English detail>"}`. The UI translates the `code`.

Times are seconds on the **source** timeline unless a field says otherwise. Sample frames are at the project's `sampleRate`.

## System

`GET /api/system`

```json
{
  "version": "4.0.0",
  "ffmpeg": true,
  "opencc": true,
  "cuda": true,
  "models": [{"name": "small", "cached": true}, {"name": "large-v3-turbo", "cached": true}],
  "defaultModel": "large-v3-turbo",
  "dataDir": "C:\\Users\\me\\AppData\\Local\\Takecut"
}
```

## Projects

`GET /api/projects` → `{"projects": [Summary, ...]}`, newest first.

A **Summary** is the `project.json` content:

```json
{
  "id": "3f2a…(32 hex)", "name": "Episode 12", "created": 1764100000.0, "updated": 1764100100.0,
  "status": "queued | transcribing | ready | error", "error": null,
  "duration": 21.8, "frames": 961154, "sampleRate": 44100, "channels": 1,
  "language": "zh | en | auto", "detectedLanguage": "zh", "model": "small", "device": "cpu",
  "sample": false, "job": "<job id while working>",
  "stats": {"editedDuration": 19.6, "cutSeconds": 2.6}
}
```

`POST /api/projects` creates a project from an upload and queues transcription.

- Body: the raw file bytes, up to 512 MiB. Audio or video; the first audio track is used, up to 60 minutes.
- Headers:
  - `X-Filename`: URI-encoded original name.
  - `X-Language`: `zh`, `en` or `auto`.
  - `X-Model` (optional): a model name from `/api/system`.
- Response: `202 {"id": "…", "job": "…"}`.

`POST /api/samples/<zh|en>` opens a bundled sample as a project and returns its Summary. The sample project is reused while it exists; delete it to start over from the original.

`GET /api/projects/<id>` → `{"project": Summary, "words": [Word], "analysis": Analysis | null, "edits": Edits}`

- **Word**: `{"start": 3.82, "end": 4.3, "text": "今天", "p": 0.93}`, where `p` is Whisper's word probability.
- **Analysis** (see `takecut/analyze.py`):

  ```json
  {"hop": 0.01, "floorDb": -62.0, "speechDb": -24.0,
   "silences": [[0.56, 1.06], ...],
   "sounds": [{"start": 10.2, "end": 10.5, "db": -30.1, "voiced": true}],
   "snap": [[3.80, 4.31], ...]}
  ```

  `snap[i]` holds the quietest point near the start and the end of word `i`; smart cuts use it.
- **Edits**: see `web/js/core/edits.js`. Shape: `{"version": 4, "cuts": [[a, b]], "pauses": [{"at": t, "duration": d}], "splits": [t], "fixes": {"12": "text"}, "ignored": ["retake:3.82"]}`.

`PATCH /api/projects/<id>` with `{"name": "New name"}` → the new Summary.

`PUT /api/projects/<id>/edits` with `{"edits": Edits, "stats": {"editedDuration": …, "cutSeconds": …}}` → `{"updated": <time>}`. The UI saves automatically after each change.

`DELETE /api/projects/<id>` → `204`. Deletes the folder and everything exported from it.

`GET /api/projects/<id>/audio` → the preview WAV (mono, 16-bit, project sample rate). Supports `Range`.

`POST /api/projects/<id>/transcribe` with `{"language": "en", "model": "small"}` → `202 {"job": "…"}`. Transcribes again. Cuts and pauses are kept; word fixes and ignored suggestions are cleared, because word indices change.

## Export

`POST /api/projects/<id>/export` → `202 {"job": "…"}`. Body:

```json
{
  "format": "wav | mp3 | m4a",
  "loudness": null,
  "denoise": false,
  "sampleRate": 44100,
  "segments": [{"type": "audio", "start": 0, "end": 120000}, {"type": "silence", "frames": 17640}]
}
```

- `loudness`: `null`, `-16` or `-14` (LUFS).
- `segments`: `renderList(buildPlan(...))` from `web/js/core/timeline.js`. Audio pieces are source frame ranges `[start, end)`; silence pieces are frame counts. An `end` up to 0.1 s past the source is clamped (browser decoders can differ by a few samples).
- The server renders from the full-quality source with FFmpeg and adds a 3 ms fade at every join.

When the job finishes, its `result` is `{"file": "Episode 12-takecut.mp3", "size": 123456, "duration": 19.6}`. Download it from `GET /api/projects/<id>/exports/<file>`, which is served as an attachment.

## Jobs

`GET /api/jobs/<id>`:

```json
{"id": "…", "kind": "transcribe | export", "project": "…",
 "state": "queued | running | done | error",
 "progress": 0.42, "stage": "transcribing", "error": null, "result": null}
```

`stage` is one of `queued`, `decoding`, `loading-model`, `transcribing`, `analyzing`, `rendering`, `measuring`, `encoding`, `done`. The UI shows it translated. Jobs run one at a time in a single worker thread.

## Text

`POST /api/text/convert` with `{"texts": ["…"], "to": "s | t"}` → `{"texts": ["…"]}`. Converts between Simplified and Traditional Chinese with OpenCC. Returns `501` when OpenCC isn't installed.
