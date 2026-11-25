"""A single background worker that runs transcription and export jobs one at a time."""
import queue
import threading
import time
import uuid


class JobError(Exception):
    """A failure with a short `code` the UI can translate, plus optional detail for logs."""

    def __init__(self, code, detail=""):
        super().__init__(detail or code)
        self.code = code
        self.detail = detail


class JobQueue:
    def __init__(self):
        self._jobs = {}
        self._queue = queue.Queue()
        self._lock = threading.Lock()
        threading.Thread(target=self._worker, name="takecut-jobs", daemon=True).start()

    def submit(self, kind, project, work):
        """`work(progress)` runs on the worker thread; progress(stage, fraction=None)."""
        job = {"id": uuid.uuid4().hex, "kind": kind, "project": project, "state": "queued", "stage": "queued",
               "progress": 0.0, "error": None, "detail": None, "result": None, "created": time.time()}
        with self._lock:
            self._jobs[job["id"]] = job
        self._queue.put((job["id"], work))
        return dict(job)

    def get(self, job_id):
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None

    def active_for(self, project):
        with self._lock:
            return [dict(j) for j in self._jobs.values() if j["project"] == project and j["state"] in ("queued", "running")]

    def _update(self, job_id, **fields):
        with self._lock:
            self._jobs[job_id].update(fields)

    def _worker(self):
        while True:
            job_id, work = self._queue.get()
            self._update(job_id, state="running", started=time.time())

            def progress(stage, fraction=None, _id=job_id):
                fields = {"stage": stage}
                if fraction is not None:
                    fields["progress"] = round(float(fraction), 4)
                self._update(_id, **fields)

            try:
                result = work(progress)
                self._update(job_id, state="done", stage="done", progress=1.0, result=result, finished=time.time())
            except Exception as exc:  # reported through the job, never crashes the worker
                code = getattr(exc, "code", None) or "failed"
                detail = getattr(exc, "detail", None) or str(exc)
                self._update(job_id, state="error", error=code, detail=detail[-1200:], finished=time.time())
