const crypto = require('crypto');
const WebSocket = require('ws');

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

function getCorsHeaders(req) {
  const origin = req.headers.origin || '';
  const allowOrigin = ALLOWED_ORIGIN === '*' ? '*' : ALLOWED_ORIGIN;
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function sendJson(req, res, status, data) {
  res.statusCode = status;
  Object.entries({
    ...getCorsHeaders(req),
    'Content-Type': 'application/json; charset=utf-8',
  }).forEach(([key, value]) => res.setHeader(key, value));
  res.end(JSON.stringify(data));
}

function rejectBadOrigin(req, res) {
  if (!ALLOWED_ORIGIN || ALLOWED_ORIGIN === '*') return false;
  const origin = req.headers.origin || '';
  if (origin && origin !== ALLOWED_ORIGIN) {
    sendJson(req, res, 403, { error: `Origin not allowed: ${origin}` });
    return true;
  }
  return false;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 12 * 1024 * 1024) {
      throw new Error('Request body is too large');
    }
  }
  return raw ? JSON.parse(raw) : {};
}

function buildXfyunIatUrl() {
  const apiKey = process.env.XFYUN_API_KEY;
  const apiSecret = process.env.XFYUN_API_SECRET;
  const host = 'iat-api.xfyun.cn';
  const path = '/v2/iat';
  const date = new Date().toUTCString();
  const signatureOrigin = `host: ${host}\ndate: ${date}\nGET ${path} HTTP/1.1`;
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(signatureOrigin)
    .digest('base64');

  const authorizationOrigin =
    `api_key="${apiKey}", algorithm="hmac-sha256", headers="host date request-line", signature="${signature}"`;
  const authorization = Buffer.from(authorizationOrigin).toString('base64');

  return `wss://${host}${path}?authorization=${encodeURIComponent(authorization)}&date=${encodeURIComponent(date)}&host=${host}`;
}

function extractIatText(message) {
  let data;
  try {
    data = typeof message === 'string' ? JSON.parse(message) : JSON.parse(message.toString());
  } catch (error) {
    return { text: '', done: false, raw: String(message || '') };
  }

  if (data.code && data.code !== 0) {
    const err = new Error(data.message || `XFYUN error: ${data.code}`);
    err.code = data.code;
    throw err;
  }

  const ws = data?.data?.result?.ws || [];
  let text = '';
  for (const item of ws) {
    const cw = item.cw || [];
    for (const word of cw) {
      text += word.w || '';
    }
  }
  return {
    text,
    done: data?.data?.status === 2,
    raw: data,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function transcribeWithXfyunPcm(pcmBuffer, options = {}) {
  const appid = process.env.XFYUN_APPID;
  const apiKey = process.env.XFYUN_API_KEY;
  const apiSecret = process.env.XFYUN_API_SECRET;

  if (!appid || !apiKey || !apiSecret) {
    throw new Error('Missing XFYUN_APPID / XFYUN_API_KEY / XFYUN_API_SECRET in Vercel Environment Variables.');
  }

  if (!pcmBuffer || !pcmBuffer.length) {
    throw new Error('Received empty PCM audio.');
  }

  const url = buildXfyunIatUrl();
  const ws = new WebSocket(url);

  let finalText = '';
  let opened = false;
  let settled = false;

  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { ws.terminate(); } catch (error) {}
        reject(new Error('XFYUN transcription timed out.'));
      }
    }, 20000);

    function finish(text) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { ws.close(1000); } catch (error) {}
      resolve(text.trim());
    }

    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { ws.terminate(); } catch (e) {}
      reject(error);
    }

    ws.on('open', async () => {
      opened = true;
      try {
        const frameSize = 1280; // 16k, 16bit, mono, about 40ms
        for (let offset = 0; offset < pcmBuffer.length; offset += frameSize) {
          const chunk = pcmBuffer.subarray(offset, Math.min(offset + frameSize, pcmBuffer.length));
          const status = offset === 0 ? 0 : 1;
          const payload = {
            data: {
              status,
              format: 'audio/L16;rate=16000',
              encoding: 'raw',
              audio: chunk.toString('base64'),
            },
          };

          if (status === 0) {
            payload.common = { app_id: appid };
            payload.business = {
              language: options.language || 'zh_cn',
              domain: options.domain || 'iat',
              accent: options.accent || 'mandarin',
              ptt: 1,
              vinfo: 1,
              vad_eos: 3000,
            };
          }

          ws.send(JSON.stringify(payload));
          await sleep(35);
        }

        ws.send(JSON.stringify({
          data: {
            status: 2,
            format: 'audio/L16;rate=16000',
            encoding: 'raw',
            audio: '',
          },
        }));
      } catch (error) {
        fail(error);
      }
    });

    ws.on('message', (message) => {
      try {
        const parsed = extractIatText(message);
        if (parsed.text) finalText += parsed.text;
        if (parsed.done) finish(finalText);
      } catch (error) {
        fail(error);
      }
    });

    ws.on('error', (error) => {
      fail(error);
    });

    ws.on('close', () => {
      if (!settled && opened) {
        finish(finalText);
      }
    });
  });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    Object.entries(getCorsHeaders(req)).forEach(([key, value]) => res.setHeader(key, value));
    return res.end();
  }

  if (rejectBadOrigin(req, res)) return;

  if (req.method === 'GET') {
    return sendJson(req, res, 200, {
      ok: true,
      route: '/api/transcribe',
      provider: 'xfyun-iat',
      configured: Boolean(process.env.XFYUN_APPID && process.env.XFYUN_API_KEY && process.env.XFYUN_API_SECRET),
      requiredEnv: ['XFYUN_APPID', 'XFYUN_API_KEY', 'XFYUN_API_SECRET'],
      optionalEnv: ['ALLOWED_ORIGIN'],
      audio: '16kHz 16-bit mono PCM',
    });
  }

  if (req.method !== 'POST') {
    return sendJson(req, res, 405, { error: 'Only GET, POST, and OPTIONS are supported.' });
  }

  try {
    const body = await readJsonBody(req);
    let { audioBase64, mimeType, language, domain, accent } = body || {};

    if (!audioBase64 || typeof audioBase64 !== 'string') {
      return sendJson(req, res, 400, { error: 'Missing audioBase64 in request body.' });
    }

    if (audioBase64.startsWith('data:')) {
      audioBase64 = audioBase64.split(',')[1] || '';
    }

    const audioBuffer = Buffer.from(audioBase64, 'base64');
    if (!audioBuffer.length) {
      return sendJson(req, res, 400, { error: 'Received empty audio data.' });
    }

    if (!String(mimeType || '').includes('pcm')) {
      return sendJson(req, res, 400, {
        error: `This XFYUN route expects 16k PCM. Received mimeType=${mimeType || 'unknown'}. Please deploy the matching index.html from this zip.`,
      });
    }

    const text = await transcribeWithXfyunPcm(audioBuffer, {
      language: language || 'zh_cn',
      domain: domain || 'iat',
      accent: accent || 'mandarin',
    });

    return sendJson(req, res, 200, { text });
  } catch (error) {
    return sendJson(req, res, 500, {
      error: error?.message || 'XFYUN transcription request failed.',
    });
  }
};
