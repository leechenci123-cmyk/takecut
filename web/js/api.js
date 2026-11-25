// Client for the local API (docs/api.md).

export class ApiError extends Error {
  constructor(code, status = 0, detail = "") {
    super(detail || code);
    this.code = code;
    this.status = status;
  }
}

async function request(method, path, { json, body, headers } = {}) {
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: {
        ...(method !== "GET" ? { "X-Takecut": "1" } : {}),
        ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: json !== undefined ? JSON.stringify(json) : body,
    });
  } catch {
    throw new ApiError("network");
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(data?.error ?? `http-${res.status}`, res.status, data?.message);
  return data;
}

export const api = {
  system: () => request("GET", "/api/system"),
  projects: () => request("GET", "/api/projects"),
  project: id => request("GET", `/api/projects/${id}`),
  sample: lang => request("POST", `/api/samples/${lang}`),
  rename: (id, name) => request("PATCH", `/api/projects/${id}`, { json: { name } }),
  remove: id => request("DELETE", `/api/projects/${id}`),
  saveEdits: (id, edits, stats) => request("PUT", `/api/projects/${id}/edits`, { json: { edits, stats } }),
  retranscribe: (id, options) => request("POST", `/api/projects/${id}/transcribe`, { json: options }),
  export: (id, options) => request("POST", `/api/projects/${id}/export`, { json: options }),
  job: id => request("GET", `/api/jobs/${id}`),
  convert: (texts, to) => request("POST", "/api/text/convert", { json: { texts, to } }),
  audioUrl: id => `/api/projects/${id}/audio`,
  exportUrl: (id, file) => `/api/projects/${id}/exports/${encodeURIComponent(file)}`,

  /** Save on page unload: keepalive lets the request finish after the page is gone. */
  saveEditsKeepalive(id, edits, stats) {
    try {
      fetch(`/api/projects/${id}/edits`, {
        method: "PUT", keepalive: true, headers: { "X-Takecut": "1", "Content-Type": "application/json" },
        body: JSON.stringify({ edits, stats }),
      });
    } catch { /* best effort */ }
  },

  /** Upload with progress (fetch can't report upload progress). Resolves to {id, job}. */
  upload(file, { language, model }, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/projects");
      xhr.setRequestHeader("X-Takecut", "1");
      xhr.setRequestHeader("X-Filename", encodeURIComponent(file.name));
      xhr.setRequestHeader("X-Language", language);
      if (model) xhr.setRequestHeader("X-Model", model);
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = e => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        let data = null;
        try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(new ApiError(data?.error ?? `http-${xhr.status}`, xhr.status, data?.message));
      };
      xhr.onerror = () => reject(new ApiError("network"));
      xhr.send(file);
    });
  },
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Poll a job until it is done or failed. `onUpdate(job)` sees every state. */
export async function waitJob(id, onUpdate, interval = 400) {
  for (;;) {
    const job = await api.job(id);
    onUpdate?.(job);
    if (job.state === "done" || job.state === "error") return job;
    await sleep(interval);
  }
}
