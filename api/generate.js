export const config = { runtime: 'edge' };

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) return json({ error: 'OPENAI_API_KEY not set' }, 500);

  let body;
  try {
    body = await req.json();
  } catch (e) {
    return json({ error: 'Invalid request body' }, 400);
  }

  const { refImage, refMime, assets, regions, outputW, outputH } = body;

  try {
    /* ── STEP 1: GPT-4o로 이미지 분석 → 프롬프트 생성 ── */
    const userContent = [];

    if (refImage) {
      userContent.push({
        type: 'image_url',
        image_url: { url: `data:${refMime || 'image/jpeg'};base64,${refImage}`, detail: 'high' },
      });
    }

    if (Array.isArray(assets)) {
      for (const asset of assets) {
        if (!asset.label || !asset.dataUrl) continue;
        userContent.push({ type: 'text', text: `소재 이미지 "${asset.label}":` });
        userContent.push({ type: 'image_url', image_url: { url: asset.dataUrl, detail: 'high' } });
      }
    }

    const regionDesc = Array.isArray(regions) && regions.length
      ? regions.map(r => {
          const refs = Array.isArray(assets)
            ? assets.filter(a => a.label && r.cmd && r.cmd.includes(a.label)).map(a => `"${a.label}"`)
            : [];
          return `영역${r.id} [좌${Math.round(r.l)}% 상${Math.round(r.t)}% 너비${Math.round(r.w)}% 높이${Math.round(r.h)}%]`
            + (refs.length ? ` → 참조 소재: ${refs.join(', ')}` : '')
            + `\n  수정 명령: ${r.cmd || '없음'}`;
        }).join('\n\n')
      : '수정 명령 없음 — 레퍼런스 이미지를 최대한 재현';

    const sizeNote = `${outputW ? outputW + 'px' : '제한없음'} x ${outputH ? outputH + 'px' : '제한없음'}`;

    userContent.push({
      type: 'text',
      text: `당신은 커머스 이미지 전문 디자이너입니다.
위 이미지들을 분석하여 아래 수정 명령을 반영한 커머스 상세 이미지 생성을 위한 프롬프트를 영어로 작성해주세요.

출력 사이즈: ${sizeNote}
수정 영역 및 명령:
${regionDesc}

규칙:
- 영어로, 300단어 이내
- 레퍼런스의 레이아웃/색상/스타일 최대한 반영
- 수정 명령 정확히 반영
- commerce product detail image 임을 명시
- 프롬프트 텍스트만 반환, 설명 없이`,
    });

    const analysisRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: userContent }], max_tokens: 500 }),
    });

    const analysisText = await analysisRes.text();
    if (!analysisRes.ok) {
      return json({ error: 'GPT-4o 오류: ' + analysisText }, 500);
    }
    let analysisData;
    try { analysisData = JSON.parse(analysisText); } catch(e) {
      return json({ error: 'GPT-4o 응답 파싱 실패: ' + analysisText.slice(0, 200) }, 500);
    }
    const imagePrompt = analysisData.choices[0].message.content.trim();

    /* ── STEP 2: gpt-image-2로 이미지 생성 ── */
    const imageSize = (() => {
      if (outputW && outputH) {
        const ratio = outputW / outputH;
        if (ratio > 1.4) return '1792x1024';
        if (ratio < 0.7) return '1024x1792';
      }
      return '1024x1024';
    })();

    const imageRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt: imagePrompt.slice(0, 1000),
        n: 1,
        size: imageSize,
        quality: 'medium',
        output_format: 'png',
      }),
    });

    const imageText = await imageRes.text();
    if (!imageRes.ok) {
      return json({ error: 'gpt-image-2 오류: ' + imageText }, 500);
    }
    let imageData;
    try { imageData = JSON.parse(imageText); } catch(e) {
      return json({ error: 'gpt-image-2 응답 파싱 실패: ' + imageText.slice(0, 200) }, 500);
    }
    const item = imageData.data[0];

    /* b64_json 직접 반환되는 경우 */
    if (item.b64_json) {
      return json({ image: item.b64_json, prompt: imagePrompt });
    }

    /* URL로 반환되는 경우 → fetch해서 base64 변환 */
    if (item.url) {
      const imgRes = await fetch(item.url);
      const buf = await imgRes.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      return json({ image: b64, prompt: imagePrompt });
    }

    return json({ error: '이미지 데이터를 받지 못했습니다' }, 500);

  } catch (err) {
    return json({ error: err.message || String(err) }, 500);
  }
}
