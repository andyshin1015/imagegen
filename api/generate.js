export const maxDuration = 60;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function jsonRes(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return Buffer.from(bytes).toString('base64');
}

export default async function handler(req, res) {
  /* CORS preflight */
  if (req.method === 'OPTIONS') {
    res.status(204).set(CORS).end();
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    res.status(500).json({ error: 'OPENAI_API_KEY가 설정되지 않았습니다' });
    return;
  }

  const { refImage, refMime, assets, regions, outputW, outputH } = req.body;

  /* ── STEP 1: GPT-4o → 프롬프트 생성 ── */
  const userContent = [];

  if (refImage) {
    userContent.push({
      type: 'image_url',
      image_url: {
        url: `data:${refMime || 'image/jpeg'};base64,${refImage}`,
        detail: 'high',
      },
    });
  }

  if (Array.isArray(assets)) {
    for (const asset of assets) {
      if (!asset.label || !asset.dataUrl) continue;
      userContent.push({ type: 'text', text: `소재 이미지 "${asset.label}":` });
      userContent.push({
        type: 'image_url',
        image_url: { url: asset.dataUrl, detail: 'high' },
      });
    }
  }

  const regionDesc = Array.isArray(regions) && regions.length
    ? regions.map(r => {
        const refs = Array.isArray(assets)
          ? assets.filter(a => a.label && r.cmd && r.cmd.includes(a.label)).map(a => `"${a.label}"`)
          : [];
        return `Region${r.id} [left:${Math.round(r.l)}% top:${Math.round(r.t)}% width:${Math.round(r.w)}% height:${Math.round(r.h)}%]`
          + (refs.length ? ` → use assets: ${refs.join(', ')}` : '')
          + `\n  instruction: ${r.cmd || 'none'}`;
      }).join('\n\n')
    : 'No modifications — recreate reference image as closely as possible';

  userContent.push({
    type: 'text',
    text: `You are a professional commerce image designer.
Analyze the reference image and write an English image generation prompt (max 300 words) for gpt-image-2.

Output size: ${outputW ? outputW + 'px' : 'flexible'} x ${outputH ? outputH + 'px' : 'flexible'}

Modification instructions:
${regionDesc}

Rules:
- English only, max 300 words
- Reflect reference layout, colors, and style as closely as possible
- Apply modification instructions precisely
- Specify this is a commerce product detail image
- Return prompt text only, no explanations`,
  });

  let imagePrompt;
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: userContent }],
        max_tokens: 500,
      }),
    });
    const text = await r.text();
    if (!r.ok) {
      res.status(500).json({ error: 'GPT-4o 오류: ' + text.slice(0, 300) });
      return;
    }
    const data = JSON.parse(text);
    imagePrompt = data.choices[0].message.content.trim();
  } catch (e) {
    res.status(500).json({ error: 'GPT-4o 요청 실패: ' + String(e) });
    return;
  }

  /* ── STEP 2: gpt-image-2 → 이미지 생성 ── */
  const imageSize = (() => {
    if (outputW && outputH) {
      const ratio = outputW / outputH;
      if (ratio > 1.4) return '1792x1024';
      if (ratio < 0.7) return '1024x1792';
    }
    return '1024x1024';
  })();

  try {
    const r = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt: imagePrompt.slice(0, 1000),
        n: 1,
        size: imageSize,
        quality: 'medium',
      }),
    });
    const text = await r.text();
    if (!r.ok) {
      res.status(500).json({ error: 'gpt-image-2 오류: ' + text.slice(0, 300) });
      return;
    }
    const data = JSON.parse(text);
    const item = data.data[0];

    let imageB64;
    if (item.b64_json) {
      imageB64 = item.b64_json;
    } else if (item.url) {
      const imgR = await fetch(item.url);
      const buf = await imgR.arrayBuffer();
      imageB64 = Buffer.from(buf).toString('base64');
    } else {
      res.status(500).json({ error: '이미지 데이터 없음' });
      return;
    }

    res.status(200).set(CORS).json({ image: imageB64, prompt: imagePrompt });
  } catch (e) {
    res.status(500).json({ error: 'gpt-image-2 요청 실패: ' + String(e) });
  }
}
