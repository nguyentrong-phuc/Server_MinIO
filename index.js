const SKIP_BUCKET_CHECK = process.env.SKIP_BUCKET_CHECK === "true";

(async () => {
  if (SKIP_BUCKET_CHECK) {
    console.log("[BOOT] Skip bucket check (SKIP_BUCKET_CHECK=true)");
    return;
  }
  try {
    await ensureBucket(BUCKET_UPLOAD);
    if (BUCKET_PRESIGN !== BUCKET_UPLOAD) await ensureBucket(BUCKET_PRESIGN);
  } catch (e) {
    console.error("[BOOT] Bucket check error:", e?.message || e);
  }
})();


require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { Client } = require("minio");

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

/* ========= ENV & CLIENTS ========= */
const PORT = parseInt(process.env.PORT || "3000", 10);

// Nội bộ (kết nối trong LAN để check/make bucket)
const INTERNAL_ENDPOINT = process.env.MINIO_INT_EP || process.env.MINIO_ENDPT || "127.0.0.1";
const INTERNAL_PORT     = parseInt(process.env.MINIO_INT_PORT || process.env.MINIO_PORT || "9000", 10);
const INTERNAL_SSL      = (process.env.MINIO_INT_SSL ?? process.env.MINIO_USE_SSL) === "true";

const ACCESS_KEY  = process.env.MINIO_ACCESS_KEY;
const SECRET_KEY  = process.env.MINIO_SECRET_KEY;
const REGION      = process.env.REGION || "us-east-1";

// Bucket
const BUCKET_UPLOAD  = process.env.MINIO_BUCKET || "dev";
const BUCKET_PRESIGN = (process.env.PRESIGN_BUCKET && process.env.PRESIGN_BUCKET.trim())
  ? process.env.PRESIGN_BUCKET.trim()
  : BUCKET_UPLOAD;

// MinIO client nội bộ (make/check bucket)
const minioInternal = new Client({
  endPoint: INTERNAL_ENDPOINT,
  port: INTERNAL_PORT,
  useSSL: INTERNAL_SSL,
  accessKey: ACCESS_KEY,
  secretKey: SECRET_KEY,
  region: REGION,
  pathStyle: true,
});

/* ===== Parse PUBLIC_BASE_URL (gọn hơn) ===== */
let signerHost = process.env.PUBLIC_HOST || INTERNAL_ENDPOINT;
let signerSSL  = (process.env.PUBLIC_SSL ?? process.env.MINIO_USE_SSL) === "true";
let signerPort = parseInt(process.env.PUBLIC_PORT || process.env.MINIO_PORT || "9000", 10);

if (process.env.PUBLIC_BASE_URL) {
  try {
    const u = new URL(process.env.PUBLIC_BASE_URL);
    signerHost = u.hostname;
    signerSSL  = u.protocol === "https:";
    signerPort = u.port ? parseInt(u.port, 10) : (signerSSL ? 443 : 80);
  } catch (e) {
    console.warn("[WARN] PUBLIC_BASE_URL parse failed, fallback to PUBLIC_HOST/PORT/SSL");
  }
}

// MinIO client ký URL (host công khai/domain)
const minioSigner = new Client({
  endPoint: signerHost,
  port: signerPort,
  useSSL: signerSSL,
  accessKey: ACCESS_KEY,
  secretKey: SECRET_KEY,
  region: REGION,
  pathStyle: true,
});

/* ========= Ensure buckets ========= */
async function ensureBucket(bucket) {
  try {
    const exists = await minioInternal.bucketExists(bucket);
    if (!exists) {
      await minioInternal.makeBucket(bucket, REGION);
      console.log(`[BOOT] Created bucket '${bucket}'`);
    } else {
      console.log(`[BOOT] Bucket '${bucket}' OK`);
    }
  } catch (e) {
    console.error(`[BOOT] Bucket '${bucket}' error:`, e?.message || e);
  }
}
(async () => {
  await ensureBucket(BUCKET_UPLOAD);
  if (BUCKET_PRESIGN !== BUCKET_UPLOAD) await ensureBucket(BUCKET_PRESIGN);
})();

/* ========= Helpers ========= */
const rmAccents = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
const safeFolder = (s) =>
  rmAccents(String(s || "")).replace(/[\\/]+/g, "-").replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64);
const userToken = (name) => {
  const parts = rmAccents(String(name || "User")).trim().split(/[^A-Za-z0-9]+/).filter(Boolean);
  return (parts.length ? parts.map((p) => p[0].toUpperCase() + p.slice(1).toLowerCase()).join("") : "User").slice(0, 64);
};
const taskTokenUpper = (task) => rmAccents(String(task || "TASK")).replace(/[^A-Za-z0-9]+/g, "").toUpperCase();

function requireFields(o, f) {
  for (const k of f) {
    if (o[k] === undefined || o[k] === null || o[k] === "") throw new Error(`Missing field: ${k}`);
  }
}

