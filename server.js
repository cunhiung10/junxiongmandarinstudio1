/**
 * Junxiong Mandarin Studio — TTS Server
 *
 * Default:  Microsoft Edge TTS (free, no credentials) via node-edge-tts
 *           Female: zh-CN-XiaoxiaoNeural  Male: zh-CN-YunxiNeural
 *
 * Upgrade:  Set VOLCANO_TTS_APP_ID + VOLCANO_TTS_ACCESS_TOKEN in .env
 *           to switch to Volcengine / Doubao 豆包 voices (灿灿 / 渐青)
 *
 * Usage:    node server.js
 *           npm start
 */

'use strict';

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const crypto  = require('crypto');
const { EdgeTTS } = require('node-edge-tts');
require('dotenv').config();

const app  = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

const USE_VOLCANO = Boolean(
  process.env.VOLCANO_TTS_APP_ID && process.env.VOLCANO_TTS_ACCESS_TOKEN
);

// Voices ─────────────────────────────────────────────────────────────────────
const VOICES = {
  edge: {
    female: process.env.TTS_FEMALE_SPEAKER || 'zh-CN-XiaoxiaoNeural',
    male:   process.env.TTS_MALE_SPEAKER   || 'zh-CN-YunxiNeural',
  },
  volcano: {
    female: process.env.TTS_FEMALE_SPEAKER_VOLCANO || '灿灿',
    male:   process.env.TTS_MALE_SPEAKER_VOLCANO   || '渐青',
  },
};

// Convert numeric speed (0.5 – 2.0) → Edge TTS rate string (e.g. "+50%")
function speedToRate(speed) {
  const pct = Math.round((parseFloat(speed) - 1) * 100);
  return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

// volcengine-tts is ESM — lazy-load when actually needed
let volcanoTTS;
async function getVolcanoTTS() {
  if (volcanoTTS) return volcanoTTS;
  const { createTTS } = await import('volcengine-tts');
  volcanoTTS = createTTS({
    defaultSpeaker: VOICES.volcano.female,
    volcano: {
      appId:       process.env.VOLCANO_TTS_APP_ID,
      accessToken: process.env.VOLCANO_TTS_ACCESS_TOKEN,
      userId:      process.env.VOLCANO_TTS_USER_ID || 'junxiong-user',
    },
  });
  return volcanoTTS;
}

// ── Vocabulary data (loaded once at startup) ─────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');

function loadVocabFile(filename) {
  try {
    const raw  = JSON.parse(fs.readFileSync(path.join(DATA_DIR, filename), 'utf8'));
    const words = raw.words ?? raw;

    // Normalise: flatten dict-of-level-arrays into a single array
    if (words && !Array.isArray(words) && typeof words === 'object') {
      return Object.entries(words).flatMap(([lvl, arr]) =>
        Array.isArray(arr) ? arr.map(w => ({ ...w, level: w.level || lvl })) : []
      );
    }
    return Array.isArray(words) ? words : [];
  } catch { return []; }
}

const VOCAB = {
  HSK1:   loadVocabFile('vocab_hsk1.json'),
  HSK2:   loadVocabFile('vocab_hsk2.json'),
  HSK3:   loadVocabFile('vocab_hsk3.json'),
  HSK4:   loadVocabFile('vocab_hsk4.json'),
  HSK5:   loadVocabFile('vocab_hsk5.json'),
  HSK6:   loadVocabFile('vocab_hsk6.json'),
  'HSK7-9': loadVocabFile('vocab_hsk7_9.json'),
  BCT:    loadVocabFile('vocab_bct.json'),
  YCT:    loadVocabFile('vocab_yct.json'),
  TOFCL:  loadVocabFile('vocab_tofcl.json'),
};

let TEST_INFO = {};
try { TEST_INFO = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'test_info.json'), 'utf8')); }
catch { /* optional */ }

// ── Vocab API ────────────────────────────────────────────────────────────────

