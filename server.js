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
