export const config = { runtime: 'edge' };

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

/* ArrayBuffer → base64 (Edge 호환) */
function bufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return jsonRes({ error: 'Method not allowed' }, 405);

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return jsonRes({ error: 'OPENAI_API_KEY가 설정되지 않았습니다' }, 500);

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonRes({ error: 'Request body 파싱 실패' }, 400);
  }

  const { refImage, refMime, assets, regions, outputW, outputH } = body;

  /* ── STEP 1: GPT-4o → 이미지 생성 프롬프트 ── */
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
        return `영역${r.id} [좌${Math.round(r.l)}% 상${Math.round(r.t)}% 너비${Math.round(r.w)}% 높이${Math.round(r.h)}%]`
          + (refs.length ? ` → 참조: ${refs.join(', ')}` : '')
          + `\n  명령: ${r.cmd || '없음'}`;
      }).join('\n\n')
    : '수정 명령 없음 — 레퍼런스 이미지를 그대로 재현';

  userContent.push({
    type: 'text',
    text: `You are a professional commerce image designer.
Analyze the reference image and generate an English prompt (max 300 words) for gpt-image-2 to create a commerce product detail image.

Size: ${outputW ? outputW + 'px' : 'flexible'} x ${outputH ? outputH + 'px' : 'flexible'}

Modification instructions:
${regionDesc}

Rules:
- English only
- Reflect the reference layout, colors, and style as closely as possible
- Apply modification instructions precisely
- Specify it is a commerce product detail image
- Return prompt text only, no explanation`,
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
    const t = await r.text();
    if (!r.ok) return jsonRes({ error: 'GPT-4o 오류: ' + t.slice(0, 300) }, 500);
    const d = JSON.parse(t);
    imagePrompt = d.choices[0].message.content.trim();
  } catch (e) {
    return jsonRes({ error: 'GPT-4o 요청 실패: ' + String(e) }, 500);
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

  let imageB64;
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
    const t = await r.text();
    if (!r.ok) return jsonRes({ error: 'gpt-image-2 오류: ' + t.slice(0, 300) }, 500);
    const d = JSON.parse(t);
    const item = d.data[0];

    if (item.b64_json) {
      imageB64 = item.b64_json;
    } else if (item.url) {
      const imgR = await fetch(item.url);
      imageB64 = bufferToBase64(await imgR.arrayBuffer());
    } else {
      return jsonRes({ error: '이미지 데이터 없음: ' + JSON.stringify(item) }, 500);
    }
  } catch (e) {
    return jsonRes({ error: 'gpt-image-2 요청 실패: ' + String(e) }, 500);
  }

  return jsonRes({ image: imageB64, prompt: imagePrompt });
}
