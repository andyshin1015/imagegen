export const maxDuration = 300;

import sharp from 'sharp';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

async function uploadToSupabase(buffer, userId) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) return null;
  try {
    const filename = `${userId || 'anon'}/${Date.now()}_${Math.random().toString(36).slice(2)}.png`;
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/images/${filename}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'image/png',
        'x-upsert': 'false',
      },
      body: buffer,
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('Supabase upload error:', err);
      return null;
    }
    return `${SUPABASE_URL}/storage/v1/object/public/images/${filename}`;
  } catch(e) {
    console.error('Supabase upload failed:', e);
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) { res.status(500).json({ error: 'OPENAI_API_KEY 없음' }); return; }

  const { refImage, refMime, assets, regions, outputW, outputH, userId } = req.body;

  const regionDesc = Array.isArray(regions) && regions.length
    ? regions.map(r => {
        const refs = Array.isArray(assets)
          ? assets.filter(a => a.label && r.cmd && r.cmd.includes(a.label)).map(a => `"${a.label}"`)
          : [];
        return `Region${r.id} [left:${Math.round(r.l)}% top:${Math.round(r.t)}% w:${Math.round(r.w)}% h:${Math.round(r.h)}%]`
          + (refs.length ? ` use: ${refs.join(', ')}` : '')
          + ` — ${r.cmd || 'reproduce as-is'}`;
      }).join('\n')
    : 'Reproduce the reference image as a high-quality commerce product detail image.';

  const canvasDesc = outputW && outputH
    ? `Target canvas size: ${outputW}x${outputH}px (ratio ${(outputW/outputH).toFixed(2)}:1). Fill naturally with no white borders.`
    : outputW ? `Target width: ${outputW}px.` : outputH ? `Target height: ${outputH}px.` : '';

  /* ── STEP 1: GPT-4o로 한국어 명령 해석 → 정밀 영어 프롬프트 생성 ── */
  const analysisContent = [];
  if (refImage) {
    analysisContent.push({ type: 'image_url', image_url: { url: `data:${refMime||'image/jpeg'};base64,${refImage}`, detail: 'high' } });
  }
  if (Array.isArray(assets)) {
    for (const asset of assets) {
      if (!asset.label || !asset.dataUrl) continue;
      analysisContent.push({ type: 'text', text: `소재 이미지 "${asset.label}":` });
      analysisContent.push({ type: 'image_url', image_url: { url: asset.dataUrl, detail: 'high' } });
    }
  }
  analysisContent.push({ type: 'text', text: `당신은 커머스 이미지 편집 전문가입니다. 사용자의 한국어 수정 명령을 정확히 해석하여 gpt-image-2용 영어 프롬프트를 작성하세요.

수정 영역 및 명령:
${regionDesc}

명령 해석 규칙:
- "~~로 수정" / "~~로 바꿔" → 해당 영역의 기존 요소를 완전히 제거하고 새 요소로 교체
- "~~추가" / "~~넣어" → 기존 요소는 유지하면서 새 요소를 추가
- "배경만 바꿔" / "배경을 ~~로" → 전경 요소(텍스트, 제품 등)는 그대로 유지, 배경만 교체
- "텍스트를 ~~로" → 해당 위치의 텍스트 내용만 변경, 레이아웃 유지
- "색상을 ~~로" → 해당 요소의 색상만 변경, 형태와 위치 유지
- "이미지N 사용" → 해당 소재 이미지를 그 위치에 배치
- 명령이 없는 영역 → 레퍼런스 이미지와 동일하게 유지
- **가장 중요한 규칙**: 사용자가 명시적으로 언급하지 않은 모든 요소(텍스트, 이미지, 색상, 레이아웃, 폰트, 배경 등)는 레퍼런스 이미지에서 절대 변경하지 말 것. 수정 명령은 해당 영역에만 국소적으로 적용할 것.
- 전체적으로 전문적인 커머스 상세페이지 품질 유지

${canvasDesc}

위 규칙을 엄격히 적용해서 gpt-image-2가 정확히 실행할 수 있는 영어 프롬프트를 300단어 이내로 작성하세요.
프롬프트 텍스트만 반환하고 설명은 포함하지 마세요.` });

  let imagePrompt;
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: analysisContent }], max_tokens: 600 })
    });
    const text = await r.text();
    if (!r.ok) { res.status(500).json({ error: 'GPT-4o 오류: ' + text.slice(0, 300) }); return; }
    const data = JSON.parse(text);
    imagePrompt = data.choices[0].message.content.trim();
  } catch(e) {
    res.status(500).json({ error: 'GPT-4o 실패: ' + String(e) }); return;
  }

  /* ── STEP 2: gpt-image-2로 이미지 생성 ── */
  const imageSize = (() => {
    if (outputW && outputH) {
      const ratio = outputW / outputH;
      if (ratio > 1.4) return '1792x1024';
      if (ratio < 0.7) return '1024x1792';
    }
    return '1024x1024';
  })();

  try {
    let rawBuffer;

    if (refImage) {
      const mimeType = refMime || 'image/jpeg';
      const ext = mimeType.includes('png') ? 'png' : 'jpeg';
      const binaryStr = atob(refImage);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      const refBlob = new Blob([bytes], { type: mimeType });

      const form = new FormData();
      form.append('model', 'gpt-image-2');
      form.append('prompt', imagePrompt.slice(0, 1000));
      form.append('n', '1');
      form.append('size', imageSize);
      form.append('quality', 'medium');
      form.append('image[]', refBlob, `ref.${ext}`);

      if (Array.isArray(assets)) {
        for (const asset of assets) {
          if (!asset.label || !asset.dataUrl) continue;
          const [meta, b64] = asset.dataUrl.split(',');
          const assetMime = meta.match(/:(.*?);/)?.[1] || 'image/jpeg';
          const assetExt = assetMime.includes('png') ? 'png' : 'jpeg';
          const ab = atob(b64);
          const ab2 = new Uint8Array(ab.length);
          for (let i = 0; i < ab.length; i++) ab2[i] = ab.charCodeAt(i);
          form.append('image[]', new Blob([ab2], { type: assetMime }), `${asset.label}.${assetExt}`);
        }
      }

      const r = await fetch('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: form,
      });
      const text = await r.text();
      if (!r.ok) { res.status(500).json({ error: 'edits 오류: ' + text.slice(0, 400) }); return; }
      const data = JSON.parse(text);
      const item = data.data[0];
      rawBuffer = item.b64_json
        ? Buffer.from(item.b64_json, 'base64')
        : await fetchToBuffer(item.url);

    } else {
      const r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: imagePrompt.slice(0, 1000), n: 1, size: imageSize, quality: 'medium' }),
      });
      const text = await r.text();
      if (!r.ok) { res.status(500).json({ error: 'generations 오류: ' + text.slice(0, 400) }); return; }
      const data = JSON.parse(text);
      const item = data.data[0];
      rawBuffer = item.b64_json
        ? Buffer.from(item.b64_json, 'base64')
        : await fetchToBuffer(item.url);
    }

    /* ── sharp로 리사이즈 ── */
    let finalBuffer = rawBuffer;
    if (outputW || outputH) {
      const resizeOptions = {
        width: outputW || undefined,
        height: outputH || undefined,
        fit: (outputW && outputH) ? 'cover' : 'inside',
        position: 'centre',
        kernel: sharp.kernel.lanczos3,
        withoutEnlargement: false,
      };
      finalBuffer = await sharp(rawBuffer).resize(resizeOptions).png().toBuffer();
    }

    const imageB64 = finalBuffer.toString('base64');

    /* Supabase Storage에 업로드 → 영구 URL 반환 */
    const imageUrl = await uploadToSupabase(finalBuffer, userId);

    res.status(200).json({
      image: imageB64,           /* 즉시 표시용 base64 */
      imageUrl: imageUrl || null, /* 영구 저장용 URL */
      prompt: imagePrompt
    });

  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

async function fetchToBuffer(url) {
  const r = await fetch(url);
  return Buffer.from(await r.arrayBuffer());
}
