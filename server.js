"use strict";

require("dotenv").config();

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const http = require("http");
const Database = require("better-sqlite3");
const QRCode = require("qrcode");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_URL = process.env.PUBLIC_URL || "https://localhost:3000";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "Apnée";
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DB_PATH = path.join(DATA_DIR, "apnee-live.sqlite");

const fs = require("fs");
fs.mkdirSync(DATA_DIR, { recursive: true });

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json({ limit: "50kb" }));
app.use(express.static(path.join(__dirname, "public")));

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS participants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS timers (
    participant_id TEXT NOT NULL,
    timer_index INTEGER NOT NULL CHECK(timer_index BETWEEN 1 AND 4),
    elapsed_ms INTEGER NOT NULL DEFAULT 0,
    is_running INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (participant_id, timer_index),
    FOREIGN KEY (participant_id) REFERENCES participants(id) ON DELETE CASCADE
  );
`);

const adminTokens = new Set();

function cleanName(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, 40);
}

function getEffectiveElapsed(timer, now = Date.now()) {
  if (!timer) return 0;
  const base = Number(timer.elapsed_ms || 0);
  if (timer.is_running && timer.started_at) {
    return base + Math.max(0, now - Number(timer.started_at));
  }
  return base;
}

function getParticipant(id) {
  const participant = db
    .prepare("SELECT id, name, created_at, updated_at FROM participants WHERE id = ?")
    .get(id);

  if (!participant) return null;

  const rows = db
    .prepare(`
      SELECT timer_index, elapsed_ms, is_running, started_at, updated_at
      FROM timers
      WHERE participant_id = ?
      ORDER BY timer_index
    `)
    .all(id);

  const byIndex = new Map(rows.map((row) => [row.timer_index, row]));
  const timers = [];

  for (let i = 1; i <= 4; i += 1) {
    const row = byIndex.get(i) || {
      timer_index: i,
      elapsed_ms: 0,
      is_running: 0,
      started_at: null,
      updated_at: participant.updated_at
    };

    timers.push({
      index: i,
      elapsedMs: Number(row.elapsed_ms || 0),
      running: Boolean(row.is_running),
      startedAt: row.started_at ? Number(row.started_at) : null,
      updatedAt: Number(row.updated_at || participant.updated_at)
    });
  }

  return {
    id: participant.id,
    name: participant.name,
    createdAt: Number(participant.created_at),
    updatedAt: Number(participant.updated_at),
    timers
  };
}

function getAllParticipants() {
  const participants = db
    .prepare("SELECT id FROM participants ORDER BY created_at ASC")
    .all();

  return participants
    .map(({ id }) => getParticipant(id))
    .filter(Boolean);
}

function buildDashboardPayload() {
  const now = Date.now();
  const participants = getAllParticipants();

  const averages = [1, 2, 3, 4].map((timerIndex) => {
    const values = participants
      .map((participant) => {
        const timer = participant.timers[timerIndex - 1];
        return getEffectiveElapsed(
          {
            elapsed_ms: timer.elapsedMs,
            is_running: timer.running,
            started_at: timer.startedAt
          },
          now
        );
      })
      .filter((value) => value > 0);

    const averageMs =
      values.length > 0
        ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length)
        : 0;

    return {
      index: timerIndex,
      averageMs,
      count: values.length
    };
  });

  return {
    generatedAt: now,
    participantCount: participants.length,
    participants,
    averages
  };
}

function emitDashboard() {
  io.to("admins").emit("dashboard:update", buildDashboardPayload());
}

function requireAdmin(req, res, next) {
  const authorization = req.get("authorization") || "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7)
    : "";

  if (!token || !adminTokens.has(token)) {
    return res.status(401).json({ error: "Accès animateur refusé." });
  }

  next();
}

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.get("/api/config", (req, res) => {
  res.json({
    publicUrl: PUBLIC_URL,
    safetyMessage:
      "Exercice à réaliser hors de l’eau, assis ou allongé, sans hyperventilation et sous la supervision de l’animateur."
  });
});

app.get("/api/qrcode", async (req, res, next) => {
  try {
    const png = await QRCode.toBuffer(PUBLIC_URL, {
      type: "png",
      width: 420,
      margin: 2,
      errorCorrectionLevel: "M"
    });
    res.type("png").send(png);
  } catch (error) {
    next(error);
  }
});

app.post("/api/participants", (req, res) => {
  const name = cleanName(req.body?.name);

  if (!name) {
    return res.status(400).json({ error: "Saisis un prénom ou un pseudo." });
  }

  const now = Date.now();
  const id = crypto.randomUUID();

  const transaction = db.transaction(() => {
    db.prepare(`
      INSERT INTO participants (id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(id, name, now, now);

    const insertTimer = db.prepare(`
      INSERT INTO timers (
        participant_id, timer_index, elapsed_ms, is_running, started_at, updated_at
      )
      VALUES (?, ?, 0, 0, NULL, ?)
    `);

    for (let index = 1; index <= 4; index += 1) {
      insertTimer.run(id, index, now);
    }
  });

  transaction();

  const participant = getParticipant(id);
  emitDashboard();

  res.status(201).json(participant);
});