// GET /api/vocab/levels  — list all levels with word counts
app.get('/api/vocab/levels', (_req, res) => {
  const levels = Object.entries(VOCAB).map(([id, arr]) => ({
    id,
    label: id.replace('HSK7-9', 'HSK 7–9'),
    count: arr.length,
  }));
  res.json(levels);
});

// GET /api/vocab/:level?offset=0&limit=1&random=1
// Returns one or more word objects for the requested level.
app.get('/api/vocab/:level', (req, res) => {
  const key   = req.params.level.toUpperCase().replace(/\s/g, '');
  const words = VOCAB[key] || VOCAB[key.replace('-', '')] || [];

  if (!words.length) return res.status(404).json({ error: `No vocabulary for level "${req.params.level}"` });

  const limit  = Math.min(parseInt(req.query.limit)  || 1, 100);
  const total  = words.length;

  let start;
  if (req.query.random === '1') {
    start = Math.floor(Math.random() * total);
  } else {
    start = parseInt(req.query.offset) || 0;
  }

  const items = [];
  for (let i = 0; i < limit; i++) {
    items.push(words[(start + i) % total]);
  }

  res.json({ level: key, total, offset: start, items });
});

// GET /api/tests  — full test-info metadata
app.get('/api/tests', (_req, res) => res.json(TEST_INFO));

// ── Static files ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname)));

// ── TTS endpoint ─────────────────────────────────────────────────────────────
// GET /api/tts?text=学&voice=female&speed=1
app.get('/api/tts', async (req, res) => {
  const text  = String(req.query.text  || '').trim();
  const voice = String(req.query.voice || 'female');
  const speed = parseFloat(req.query.speed) || 1.0;

  if (!text) {
    return res.status(400).json({ error: 'text parameter is required' });
  }

  try {
    let audioBuffer;

    if (USE_VOLCANO) {
      // ── Volcengine / Doubao ──────────────────────────────────────────────
      const tts      = await getVolcanoTTS();
      const speaker  = voice === 'male' ? VOICES.volcano.male : VOICES.volcano.female;
      audioBuffer    = await tts({ text, speaker, speed });
    } else {
      // ── Edge TTS (free default) ──────────────────────────────────────────
      const speaker  = voice === 'male' ? VOICES.edge.male : VOICES.edge.female;
      const tmpFile  = path.join(os.tmpdir(), `jms-tts-${crypto.randomUUID()}.mp3`);
      const edgeTTS  = new EdgeTTS({
        voice:  speaker,
        lang:   'zh-CN',
        rate:   speedToRate(speed),
        outputFormat: 'audio-24khz-96kbitrate-mono-mp3',
      });
      await edgeTTS.ttsPromise(text, tmpFile);
      audioBuffer = fs.readFileSync(tmpFile);
      fs.unlink(tmpFile, () => {});   // async cleanup, don't block response
    }

    if (!audioBuffer || audioBuffer.length === 0) {
      return res.status(500).json({ error: 'TTS synthesis returned no audio' });
    }

    res.set({
      'Content-Type':  'audio/mpeg',
      'Cache-Control': 'public, max-age=86400',
    });
    res.send(audioBuffer);

  } catch (err) {
    console.error('[TTS]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Boot ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🎙️  Junxiong TTS Server`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Voice engine : ${USE_VOLCANO ? 'Volcengine / Doubao 豆包 🔥' : 'Microsoft Edge TTS (free)'}`);
  console.log(`   Female       : ${USE_VOLCANO ? VOICES.volcano.female : VOICES.edge.female}`);
  console.log(`   Male         : ${USE_VOLCANO ? VOICES.volcano.male   : VOICES.edge.male}`);
  if (!USE_VOLCANO) {
    console.log(`\n   ℹ️  To upgrade to Doubao voices, add VOLCANO_TTS_APP_ID`);
    console.log(`      and VOLCANO_TTS_ACCESS_TOKEN to your .env file.\n`);
  }
});
