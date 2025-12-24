import express from "express";
import cors from "cors";
import multer from "multer";
import { nanoid } from "nanoid";
import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const app = express();
const PORT = process.env.PORT || 10000;

// ---- CORS: allow GitHub Pages + local testing ----
app.use(cors({
  origin: true, // or set to "https://navinedevs.github.io"
  methods: ["GET","POST"],
}));

app.get("/", (_req, res) => res.send("Navine Compressor backend OK"));

const workDir = "/tmp/navine";
fs.mkdirSync(workDir, { recursive: true });

// Multer upload
const upload = multer({
  dest: path.join(workDir, "uploads"),
  limits: {
    fileSize: 25 * 1024 * 1024 * 1024 // 25GB hard cap; Render plan/network may limit earlier
  }
});

// In-memory job store
const jobs = new Map();
/**
 * job = {
 *  status: 'queued'|'running'|'done'|'error',
 *  percent: number,
 *  message: string,
 *  inputPath, outputPath,
 *  outputBytes,
 *  error
 * }
 */

function setJob(jobId, patch){
  const cur = jobs.get(jobId) || {};
  jobs.set(jobId, { ...cur, ...patch });
}

// --- Helpers ---
function run(cmd, args, { onStdErr, onStdOut } = {}){
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore","pipe","pipe"] });

    let stderr = "";
    p.stdout.on("data", (d) => { onStdOut?.(d.toString()); });
    p.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      onStdErr?.(s);
    });

    p.on("close", (code) => {
      if (code === 0) resolve({ stderr });
      else reject(new Error(`${cmd} exited ${code}\n${stderr}`));
    });
  });
}

async function ffprobeJson(inputPath){
  const args = [
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    inputPath
  ];
  const { stderr } = await run("ffprobe", args);
  // ffprobe prints JSON to stdout typically; but our helper captures stderr only.
  // So run again capturing stdout:
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", args, { stdio: ["ignore","pipe","pipe"] });
    let out = "";
    let err = "";
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("close", code => {
      if (code === 0) {
        try { resolve(JSON.parse(out)); }
        catch(e){ reject(new Error("Failed to parse ffprobe output: " + e.message)); }
      } else {
        reject(new Error("ffprobe failed: " + err));
      }
    });
  });
}

function parseDurationSeconds(probe){
  const d = Number(probe?.format?.duration || 0);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

function getVideoStream(probe){
  return (probe.streams || []).find(s => s.codec_type === "video");
}

function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }

/**
 * Auto quality detection:
 * - chooses preset + optional scale based on resolution + duration
 */
function autoSettings({ width, height, durationSec }){
  const maxDim = Math.max(width||0, height||0);

  // Preset: longer videos -> faster
  let preset = "slow";
  if (durationSec > 30*60) preset = "veryfast";
  else if (durationSec > 15*60) preset = "fast";
  else if (durationSec > 7*60) preset = "medium";

  // Optional scale: keep original unless huge
  let scaleFilter = null;
  if (maxDim >= 3840) scaleFilter = "scale=1920:-2"; // 4K -> 1080p by default
  // You can change this behavior easily.

  return { preset, scaleFilter };
}

/**
 * Compute video bitrate to target a final file size.
 * targetMB includes audio. We'll allocate audioKbps and compute remaining for video.
 */
function computeBitrates({ targetMB, durationSec, audioKbps }){
  // Total bits = MB * 1024^2 bytes * 8
  const totalBits = targetMB * 1024 * 1024 * 8;

  // audio bits = audioKbps*1000 * duration
  const audioBits = audioKbps * 1000 * durationSec;

  const videoBits = Math.max(totalBits - audioBits, totalBits * 0.70); // safety so video doesn't go too low
  const videoBps = videoBits / durationSec;

  // Convert to kbps for ffmpeg -b:v
  const videoKbps = clamp(Math.floor(videoBps / 1000), 200, 50000);
  return { videoKbps };
}

/**
 * Parse ffmpeg progress from stderr:
 * Look for "time=HH:MM:SS.xx" and compare to total duration.
 */
function makeProgressParser(durationSec, jobId){
  let lastPct = 0;
  const timeRe = /time=(\d+):(\d+):(\d+)\.(\d+)/;

  return (chunk) => {
    const m = chunk.match(timeRe);
    if (!m || !durationSec) return;

    const hh = Number(m[1]), mm = Number(m[2]), ss = Number(m[3]), cs = Number(m[4]);
    const t = hh*3600 + mm*60 + ss + (cs/100);
    const pct = clamp((t / durationSec) * 100, 0, 100);

    // Keep updates smooth and monotonic
    if (pct >= lastPct){
      lastPct = pct;
      setJob(jobId, { percent: pct, message: `Encoding… ${pct.toFixed(1)}%` });
    }
  };
}