app.get("/api/participants/:id", (req, res) => {
  const participant = getParticipant(req.params.id);

  if (!participant) {
    return res.status(404).json({ error: "Participant introuvable." });
  }

  res.json(participant);
});

app.post("/api/participants/:id/name", (req, res) => {
  const name = cleanName(req.body?.name);

  if (!name) {
    return res.status(400).json({ error: "Saisis un prénom ou un pseudo." });
  }

  const now = Date.now();
  const result = db
    .prepare("UPDATE participants SET name = ?, updated_at = ? WHERE id = ?")
    .run(name, now, req.params.id);

  if (result.changes === 0) {
    return res.status(404).json({ error: "Participant introuvable." });
  }

  const participant = getParticipant(req.params.id);
  emitDashboard();
  res.json(participant);
});

app.post("/api/participants/:id/timers/:index/start", (req, res) => {
  const participantId = req.params.id;
  const index = Number(req.params.index);

  if (![1, 2, 3, 4].includes(index)) {
    return res.status(400).json({ error: "Chronomètre invalide." });
  }

  const timer = db
    .prepare(`
      SELECT elapsed_ms, is_running, started_at
      FROM timers
      WHERE participant_id = ? AND timer_index = ?
    `)
    .get(participantId, index);

  if (!timer) {
    return res.status(404).json({ error: "Participant ou chronomètre introuvable." });
  }

  if (!timer.is_running) {
    const now = Date.now();

    db.prepare(`
      UPDATE timers
      SET is_running = 1, started_at = ?, updated_at = ?
      WHERE participant_id = ? AND timer_index = ?
    `).run(now, now, participantId, index);

    db.prepare("UPDATE participants SET updated_at = ? WHERE id = ?")
      .run(now, participantId);
  }

  const participant = getParticipant(participantId);
  emitDashboard();
  res.json(participant);
});

app.post("/api/participants/:id/timers/:index/stop", (req, res) => {
  const participantId = req.params.id;
  const index = Number(req.params.index);

  if (![1, 2, 3, 4].includes(index)) {
    return res.status(400).json({ error: "Chronomètre invalide." });
  }

  const timer = db
    .prepare(`
      SELECT elapsed_ms, is_running, started_at
      FROM timers
      WHERE participant_id = ? AND timer_index = ?
    `)
    .get(participantId, index);

  if (!timer) {
    return res.status(404).json({ error: "Participant ou chronomètre introuvable." });
  }

  if (timer.is_running) {
    const now = Date.now();
    const elapsedMs = getEffectiveElapsed(timer, now);

    db.prepare(`
      UPDATE timers
      SET elapsed_ms = ?, is_running = 0, started_at = NULL, updated_at = ?
      WHERE participant_id = ? AND timer_index = ?
    `).run(elapsedMs, now, participantId, index);

    db.prepare("UPDATE participants SET updated_at = ? WHERE id = ?")
      .run(now, participantId);
  }

  const participant = getParticipant(participantId);
  emitDashboard();
  res.json(participant);
});

app.post("/api/admin/login", (req, res) => {
  const password = String(req.body?.password || "");

  const expected = Buffer.from(ADMIN_PASSWORD);
  const received = Buffer.from(password);

  const valid =
    expected.length === received.length &&
    crypto.timingSafeEqual(expected, received);

  if (!valid) {
    return res.status(401).json({ error: "Mot de passe incorrect." });
  }

  const token = crypto.randomBytes(32).toString("hex");
  adminTokens.add(token);

  res.json({ token });
});

app.get("/api/admin/dashboard", requireAdmin, (req, res) => {
  res.json(buildDashboardPayload());
});

app.post("/api/admin/reset", requireAdmin, (req, res) => {
  const transaction = db.transaction(() => {
    db.prepare("DELETE FROM timers").run();
    db.prepare("DELETE FROM participants").run();
  });

  transaction();
  emitDashboard();

  res.json({ ok: true });
});

io.on("connection", (socket) => {
  socket.on("admin:authenticate", (token, callback) => {
    const valid = typeof token === "string" && adminTokens.has(token);

    if (valid) {
      socket.join("admins");
      socket.emit("dashboard:update", buildDashboardPayload());
    }

    if (typeof callback === "function") {
      callback({ ok: valid });
    }
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: "Une erreur interne est survenue." });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Apnée Live écoute sur le port ${PORT}`);
  console.log(`Base SQLite : ${DB_PATH}`);
});
