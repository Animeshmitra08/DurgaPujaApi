# Google Drive Storage API

A generic file storage backend. Google Drive holds the bytes; MongoDB holds the
metadata. Handles audio, images, video, PDFs, documents and arbitrary files
behind one REST API.

```
Frontend
   │  REST
   ▼
Express ──────► MongoDB Atlas   (metadata + driveFileId)
   │
   ▼
Google Drive API                (the actual files)
```

The frontend never sees a Google Drive file ID and never talks to Google. It
addresses everything by MongoDB `_id`.

---

## Read this before you start: service account storage quota

**A service account cannot own files in a personal Google Drive.** Service
accounts have no storage allocation, so the moment one uploads into a folder
you shared from a Gmail account, Drive returns `storageQuotaExceeded`. Sharing
the folder does not help — the uploader still becomes the file owner.

Two configurations actually work:

| Option | Env vars | Requires |
| --- | --- | --- |
| **Shared Drive** (recommended) | `GOOGLE_SHARED_DRIVE_ID` + `GOOGLE_DRIVE_FOLDER_ID` | Google Workspace |
| **Domain-wide delegation** | `GOOGLE_IMPERSONATE_USER` | Google Workspace admin access |

With a Shared Drive the quota belongs to the drive itself, so the service
account can write freely. With delegation the service account acts as a real
user and consumes that user's quota.

If you have neither, the storage seam in
[storageService.js](src/services/storageService.js) is where you swap Drive for
S3, GCS or Cloudflare R2 — no controller changes required.

The server logs a warning at boot when neither variable is set.

---

## Setup

### 1. Install

```bash
npm install
cp .env.example .env
```

### 2. Create the service account

1. Google Cloud Console → **APIs & Services → Enable APIs** → enable **Google Drive API**.
2. **IAM & Admin → Service Accounts → Create**.
3. On the new account: **Keys → Add key → JSON**. Download it.
4. Copy `client_email` and `private_key` out of the JSON into `.env`.
5. **Delete the JSON file, or store it outside the repo.** It is already
   gitignored, but do not rely on that.

### 3. Grant access

- **Shared Drive:** create one, add the service account email as **Content
  manager**, create a folder inside it. `GOOGLE_SHARED_DRIVE_ID` is in the URL
  at `drive/folders/<id>` for the drive root; `GOOGLE_DRIVE_FOLDER_ID` is the
  folder inside it.
- **Delegation:** Workspace Admin console → Security → API controls → Domain-wide
  delegation → add the service account client ID with scope
  `https://www.googleapis.com/auth/drive`.

### 4. The private key

Keep the literal `\n` escapes and wrap the value in quotes:

```env
GOOGLE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvgIB...\n-----END PRIVATE KEY-----\n"
```

Some hosts (Render, Railway) un-escape it on their own. The loader in
[env.js](src/config/env.js) handles both shapes and strips surrounding quotes.

### 5. Run

```bash
npm run dev    # node --watch
npm start
```

On boot the server validates the environment, connects to Mongo, and probes the
Drive folder so a misconfiguration surfaces immediately rather than on a user's
first upload.

---

## API

Base path `/api/files`. Reads are open. Writes require `x-api-key` **only when
`API_KEY` is set** in the environment — leave it blank for local testing.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/upload` | Upload a file |
| `GET` | `/` | List active files (filter, search, paginate) |
| `GET` | `/:id` | Metadata only |
| `GET` | `/:id/stream` | Stream the bytes (Range-aware) |
| `PATCH` | `/:id` | Update title / description / fileType |
| `PUT` | `/:id/replace` | Replace the binary |
| `DELETE` | `/:id` | Soft delete (`?permanent=true` for real) |
| `GET` | `/stats/summary` | Counts and bytes by type |
| `GET` | `/health` | Liveness + DB state |

### Upload

```http
POST /api/files/upload
Content-Type: multipart/form-data
```

| Field | Required | Notes |
| --- | --- | --- |
| `file` | yes | The binary |
| `title` | no | Defaults to the original filename |
| `description` | no | |
| `fileType` | no | `audio\|image\|video\|pdf\|document\|other`; derived from the MIME type when omitted |
| `folderName` | no | Subfolder under the root, created on demand |

```json
{
  "success": true,
  "message": "File uploaded successfully",
  "data": {
    "_id": "65f...",
    "title": "My Audio",
    "originalName": "audio.mp3",
    "mimeType": "audio/mpeg",
    "fileType": "audio",
    "fileSize": 123456,
    "driveFileId": "1AbC...",
    "isActive": true,
    "createdAt": "2026-09-20T10:00:00.000Z"
  }
}
```

### List

```http
GET /api/files?fileType=audio&page=1&limit=20&search=lecture&sort=-createdAt
```

`fileType`, `search`, `page` (default 1), `limit` (default 20, max 100), and
`sort` (`createdAt`, `title`, `fileSize`, each with an optional `-` prefix) are
all optional. The response carries a `pagination` block alongside `data`.

### Stream

```http
GET /api/files/:id/stream
Range: bytes=0-1048575        # optional
```

Returns `200` for a whole file or `206 Partial Content` for a range, with
`Accept-Ranges`, `Content-Length` and `Content-Range` set. Add `?download=true`
to force a download instead of inline rendering.

### Delete

```http
DELETE /api/files/:id                  # soft: isActive=false, bytes kept in Drive
DELETE /api/files/:id?permanent=true   # removes from Drive, then drops the record
```

Soft delete is the default and is recoverable. Every read path filters on
`isActive`, so a soft-deleted file is invisible to the API — including to
`/stream`.

---

## Frontend usage

Point media elements straight at the stream endpoint:

```jsx
<audio controls src={`${API_URL}/api/files/${file._id}/stream`} />
<img    src={`${API_URL}/api/files/${file._id}/stream`} alt={file.title} />
<video  controls src={`${API_URL}/api/files/${file._id}/stream`} />
<iframe src={`${API_URL}/api/files/${file._id}/stream`} title={file.title} />
```

Upload with `FormData`:

```js
const form = new FormData();
form.append("file", fileInput.files[0]);
form.append("title", "My Audio");
form.append("fileType", "audio");