function buildBase({ projectId, userName, orderIndex, taskName, padWidth = 3 }) {
  requireFields({ projectId, userName, orderIndex, taskName }, ["projectId", "userName", "orderIndex", "taskName"]);
  const n = parseInt(String(orderIndex), 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error("orderIndex must be a positive integer");
  const projectID = safeFolder(projectId);
  const uTok = userToken(userName);
  const TASK = taskTokenUpper(taskName);
  const idx = String(n).padStart(padWidth, "0");
  return `project/${projectID}/OM/${uTok}/checklist/${idx}_${TASK}`;
}

function buildKey({ base, phase, kind, index }) {
  if (!["pre", "doing", "post"].includes(phase)) throw new Error("Invalid phase");
  const folder = `${base}/${phase}`;
  if (kind === "photo") {
    const i = Number(index);
    if (!Number.isFinite(i) || i <= 0) throw new Error("photo index is required (>0)");
    return `${folder}/photo_${String(i).padStart(2, "0")}.jpg`;
  }
  if (kind === "video") {
    const i = Number(index);
    if (!Number.isFinite(i) || i <= 0) throw new Error("video index is required (>0)");
    return `${folder}/video_${String(i).padStart(2, "0")}.mp4`;
  }
  if (kind === "note") return `${folder}/note.txt`;
  throw new Error("Invalid kind");
}

/* ========= Routes ========= */

app.get("/health-minio", (req, res) => {
  res.status(200).json({ ok: true, ts: new Date().toISOString() });
});


// Health
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    uploadBucket: BUCKET_UPLOAD,
    presignBucket: BUCKET_PRESIGN,
    public: { host: signerHost, port: signerPort, ssl: signerSSL },
  });
});

/* ---- A) Upload (multipart/form-data) ---- */
const storage = multer.memoryStorage();
const upload = multer({ storage });

/**
 * POST /upload
 * form-data:
 *  - image: file
 *  - filename?: string (nếu không có sẽ dùng originalname)
 *  - (tuỳ chọn) commentKey, idCode, stt
 */
app.post("/upload", upload.single("image"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ ok: false, error: "Missing file field 'image'" });

    const { originalname, mimetype, buffer } = req.file;
    let { filename, commentKey, idCode, stt } = req.body;

    if (!filename) filename = originalname;

    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const prefix = `${yyyy}/${mm}/${dd}`;
    const objectName = `${prefix}/${filename}`;

    await minioInternal.putObject(BUCKET_UPLOAD, objectName, buffer, {
      "Content-Type": mimetype || "application/octet-stream",
    });

    // presign GET (để xem/lấy về) — hết hạn 7 ngày
    const expires = 7 * 24 * 60 * 60;
    const presignedUrl = await minioSigner.presignedGetObject(BUCKET_UPLOAD, objectName, expires);

    return res.json({
      ok: true,
      bucket: BUCKET_UPLOAD,
      key: objectName,
      url: presignedUrl,
      meta: { commentKey, idCode, stt },
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || "Upload failed" });
  }
});

/* ---- B) Presign cho checklist (app mobile sẽ PUT trực tiếp) ---- */

// Test presign PUT đơn
app.get("/presign-put", async (req, res) => {
  try {
    const key = String(req.query.key || "ping.txt");
    const url = await minioSigner.presignedPutObject(BUCKET_PRESIGN, key, 600);
    res.json({ bucket: BUCKET_PRESIGN, key, url });
  } catch (e) {
    res.status(400).json({ error: e?.message || "Presign failed" });
  }
});

/**
 * POST /presign-checklist-batch
 * Body: { projectId, userName, orderIndex, taskName, plans:[{kind,phase,index?}] }
 * Return: { bucket, expiresIn, results:[{kind,phase,index,key,url}] }
 */
app.post("/presign-checklist-batch", async (req, res) => {
  try {
    const { projectId, userName, orderIndex, taskName, plans } = req.body || {};
    if (!Array.isArray(plans) || plans.length === 0)
      return res.status(400).json({ error: "plans required" });

    const base = buildBase({ projectId, userName, orderIndex, taskName });

    const localCounters = new Map();
    const nextIdx = (phase, kind) => {
      const k = `${phase}:${kind}`;
      const n = (localCounters.get(k) || 0) + 1;
      localCounters.set(k, n);
      return n;
    };

    const results = [];
    for (const raw of plans) {
      const { kind, phase } = raw || {};
      let idx = null;
      if (kind === "photo" || kind === "video") {
        const parsed = Number(raw.index);
        idx = Number.isFinite(parsed) && parsed > 0 ? parsed : nextIdx(phase, kind);
      }
      const key = buildKey({ base, phase, kind, index: idx });
      const url = await minioSigner.presignedPutObject(BUCKET_PRESIGN, key, 3600);
      results.push({ kind, phase, index: idx, key, url });
    }
    res.json({ bucket: BUCKET_PRESIGN, expiresIn: 3600, results });
  } catch (e) {
    console.error("presign-checklist-batch", e?.message || e);
    res.status(400).json({ error: e?.message || "Presign failed" });
  }
});

/* ========= Start ========= */
app.listen(PORT, () => {
  const pub = `${signerSSL ? "https" : "http"}://${signerHost}:${signerPort}`;
  console.log(
    `OK http://0.0.0.0:${PORT} | uploadBucket=${BUCKET_UPLOAD} presignBucket=${BUCKET_PRESIGN}\n` +
    `Public for signed URLs: ${pub}`
  );
});