async function twoPassEncode({ jobId, inputPath, outputPath, targetMB, codec, audioKbps, autoQuality }){
  setJob(jobId, { status: "running", percent: 1, message: "Analyzing media…" });

  const probe = await ffprobeJson(inputPath);
  const durationSec = parseDurationSeconds(probe);
  if (!durationSec) throw new Error("Could not read duration.");

  const v = getVideoStream(probe);
  const width = Number(v?.width || 0);
  const height = Number(v?.height || 0);

  const { preset, scaleFilter } = autoSettings({ width, height, durationSec });

  const { videoKbps } = computeBitrates({ targetMB, durationSec, audioKbps });

  // Auto-quality toggles only scaling/preset decisions, not size targeting.
  const useScale = (autoQuality === "on" && scaleFilter) ? ["-vf", scaleFilter] : [];
  const chosenPreset = (autoQuality === "on") ? preset : "medium";

  // Codecs
  const vCodec = (codec === "h265") ? "libx265" : "libx264";

  // Passlog file
  const passlog = path.join(workDir, `passlog-${jobId}`);

  // Pass 1
  setJob(jobId, { message: "Pass 1/2…" , percent: 2 });

  const p1Args = [
    "-y",
    "-i", inputPath,
    ...useScale,
    "-c:v", vCodec,
    "-b:v", `${videoKbps}k`,
    "-preset", chosenPreset,
    "-pass", "1",
    "-passlogfile", passlog,
    "-an",
    "-f", "mp4",
    "/dev/null"
  ];

  await run("ffmpeg", p1Args, { onStdErr: makeProgressParser(durationSec, jobId) });

  // Pass 2
  setJob(jobId, { message: "Pass 2/2…", percent: 50 });

  const p2Args = [
    "-y",
    "-i", inputPath,
    ...useScale,
    "-c:v", vCodec,
    "-b:v", `${videoKbps}k`,
    "-preset", chosenPreset,
    "-pass", "2",
    "-passlogfile", passlog,
    "-c:a", "aac",
    "-b:a", `${audioKbps}k`,
    "-movflags", "+faststart",
    outputPath
  ];

  await run("ffmpeg", p2Args, { onStdErr: makeProgressParser(durationSec, jobId) });

  // Stat output
  const st = fs.statSync(outputPath);
  setJob(jobId, {
    status: "done",
    percent: 100,
    message: "Done ✅",
    outputBytes: st.size
  });

  // Cleanup pass logs
  for (const f of [`${passlog}-0.log`, `${passlog}-0.log.mbtree`]){
    try{ fs.unlinkSync(f); }catch{}
  }
}

// ---- Routes ----
app.post("/api/start", upload.single("file"), async (req, res) => {
  const jobId = nanoid(10);

  const targetMB = Number(req.body.targetMB || 499);
  const codec = (req.body.codec === "h265") ? "h265" : "h264";
  const audioKbps = Number(req.body.audioKbps || 128);
  const autoQuality = (req.body.autoQuality === "off") ? "off" : "on";

  if (!req.file){
    return res.status(400).send("No file uploaded.");
  }

  const inputPath = req.file.path;
  const outputPath = path.join(workDir, `out-${jobId}.mp4`);

  setJob(jobId, {
    status: "queued",
    percent: 0,
    message: "Queued…",
    inputPath,
    outputPath
  });

  res.json({ jobId });

  // Start encode async (in-process)
  try{
    await twoPassEncode({ jobId, inputPath, outputPath, targetMB, codec, audioKbps, autoQuality });
  }catch(e){
    console.error(e);
    setJob(jobId, { status:"error", percent: 0, message: "Error", error: e.message || String(e) });
  }finally{
    // Remove input file after job ends
    try{ fs.unlinkSync(inputPath); }catch{}
  }
});

app.get("/api/progress/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ status: "missing" });

  res.json({
    status: job.status,
    percent: job.percent ?? 0,
    message: job.message ?? "",
    error: job.error,
    outputMB: job.outputBytes ? (job.outputBytes / (1024*1024)) : undefined
  });
});

app.get("/api/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).send("Missing job.");
  if (job.status !== "done") return res.status(409).send("Not ready.");

  res.download(job.outputPath, `navine-${req.params.jobId}.mp4`, (err) => {
    if (err) console.error(err);
  });
});

// Optional cleanup: remove old outputs periodically
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()){
    // basic TTL: 30 minutes after done/error
    const created = job.createdAt || (job.createdAt = now);
    const ageMs = now - created;

    if ((job.status === "done" || job.status === "error") && ageMs > 30*60*1000){
      try{ if (job.outputPath) fs.unlinkSync(job.outputPath); }catch{}
      jobs.delete(id);
    }
  }
}, 5*60*1000);

app.listen(PORT, () => console.log("Navine backend running on", PORT));