const res = await fetch(`${API_URL}/api/files/upload`, {
  method: "POST",
  body: form,           // do NOT set Content-Type; the browser adds the boundary
});
```

---

## Postman

Import [postman_collection.json](postman_collection.json) and set the
`baseUrl` variable (default `http://localhost:5000`). The upload request saves
the returned `_id` into a `fileId` collection variable, so the metadata, stream,
patch, replace and delete requests work without copy-pasting IDs.

Requests by hand:

```http
POST   {{baseUrl}}/api/files/upload           # form-data: file, title, description, fileType
GET    {{baseUrl}}/api/files
GET    {{baseUrl}}/api/files?fileType=audio
GET    {{baseUrl}}/api/files/{{fileId}}
GET    {{baseUrl}}/api/files/{{fileId}}/stream
PATCH  {{baseUrl}}/api/files/{{fileId}}       # json: { "title": "...", "description": "..." }
PUT    {{baseUrl}}/api/files/{{fileId}}/replace   # form-data: file
DELETE {{baseUrl}}/api/files/{{fileId}}
```

In Postman, set the `file` field's type to **File** in the form-data editor, and
leave `Content-Type` unset so the boundary is generated for you.

---

## How the failure paths behave

**Upload.** The file reaches Drive before MongoDB can store its ID, which leaves
a window where Drive holds an unreferenced object. If the insert fails, the
upload is deleted. If that cleanup itself fails the file is logged with an
`[ORPHAN]` marker for reconciliation, and the original error still reaches the
client unmasked.

**Replace.** Upload the new file, swap the record, then delete the old one. A
failed upload leaves the original untouched; a failed database write deletes the
new upload and keeps the original. The record never points at an object that
does not exist.

**Temp files.** Removed in a `finally` block, again in the error handler, and
swept hourly for anything a crash left behind.

---

## Security

Implemented here:

- Credentials live only in environment variables, server-side. Nothing Google
  related crosses the API boundary.
- MIME allowlist plus magic-byte sniffing — a declared `image/png` whose bytes
  are HTML is rejected with `415` before it reaches Drive.
- `X-Content-Type-Options: nosniff` on every stream; SVG and HTML are forced to
  `attachment` so they cannot execute on this origin.
- Filenames stripped of path separators, control characters and quotes, so they
  are safe in a `Content-Disposition` header.
- The client passes a folder *name*, never a Drive folder ID; names resolve
  under the configured root only.
- Size limit via `MAX_FILE_SIZE_MB` (default 200), enforced by multer.
- Optional constant-time `x-api-key` check on all write routes.
- Internal errors return a generic message in production; stacks stay in logs.

Still worth adding before serious production traffic:

- **Real authentication.** A shared API key is a floor, not a ceiling. There is
  no per-user ownership model, so any key holder can delete any file.
- **Rate limiting.** No throttle on uploads. Add `express-rate-limit`.
- **Virus scanning.** Nothing inspects file contents beyond the signature check.
- **Orphan reconciliation.** `listFiles()` exists for this; a periodic job that
  diffs Drive against MongoDB is not yet written.

---

## Scaling notes

Drive is not a CDN. Every streamed byte travels Drive → this server → the
client, so each concurrent viewer holds an open socket and consumes bandwidth
twice. That is fine for modest internal media libraries and a poor fit for
public video at scale.

Drive also enforces roughly 750 GB/day of uploads and per-minute request quotas,
answering bursts with `403 rateLimitExceeded`. The service retries those with
exponential backoff and jitter; uploads are deliberately **not** retried, since
a request that reached Drive before the socket died would be duplicated.

When streaming volume becomes the bottleneck, the fix is a CDN in front of
object storage rather than more application servers.

---

## Deployment

Set every variable from `.env.example` in your host's secret manager. Never
commit `.env` or the service-account JSON.

The container filesystem is treated as disposable: `uploads/` is scratch space
for the seconds between a request landing and the Drive upload finishing, and
the loader falls back to the OS temp directory when that path is not writable.
MongoDB Atlas and Google Drive are the only durable stores.

`SIGTERM` closes the listener, drains in-flight requests, disconnects Mongo, and
force-exits after 15 seconds so a stalled stream cannot block a deploy.

---

## Layout

```
src/
├── config/
│   ├── env.js              env parsing, validation, key normalisation
│   ├── db.js               Mongo connection
│   └── googleDrive.js      authenticated Drive client + Shared Drive flags
├── services/
│   ├── googleDriveService.js   ALL Drive-specific logic: retry, errors, streams
│   └── storageService.js       provider-agnostic seam the controllers use
├── models/File.js
├── controllers/fileController.js
├── routes/fileRoutes.js
├── middleware/
│   ├── upload.js           multer temp storage + MIME filter
│   ├── auth.js             optional API key
│   └── errorHandler.js
├── utils/
│   ├── fileType.js         allowlist, type detection, magic bytes
│   ├── sanitize.js         filenames, headers, free text
│   ├── tempFiles.js        cleanup + hourly sweep
│   └── ApiError.js
├── app.js
└── server.js
```

Controllers call `storage.uploadFile()` / `streamFile()` / `deleteFile()` and
never touch `drive.files.*`. Replacing Google Drive means writing one module
with the same shape and changing a single import in `storageService.js`.
