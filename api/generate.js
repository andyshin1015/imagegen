export const maxDuration = 300;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) { res.status(500).json({ error: 'OPENAI_API_KEY 없음' }); return; }

  const { refImage, refMime, assets, regions, outputW, outputH } = req.body;

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

  const prompt = `Commerce product detail image. Based on the reference, apply these changes:\n${regionDesc}\nStyle: professional, clean, high quality e-commerce.`;

  const imageSize = (() => {
    if (outputW && outputH) {
      const ratio = outputW / outputH;
      if (ratio > 1.4) return '1792x1024';
      if (ratio < 0.7) return '1024x1792';
    }
    return '1024x1024';
  })();

  try {
    let imageB64;

    if (refImage) {
      const mimeType = refMime || 'image/jpeg';
      const ext = mimeType.includes('png') ? 'png' : 'jpeg';
      const binaryStr = atob(refImage);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
      const refBlob = new Blob([bytes], { type: mimeType });

      const form = new FormData();
      form.append('model', 'gpt-image-2');
      form.append('prompt', prompt.slice(0, 1000));
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
      imageB64 = item.b64_json || await fetchToBase64(item.url);

    } else {
      const r = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({ model: 'gpt-image-2', prompt: prompt.slice(0, 1000), n: 1, size: imageSize, quality: 'medium' }),
      });
      const text = await r.text();
      if (!r.ok) { res.status(500).json({ error: 'generations 오류: ' + text.slice(0, 400) }); return; }
      const data = JSON.parse(text);
      const item = data.data[0];
      imageB64 = item.b64_json || await fetchToBase64(item.url);
    }

    res.status(200).json({ image: imageB64, prompt });

  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

async function fetchToBase64(url) {
  const r = await fetch(url);
  const buf = await r.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}
