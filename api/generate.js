export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
    });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }

  try {
    const body = await req.json();
    const { refImage, refMime, assets, regions, outputW, outputH } = body;

    const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');

    /* ── STEP 1: GPT-4o로 레퍼런스 분석 + DALL-E 프롬프트 생성 ── */
    const analysisMessages = [{ role: 'user', content: [] }];

    if (refImage) {
      analysisMessages[0].content.push({
        type: 'image_url',
        image_url: { url: `data:${refMime};base64,${refImage}`, detail: 'high' },
      });
    }

    if (assets && assets.length > 0) {
      for (const asset of assets) {
        if (!asset.label || !asset.dataUrl) continue;
        analysisMessages[0].content.push({
          type: 'text',
          text: `소재 이미지 "${asset.label}":`,
        });
        analysisMessages[0].content.push({
          type: 'image_url',
          image_url: { url: asset.dataUrl, detail: 'high' },
        });
      }
    }

    const regionDesc = regions && regions.length
      ? regions.map(r => {
          const refs = assets
            ? assets.filter(a => a.label && r.cmd && r.cmd.includes(a.label)).map(a => `"${a.label}"`)
            : [];
          return `영역${r.id} [좌${Math.round(r.l)}% 상${Math.round(r.t)}% 너비${Math.round(r.w)}% 높이${Math.round(r.h)}%]`
            + (refs.length ? ` → 참조 소재: ${refs.join(', ')}` : '')
            + `\n  수정 명령: ${r.cmd || '없음'}`;
        }).join('\n\n')
      : '수정 명령 없음 — 레퍼런스 이미지를 그대로 재현';

    const sizeNote = `${outputW ? outputW + 'px' : '제한없음'} x ${outputH ? outputH + 'px' : '제한없음'}`;

    analysisMessages[0].content.push({
      type: 'text',
      text: `당신은 커머스 이미지 전문 디자이너입니다.
위 레퍼런스 이미지와 소재 이미지들을 분석해서, 아래 수정 명령을 반영한 커머스 상세 이미지를 만들기 위한 DALL-E 3 프롬프트를 영어로 작성해주세요.

출력 사이즈: ${sizeNote}

수정 영역 및 명령:
${regionDesc}

규칙:
- 프롬프트는 영어로, 200단어 이내로 작성
- 레퍼런스의 레이아웃, 색상, 스타일을 최대한 반영
- 수정 명령을 정확히 반영
- 커머스 상세페이지 이미지임을 명시
- 프롬프트 텍스트만 반환, 설명 없이`,
    });

    const analysisRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o',
        messages: analysisMessages,
        max_tokens: 400,
      }),
    });

    if (!analysisRes.ok) {
      const e = await analysisRes.json();
      throw new Error(e.error?.message || 'GPT-4o error');
    }

    const analysisData = await analysisRes.json();
    const dallePrompt = analysisData.choices[0].message.content.trim();

    /* ── STEP 2: DALL-E 3로 이미지 생성 ── */
    const imageSize = (() => {
      if (outputW && outputH) {
        const ratio = outputW / outputH;
        if (ratio > 1.4) return '1792x1024';
        if (ratio < 0.7) return '1024x1792';
      }
      return '1024x1024';
    })();

    const dalleRes = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: 'gpt-image-2',
        prompt: dallePrompt.slice(0, 1000),
        n: 1,
        size: imageSize,
        quality: 'standard',
        response_format: 'b64_json',
      }),
    });

    if (!dalleRes.ok) {
      const e = await dalleRes.json();
      throw new Error(e.error?.message || 'DALL-E error');
    }

    const dalleData = await dalleRes.json();
    const imageB64 = dalleData.data[0].b64_json;
    const revisedPrompt = dalleData.data[0].revised_prompt || dallePrompt;

    return new Response(
      JSON.stringify({ image: imageB64, prompt: revisedPrompt }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err.message }),
      {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      }
    );
  }
}
